import { describe, expect, spyOn, test } from "bun:test";
import { defaultConfig } from "../config/schema.ts";
import type { Chatter, Mote, OverlayMessage, OverlayOutcome, OverlaySkin, OverlayState } from "../server/overlay.ts";
import { thankDwellMs } from "./celebration.ts";
import { fullLabel, unlockStinger } from "./copy.ts";
import { OverlayModel, TIER_STAGGER_MS, tryApply, type Effect } from "./state.ts";

const base = defaultConfig();
const cfg = base.overlay; // fullHoldMs 900, fullHoldBigMs 1700, bigIntensity 0.6, justRevealedMs 25000, anchor $600
const theme = base.themes["club-deck"]!;
const skin: OverlaySkin = { config: cfg, theme, channelName: "dj", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } };

type Contribution = Extract<OverlayMessage, { type: "contribution" }>;
type Fire = Extract<OverlayMessage, { type: "fire" }>;

const outcome = (id: string, name: string, tier: number, left: number, open: boolean): OverlayOutcome => ({
  id,
  name: open ? name : null,
  nameLength: name.length,
  glyph: open ? "🎟️" : "🔒",
  shape: "giveaway",
  tier,
  left,
  used: 0,
  status: "live",
});

/** An overlay state as the server projects it: outcomes above `tier` travel masked. */
function st(over: Partial<OverlayState> = {}): OverlayState {
  const tier = over.tier ?? 0;
  return {
    thresholdCents: 5000,
    progressCents: 1300,
    queue: 0,
    bankedTotal: 0,
    tier,
    gates: [0, 3, 6],
    outcomes: [outcome("stickers", "STICKERS", 0, 5, true), outcome("shirt-t1", "SHIRT", 1, 2, tier >= 1), outcome("pie-to-the-face", "PIE TO THE FACE", 2, 1, tier >= 2)],
    drained: false,
    motes: { collecting: [], ready: [] },
    ...over,
  };
}

const contribution = (over: Partial<Contribution> = {}): Contribution => ({
  type: "contribution",
  source: "streamelements",
  displayName: "alice",
  anonymous: false,
  avatar: "🎧",
  avatarUrl: null,
  face: { kind: "tip", cents: 1500 },
  faceValueCents: 1500,
  progressCents: 1500,
  unlocksBanked: 0,
  tiersOpened: [],
  state: st(),
  ...over,
});

const fire = (over: Partial<Fire> = {}): Fire => ({ type: "fire", fireSeq: 9, outcomeId: "stickers", solo: null, group: [], stockAfter: 4, state: st(), ...over });

const kinds = (fx: Effect[]): string[] => fx.map((e) => e.kind);
const names = (m: OverlayModel): Array<string | null> => m.view.outcomes.map((o) => o.name);

/** A model that has seen its snapshot at t=0. */
function model(): OverlayModel {
  const m = new OverlayModel(cfg);
  m.apply({ type: "snapshot", state: st(), skin, chatters: [] }, 0);
  return m;
}

describe("snapshot", () => {
  test("skin + resync; the view adopts the state and shows the real progress", () => {
    const m = new OverlayModel(cfg);
    expect(m.view).toEqual({ thresholdCents: 0, progressDisplayCents: 0, fullCount: 0, queue: 0, bankedTotal: 0, tier: 0, gates: [], outcomes: [], drained: false, justRevealed: [], motes: { collecting: [], ready: [] }, chatters: [] });
    const fx = m.apply({ type: "snapshot", state: st({ progressCents: 1300, queue: 2, bankedTotal: 2 }), skin, chatters: [] }, 1000);
    expect(fx).toEqual([{ kind: "skin", skin }, { kind: "resync" }]);
    expect(m.view).toMatchObject({ thresholdCents: 5000, progressDisplayCents: 1300, fullCount: 0, queue: 2, bankedTotal: 2, tier: 0, gates: [0, 3, 6], drained: false, justRevealed: [] });
    expect("cabin" in m.view).toBe(false);
    expect(names(m)).toEqual(["STICKERS", null, null]);
  });

  test("a snapshot during a FULL hold (reconnect) replaces everything: no stinger owed, no reveal queued", () => {
    const m = model();
    m.apply(contribution({ unlocksBanked: 1, tiersOpened: [1], state: st({ progressCents: 300, queue: 1, bankedTotal: 3, tier: 1 }) }), 0);
    const fx = m.apply({ type: "snapshot", state: st({ progressCents: 300, queue: 1, bankedTotal: 3, tier: 1 }), skin, chatters: [] }, 100);
    expect(kinds(fx)).toEqual(["skin", "resync"]);
    expect(m.view).toMatchObject({ progressDisplayCents: 300, fullCount: 0, tier: 1 });
    expect(names(m)).toEqual(["STICKERS", "SHIRT", null]);
    expect(m.tick(5000)).toEqual([]);
  });
});

describe("contribution", () => {
  test("without a crossing: thank + celebrate, the state adopted at once", () => {
    const m = model();
    const fx = m.apply(contribution({ state: st({ progressCents: 2800 }) }), 5000);
    expect(kinds(fx)).toEqual(["thank", "celebrate"]);
    const thank = fx[0] as Extract<Effect, { kind: "thank" }>;
    expect(thank.html).toBe("✦ 🎧 <b>@alice</b> tipped $15 — thank you ✦");
    expect(thank.intensity).toBeCloseTo(0.42, 2);
    expect(thank.dwellMs).toBe(thankDwellMs(thank.intensity, cfg));
    expect(fx[1]).toEqual({ kind: "celebrate", intensity: thank.intensity, face: { kind: "tip", cents: 1500 }, source: "streamelements", name: "alice" });
    expect(m.view).toMatchObject({ progressDisplayCents: 2800, fullCount: 0 });
  });

  test("an Avatar Picture on the message reaches the thank line as <img class=\"pic\">; the celebration still names by display name", () => {
    const m = new OverlayModel(cfg);
    const url = "https://static-cdn.jtvnw.net/jtv_user_pictures/aaaa-profile_image-150x150.png";
    const fx = m.apply(contribution({ avatarUrl: url }), 0);
    const thank = fx[0] as Extract<Effect, { kind: "thank" }>;
    expect(thank.html).toBe(`✦ <img class="pic" src="${url}" data-glyph="🎧" alt=""> <b>@alice</b> tipped $15 — thank you ✦`);
    expect(fx[1]).toMatchObject({ kind: "celebrate", name: "alice" });
    // anonymous with a URL (the server never sends one): the glyph, as today
    const anon = m.apply(contribution({ displayName: null, anonymous: true, avatar: "🥁", avatarUrl: url }), 0);
    expect((anon[0] as Extract<Effect, { kind: "thank" }>).html).toBe("✦ 🥁 <b>Anonymous</b> tipped $15 — thank you ✦");
  });

  test("anonymous: no @ in the thank line, no name for the celebration", () => {
    const m = model();
    const fx = m.apply(contribution({ displayName: null, anonymous: true, avatar: "🥁", face: { kind: "bits", bits: 500 }, faceValueCents: 500 }), 0);
    expect((fx[0] as Extract<Effect, { kind: "thank" }>).html).toBe("✦ 🥁 <b>Anonymous</b> cheered 500 bits — thank you ✦");
    expect(fx[1]).toMatchObject({ kind: "celebrate", name: null });
  });

  test("a Ko-fi contribution (by its source) is acknowledged as donated on Ko-fi", () => {
    const m = model();
    const fx = m.apply(contribution({ source: "kofi", face: { kind: "tip", cents: 1000 }, faceValueCents: 1000 }), 0);
    expect((fx[0] as Extract<Effect, { kind: "thank" }>).html).toBe("✦ 🎧 <b>@alice</b> donated $10 on Ko-fi — thank you ✦");
    expect(fx[1]).toMatchObject({ kind: "celebrate", source: "kofi" }); // the big-moment stinger words it the same way
  });

  test("a crossing: FULL at the threshold, nothing until fullHoldMs, then the stinger and the drop to the remainder", () => {
    const m = model();
    const after = st({ progressCents: 300, queue: 1, bankedTotal: 1 });
    const fx = m.apply(contribution({ face: { kind: "tip", cents: 4000 }, faceValueCents: 4000, progressCents: 4000, unlocksBanked: 1, state: after }), 10_000);
    expect(kinds(fx)).toEqual(["thank", "celebrate", "full"]);
    expect(fx[2]).toEqual({ kind: "full", count: 1, untilMs: 10_900 });
    expect(m.view).toMatchObject({ progressDisplayCents: 5000, thresholdCents: 5000, fullCount: 1, queue: 0 }); // READY moves with the stinger, not before
    expect(fullLabel(m.view.fullCount)).toBe("FULL");
    expect(m.tick(10_899)).toEqual([]);
    expect(m.view.progressDisplayCents).toBe(5000);
    expect(m.tick(10_900)).toEqual([{ kind: "unlock_stinger", count: 1 }]);
    expect(unlockStinger(1)).toEqual({ big: "+1 UNLOCK", sub: "READY TO DROP" });
    expect(m.view).toMatchObject({ progressDisplayCents: 300, fullCount: 0, queue: 1, bankedTotal: 1 });
    expect(m.tick(20_000)).toEqual([]);
  });

  test("stacked: FULL ×3 for the beat, then one +3 UNLOCKS stinger, then the tier it opened", () => {
    const m = model();
    const fx = m.apply(contribution({ face: { kind: "tip", cents: 4000 }, faceValueCents: 4000, unlocksBanked: 3, tiersOpened: [1], state: st({ progressCents: 1300, queue: 3, bankedTotal: 3, tier: 1 }) }), 0);
    expect(fx[2]).toEqual({ kind: "full", count: 3, untilMs: 900 });
    expect(fullLabel(m.view.fullCount)).toBe("FULL ×3");
    expect(m.tick(900)).toEqual([{ kind: "unlock_stinger", count: 3 }]);
    expect(unlockStinger(3)).toEqual({ big: "+3 UNLOCKS", sub: "3 UNLOCKS EARNED IN ONE MOMENT · READY TO DROP" });
    expect(m.view).toMatchObject({ queue: 3, tier: 0 });
    expect(m.tick(900 + TIER_STAGGER_MS)).toEqual([{ kind: "tier_open", tier: 1 }]);
    expect(m.view.tier).toBe(1);
  });

  test("a big contribution (intensity ≥ bigIntensity) holds fullHoldBigMs", () => {
    const m = model();
    m.apply(contribution({ face: { kind: "gift", tier: "1000", count: 25 }, faceValueCents: 14975, progressCents: 5000, unlocksBanked: 1, state: st({ progressCents: 1300, queue: 1, bankedTotal: 1 }) }), 0);
    expect(m.tick(900)).toEqual([]);
    expect(m.tick(1699)).toEqual([]);
    expect(m.tick(1700)).toEqual([{ kind: "unlock_stinger", count: 1 }]);
  });

  test("a crossing that opens two tiers: stinger, TIER 1 at +900, TIER 2 at +1800; names unmask at each reveal", () => {
    const m = model();
    const after = st({ progressCents: 1300, queue: 4, bankedTotal: 4, tier: 2 });
    m.apply(contribution({ face: { kind: "bits", bits: 20000 }, faceValueCents: 20000, progressCents: 20000, unlocksBanked: 4, tiersOpened: [1, 2], state: after }), 0);
    expect(m.tick(1700)).toEqual([{ kind: "unlock_stinger", count: 4 }]); // 20,000 bits = $200 → 0.83: the big hold
    expect(m.view).toMatchObject({ queue: 4, bankedTotal: 4, tier: 0 });
    expect(names(m)).toEqual(["STICKERS", null, null]);
    expect(m.tick(2599)).toEqual([]);
    expect(m.tick(2600)).toEqual([{ kind: "tier_open", tier: 1 }]);
    expect(m.view.tier).toBe(1);
    expect(m.view.outcomes.map((o) => [o.name, o.glyph])).toEqual([["STICKERS", "🎟️"], ["SHIRT", "🎟️"], [null, "🔒"]]);
    expect(m.view.justRevealed).toEqual([{ tier: 1, until: 2600 + cfg.justRevealedMs }]);
    expect(m.tick(3499)).toEqual([]);
    expect(m.tick(3500)).toEqual([{ kind: "tier_open", tier: 2 }]);
    expect(m.view.tier).toBe(2);
    expect(names(m)).toEqual(["STICKERS", "SHIRT", "PIE TO THE FACE"]);
    expect(m.view.justRevealed.map((j) => j.tier)).toEqual([1, 2]);
  });

  test("a late tick releases everything that is due, in order", () => {
    const m = model();
    m.apply(contribution({ unlocksBanked: 4, tiersOpened: [1, 2], state: st({ queue: 4, bankedTotal: 4, tier: 2 }) }), 0);
    expect(m.tick(60_000)).toEqual([{ kind: "unlock_stinger", count: 4 }, { kind: "tier_open", tier: 1 }, { kind: "tier_open", tier: 2 }]);
    expect(m.view.tier).toBe(2);
  });

  test("a second crossing during the hold merges: FULL ×2, one +2 stinger, the newest state adopted", () => {
    const m = model();
    m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 1300, queue: 1, bankedTotal: 1 }) }), 0);
    const fx = m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 1300, queue: 2, bankedTotal: 2 }) }), 300);
    expect(kinds(fx)).toEqual(["thank", "celebrate", "full"]);
    expect(fx[2]).toEqual({ kind: "full", count: 2, untilMs: 1200 }); // the beat restarts from the newest crossing
    expect(m.view.fullCount).toBe(2);
    expect(m.tick(900)).toEqual([]);
    expect(m.tick(1200)).toEqual([{ kind: "unlock_stinger", count: 2 }]);
    expect(m.view.queue).toBe(2);
  });

  test("a small contribution during the hold keeps the fader FULL; its state is what the hold ends on", () => {
    const m = model();
    m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 300, queue: 1, bankedTotal: 1 }) }), 0);
    const fx = m.apply(contribution({ face: { kind: "tip", cents: 300 }, faceValueCents: 300, progressCents: 300, state: st({ progressCents: 600, queue: 1, bankedTotal: 1 }) }), 100);
    expect(kinds(fx)).toEqual(["thank", "celebrate"]);
    expect(m.view).toMatchObject({ progressDisplayCents: 5000, fullCount: 1, queue: 0 });
    expect(m.tick(900)).toEqual([{ kind: "unlock_stinger", count: 1 }]);
    expect(m.view).toMatchObject({ progressDisplayCents: 600, queue: 1 });
  });
});

describe("fire", () => {
  test("a drop effect with the fire's fields; the state adopted; miniDraw only when present", () => {
    const m = model();
    const miniDraw = { title: "GENRE ROULETTE · 10–15 MIN", list: ["DISCO / NU-DISCO", "TRANCE"], pick: "TRANCE" };
    const fx = m.apply(fire({ miniDraw, state: st({ queue: 0, bankedTotal: 1 }) }), 0);
    expect(fx).toEqual([{ kind: "drop", fireSeq: 9, outcomeId: "stickers", solo: null, group: [], stockAfter: 4, miniDraw }]);
    expect(m.view).toMatchObject({ queue: 0, bankedTotal: 1 });
    const plain = m.apply(fire({ fireSeq: 10, stockAfter: 3 }), 1);
    expect(plain).toEqual([{ kind: "drop", fireSeq: 10, outcomeId: "stickers", solo: null, group: [], stockAfter: 3 }]);
    expect("miniDraw" in plain[0]!).toBe(false);
  });

  test("a Fire during a FULL hold ends the hold first: stinger, then the drop", () => {
    const m = model();
    m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 300, queue: 1, bankedTotal: 1 }) }), 0);
    const fx = m.apply(fire({ state: st({ progressCents: 300, queue: 0, bankedTotal: 1 }) }), 200);
    expect(kinds(fx)).toEqual(["unlock_stinger", "drop"]);
    expect(m.view).toMatchObject({ progressDisplayCents: 300, fullCount: 0, queue: 0 });
    expect(m.tick(900)).toEqual([]);
  });

  test("the fired outcome keeps its pre-fire Used / Left (and stays live) until `revealed(fireSeq)` — the pad and the rack row flip when the banner names it", () => {
    const m = model();
    const left = (): number => m.view.outcomes.find((o) => o.id === "stickers")!.left;
    const after = st({ outcomes: [outcome("stickers", "STICKERS", 0, 0, true), outcome("shirt-t1", "SHIRT", 1, 2, false), outcome("pie-to-the-face", "PIE TO THE FACE", 2, 1, false)] });
    after.outcomes[0]!.used = 5;
    after.outcomes[0]!.status = "retired"; // whatever the server says of a used-up outcome, the row reads live until its reveal
    m.apply(fire({ fireSeq: 9, stockAfter: 0, state: after }), 0);
    expect(left()).toBe(5);
    expect(m.view.outcomes[0]).toMatchObject({ left: 5, used: 0, status: "live" }); // the pips hold too: no extra dimmed pip before the reveal
    expect(m.tick(60_000)).toEqual([]); // time alone never releases it: the reveal is the scene's moment
    expect(left()).toBe(5);
    m.revealed(9);
    expect(m.view.outcomes[0]).toMatchObject({ left: 0, used: 5, status: "retired" });
    m.revealed(9); // unknown / already revealed: a no-op
    expect(left()).toBe(0);
  });

  test("two fires on one outcome reveal 3 → 2 → 1, each at its own reveal; a state message in between keeps the lag", () => {
    const m = model();
    const three = outcome("stickers", "STICKERS", 0, 3, true);
    m.apply({ type: "snapshot", state: st({ outcomes: [three] }), skin, chatters: [] }, 0);
    const stock = (): { left: number; used: number } => ({ left: m.view.outcomes[0]!.left, used: m.view.outcomes[0]!.used });
    m.apply(fire({ fireSeq: 1, stockAfter: 2, state: st({ outcomes: [{ ...three, left: 2, used: 1 }] }) }), 100);
    m.apply(fire({ fireSeq: 2, stockAfter: 1, state: st({ outcomes: [{ ...three, left: 1, used: 2 }] }) }), 200);
    expect(stock()).toEqual({ left: 3, used: 0 });
    m.apply({ type: "state", reason: "queue_adjust", tiersOpened: [], state: st({ queue: 4, outcomes: [{ ...three, left: 1, used: 2 }] }) }, 300);
    expect(m.view.queue).toBe(4);
    expect(stock()).toEqual({ left: 3, used: 0 });
    m.apply(contribution({ state: st({ progressCents: 2800, outcomes: [{ ...three, left: 1, used: 2 }] }) }), 400);
    expect(stock()).toEqual({ left: 3, used: 0 });
    m.revealed(1);
    expect(stock()).toEqual({ left: 2, used: 1 });
    m.revealed(2);
    expect(stock()).toEqual({ left: 1, used: 2 });
  });

  test("a `state` with reason \"outcomes\" mid-air (the editor removed the fired outcome, added another): the view is the new list at once; the lag survives the outcome coming back", () => {
    const m = model();
    m.apply(fire({ fireSeq: 9, stockAfter: 4, state: st({ outcomes: [outcome("stickers", "STICKERS", 0, 4, true)] }) }), 0);
    const view = (): Array<{ id: string; name: string | null; left: number }> => m.view.outcomes.map((o) => ({ id: o.id, name: o.name, left: o.left }));
    expect(view()).toEqual([{ id: "stickers", name: "STICKERS", left: 5 }]);
    const removed = st({ outcomes: [outcome("hoodie", "HOODIE", 0, 2, true), outcome("shirt-t1", "SHIRT", 1, 2, false)] });
    expect(kinds(m.apply({ type: "state", reason: "outcomes", tiersOpened: [], state: removed }, 100))).toEqual(["resync"]);
    expect(view()).toEqual([{ id: "hoodie", name: "HOODIE", left: 2 }, { id: "shirt-t1", name: null, left: 2 }]); // what stays under the jumper is the pad strip's call, not the model's
    m.apply({ type: "state", reason: "outcomes", tiersOpened: [], state: st({ outcomes: [outcome("stickers", "STICKERS", 0, 4, true), outcome("hoodie", "HOODIE", 0, 2, true)] }) }, 200);
    expect(view()[0]).toEqual({ id: "stickers", name: "STICKERS", left: 5 }); // back before the reveal: still the pre-fire ×5
    m.revealed(9);
    expect(view()[0]).toEqual({ id: "stickers", name: "STICKERS", left: 4 });
  });

  test("a reveal whose outcome vanished mid-air is a harmless no-op", () => {
    const m = model();
    m.apply(fire({ fireSeq: 9, stockAfter: 4, state: st({ outcomes: [outcome("stickers", "STICKERS", 0, 4, true)] }) }), 0);
    m.apply({ type: "state", reason: "outcomes", tiersOpened: [], state: st({ outcomes: [outcome("hoodie", "HOODIE", 0, 2, true)] }) }, 100);
    expect(() => m.revealed(9)).not.toThrow();
    expect(m.view.outcomes.map((o) => o.id)).toEqual(["hoodie"]);
    expect(m.tick(60_000)).toEqual([]);
  });

  test("a `state` with reason \"stock\" mid-air (a Left edit): the fired outcome keeps its pre-fire Left until the reveal, then shows the edit — not stockAfter; another outcome's edit shows at once", () => {
    const m = model();
    m.apply(fire({ fireSeq: 9, stockAfter: 4, state: st({ outcomes: [outcome("stickers", "STICKERS", 0, 4, true), outcome("shirt-t1", "SHIRT", 1, 2, false)] }) }), 0);
    const left = (id: string): number => m.view.outcomes.find((o) => o.id === id)!.left;
    expect(kinds(m.apply({ type: "state", reason: "stock", tiersOpened: [], state: st({ outcomes: [outcome("stickers", "STICKERS", 0, 10, true), outcome("shirt-t1", "SHIRT", 1, 7, false)] }) }, 100))).toEqual(["resync"]);
    expect(left("stickers")).toBe(5); // the pad must not give the landing away
    expect(left("shirt-t1")).toBe(7);
    m.revealed(9);
    expect(left("stickers")).toBe(10);
  });

  test("a snapshot (resync) clears every pending fire: the view is the fresh truth", () => {
    const m = model();
    m.apply(fire({ fireSeq: 9, stockAfter: 4, state: st({ outcomes: [outcome("stickers", "STICKERS", 0, 4, true)] }) }), 0);
    expect(m.view.outcomes[0]!.left).toBe(5);
    m.apply({ type: "snapshot", state: st({ outcomes: [outcome("stickers", "STICKERS", 0, 4, true)] }), skin, chatters: [] }, 10);
    expect(m.view.outcomes[0]!.left).toBe(4);
    m.revealed(9);
    expect(m.view.outcomes[0]!.left).toBe(4);
  });

  test("a fire during a FULL hold: the hold's state lands first, the fired outcome still lags to its reveal", () => {
    const m = model();
    m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 300, queue: 1, bankedTotal: 1 }) }), 0);
    m.apply(fire({ fireSeq: 3, stockAfter: 4, state: st({ progressCents: 300, queue: 0, bankedTotal: 1, outcomes: [outcome("stickers", "STICKERS", 0, 4, true)] }) }), 200);
    expect(m.view).toMatchObject({ progressDisplayCents: 300, queue: 0 });
    expect(m.view.outcomes[0]!.left).toBe(5);
    m.revealed(3);
    expect(m.view.outcomes[0]!.left).toBe(4);
  });

  test("drained: once, when the adopted state flips it on; silently off again; never on a snapshot", () => {
    const m = model();
    expect(kinds(m.apply(fire({ stockAfter: 0, state: st({ drained: true }) }), 0))).toEqual(["drop", "drained"]);
    expect(m.view.drained).toBe(true);
    expect(kinds(m.apply({ type: "state", reason: "outcome_status", tiersOpened: [], state: st({ drained: true }) }, 1))).toEqual(["resync"]);
    expect(kinds(m.apply({ type: "state", reason: "restock", tiersOpened: [], state: st({ drained: false }) }, 2))).toEqual(["resync"]);
    expect(m.view.drained).toBe(false);
    expect(kinds(m.apply(fire({ stockAfter: 0, state: st({ drained: true }) }), 3))).toEqual(["drop", "drained"]);
    const fresh = new OverlayModel(cfg);
    expect(kinds(fresh.apply({ type: "snapshot", state: st({ drained: true }), skin, chatters: [] }, 0))).toEqual(["skin", "resync"]);
    expect(fresh.view.drained).toBe(true);
  });
});

describe("state, skin, cue", () => {
  test("state: resync, tier_open for tiersOpened (first now, next +900), adopt", () => {
    const m = model();
    const fx = m.apply({ type: "state", reason: "queue_adjust", tiersOpened: [1, 2], state: st({ queue: 6, bankedTotal: 6, tier: 2 }) }, 100);
    expect(fx).toEqual([{ kind: "resync" }, { kind: "tier_open", tier: 1 }]);
    expect(m.view).toMatchObject({ queue: 6, bankedTotal: 6, tier: 1 });
    expect(names(m)).toEqual(["STICKERS", "SHIRT", null]);
    expect(m.tick(999)).toEqual([]);
    expect(m.tick(1000)).toEqual([{ kind: "tier_open", tier: 2 }]);
    expect(m.view.tier).toBe(2);
    expect(names(m)).toEqual(["STICKERS", "SHIRT", "PIE TO THE FACE"]);
    const plain = m.apply({ type: "state", reason: "threshold", tiersOpened: [], state: st({ thresholdCents: 3500, progressCents: 300, tier: 2 }) }, 2000);
    expect(plain).toEqual([{ kind: "resync" }]);
    expect(m.view).toMatchObject({ thresholdCents: 3500, progressDisplayCents: 300, tier: 2 });
  });

  test("a state message during a FULL hold ends the hold first", () => {
    const m = model();
    m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 300, queue: 1, bankedTotal: 1 }) }), 0);
    const fx = m.apply({ type: "state", reason: "threshold", tiersOpened: [], state: st({ thresholdCents: 3500, progressCents: 300, queue: 1, bankedTotal: 1 }) }, 100);
    expect(kinds(fx)).toEqual(["unlock_stinger", "resync"]);
    expect(m.view).toMatchObject({ thresholdCents: 3500, progressDisplayCents: 300, fullCount: 0, queue: 1 });
  });

  test("justRevealed entries expire after justRevealedMs", () => {
    const m = model();
    m.apply({ type: "state", reason: "queue_adjust", tiersOpened: [1], state: st({ queue: 3, bankedTotal: 3, tier: 1 }) }, 1000);
    expect(m.view.justRevealed).toEqual([{ tier: 1, until: 1000 + cfg.justRevealedMs }]);
    expect(m.tick(1000 + cfg.justRevealedMs - 1)).toEqual([]);
    expect(m.view.justRevealed).toHaveLength(1);
    m.tick(1000 + cfg.justRevealedMs);
    expect(m.view.justRevealed).toEqual([]);
    expect(m.view.tier).toBe(1); // the reveal is over; the tier stays open
  });

  test("cue → cue effect (value only when given)", () => {
    const m = model();
    expect(m.apply({ type: "cue", name: "beat", value: 0.8 }, 0)).toEqual([{ kind: "cue", name: "beat", value: 0.8 }]);
    const bare = m.apply({ type: "cue", name: "drop" }, 0);
    expect(bare).toEqual([{ kind: "cue", name: "drop" }]);
    expect("value" in bare[0]!).toBe(false);
  });

  test("skin → skin effect, and the new config's timings apply from then on", () => {
    const m = model();
    const slow: OverlaySkin = { ...skin, config: { ...cfg, fullHoldMs: 3000 } };
    expect(m.apply({ type: "skin", skin: slow }, 0)).toEqual([{ kind: "skin", skin: slow }]);
    m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 1300, queue: 1, bankedTotal: 1 }) }), 100);
    expect(m.tick(1000)).toEqual([]);
    expect(m.tick(3099)).toEqual([]);
    expect(m.tick(3100)).toEqual([{ kind: "unlock_stinger", count: 1 }]);
  });
});

describe("tryApply — a malformed frame is logged and dropped, never thrown (ws.onmessage and the debug bar go through it)", () => {
  test("returns null and logs once; the model is untouched and the next frame still applies", () => {
    const m = new OverlayModel(cfg);
    m.apply({ type: "snapshot", state: st(), skin, chatters: [] }, 0);
    const before = structuredClone(m.view);
    const err = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(tryApply(m, { type: "snapshot" } as unknown as OverlayMessage, 100)).toBeNull();
      expect(err).toHaveBeenCalledTimes(1);
      expect(String(err.mock.calls[0]![0])).toContain("overlay");
    } finally {
      err.mockRestore();
    }
    expect(m.view).toEqual(before);
    expect(tryApply(m, { type: "skin", skin }, 200)).toEqual([{ kind: "skin", skin }]);
  });
});

describe("Contributor Motes: view.motes adopts the wire with the state; the drop effect carries the Unlock's group", () => {
  const mote = (key: string, cents: number, name: string | null = key): Mote => ({ key, name, avatar: name === null ? "" : "🎧", avatarUrl: null, cents });

  test("a plain contribution: view.motes is the message's motes at once (the new mote spawns with the thank line)", () => {
    const m = model();
    const motes = { collecting: [mote("alice", 1500)], ready: [] };
    m.apply(contribution({ state: st({ progressCents: 2800, motes }) }), 0);
    expect(m.view.motes).toEqual(motes);
  });

  test("a crossing: the motes move with the state at the stinger, not before — the group is READY when the count is", () => {
    const m = model();
    m.apply(contribution({ state: st({ progressCents: 1300, motes: { collecting: [mote("alice", 1300)], ready: [] } }) }), 0);
    const ready = { collecting: [mote("bob", 400)], ready: [[mote("alice", 1300), mote("bob", 3700)]] };
    m.apply(contribution({ displayName: "bob", unlocksBanked: 1, state: st({ progressCents: 400, queue: 1, bankedTotal: 1, motes: ready }) }), 100);
    expect(m.view.fullCount).toBe(1);
    expect(m.view.motes).toEqual({ collecting: [mote("alice", 1300)], ready: [] });
    expect(kinds(m.tick(100 + cfg.fullHoldMs))).toEqual(["unlock_stinger"]);
    expect(m.view).toMatchObject({ queue: 1, motes: ready });
  });

  test("a fire: the drop effect carries the message's group and the view adopts the post-fire motes; a state message adopts too", () => {
    const m = model();
    const group = [mote("alice", 1300), mote("bob", 3700), mote("anon:4", 100, null)];
    const fx = m.apply(fire({ group, state: st({ queue: 0, bankedTotal: 1, motes: { collecting: [mote("bob", 400)], ready: [] } }) }), 0);
    expect(fx).toEqual([{ kind: "drop", fireSeq: 9, outcomeId: "stickers", solo: null, group, stockAfter: 4 }]);
    expect(m.view.motes).toEqual({ collecting: [mote("bob", 400)], ready: [] });
    const rebanked = { collecting: [mote("bob", 400)], ready: [group] };
    m.apply({ type: "state", reason: "rebank", tiersOpened: [], state: st({ queue: 1, bankedTotal: 1, motes: rebanked }) }, 1);
    expect(m.view.motes).toEqual(rebanked);
  });

  test("a snapshot replaces the motes outright (a reconnect owes nothing from before)", () => {
    const m = model();
    m.apply(contribution({ state: st({ motes: { collecting: [mote("alice", 1500)], ready: [] } }) }), 0);
    m.apply({ type: "snapshot", state: st(), skin, chatters: [] }, 1);
    expect(m.view.motes).toEqual({ collecting: [], ready: [] });
  });
});

describe("Chatter Dancers: view.chatters follows the snapshot and every chatters message; chat-hop is an effect", () => {
  const ch = (key: string, name: string, lastSeenMs: number): Chatter => ({ key, name, avatarUrl: null, firstSeenMs: 0, lastSeenMs });

  test("the snapshot adopts the roster; a chatters message replaces it with no effect; other messages leave it alone", () => {
    const m = new OverlayModel(cfg);
    expect(m.view.chatters).toEqual([]);
    m.apply({ type: "snapshot", state: st(), skin, chatters: [ch("a", "Alice", 5)] }, 0);
    expect(m.view.chatters).toEqual([ch("a", "Alice", 5)]);
    expect(m.apply({ type: "chatters", chatters: [ch("b", "Bob", 9), ch("a", "Alice", 5)] }, 10)).toEqual([]);
    expect(m.view.chatters.map((c) => c.name)).toEqual(["Bob", "Alice"]);
    m.apply(contribution({ state: st({ progressCents: 2800 }) }), 20);
    m.apply({ type: "state", reason: "threshold", tiersOpened: [], state: st() }, 30);
    m.apply(fire(), 40);
    expect(m.view.chatters.map((c) => c.name)).toEqual(["Bob", "Alice"]);
    expect(m.apply({ type: "chatters", chatters: [] }, 50)).toEqual([]);
    expect(m.view.chatters).toEqual([]);
  });

  test("a snapshot during a FULL hold (reconnect) replaces the roster like everything else", () => {
    const m = model();
    m.apply({ type: "chatters", chatters: [ch("a", "Alice", 5)] }, 0);
    m.apply(contribution({ unlocksBanked: 1, state: st({ progressCents: 300, queue: 1, bankedTotal: 1 }) }), 0);
    m.apply({ type: "snapshot", state: st(), skin, chatters: [ch("c", "Cy", 7)] }, 100);
    expect(m.view.chatters).toEqual([ch("c", "Cy", 7)]);
  });

  test("chat-hop → one chat-hop effect carrying the key; the view is untouched", () => {
    const m = model();
    m.apply({ type: "chatters", chatters: [ch("a", "Alice", 5)] }, 0);
    const before = structuredClone(m.view);
    expect(m.apply({ type: "chat-hop", key: "a" }, 1)).toEqual([{ kind: "chat-hop", key: "a" }]);
    expect(m.view).toEqual(before);
  });
});
