import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { boot, type Booted } from "./boot.ts";
import { defaultConfig } from "./config/schema.ts";
import type { Entry } from "./ledger/types.ts";
import type { HealthItem } from "./server/health.ts";
import { chatterKey, type OverlayMessage } from "./server/overlay.ts";
import { main, optionsFromEnv, version } from "./main.ts";
import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";

const REPO = path.resolve(import.meta.dir, "..");
const EPHEMERAL = { streamer: 0, funnel: 0, overlay: 0 };

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tpo-boot-"));

/** Boot against a fresh temp DATA_DIR on ephemeral ports with the log silenced. */
async function bootTmp(dataDir = tmpDir()): Promise<{ dataDir: string; booted: Booted; api: (p: string) => Promise<Response> }> {
  const booted = await boot({ dataDir, ports: EPHEMERAL, log: () => {} });
  const api = (p: string) => fetch(`http://127.0.0.1:${booted.ports.streamer}${p}`);
  return { dataDir, booted, api };
}

const stateOf = async (api: (p: string) => Promise<Response>) => (await api("/api/state")).json() as Promise<{ health: HealthItem[] }>;
const entriesOf = async (api: (p: string) => Promise<Response>) => ((await (await api("/api/ledger?limit=200")).json()) as { entries: Entry[] }).entries;

/** Resolves with every message the overlay socket receives, as it opens; `next(type)` waits for one of that type. */
function attachOverlay(port: number): Promise<{ next: (type: OverlayMessage["type"], ms: number) => Promise<OverlayMessage>; close: () => void }> {
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
        next: (type, ms) =>
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

/** Three ports nobody is listening on right now (bind 0, read, release) — validateConfig refuses port 0 in the file. Keyed like
 *  `config.listeners` so the spread below actually replaces the defaults (8700–8702 are taken whenever `just show` is up). */
function freePorts(): { streamerPort: number; funnelPort: number; overlayPort: number } {
  const take = () => {
    const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = s.port;
    void s.stop(true);
    if (port === undefined) throw new Error("no port");
    return port;
  };
  return { streamerPort: take(), funnelPort: take(), overlayPort: take() };
}

test("version comes from package.json", () => {
  expect(version()).toBe((JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version);
});

test("boot: serves /api/state on the streamer listener with the boot banner and the not-linked warning; stop resolves", async () => {
  const { dataDir, booted, api } = await bootTmp();
  try {
    expect(booted.ports.streamer).toBeGreaterThan(0);
    expect(booted.ports.funnel).toBeGreaterThan(0);
    expect(booted.ports.overlay).toBeGreaterThan(0);
    const res = await api("/api/state");
    expect(res.status).toBe(200);
    const { health } = (await res.json()) as { health: HealthItem[] };
    expect(health.map((h) => [h.id, h.level, h.text])).toEqual(
      expect.arrayContaining([
        ["boot", "info", expect.stringMatching(/^Service \(re\)started at .+ — Ko-fi webhooks during downtime are lost; check the Ko-fi dashboard$/)],
        ["twitch-link", "warn", "Twitch account not connected — open Setup on the computer running the overlay (/setup)"],
        ["twitch-app", "warn", "Twitch app not set up yet — open Setup on the computer running the overlay (/setup)"],
      ]),
    );
    expect(fs.existsSync(path.join(dataDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "ledger.sqlite"))).toBe(true);
  } finally {
    await booted.stop();
  }
  await expect(fetch(`http://127.0.0.1:${booted.ports.streamer}/api/state`)).rejects.toBeInstanceOf(Error);
});

test("boot: with TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in Secrets there is no twitch-app banner; an empty value counts as missing", async () => {
  const withBoth = tmpDir();
  fs.writeFileSync(path.join(withBoth, "secrets.env"), "TWITCH_CLIENT_ID=cid\nTWITCH_CLIENT_SECRET=csecret\n");
  const a = await bootTmp(withBoth);
  try {
    expect((await stateOf(a.api)).health.find((h) => h.id === "twitch-app")).toBeUndefined();
  } finally {
    await a.booted.stop();
  }
  const emptySecret = tmpDir();
  fs.writeFileSync(path.join(emptySecret, "secrets.env"), "TWITCH_CLIENT_ID=cid\nTWITCH_CLIENT_SECRET=\n");
  const b = await bootTmp(emptySecret);
  try {
    expect((await stateOf(b.api)).health.find((h) => h.id === "twitch-app")).toMatchObject({ level: "warn", text: "Twitch app not set up yet — open Setup on the computer running the overlay (/setup)" });
  } finally {
    await b.booted.stop();
  }
});

test("boot: listeners.bindAll in config.json without BIND_ALL raises the bind-all warning; BIND_ALL=1 (Docker) does not", async () => {
  const dataDir = tmpDir();
  const config = defaultConfig();
  config.listeners.bindAll = true;
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
  const logs: string[] = [];
  const fromFile = await boot({ dataDir, ports: EPHEMERAL, log: (line) => void logs.push(line) });
  try {
    const { health } = await stateOf((p) => fetch(`http://127.0.0.1:${fromFile.ports.streamer}${p}`));
    expect(health.find((h) => h.id === "bind-all")).toMatchObject({ level: "warn", text: "listeners.bindAll is on — the streamer Dashboard is reachable from the LAN without login" });
    expect(logs.some((l) => l.includes("listeners.bindAll is on"))).toBe(true);
  } finally {
    await fromFile.stop();
  }
  const fromEnv = await boot({ dataDir, ports: EPHEMERAL, bindAll: true, log: () => {} });
  try {
    const { health } = await stateOf((p) => fetch(`http://127.0.0.1:${fromEnv.ports.streamer}${p}`));
    expect(health.find((h) => h.id === "bind-all")).toBeUndefined();
  } finally {
    await fromEnv.stop();
  }
});

test("boot: seeds empty channel.login / funnel.publicUrl / ingest.kofi.webhookPath from Secrets exactly once", async () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "secrets.env"), "CHANNEL_LOGIN=djexample\nFUNNEL_PUBLIC_URL=https://laptop.tail1234.ts.net\nKOFI_WEBHOOK_PATH=k0f1\n");
  const first = await bootTmp(dataDir);
  try {
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
    expect(onDisk.channel.login).toBe("djexample");
    expect(onDisk.funnel.publicUrl).toBe("https://laptop.tail1234.ts.net");
    expect(onDisk.ingest.kofi.webhookPath).toBe("k0f1");
    const entries = await entriesOf(first.api);
    // newest first: the identity seed, then the Engine's boot seeds — one `stock` per Outcome, and the threshold seed (seq 1)
    expect(entries.map((e) => [e.type, e.actor])).toEqual([["config_change", "system:boot"], ...defaultConfig().outcomes.map(() => ["stock", "system:boot"]), ["threshold", "system:boot"]]);
    expect((entries[0] as Entry<"config_change">).payload.diff.map((d) => d.path).sort()).toEqual(["channel.login", "funnel.publicUrl", "ingest.kofi.webhookPath"]);
  } finally {
    await first.booted.stop();
  }

  // The streamer edits the login by hand; a second boot must not put the Secrets value back.
  const edited = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  edited.channel.login = "renamed";
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(edited));
  const second = await bootTmp(dataDir);
  try {
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).channel.login).toBe("renamed");
    expect((await entriesOf(second.api)).filter((e) => e.type === "config_change")).toHaveLength(1);
  } finally {
    await second.booted.stop();
  }
});

test("boot: a hand edit of threshold.cents between two boots applies at the second boot and is recorded as a threshold entry by system:file", async () => {
  const dataDir = tmpDir();
  const first = await bootTmp(dataDir);
  try {
    const res = await fetch(`http://127.0.0.1:${first.booted.ports.streamer}/api/contributions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-requested-with": "twitch-party-overlay" },
      body: JSON.stringify({ face: { kind: "tip", cents: 1300 }, displayName: "alice" }),
    });
    expect(res.status).toBe(200);
    expect(((await stateOf(first.api)) as unknown as { state: { thresholdCents: number; progressCents: number } }).state).toMatchObject({ thresholdCents: 5000, progressCents: 1300 });
  } finally {
    await first.booted.stop();
  }

  const edited = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8"));
  edited.threshold.cents = 3500;
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(edited));
  const second = await bootTmp(dataDir);
  try {
    expect(((await stateOf(second.api)) as unknown as { state: { thresholdCents: number; progressCents: number } }).state).toMatchObject({ thresholdCents: 3500, progressCents: 1300 });
    const entries = await entriesOf(second.api);
    expect(entries[0]).toMatchObject({ type: "threshold", actor: "system:file", payload: { cents: 3500 } }); // newest first
    expect(entries.filter((e) => e.type === "threshold")).toHaveLength(2); // the boot seed and the recorded hand edit
  } finally {
    await second.booted.stop();
  }
});

test("hot reload: a hand edit of overlay.side reaches an attached overlay as a skin message and writes exactly one config_change by system:file", async () => {
  const { dataDir, booted, api } = await bootTmp();
  const overlay = await attachOverlay(booted.ports.overlay);
  try {
    await overlay.next("snapshot", 1000);
    await Bun.sleep(150); // fs.watch arms on a background thread — see store.test.ts
    const edited = defaultConfig();
    edited.overlay.side = "left";
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(edited, null, 2));

    const skin = await overlay.next("skin", 2000);
    if (skin.type !== "skin") throw new Error(skin.type);
    expect(skin.skin.config.side).toBe("left");

    const changes = (await entriesOf(api)).filter((e): e is Entry<"config_change"> => e.type === "config_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.actor).toBe("system:file");
    expect(changes[0]!.payload.diff).toEqual([{ path: "overlay.side", from: "right", to: "left" }]);
    expect((await (await api("/api/config")).json()) as { config: { overlay: { side: string } } }).toMatchObject({ config: { overlay: { side: "left" } } });
  } finally {
    overlay.close();
    await booted.stop();
  }
});

test("hot reload: an invalid edit keeps the last good config and raises the config warning", async () => {
  const { dataDir, booted, api } = await bootTmp();
  try {
    await Bun.sleep(150);
    fs.writeFileSync(path.join(dataDir, "config.json"), "{ not json");
    const deadline = Date.now() + 2000;
    let banner: HealthItem | undefined;
    while (banner === undefined && Date.now() < deadline) {
      await Bun.sleep(50);
      banner = (await stateOf(api)).health.find((h) => h.id === "config");
    }
    expect(banner).toMatchObject({ level: "warn", text: expect.stringMatching(/^config\.json is invalid — last good config still in use: .+/) });
    expect((await (await api("/api/config")).json()) as { config: { overlay: { side: string } } }).toMatchObject({ config: { overlay: { side: "right" } } });
  } finally {
    await booted.stop();
  }
});

// ---- console lines (follow-up 1): one per Ledger entry, always; the noisy ones only under VERBOSE --------------------------

const post = (port: number, p: string, body: unknown, method = "POST") =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { "content-type": "application/json", "x-requested-with": "twitch-party-overlay" }, body: JSON.stringify(body) });
const LINE = /^\d{2}:\d{2}:\d{2} #(\d+) (\w+) (\S+) — (.*)$/; // HH:MM:SS #seq type actor — description
const KOFI_GUESS = "s3cr3t-hook-path";

test("boot: every Ledger entry prints one console line — a Manual Credit exactly one `contribution` line with the amount and the fader, a config PUT a `config_change` line", async () => {
  const logs: string[] = [];
  const booted = await boot({ dataDir: tmpDir(), ports: EPHEMERAL, log: (line) => void logs.push(line) });
  try {
    const before = logs.length;
    expect((await post(booted.ports.streamer, "/api/contributions", { face: { kind: "tip", cents: 1300 }, displayName: "alice" })).status).toBe(200);
    const contribution = logs.slice(before).filter((l) => l.includes("contribution"));
    expect(contribution).toHaveLength(1);
    const m = LINE.exec(contribution[0]!);
    expect(m).not.toBeNull();
    expect(m![2]).toBe("contribution");
    expect(m![3]).toBe("streamer@local");
    expect(m![4]).toBe("@alice tipped $13 (+$13) → $13 of $50");

    const cfg = (await (await fetch(`http://127.0.0.1:${booted.ports.streamer}/api/config`)).json()) as { config: ReturnType<typeof defaultConfig> };
    cfg.config.overlay.side = "left";
    expect((await post(booted.ports.streamer, "/api/config", cfg.config, "PUT")).status).toBe(200);
    const change = logs.filter((l) => LINE.exec(l)?.[2] === "config_change");
    expect(change).toHaveLength(1);
    expect(change[0]).toMatch(/ #\d+ config_change streamer@local — 1 change: overlay\.side$/);
  } finally {
    await booted.stop();
  }
});

test("boot: VERBOSE prints unlock lines and overlay client counts but no request lines; DEBUG adds the request lines; the default prints none of them", async () => {
  const run = async (level: { verbose?: boolean; debug?: boolean }) => {
    const logs: string[] = [];
    const booted = await boot({ dataDir: tmpDir(), ports: EPHEMERAL, log: (line) => void logs.push(line), ...level });
    try {
      const overlay = await attachOverlay(booted.ports.overlay);
      await overlay.next("snapshot", 1000);
      expect((await post(booted.ports.streamer, "/api/contributions", { face: { kind: "tip", cents: 5000 }, displayName: "alice" })).status).toBe(200);
      expect((await post(booted.ports.funnel, `/hooks/kofi/${KOFI_GUESS}`, {})).status).toBe(404); // no Ko-fi path configured: 404, but the request line still prints
      overlay.close();
      await Bun.sleep(50);
    } finally {
      await booted.stop();
    }
    return logs;
  };

  // VERBOSE: the "is it working" signals — every unlock entry, overlay clients — and not one request line
  const detail = await run({ verbose: true });
  expect(detail.filter((l) => LINE.exec(l)?.[2] === "contribution")).toHaveLength(1);
  expect(detail.find((l) => LINE.exec(l)?.[2] === "contribution")).toMatch(/@alice tipped \$50 \(\+\$50\) → \$0 of \$50 · \+1 UNLOCK$/);
  const bootSeeds = 1 + defaultConfig().outcomes.length; // the threshold seed + one stock seed per Outcome precede the first command
  expect(detail.filter((l) => LINE.exec(l)?.[2] === "unlock")).toEqual([expect.stringMatching(new RegExp(` #${bootSeeds + 2} unlock streamer@local — unlock from contribution #${bootSeeds + 1}$`))]);
  expect(detail).toContain("overlay: client connected (1 attached)");
  expect(detail).toContain("overlay: client disconnected (0 attached)");
  expect(detail.filter((l) => /^(GET|POST) \//.test(l))).toHaveLength(0);
  expect(detail.filter((l) => l.includes(KOFI_GUESS))).toEqual([]);

  // DEBUG: everything VERBOSE prints, plus one line per request (the Ko-fi hook path still masked)
  const everything = await run({ debug: true });
  expect(everything.filter((l) => LINE.exec(l)?.[2] === "unlock")).toHaveLength(1);
  expect(everything).toContain("overlay: client connected (1 attached)");
  expect(everything.filter((l) => /^POST \/api\/contributions on streamer 200 \d+ms$/.test(l))).toHaveLength(1);
  expect(everything.filter((l) => /^POST \/hooks\/kofi\/<redacted> on funnel 404 \d+ms$/.test(l))).toHaveLength(1); // the hook path is a secret
  expect(everything.filter((l) => l.includes(KOFI_GUESS))).toEqual([]);

  const quiet = await run({});
  expect(quiet.filter((l) => LINE.exec(l)?.[2] === "contribution")).toHaveLength(1);
  expect(quiet.filter((l) => LINE.exec(l)?.[2] === "unlock")).toHaveLength(0);
  expect(quiet.filter((l) => l.startsWith("overlay: client"))).toHaveLength(0);
  expect(quiet.filter((l) => /^(GET|POST) \//.test(l))).toHaveLength(0);
});

test("boot: a ws:// eventsubUrl (the Twitch CLI mock) with a linked broadcaster logs `twitch: mock mode` with the mock's subscriptions endpoint", async () => {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "secrets.env"), "TWITCH_CLIENT_ID=cid\nTWITCH_CLIENT_SECRET=csecret\nTWITCH_BROADCASTER_ACCESS_TOKEN=fake\nTWITCH_BROADCASTER_REFRESH_TOKEN=fake\nTWITCH_BROADCASTER_EXPIRES_AT=2099-01-01T00:00:00.000Z\n");
  const config = defaultConfig();
  config.channel.broadcasterId = "12345";
  config.ingest.twitch.eventsubUrl = "ws://127.0.0.1:1/ws"; // nobody listens on port 1: the client just retries with backoff until stop()
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
  const logs: string[] = [];
  const booted = await boot({ dataDir, ports: EPHEMERAL, log: (line) => void logs.push(line), fetchImpl: async () => new Response("offline", { status: 503 }) });
  try {
    expect(logs).toContain("twitch: mock mode — subscriptions via http://127.0.0.1:1/eventsub/subscriptions");
  } finally {
    await booted.stop();
  }
});

/** A linked broadcaster; by default on a socket url nobody answers (port 1), so only the token check and the Health line are in play. */
function linkedDataDir(twitch: { eventsubUrl?: string; sessions?: number } = {}): string {
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, "secrets.env"), "TWITCH_CLIENT_ID=cid\nTWITCH_CLIENT_SECRET=csecret\nTWITCH_BROADCASTER_ACCESS_TOKEN=fake\nTWITCH_BROADCASTER_REFRESH_TOKEN=fake\nTWITCH_BROADCASTER_EXPIRES_AT=2099-01-01T00:00:00.000Z\n");
  const config = defaultConfig();
  config.channel.broadcasterId = "12345";
  config.ingest.twitch.sessions = twitch.sessions ?? 1;
  config.ingest.twitch.eventsubUrl = twitch.eventsubUrl ?? "ws://127.0.0.1:1/ws";
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
  return dataDir;
}

const VALIDATE_URL = "https://id.twitch.tv/oauth2/validate";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const MONEY_SCOPES = ["bits:read", "channel:read:subscriptions", "moderation:read"];
const CHAT = "channel.chat.message";
const CHAT_SCOPE = "user:read:chat";
const CHAT_UNHEARD = "chat-unheard";
/** The token a fresh broadcaster link mints (the fake code exchange). */
const LINKED_TOKEN = "fake-linked";

/** Poll `cond` every 10 ms until it holds; `what` names the wait when it never does. */
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

interface FakeConn {
  id: number;
  ws: ServerWebSocket<{ id: number }>;
  closed: boolean;
}
const stamp = () => new Date().toISOString();

/** One fake eventsub.wss.twitch.tv (a ws:// url, so the subscription POSTs go to its host through fetchImpl): every socket is recorded; the test decides what each is sent. */
function fakeEventSub() {
  const conns: FakeConn[] = [];
  let nextId = 1;
  const server = Bun.serve<{ id: number }>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req, { data: { id: nextId++ } }) ? undefined : new Response("websocket only", { status: 400 })),
    websocket: {
      open(ws) {
        conns.push({ id: ws.data.id, ws, closed: false });
      },
      message() {},
      close(ws) {
        const c = conns.find((x) => x.id === ws.data.id);
        if (c) c.closed = true;
      },
    },
  });
  const send = (conn: FakeConn, msg: unknown) => conn.ws.send(JSON.stringify(msg));
  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    subscriptionsUrl: `http://127.0.0.1:${server.port}/eventsub/subscriptions`,
    /** The n-th socket (1-based), once it has connected. */
    conn: async (n: number): Promise<FakeConn> => {
      await until(() => conns.length >= n, `socket ${n}`);
      return conns[n - 1]!;
    },
    welcome: (conn: FakeConn, sessionId: string) =>
      send(conn, {
        metadata: { message_id: `welcome-${conn.id}`, message_type: "session_welcome", message_timestamp: stamp() },
        payload: { session: { id: sessionId, status: "connected", connected_at: stamp(), keepalive_timeout_seconds: 10, reconnect_url: null } },
      }),
    /** A `channel.chat.message` frame from Cool_User, as Twitch sends it (the text never leaves the adapter). */
    chat: (conn: FakeConn, messageId: string) =>
      send(conn, {
        metadata: { message_id: messageId, message_type: "notification", message_timestamp: stamp(), subscription_type: CHAT, subscription_version: "1" },
        payload: {
          subscription: { id: "sub-chat", status: "enabled", type: CHAT, version: "1", cost: 0, condition: { broadcaster_user_id: "12345", user_id: "12345" }, transport: { method: "websocket", session_id: "s" }, created_at: stamp() },
          event: {
            broadcaster_user_id: "12345", broadcaster_user_login: "dj", broadcaster_user_name: "DJ",
            chatter_user_id: "1234", chatter_user_login: "cool_user", chatter_user_name: "Cool_User",
            message_id: `u-${messageId}`, message_type: "text", message: { text: "hello", fragments: [{ type: "text", text: "hello", cheermote: null, emote: null, mention: null }] },
            badges: [], color: "#FF0000", source_broadcaster_user_id: null, source_broadcaster_user_login: null, source_broadcaster_user_name: null, source_badges: null, source_message_id: null, is_source_only: null,
          },
        },
      }),
    stop: () => server.stop(true),
  };
}

interface SubscribePost {
  session: string;
  type: string;
  bearer: string;
}

/** What Get Users answers for one account: Twitch's 300x300 picture, as the API hands it out. */
const COOL_USER = { id: "1234", login: "cool_user", profile_image_url: "https://static-cdn.jtvnw.net/jtv_user_pictures/cool-profile_image-300x300.png" };

/**
 * Helix and id.twitch.tv behind boot's fetchImpl: validate answers with `scopes(token)`, the code exchange mints LINKED_TOKEN,
 * a subscription POST is 202 unless `refuse` says 403 (what Twitch does to a chat POST from a token without the scope); Get Users answers
 * `users` when given (every call recorded in `lookups`); anything else is 503.
 */
function fakeTwitch(subscriptionsUrl: string, opts: { scopes: (token: string) => string[]; refuse?: (post: SubscribePost) => boolean; users?: Array<typeof COOL_USER> }) {
  const validates: string[] = [];
  const posts: SubscribePost[] = [];
  const lookups: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url === VALIDATE_URL) {
      validates.push(auth);
      return Response.json({ client_id: "cid", login: "dj", user_id: "12345", scopes: opts.scopes(auth.replace(/^OAuth /, "")), expires_in: 5000 });
    }
    if (url === TOKEN_URL && init?.method === "POST") return Response.json({ access_token: LINKED_TOKEN, refresh_token: "fake-linked-refresh", expires_in: 5000, token_type: "bearer" });
    if (url === subscriptionsUrl && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { type: string; transport: { session_id: string } };
      const post: SubscribePost = { session: body.transport.session_id, type: body.type, bearer: auth.replace(/^Bearer /, "") };
      posts.push(post);
      if (opts.refuse?.(post) === true) return new Response("forbidden", { status: 403 });
      return Response.json({ data: [{ id: `sub-${posts.length}`, status: "enabled" }], total: posts.length, total_cost: 0, max_total_cost: 10 }, { status: 202 });
    }
    if (opts.users !== undefined && url.startsWith("https://api.twitch.tv/helix/users?") && (init?.method ?? "GET") === "GET") {
      lookups.push(url);
      return Response.json({ data: opts.users });
    }
    return new Response("offline", { status: 503 });
  };
  return { fetchImpl, validates, posts, lookups };
}

test("boot: a linked broadcaster whose token lacks user:read:chat gets the chat-unheard warning from the token check at boot, before any subscription; with the scope there is none; the check is `OAuth <token>` against /oauth2/validate", async () => {
  const run = async (scopes: string[]) => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") ?? undefined });
      return url === VALIDATE_URL ? Response.json({ client_id: "cid", login: "dj", user_id: "12345", scopes, expires_in: 5000 }) : new Response("offline", { status: 503 });
    };
    const booted = await boot({ dataDir: linkedDataDir(), ports: EPHEMERAL, log: () => {}, fetchImpl });
    try {
      const deadline = Date.now() + 2000;
      while (!calls.some((c) => c.url === VALIDATE_URL) && Date.now() < deadline) await Bun.sleep(10);
      await Bun.sleep(50); // the Health line lands right after the validate answer
      const { health } = await stateOf((p) => fetch(`http://127.0.0.1:${booted.ports.streamer}${p}`));
      return { calls, banner: health.find((b) => b.id === "chat-unheard") };
    } finally {
      await booted.stop();
    }
  };
  const missing = await run(MONEY_SCOPES);
  expect(missing.calls.filter((c) => c.url === VALIDATE_URL)).toEqual([{ url: VALIDATE_URL, auth: "OAuth fake" }]);
  expect(missing.banner).toMatchObject({ level: "warn", text: "Connect the broadcaster account again to hear chat: click the broadcaster link on the Config page" });
  expect(missing.calls.filter((c) => c.url.endsWith("/eventsub/subscriptions"))).toEqual([]); // nothing subscribed yet: the line came from the token check

  const present = await run([...MONEY_SCOPES, "user:read:chat"]);
  expect(present.banner).toBeUndefined();
});

test("boot: the token check failing (Twitch unreachable) is one log line and no chat banner — the subscription's own refusal decides later", async () => {
  const logs: string[] = [];
  const booted = await boot({ dataDir: linkedDataDir(), ports: EPHEMERAL, log: (line) => void logs.push(line), fetchImpl: async () => new Response("down", { status: 503 }) });
  try {
    const deadline = Date.now() + 2000;
    while (!logs.some((l) => l.includes("could not read the token's scopes")) && Date.now() < deadline) await Bun.sleep(10);
    expect(logs).toContain("twitch: could not read the token's scopes (Twitch validate → 503); subscribing anyway");
    const { health } = await stateOf((p) => fetch(`http://127.0.0.1:${booted.ports.streamer}${p}`));
    expect(health.find((b) => b.id === "chat-unheard")).toBeUndefined();
  } finally {
    await booted.stop();
  }
});

test("boot: a chat frame reaches the roster (never the Engine) and clears the chat-unheard line again after a later session's chat refusal raised it", async () => {
  const server = fakeEventSub();
  const twitch = fakeTwitch(server.subscriptionsUrl, { scopes: () => [...MONEY_SCOPES, CHAT_SCOPE], refuse: (p) => p.type === CHAT && p.session === "s2" });
  const booted = await boot({ dataDir: linkedDataDir({ eventsubUrl: server.url, sessions: 2 }), ports: EPHEMERAL, log: () => {}, fetchImpl: twitch.fetchImpl });
  const api = (p: string) => fetch(`http://127.0.0.1:${booted.ports.streamer}${p}`);
  const banner = async () => (await stateOf(api)).health.find((b) => b.id === CHAT_UNHEARD);
  try {
    const overlay = await attachOverlay(booted.ports.overlay);
    const a = await server.conn(1);
    const b = await server.conn(2);
    server.welcome(a, "s1");
    await until(() => twitch.posts.filter((p) => p.session === "s1").length === 6, "session 1's six subscriptions");
    expect(await banner()).toBeUndefined();

    server.chat(a, "m1");
    expect(await overlay.next("chatters", 2000)).toMatchObject({ type: "chatters", chatters: [{ key: chatterKey("1234"), name: "Cool_User", avatarUrl: null }] });
    expect((await entriesOf(api)).filter((e) => e.type === "contribution")).toEqual([]); // presence, never progress

    server.welcome(b, "s2"); // Twitch refuses chat on this session: the line goes up
    await until(async () => (await banner()) !== undefined, "the line after session 2's refusal");
    expect(await banner()).toMatchObject({ level: "warn", text: "Connect the broadcaster account again to hear chat: click the broadcaster link on the Config page" });

    server.chat(a, "m2"); // chat is still arriving on session 1: the line comes down again
    await until(async () => (await banner()) === undefined, "the line to clear on the next heard frame");
    overlay.close();
  } finally {
    await booted.stop();
    server.stop();
  }
});

test("boot: the broadcaster link restarts EventSub with the new token: the scopes are read again, every subscription is made again (chat now accepted) and the chat-unheard line clears", async () => {
  const server = fakeEventSub();
  const hasChat = (token: string) => token === LINKED_TOKEN; // the scope belongs to the token: the old one never gets it
  const twitch = fakeTwitch(server.subscriptionsUrl, { scopes: (t) => (hasChat(t) ? [...MONEY_SCOPES, CHAT_SCOPE] : MONEY_SCOPES), refuse: (p) => p.type === CHAT && !hasChat(p.bearer) });
  const booted = await boot({ dataDir: linkedDataDir({ eventsubUrl: server.url }), ports: EPHEMERAL, log: () => {}, fetchImpl: twitch.fetchImpl });
  const base = `http://127.0.0.1:${booted.ports.streamer}`;
  const banner = async () => (await stateOf((p) => fetch(`${base}${p}`))).health.find((b) => b.id === CHAT_UNHEARD);
  try {
    const a = await server.conn(1);
    server.welcome(a, "s1");
    await until(() => twitch.posts.filter((p) => p.session === "s1").length === 6, "session 1's six subscriptions");
    expect(await banner()).toMatchObject({ level: "warn" }); // the token check said so; Twitch's refusal agreed

    // The remedy the line names: the streamer clicks the broadcaster link on Config; Twitch sends the browser back with a code.
    const start = await fetch(`${base}/auth/twitch/broadcaster`, { redirect: "manual" });
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    const back = await fetch(`${base}/auth/twitch/callback?code=abc&state=${state}`, { redirect: "manual", headers: { cookie } });
    expect(back.status).toBe(302);

    const b = await server.conn(2); // a fresh socket: EventSub restarted on the new token
    await until(() => a.closed, "the old socket to close");
    server.welcome(b, "s2");
    await until(async () => (await banner()) === undefined, "the line to clear after the new chat subscription");
    expect(twitch.posts.filter((p) => p.type === CHAT).map((p) => [p.session, p.bearer])).toEqual([["s1", "fake"], ["s2", LINKED_TOKEN]]);
    expect(twitch.validates).toEqual(["OAuth fake", `OAuth ${LINKED_TOKEN}`, `OAuth ${LINKED_TOKEN}`]); // the boot check, the callback's identity check, the check after the restart
  } finally {
    await booted.stop();
    server.stop();
  }
});

test("boot: the sockets never wait on the token check — with id.twitch.tv hanging, EventSub connects and the six subscriptions go up; the late answer still raises the chat-unheard line", async () => {
  const server = fakeEventSub();
  const twitch = fakeTwitch(server.subscriptionsUrl, { scopes: () => MONEY_SCOPES });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(input) === VALIDATE_URL) await gate; // id.twitch.tv hangs
    return twitch.fetchImpl(input, init);
  };
  const booted = await boot({ dataDir: linkedDataDir({ eventsubUrl: server.url }), ports: EPHEMERAL, log: () => {}, fetchImpl });
  const api = (p: string) => fetch(`http://127.0.0.1:${booted.ports.streamer}${p}`);
  const banner = async () => (await stateOf(api)).health.find((b) => b.id === CHAT_UNHEARD);
  try {
    const a = await server.conn(1); // the money path is up while the validate call is still pending
    server.welcome(a, "s1");
    await until(() => twitch.posts.filter((p) => p.session === "s1").length === 6, "session 1's six subscriptions");
    expect(twitch.validates).toEqual([]); // still hanging
    expect(await banner()).toBeUndefined();
    release();
    await until(async () => (await banner()) !== undefined, "the line from the late token check");
    expect(await banner()).toMatchObject({ level: "warn", text: "Connect the broadcaster account again to hear chat: click the broadcaster link on the Config page" });
  } finally {
    release();
    await booted.stop();
    server.stop();
  }
});

test("boot: the broadcaster link's restart forgets the old sessions — with sessions lowered from 2 to 1 first, a new socket that never says welcome is an outage after the grace, not masked by a stale session 2", async () => {
  const server = fakeEventSub();
  const twitch = fakeTwitch(server.subscriptionsUrl, { scopes: () => [...MONEY_SCOPES, CHAT_SCOPE] });
  const booted = await boot({ dataDir: linkedDataDir({ eventsubUrl: server.url, sessions: 2 }), ports: EPHEMERAL, log: () => {}, fetchImpl: twitch.fetchImpl, twitchDownGraceMs: 200 });
  const base = `http://127.0.0.1:${booted.ports.streamer}`;
  const outage = async () => (await stateOf((p) => fetch(`${base}${p}`))).health.find((b) => b.id === "twitch");
  try {
    const a = await server.conn(1);
    const b = await server.conn(2);
    server.welcome(a, "s1");
    server.welcome(b, "s2"); // both sessions up
    await until(() => twitch.posts.filter((p) => p.session === "s2").length === 6, "session 2's six subscriptions");
    expect(await outage()).toBeUndefined();

    const cfg = (await (await fetch(`${base}/api/config`)).json()) as { config: ReturnType<typeof defaultConfig> };
    cfg.config.ingest.twitch.sessions = 1;
    expect((await post(booted.ports.streamer, "/api/config", cfg.config, "PUT")).status).toBe(200);

    const start = await fetch(`${base}/auth/twitch/broadcaster`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${base}/auth/twitch/callback?code=abc&state=${state}`, { redirect: "manual", headers: { cookie } })).status).toBe(302);

    await server.conn(3); // the restarted client's only session: never welcomed, so it is never up
    await until(() => a.closed && b.closed, "the old sockets to close");
    await until(async () => (await outage()) !== undefined, "the outage line after the grace", 2000);
    expect(await outage()).toMatchObject({ level: "warn", text: expect.stringContaining("Twitch EventSub: all sessions disconnected") });
  } finally {
    await booted.stop();
    server.stop();
  }
});

test("acceptance: with user:read:chat, a chat message from a new account → six subscriptions up, one Get Users call, a `chatters` message with the person and their picture; a second message → `chat-hop`; the Ledger is untouched, no chat banner, the id and login stay on the server", async () => {
  const server = fakeEventSub();
  const twitch = fakeTwitch(server.subscriptionsUrl, { scopes: () => [...MONEY_SCOPES, CHAT_SCOPE], users: [COOL_USER] });
  const booted = await boot({ dataDir: linkedDataDir({ eventsubUrl: server.url }), ports: EPHEMERAL, log: () => {}, fetchImpl: twitch.fetchImpl });
  const api = (p: string) => fetch(`http://127.0.0.1:${booted.ports.streamer}${p}`);
  const overlay = await attachOverlay(booted.ports.overlay);
  try {
    const snap = await overlay.next("snapshot", 2000);
    if (snap.type !== "snapshot") throw new Error(snap.type);
    expect(snap.chatters).toEqual([]);
    const a = await server.conn(1);
    server.welcome(a, "s1");
    await until(() => twitch.posts.length >= 6, "the six subscriptions");
    expect(twitch.posts.map((p) => p.type).sort()).toEqual(["channel.bits.use", "channel.chat.message", "channel.cheer", "channel.subscribe", "channel.subscription.gift", "channel.subscription.message"]);
    const before = (await entriesOf(api)).length;

    server.chat(a, "m1");
    const roster = await overlay.next("chatters", 3000); // the 500 ms batch, then the picture
    if (roster.type !== "chatters") throw new Error(roster.type);
    expect(roster.chatters).toEqual([{ key: chatterKey("1234"), name: "Cool_User", avatarUrl: "https://static-cdn.jtvnw.net/jtv_user_pictures/cool-profile_image-150x150.png", firstSeenMs: expect.any(Number), lastSeenMs: expect.any(Number) }]);
    expect(twitch.lookups).toEqual(["https://api.twitch.tv/helix/users?id=1234"]);

    server.chat(a, "m2");
    const hop = await overlay.next("chat-hop", 3000);
    expect(hop).toEqual({ type: "chat-hop", key: chatterKey("1234") });
    expect(twitch.lookups).toHaveLength(1); // present already: no lookup

    expect((await entriesOf(api)).length).toBe(before); // presence, never Progress
    const { health } = await stateOf(api);
    expect(health.find((b) => b.id === CHAT_UNHEARD)).toBeUndefined();
    expect(JSON.stringify([roster, hop])).not.toMatch(/chatter_user|"1234"|cool_user|hello/);
  } finally {
    overlay.close();
    await booted.stop();
    server.stop();
  }
});

test("optionsFromEnv: VERBOSE=1 turns verbose on alone; DEBUG=1 turns both on; neither (or any other value) leaves both off", () => {
  expect(optionsFromEnv({ VERBOSE: "1" })).toMatchObject({ verbose: true, debug: false });
  expect(optionsFromEnv({ DEBUG: "1" })).toMatchObject({ verbose: true, debug: true });
  expect(optionsFromEnv({ VERBOSE: "1", DEBUG: "1" })).toMatchObject({ verbose: true, debug: true });
  expect(optionsFromEnv({})).toMatchObject({ verbose: false, debug: false });
  expect(optionsFromEnv({ VERBOSE: "true", DEBUG: "yes" })).toMatchObject({ verbose: false, debug: false });
});

test("bun src/main.ts: boots from DATA_DIR, logs the listening line, answers /api/state, exits 0 on SIGTERM within 3 s", async () => {
  const dataDir = tmpDir();
  const config = defaultConfig();
  config.listeners = { ...config.listeners, ...freePorts(), bindAll: false };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));

  // Only DATA_DIR from us: the child must never see this shell's SECRETS_FILE / CONFIG_FILE / LEDGER_FILE / BIND_ALL.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["SECRETS_FILE", "CONFIG_FILE", "LEDGER_FILE", "BIND_ALL", "DATA_DIR"].includes(k)));
  const child = Bun.spawn(["bun", "src/main.ts"], { cwd: REPO, env: { ...env, DATA_DIR: dataDir }, stdout: "pipe", stderr: "pipe" });

  let out = "";
  const stderr = new Response(child.stderr).text();
  // A child that dies before the listening line fails right away with its stderr — not as a silent timeout 10 s later.
  const listening = new Promise<string>((resolve, reject) => {
    const fail = (why: string) => void stderr.then((err) => reject(new Error(`${why}; stdout so far:\n${out}\nstderr:\n${err}`)));
    const timer = setTimeout(() => fail("no listening line within 10 s"), 10_000);
    (async () => {
      const reader = child.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          return fail(`child exited (code ${await child.exited}) before the listening line`);
        }
        out += new TextDecoder().decode(value);
        const m = /^listening (.*)$/m.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      }
    })().catch(reject);
  });

  try {
    const line = await listening;
    expect(line).toBe(`streamer=127.0.0.1:${config.listeners.streamerPort} funnel=127.0.0.1:${config.listeners.funnelPort} overlay=127.0.0.1:${config.listeners.overlayPort}`); // OBS on the same computer is the default
    expect(out).toContain(`twitch-party-overlay ${version()}`);
    expect(out).toContain(`replayed ${1 + config.outcomes.length} entries`); // the threshold seed plus one stock seed per Outcome
    expect((await fetch(`http://127.0.0.1:${config.listeners.streamerPort}/api/state`)).status).toBe(200);
  } finally {
    child.kill("SIGTERM");
  }
  const exited = await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout" as const)]);
  expect(exited).toBe(0);
  expect(await stderr).toBe("");
});

// main(): process wiring with a fake process — the rejection guard is up before boot (Bun exits 1 on an unhandled rejection),
// and a stop that hangs cannot keep the process alive past the hard-exit fallback.

function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const proc = { on: (event: string, fn: (...args: unknown[]) => void) => emitter.on(event, fn), exit: (code?: number) => void exits.push(code ?? 0) };
  return { proc, exits, emit: (event: string, ...args: unknown[]) => emitter.emit(event, ...args), listeners: (event: string) => emitter.listenerCount(event) };
}

test("main: the unhandledRejection handler is registered before boot runs and logs the rejection instead of exiting", async () => {
  const p = fakeProcess();
  const errors: string[] = [];
  let listenersAtBoot = -1;
  await main({}, {
    boot: async () => {
      listenersAtBoot = p.listeners("unhandledRejection");
      return { stop: async () => {} };
    },
    proc: p.proc,
    log: () => {},
    error: (line) => void errors.push(line),
  });
  expect(listenersAtBoot).toBe(1);
  p.emit("unhandledRejection", new Error("adapter call nobody awaited"));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("unhandled rejection: Error: adapter call nobody awaited");
  expect(p.exits).toEqual([]);
});

test("main: SIGTERM stops and exits 0 once; a stop that hangs is hard-exited with 1 after the fallback delay", async () => {
  const clean = fakeProcess();
  let stops = 0;
  await main({}, { boot: async () => ({ stop: async () => void stops++ }), proc: clean.proc, log: () => {}, error: () => {}, hardExitMs: 30 });
  clean.emit("SIGTERM");
  clean.emit("SIGINT"); // a second signal while stopping is ignored
  await Bun.sleep(80); // past the fallback delay: the timer must have been cleared by the clean exit
  expect(stops).toBe(1);
  expect(clean.exits).toEqual([0]);

  const hung = fakeProcess();
  await main({}, { boot: async () => ({ stop: () => new Promise<void>(() => {}) }), proc: hung.proc, log: () => {}, error: () => {}, hardExitMs: 30 });
  hung.emit("SIGINT");
  expect(hung.exits).toEqual([]);
  await Bun.sleep(80);
  expect(hung.exits).toEqual([1]);
});

test("main: the Dashboard's Shut down button reaches boot as onShutdownRequest and runs the same stop + exit(0) path as a signal, once", async () => {
  const p = fakeProcess();
  const logs: string[] = [];
  let stops = 0;
  let hook: ((source: string) => void) | undefined;
  await main({}, {
    boot: async (opts) => {
      hook = opts.onShutdownRequest;
      return { stop: async () => void stops++ };
    },
    proc: p.proc,
    log: (line) => void logs.push(line),
    error: () => {},
    hardExitMs: 30,
  });
  expect(hook).toBeDefined();
  hook!("dashboard");
  p.emit("SIGTERM"); // the container's stop arriving on top is ignored: already stopping
  await Bun.sleep(80);
  expect(stops).toBe(1);
  expect(p.exits).toEqual([0]);
  expect(logs).toContain("dashboard: stopping");
});

test("main: a shutdown request that lands while boot is still returning is not lost", async () => {
  const p = fakeProcess();
  let stops = 0;
  await main({}, {
    boot: async (opts) => {
      opts.onShutdownRequest?.("dashboard"); // the listeners are up before boot() resolves: a click can beat main's wiring
      return { stop: async () => void stops++ };
    },
    proc: p.proc,
    log: () => {},
    error: () => {},
    hardExitMs: 30,
  });
  await Bun.sleep(20);
  expect(stops).toBe(1);
  expect(p.exits).toEqual([0]);
});

// main(): the compiled download opens the Dashboard and keeps the machine awake; source mode and Docker do neither.

const COMPILED = { platform: "darwin" as const, execPath: "/Users/me/Downloads/twitch-party-overlay-macos-apple-silicon", cwd: "/Users/me" };
const SOURCE = { platform: "darwin" as const, execPath: "/Users/me/.bun/bin/bun", cwd: "/Users/me/repos/overlay" };

function fakeSpawn() {
  const spawned: string[][] = [];
  const killed: string[] = [];
  const spawn = (argv: string[]) => {
    spawned.push(argv);
    return { kill: () => void killed.push(argv[0]!) };
  };
  return { spawn, spawned, killed };
}

test("main: prints the resolved data folder — beside the binary when compiled, ./data under the working directory from source — and hands it to boot", async () => {
  for (const [rt, expected] of [
    [COMPILED, "/Users/me/Downloads/data"],
    [SOURCE, "/Users/me/repos/overlay/data"],
  ] as const) {
    const p = fakeProcess();
    const logs: string[] = [];
    let dataDir = "";
    await main({ NO_OPEN: "1" }, { boot: async (opts) => ((dataDir = opts.dataDir), { stop: async () => {} }), proc: p.proc, log: (l) => void logs.push(l), error: () => {}, runtime: rt, spawn: () => ({ kill() {} }), has: () => true, exists: () => false });
    expect(dataDir).toBe(expected);
    expect(logs).toContain(`data folder: ${expected}`);
  }
});

test("main (compiled, outside Docker): starts the keep-awake child, opens the Dashboard on the streamer port once the listeners are up, and kills the helpers on shutdown", async () => {
  const p = fakeProcess();
  const { spawn, spawned, killed } = fakeSpawn();
  const logs: string[] = [];
  await main({}, { boot: async () => ({ stop: async () => {}, ports: { streamer: 8700, funnel: 8701, overlay: 8702 } }), proc: { ...p.proc, pid: 777 }, log: (l) => void logs.push(l), error: () => {}, runtime: COMPILED, spawn, has: () => true, exists: () => false, hardExitMs: 30 });
  expect(spawned).toEqual([
    ["caffeinate", "-dis", "-w", "777"],
    ["open", "http://localhost:8700/"],
  ]);
  expect(logs).toContain("opening http://localhost:8700/ in your browser (NO_OPEN=1 turns this off)");
  p.emit("SIGINT");
  await Bun.sleep(20);
  expect(killed).toEqual(["caffeinate", "open"]);
  expect(p.exits).toEqual([0]);
});

test("main (compiled): NO_OPEN=1 keeps the browser shut but still keeps the machine awake; a missing helper is one log line, not a failure", async () => {
  const p = fakeProcess();
  const logs: string[] = [];
  await main({ NO_OPEN: "1" }, {
    boot: async () => ({ stop: async () => {}, ports: { streamer: 8700, funnel: 8701, overlay: 8702 } }),
    proc: p.proc,
    log: (l) => void logs.push(l),
    error: () => {},
    runtime: { ...COMPILED, platform: "linux" },
    spawn: (argv) => {
      throw new Error(`ENOENT: ${argv[0]}`);
    },
    has: () => true,
    exists: () => false,
  });
  expect(logs.filter((l) => l.startsWith("opening"))).toEqual([]);
  expect(logs).toContain("keep awake: could not run systemd-inhibit (ENOENT: systemd-inhibit); carrying on without it");
  expect(p.exits).toEqual([]);
});

test("main: from source, or in Docker (IN_DOCKER=1 or /.dockerenv), nothing is spawned", async () => {
  for (const [env, rt, exists] of [
    [{}, SOURCE, () => false],
    [{ IN_DOCKER: "1" }, COMPILED, () => false],
    [{}, COMPILED, (f: string) => f === "/.dockerenv"],
  ] as const) {
    const p = fakeProcess();
    const { spawn, spawned } = fakeSpawn();
    await main(env, { boot: async () => ({ stop: async () => {}, ports: { streamer: 8700, funnel: 8701, overlay: 8702 } }), proc: p.proc, log: () => {}, error: () => {}, runtime: rt, spawn, has: () => true, exists });
    expect(spawned).toEqual([]);
  }
});

test("main: SIGBREAK (Ctrl-Break on Windows) and SIGHUP (the console closing) stop and exit 0 like SIGINT", async () => {
  for (const signal of ["SIGBREAK", "SIGHUP"]) {
    const p = fakeProcess();
    let stops = 0;
    await main({}, { boot: async () => ({ stop: async () => void stops++ }), proc: p.proc, log: () => {}, error: () => {}, runtime: SOURCE, hardExitMs: 30 });
    p.emit(signal);
    await Bun.sleep(20);
    expect(stops).toBe(1);
    expect(p.exits).toEqual([0]);
  }
});
