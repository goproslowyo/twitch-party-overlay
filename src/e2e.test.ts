/**
 * End-to-end wiring check: the prototype-verified scenario walked through the public seams only — real HTTP on
 * the streamer and funnel listeners, the real Ko-fi webhook route, and a real WebSocket on the overlay listener — then a
 * restart on the same DATA_DIR to prove the Ledger replay reproduces the last overlay state. Ephemeral ports, temp dirs,
 * fake secrets, no network adapters (Twitch / StreamElements off, Firebot off).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boot, type Booted } from "./boot.ts";
import { defaultConfig, type OutcomeDef } from "./config/schema.ts";
import { moteWireKey, type OverlayMessage, type OverlayState } from "./server/overlay.ts";

const EPHEMERAL = { streamer: 0, funnel: 0, overlay: 0 };
const KOFI_PATH = "k0f1-e2e";
const KOFI_TOKEN = "e2e-fake-verification-token";
const CSRF = { "X-Requested-With": "twitch-party-overlay" };
const WAIT_MS = 2000;

type Overlay = { next: (type: OverlayMessage["type"], ms?: number) => Promise<OverlayMessage>; close: () => void };
type FireResponse = { seq: number; outcome: { id: string; left: number; used: number } };

/** A real overlay client: queues every message; `next(type)` resolves with the oldest of that type (bounded wait). */
function attachOverlay(port: number): Promise<Overlay> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/overlay/ws`);
    const queue: OverlayMessage[] = [];
    const waiters: Array<{ type: string; resolve: (m: OverlayMessage) => void }> = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as OverlayMessage;
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i === -1) queue.push(msg);
      else waiters.splice(i, 1)[0]!.resolve(msg);
    };
    ws.onerror = () => reject(new Error("overlay ws failed"));
    ws.onopen = () =>
      resolve({
        next: (type, ms = WAIT_MS) =>
          new Promise((res, rej) => {
            const i = queue.findIndex((m) => m.type === type);
            if (i !== -1) return res(queue.splice(i, 1)[0]!);
            const t = setTimeout(() => rej(new Error(`no ${type} message within ${ms} ms`)), ms);
            waiters.push({ type, resolve: (m) => (clearTimeout(t), res(m)) });
          }),
        close: () => ws.close(),
      });
  });
}

/** Narrow a message to one type, failing loudly on the wrong one. */
function as<T extends OverlayMessage["type"]>(msg: OverlayMessage, type: T): Extract<OverlayMessage, { type: T }> {
  if (msg.type !== type) throw new Error(`expected a ${type} message, got ${msg.type}`);
  return msg as Extract<OverlayMessage, { type: T }>;
}

const kofiForm = (data: Record<string, unknown>) => `data=${encodeURIComponent(JSON.stringify(data))}`;

const kofiDonation = (amount: string) => ({
  verification_token: KOFI_TOKEN,
  message_id: randomUUID(),
  timestamp: "2026-09-12T20:15:00Z",
  type: "Donation",
  is_public: true,
  from_name: "alice",
  message: "play the one with the whistle",
  amount,
  url: "https://ko-fi.com/Home/CoffeeShop?txid=fake",
  email: "alice@example.invalid",
  currency: "USD",
  is_subscription_payment: false,
  is_first_subscription_payment: false,
  kofi_transaction_id: randomUUID(),
  shop_items: null,
  tier_name: null,
  shipping: null,
});

describe("wiring check: Ko-fi → manual credit → fire ×2 → rebank → threshold → restart replay → funnel login gate", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-e2e-"));
  let booted: Booted;
  let overlay: Overlay;
  let lastState: OverlayState;
  const fires: FireResponse[] = [];

  const streamer = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${booted.ports.streamer}${p}`, init);
  const funnel = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${booted.ports.funnel}${p}`, init);
  const post = (p: string, body?: unknown) =>
    streamer(p, { method: "POST", headers: { ...CSRF, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const start = () => boot({ dataDir, ports: EPHEMERAL, log: () => {} });
  const configFile = path.join(dataDir, "config.json");
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8")) as { outcomes: OutcomeDef[] };
  const writeConfig = (c: unknown) => fs.writeFileSync(configFile, JSON.stringify(c, null, 2));
  const apiState = async () => ((await (await streamer("/api/state")).json()) as { state: { outcomes: Array<{ id: string; left: number; used: number }> } }).state;
  /** The `stock` entries the service wrote for hand edits (system:file) — never the boot seeds (system:boot). */
  const stockByFile = async () => {
    const { entries } = (await (await streamer("/api/ledger?limit=200")).json()) as { entries: Array<{ type: string; actor: string; payload: unknown }> };
    return entries.filter((e) => e.type === "stock" && e.actor === "system:file").map((e) => e.payload).reverse(); // oldest first
  };

  beforeAll(async () => {
    const config = defaultConfig();
    config.channel = { login: "djexample", broadcasterId: "", displayName: "DJ Example" };
    config.ingest.twitch.enabled = false; // no network: nothing dials Twitch or StreamElements
    config.ingest.streamelements.enabled = false;
    config.ingest.kofi = { enabled: true, webhookPath: KOFI_PATH };
    config.firebot.enabled = false;
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2));
    fs.writeFileSync(path.join(dataDir, "secrets.env"), `KOFI_VERIFICATION_TOKEN=${KOFI_TOKEN}\n`);
    booted = await start();
    overlay = await attachOverlay(booted.ports.overlay);
  });

  afterAll(async () => {
    overlay?.close();
    await booted?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test("the overlay gets a snapshot first: fresh pool, empty queue, threshold $50", async () => {
    const snap = as(await overlay.next("snapshot"), "snapshot");
    expect(snap.state).toMatchObject({ thresholdCents: 5000, progressCents: 0, queue: 0, bankedTotal: 0, tier: 0, drained: false, motes: { collecting: [], ready: [] } });
    expect("cabin" in snap.state).toBe(false);
    expect(snap.skin.channelName).toBe("DJ Example");
    lastState = snap.state;
  });

  test("Ko-fi $13 through the webhook route on the funnel → contribution message with progressCents 1300", async () => {
    const res = await funnel(`/hooks/kofi/${KOFI_PATH}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: kofiForm(kofiDonation("13.00")) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, credited: true });

    const msg = as(await overlay.next("contribution"), "contribution");
    expect(msg).toMatchObject({ source: "kofi", displayName: "alice", anonymous: false, face: { kind: "tip", cents: 1300 }, faceValueCents: 1300, progressCents: 1300, unlocksBanked: 0, tiersOpened: [] });
    expect(msg.state).toMatchObject({ progressCents: 1300, queue: 0, bankedTotal: 0 });
    lastState = msg.state;
  });

  test("Manual Credit 10,000 bits on the streamer listener → unlocksBanked 2, two READY jumpers, $13 carried over", async () => {
    const res = await post("/api/contributions", { face: { kind: "bits", bits: 10000 }, displayName: "bob" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unlocksBanked: 2, tiersOpened: [] });

    // the message's own `progressCents` is what this contribution credited; the fader position is `state.progressCents`.
    const msg = as(await overlay.next("contribution"), "contribution");
    expect(msg).toMatchObject({ source: "manual", displayName: "bob", face: { kind: "bits", bits: 10000 }, faceValueCents: 10000, progressCents: 10000, unlocksBanked: 2 });
    expect(msg.state).toMatchObject({ progressCents: 1300, queue: 2, bankedTotal: 2, tier: 0 });
    expect(msg.avatarUrl).toBeNull();
    expect("cabin" in msg.state).toBe(false);
    lastState = msg.state;
  });

  test("/api/fire twice → two fire messages with distinct fireSeq / outcomeId and the decremented stockAfter", async () => {
    for (let n = 0; n < 2; n++) {
      const res = await post("/api/fire");
      expect(res.status).toBe(200);
      const fire = (await res.json()) as FireResponse;
      fires.push(fire);

      const msg = as(await overlay.next("fire"), "fire");
      expect(msg.fireSeq).toBe(fire.seq);
      expect(msg.outcomeId).toBe(fire.outcome.id);
      expect(msg.stockAfter).toBe(fire.outcome.left);
      expect(msg.solo).toBe(n === 0 ? null : "bob"); // the first Unlock finished alice's $13; the second was bob's alone (the solo rule)
      // the Contributor Motes of each Unlock: alice's $13 + $37 of bob's, then $50 of bob's alone (the last $13 of his is collecting)
      expect(msg.group.map((m) => [m.key, m.cents])).toEqual(n === 0 ? [[moteWireKey("alice"), 1300], [moteWireKey("bob"), 3700]] : [[moteWireKey("bob"), 5000]]);
      expect(msg.state.motes.collecting.map((m) => [m.key, m.cents])).toEqual([[moteWireKey("bob"), 1300]]);
      expect("contributor" in msg).toBe(false);
      const drawn = msg.state.outcomes.find((o) => o.id === msg.outcomeId)!;
      expect(drawn.tier).toBe(0);
      expect(drawn.left).toBe(msg.stockAfter);
      expect(drawn.used).toBe(1);
      expect(msg.state.queue).toBe(1 - n);
      lastState = msg.state;

      // The draw is weighted by the stock left and server-random: park the drawn outcome so the second draw cannot repeat it.
      if (n === 0) {
        expect((await post(`/api/outcomes/${fire.outcome.id}/status`, { status: "suspended" })).status).toBe(200);
        lastState = as(await overlay.next("state"), "state").state;
      }
    }
    expect(fires[0]!.seq).not.toBe(fires[1]!.seq);
    expect(fires[0]!.outcome.id).not.toBe(fires[1]!.outcome.id);
    expect(lastState).toMatchObject({ queue: 0, bankedTotal: 2 });
  });

  test("/api/fires/:seq/rebank → state message with the queue back at 1 and the fire refunded (used back to 0)", async () => {
    const second = fires[1]!;
    const res = await post(`/api/fires/${second.seq}/rebank`, { reason: "dj was mid-transition" });
    expect(res.status).toBe(200);

    const msg = as(await overlay.next("state"), "state");
    expect(msg.reason).toBe("rebank");
    expect(msg.state).toMatchObject({ queue: 1, progressCents: 1300 });
    const refunded = msg.state.outcomes.find((o) => o.id === second.outcome.id)!;
    expect(refunded).toMatchObject({ left: second.outcome.left + 1, used: 0 });
    lastState = msg.state;
  });

  test("/api/threshold 3500 → state message with thresholdCents 3500 and no extra unlock ($13 < $35)", async () => {
    const res = await post("/api/threshold", { cents: 3500 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unlocksBanked: 0 });

    const msg = as(await overlay.next("state"), "state");
    expect(msg.reason).toBe("threshold");
    expect(msg.state).toMatchObject({ thresholdCents: 3500, progressCents: 1300, queue: 1 });
    lastState = msg.state;
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).threshold.cents).toBe(3500);
  });

  test("restart on the same DATA_DIR after a hand edit of `outcomes`: the snapshot replays the last state; the added Outcome is seeded (Left 2) and the removed one zeroed, both by system:file", async () => {
    overlay.close();
    await booted.stop();
    // While the service is down, the streamer edits the file: one Outcome in, one out (definitions in config, stock in the Ledger).
    const edited = readConfig();
    edited.outcomes = edited.outcomes.filter((o) => o.id !== "party-polaroid");
    edited.outcomes.push({ id: "vinyl-only", name: "VINYL ONLY", glyph: "💿", shape: "challenge", tier: 0, initialLeft: 2, restockable: true, occupancy: "~1 track", description: "" });
    writeConfig(edited);
    booted = await start();
    overlay = await attachOverlay(booted.ports.overlay);

    const snap = as(await overlay.next("snapshot"), "snapshot");
    const { outcomes, ...rest } = snap.state;
    const { outcomes: before, ...lastRest } = lastState;
    expect(rest).toEqual(lastRest); // everything but the Outcome list replays exactly
    expect(outcomes.filter((o) => o.id !== "vinyl-only")).toEqual(before.filter((o) => o.id !== "party-polaroid")); // and so does every Outcome that stayed
    expect(outcomes.find((o) => o.id === "vinyl-only")).toMatchObject({ tier: 0, left: 2, used: 0, status: "live" });
    expect(outcomes.some((o) => o.id === "party-polaroid")).toBe(false);
    expect((await (await streamer("/api/state")).json()) as { state: { thresholdCents: number } }).toMatchObject({ role: "streamer", state: { thresholdCents: 3500 } });
    expect(await stockByFile()).toEqual(expect.arrayContaining([{ outcomeId: "vinyl-only", delta: 2, reason: "initial" }, { outcomeId: "party-polaroid", delta: -1, reason: "removed" }]));
    expect(await stockByFile()).toHaveLength(2);
    lastState = snap.state;
  });

  test("a hand edit of config.json while running: the new Outcome is on /api/state and the overlay without a restart, seeded by system:file", async () => {
    const edited = readConfig();
    edited.outcomes.push({ id: "tape-only", name: "TAPE ONLY", glyph: "📼", shape: "challenge", tier: 0, initialLeft: 3, restockable: true, occupancy: "~1 track", description: "" });
    writeConfig(edited);
    // fs.watch + the store's 200 ms debounce: give it a moment, then a short bounded wait for a slow machine.
    await Bun.sleep(600);
    let state = await apiState();
    for (let i = 0; i < 20 && !state.outcomes.some((o) => o.id === "tape-only"); i++) {
      await Bun.sleep(100);
      state = await apiState();
    }
    expect(state.outcomes.find((o) => o.id === "tape-only")).toMatchObject({ left: 3, used: 0 });

    const msg = as(await overlay.next("state"), "state");
    expect(msg.reason).toBe("outcomes");
    expect(msg.state.outcomes.find((o) => o.id === "tape-only")).toMatchObject({ tier: 0, left: 3, used: 0, status: "live" });
    expect((await stockByFile()).at(-1)).toEqual({ outcomeId: "tape-only", delta: 3, reason: "initial" });
    expect(await stockByFile()).toHaveLength(3);
  });

  test("GET /help on the funnel without a cookie → the login page (302 to /login)", async () => {
    const res = await funnel("/help", { redirect: "manual" });
    expect([302, 401]).toContain(res.status);
    if (res.status === 302) expect(res.headers.get("location")).toBe("/login");
    else expect(res.headers.get("content-type")).toContain("text/html");
  });
});
