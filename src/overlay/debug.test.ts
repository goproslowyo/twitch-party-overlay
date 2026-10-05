import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config/schema.ts";
import { LOCKED_GLYPH, type OverlayMessage, type OverlayOutcome, type OverlaySkin, type OverlayState } from "../server/overlay.ts";
import { READOUT_EVERY_MS, creditedCents, fakeContribution, fakeDrained, fakeFire, fakeRestock, fakeSkin, fakeTierOpen, fakeUnlock, fakeValve, forcedLevel, mountDebug, qualityReadoutText, type QualityReadout } from "./debug.ts";
import { LEVELS, QualityController } from "./quality.ts";
import { OverlayModel } from "./state.ts";
import { avatarFor } from "./theme.ts";

const base = defaultConfig();
const theme = base.themes["club-deck"]!;

function snapshotState(): OverlayState {
  const outcomes: OverlayOutcome[] = base.outcomes.map((o) => ({ id: o.id, name: o.tier === 0 ? o.name : null, nameLength: o.name.length, glyph: o.tier === 0 ? o.glyph : LOCKED_GLYPH, shape: o.shape, tier: o.tier, left: o.initialLeft, used: 0, status: "live" }));
  return { thresholdCents: 5000, progressCents: 1300, queue: 0, bankedTotal: 0, tier: 0, gates: [0, 3, 6], outcomes, drained: false, motes: { collecting: [], ready: [] } };
}

interface FakeEl {
  tag: string;
  id: string;
  className: string;
  type: string;
  textContent: string;
  children: FakeEl[];
  listeners: Partial<Record<string, () => void>>;
  appendChild(child: FakeEl): FakeEl;
  addEventListener(name: string, fn: () => void): void;
}

/** The least Document `mountDebug` needs: elements that remember their children, listeners, and text. */
function fakeDoc(): { doc: Document; body: FakeEl } {
  const createElement = (tag: string): FakeEl => {
    const el: FakeEl = {
      tag,
      id: "",
      className: "",
      type: "",
      textContent: "",
      children: [],
      listeners: {},
      appendChild(child) {
        el.children.push(child);
        return child;
      },
      addEventListener(name, fn) {
        el.listeners[name] = fn;
      },
    };
    return el;
  };
  const body = { ...createElement("body"), classList: { toggle: () => false } };
  return { doc: { createElement, body } as unknown as Document, body };
}

describe("debug.ts — fake overlay messages, client-side only", () => {
  test("creditedCents: the default policy (tips in full, 1¢ a bit, sub rates, gifts × rate)", () => {
    expect(creditedCents({ kind: "tip", cents: 1500 })).toBe(1500);
    expect(creditedCents({ kind: "bits", bits: 10_000 })).toBe(10_000);
    expect(creditedCents({ kind: "sub", tier: "2000" })).toBe(350);
    expect(creditedCents({ kind: "gift", tier: "1000", count: 25 })).toBe(5000);
  });

  test("tip $15 from $13: no crossing, progress $28, nothing else moves; the input state is untouched", () => {
    const s = snapshotState();
    const m = fakeContribution(s, theme, { kind: "tip", cents: 1500 }, "streamelements", "alice");
    if (m.type !== "contribution") throw new Error(m.type);
    expect(m).toMatchObject({ displayName: "alice", anonymous: false, avatar: avatarFor("alice", theme), faceValueCents: 1500, progressCents: 1500, unlocksBanked: 0, tiersOpened: [] });
    expect(m.state).toMatchObject({ progressCents: 2800, queue: 0, bankedTotal: 0, tier: 0 });
    expect(m.avatarUrl).toBeNull();
    expect(s.progressCents).toBe(1300);
  });

  test("10k bits from $13: two Unlocks, $13 left, nobody seated anywhere (the standard test sequence)", () => {
    const m = fakeContribution(snapshotState(), theme, { kind: "bits", bits: 10_000 }, "twitch", "bob");
    if (m.type !== "contribution") throw new Error(m.type);
    expect(m).toMatchObject({ unlocksBanked: 2, tiersOpened: [], progressCents: 10_000, faceValueCents: 10_000 });
    expect(m.state).toMatchObject({ progressCents: 1300, queue: 2, bankedTotal: 2, tier: 0 });
    expect("cabin" in m.state).toBe(false);
    expect(JSON.stringify(m.state)).not.toContain("bob");
  });

  test("a crossing that reaches a gate opens the tier and unmasks its outcomes (named after their ids — the client never knew them)", () => {
    const m = fakeContribution(snapshotState(), theme, { kind: "tip", cents: 15_000 }, "streamelements", null);
    if (m.type !== "contribution") throw new Error(m.type);
    expect(m).toMatchObject({ anonymous: true, displayName: null, avatar: avatarFor(null, theme), unlocksBanked: 3, tiersOpened: [1] });
    expect(m.state.tier).toBe(1);
    const roulette = m.state.outcomes.find((o) => o.id === "genre-roulette")!;
    expect(roulette.name).toBe("GENRE ROULETTE");
    expect(roulette.glyph).not.toBe(LOCKED_GLYPH);
    expect(m.state.outcomes.find((o) => o.id === "pie-to-the-face")!.name).toBeNull();
  });

  test("+unlock: a queue_adjust with nobody behind it; three of them open Tier 1", () => {
    let s = snapshotState();
    for (let i = 0; i < 2; i++) {
      const m = fakeUnlock(s);
      if (m.type !== "state") throw new Error(m.type);
      expect(m.tiersOpened).toEqual([]);
      s = m.state;
    }
    const m = fakeUnlock(s);
    if (m.type !== "state") throw new Error(m.type);
    expect(m).toMatchObject({ reason: "queue_adjust", tiersOpened: [1] });
    expect(m.state).toMatchObject({ queue: 3, bankedTotal: 3, tier: 1 });
    expect("cabin" in m.state).toBe(false);
  });

  test("fire: a live outcome goes left −1 / used +1 (odds ∝ left), the queue shrinks, drained when nothing live is left; null with nothing to fire or an empty queue", () => {
    const seeded = { ...snapshotState(), queue: 1, bankedTotal: 1 };
    const m = fakeFire(seeded, 7, () => 0); // rng 0 → the first live outcome: stickers
    if (m === null || m.type !== "fire") throw new Error(String(m?.type));
    expect(m).toMatchObject({ fireSeq: 7, outcomeId: "stickers", solo: null, group: [], stockAfter: 4 });
    expect(m.state).toMatchObject({ queue: 0, drained: false });
    expect(m.state.outcomes.find((o) => o.id === "stickers")!).toMatchObject({ left: 4, used: 1 });
    expect(seeded.outcomes.find((o) => o.id === "stickers")!).toMatchObject({ left: 5, used: 0 });

    const oneLeft = { ...snapshotState(), queue: 1, outcomes: snapshotState().outcomes.map((o) => ({ ...o, left: o.id === "shirt-t0" ? 1 : 0 })) };
    const last = fakeFire(oneLeft, 8, () => 0.99);
    if (last === null || last.type !== "fire") throw new Error("expected a fire");
    expect(last).toMatchObject({ outcomeId: "shirt-t0", solo: null, stockAfter: 0 });
    expect(last.state.drained).toBe(true);
    expect(fakeFire(last.state, 9)).toBeNull();
    expect(fakeFire(snapshotState(), 10, () => 0)).toBeNull(); // live stock but an empty queue: the Engine rejects that fire, so the bar must not fake one
  });

  test("fire: a mini-draw outcome (genre roulette, chat-rule draw) carries a miniDraw with the default list and a pick from it", () => {
    const seeded = { ...snapshotState(), queue: 1, tier: 1, bankedTotal: 3 };
    seeded.outcomes = seeded.outcomes.map((o) => (o.tier <= 1 ? { ...o, name: o.id.toUpperCase(), glyph: "🎁" } : o));
    const live = seeded.outcomes.filter((o) => o.tier <= 1 && o.status === "live" && o.left > 0);
    const before = live.slice(0, live.findIndex((o) => o.id === "genre-roulette")).reduce((a, o) => a + o.left, 0);
    const total = live.reduce((a, o) => a + o.left, 0);
    const lists = defaultConfig().lists;
    const draws = [(before + 0.5) / total, 0.99];
    const m = fakeFire(seeded, 3, () => draws.shift() ?? 0)!;
    expect(m.type).toBe("fire");
    if (m.type !== "fire") return;
    expect(m.outcomeId).toBe("genre-roulette");
    expect(m.miniDraw).toEqual({ title: "GENRE ROULETTE · 10–15 MIN", list: lists.genreRoulette, pick: lists.genreRoulette[lists.genreRoulette.length - 1]! });
    const plain = fakeFire(seeded, 4, () => 0)!;
    expect(plain.type === "fire" && "miniDraw" in plain).toBe(false);
  });

  test("valve: the next lower suggested Threshold; Progress already past it banks at once", () => {
    const m = fakeValve({ ...snapshotState(), progressCents: 4000 });
    if (m.type !== "state") throw new Error(m.type);
    expect(m.reason).toBe("threshold");
    expect(m.state).toMatchObject({ thresholdCents: 3500, progressCents: 500, queue: 1, bankedTotal: 1 });
    const floor = fakeValve({ ...snapshotState(), thresholdCents: 1000 });
    if (floor.type !== "state") throw new Error(floor.type);
    expect(floor.state.thresholdCents).toBe(1000);
  });

  test("restock, tier open, drained", () => {
    const drained = fakeDrained(snapshotState());
    if (drained.type !== "state") throw new Error(drained.type);
    expect(drained.state.drained).toBe(true);
    expect(drained.state.outcomes.filter((o) => o.tier === 0).every((o) => o.left === 0)).toBe(true);
    expect(drained.state.outcomes.find((o) => o.id === "stickers")).toMatchObject({ left: 0, used: 5 }); // fired dry: the pips stay, all dimmed
    expect(drained.state.outcomes.find((o) => o.id === "shirt-t1")).toMatchObject({ left: 2, used: 0 }); // locked stock is untouched

    const restocked = fakeRestock(drained.state);
    if (restocked.type !== "state") throw new Error(restocked.type);
    expect(restocked.state.drained).toBe(false);
    // a restock re-arms what was used and leaves `used` alone — the Engine's restock never rewrites history
    expect(restocked.state.outcomes.map((o) => [o.left, o.used])).toEqual(drained.state.outcomes.map((o) => [o.left + o.used, o.used]));

    const open = fakeTierOpen(snapshotState());
    if (open === null || open.type !== "state") throw new Error("expected a state");
    expect(open).toMatchObject({ reason: "tier_adjust", tiersOpened: [1] });
    expect(open.state).toMatchObject({ tier: 1, bankedTotal: 3 });
    expect(open.state.outcomes.find((o) => o.id === "genre-roulette")!.name).toBe("GENRE ROULETTE");
    const two = fakeTierOpen(open.state);
    if (two === null || two.type !== "state") throw new Error("expected a state");
    expect(two.state.tier).toBe(2);
    expect(fakeTierOpen(two.state)).toBeNull();
  });

  test("theme swap: the other built-in theme, config untouched", () => {
    const skin: OverlaySkin = { config: base.overlay, theme, channelName: "dj", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } };
    const m = fakeSkin(skin);
    if (m.type !== "skin") throw new Error(m.type);
    expect(m.skin.theme.name).toBe(base.themes["duck-farm"]!.name);
    expect(m.skin.config).toBe(base.overlay);
    const back = fakeSkin(m.skin);
    if (back.type !== "skin") throw new Error(back.type);
    expect(back.skin.theme.name).toBe(theme.name);
  });

  test("the bar: one button per fake plus step, a clock that reads the loop after every click, the quality readout (refreshed on click and on its timer), and 'fire' with an empty queue injects nothing", () => {
    const injected: OverlayMessage[] = [];
    let now = 1000;
    const { doc, body } = fakeDoc();
    const skin: OverlaySkin = { config: base.overlay, theme, channelName: "dj", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } };
    let quality: QualityReadout = { level: 5, missRatio: 0, meanIntervalMs: 0, meanWorkMs: 0, stable: true, lastChange: null, mode: "auto", webgl: false };
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const bar = mountDebug({ inject: (m) => void injected.push(m), step: (dt) => void (now += dt), state: snapshotState, skin: () => skin, nowMs: () => now, quality: () => quality }, doc, (fn, ms) => void timers.push({ fn, ms })) as unknown as FakeEl;
    expect(body.children).toEqual([bar]);
    const buttons = bar.children.filter((c) => c.tag === "button");
    expect(buttons.map((b) => b.textContent)).toEqual(["tip $3", "tip $15", "500 bits", "10k bits", "tip $40", "25 gifts", "+unlock", "fire", "valve", "restock", "tier open", "drained", "theme swap", "hide chrome", "step 100ms"]);
    const clock = bar.children.at(-1)!;
    expect(clock).toMatchObject({ tag: "span", className: "clock", textContent: "t=1000" });
    const readout = bar.children.at(-2)!;
    expect(readout).toMatchObject({ tag: "span", className: "quality", textContent: "fps — · work — · miss 0 % · L5 auto · WebGL off" });
    const click = (label: string): void => buttons.find((b) => b.textContent === label)!.listeners.click!();
    click("fire");
    expect(injected).toEqual([]); // the snapshot's queue is empty
    click("step 100ms");
    expect(clock.textContent).toBe("t=1100");
    click("tip $15");
    expect(injected.map((m) => m.type)).toEqual(["contribution"]);
    quality = { level: 4, missRatio: 0.031, meanIntervalMs: 16.7, meanWorkMs: 7.6, stable: false, lastChange: "down", mode: "auto", webgl: true };
    expect(readout.textContent).toBe("fps — · work — · miss 0 % · L5 auto · WebGL off"); // until a refresh
    expect(timers).toEqual([{ fn: expect.any(Function), ms: READOUT_EVERY_MS }]);
    timers[0]!.fn();
    expect(readout.textContent).toBe("fps 60 · work 8 ms · miss 3 % · L4 auto · WebGL on");
    quality = { ...quality, level: 2, mode: "manual", meanIntervalMs: 50, meanWorkMs: 31.2 };
    click("step 100ms");
    expect(readout.textContent).toBe("fps 20 · work 31 ms · miss 3 % · L2 manual · WebGL on");
  });

  test("?quality=N forces a Level (1..5 only); main.ts hands it to the controller in debug mode alone, where it beats the setting", () => {
    expect(forcedLevel(new URLSearchParams("debug=1&quality=2"))).toBe(2);
    expect(forcedLevel(new URLSearchParams("quality=5"))).toBe(5);
    for (const q of ["", "quality=", "quality=0", "quality=6", "quality=auto", "quality=2.5", "quality=22", "quality=-1"]) expect(forcedLevel(new URLSearchParams(q))).toBeNull();
    const debug = new QualityController(() => "auto", forcedLevel(new URLSearchParams("debug=1&quality=2")));
    expect(debug.spec).toBe(LEVELS[2]);
    expect(debug.mode).toBe("manual");
    const plain = new QualityController(() => "auto", null); // not debug: the same URL forces nothing
    expect(plain.spec).toBe(LEVELS[5]);
    expect(qualityReadoutText({ level: 2, missRatio: 0, meanIntervalMs: 0, meanWorkMs: 0, stable: true, lastChange: null, mode: "manual", webgl: false })).toBe("fps — · work — · miss 0 % · L2 manual · WebGL off");
  });

  test("the fakes drive the real model through the standard test sequence: FULL ×2 → +2 UNLOCKS → $13 of $50", () => {
    const model = new OverlayModel(base.overlay);
    const skin: OverlaySkin = { config: base.overlay, theme, channelName: "dj", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } };
    model.apply({ type: "snapshot", state: snapshotState(), skin, chatters: [] }, 0);
    const fx = model.apply(fakeContribution(snapshotState(), theme, { kind: "bits", bits: 10_000 }, "twitch", "bob"), 1000);
    expect(fx.map((e) => e.kind)).toEqual(["thank", "celebrate", "full"]);
    expect(model.view).toMatchObject({ progressDisplayCents: 5000, fullCount: 2, queue: 0 });
    expect(model.tick(1000 + base.overlay.fullHoldBigMs - 1)).toEqual([]);
    expect(model.tick(1000 + base.overlay.fullHoldBigMs)).toEqual([{ kind: "unlock_stinger", count: 2 }]);
    expect(model.view).toMatchObject({ progressDisplayCents: 1300, fullCount: 0, queue: 2 });
    expect("cabin" in model.view).toBe(false);
  });
});
