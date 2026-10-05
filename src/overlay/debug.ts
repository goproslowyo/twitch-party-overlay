/**
 * The client-only test chrome (`?debug=1`): a bar of buttons that build fake overlay messages from the last
 * state the page saw and hand them to `inject()`. Nothing here talks to the server — the Ledger never learns of a fake
 * tip — and the arithmetic is a stand-in (tips at 100 %, 1 ¢ per bit, the default sub rates) good enough to exercise
 * every moment the overlay has: crossings, stacked FULLs, tier reveals, fires, the drained pool, a theme swap. Names
 * behind a locked tier are unknown to the client, so a fake reveal names them after their ids. The bar also carries the
 * quality readout (fps, miss ratio, level, WebGL) and `?quality=N` forces a Quality Level — debug only, never config.
 */
import { defaultConfig, type Theme } from "../config/schema.ts";
import type { ContributionSource, Face, SubTier } from "../ingest/contribution.ts";
import { faceValueCents } from "../ingest/contribution.ts";
import type { OverlayMessage, OverlayOutcome, OverlaySkin, OverlayState } from "../server/overlay.ts";
import type { AutoStatus, Level } from "./quality.ts";
import { avatarFor } from "./theme.ts";

/** What the readout shows: the controller's status plus who is in charge and whether the light layer is live. */
export interface QualityReadout extends AutoStatus {
  mode: "auto" | "manual";
  webgl: boolean;
}

export interface DebugContext {
  inject(msg: OverlayMessage): void;
  /** Advance the loop by `dtMs` of synthetic time. */
  step(dtMs: number): void;
  state(): OverlayState | null;
  skin(): OverlaySkin;
  nowMs(): number;
  quality(): QualityReadout;
}

/** How often the readout refreshes on its own (a timer is fine here: debug.ts is not a scene module). */
export const READOUT_EVERY_MS = 500;

/** `?quality=N` → the Level to force, for main.ts to honour in debug mode only; anything else is null. */
export function forcedLevel(params: URLSearchParams): Level | null {
  const raw = params.get("quality");
  if (raw === null || !/^[1-5]$/.test(raw)) return null;
  return Number(raw) as Level;
}

/**
 * The readout's one line: `fps 60 · work 8 ms · miss 3 % · L4 auto · WebGL off` — fps from the mean interval, work the
 * mean time inside the frame callback (the headroom Auto steps up on); — for both with no frames yet.
 */
export function qualityReadoutText(q: QualityReadout): string {
  const measured = q.meanIntervalMs > 0;
  const fps = measured ? String(Math.round(1000 / q.meanIntervalMs)) : "—";
  const work = measured ? `${Math.round(q.meanWorkMs)} ms` : "—";
  return `fps ${fps} · work ${work} · miss ${Math.round(q.missRatio * 100)} % · L${q.level} ${q.mode} · WebGL ${q.webgl ? "on" : "off"}`;
}

const SUB_CENTS: Record<SubTier, number> = { "1000": 200, "2000": 350, "3000": 875, prime: 200 };
const VALVE_CENTS = [5000, 3500, 2500, 2000, 1000];
const NAMES = ["bassline_bea", "kickdrum_kev", "hihat_hana", "reverb_rob", "fader_faye", "sub_drop_sam", "vinyl_vic", "echo_em"];
const STEP_MS = 100;

/** What the Progress bar credits for a face — the default policy, client-side, for testing only. */
export function creditedCents(face: Face): number {
  switch (face.kind) {
    case "tip":
      return face.cents;
    case "bits":
      return face.bits;
    case "sub":
      return SUB_CENTS[face.tier];
    case "gift":
      return face.count * SUB_CENTS[face.tier];
  }
}

const tierFor = (bankedTotal: number, gates: number[]): number => gates.reduce((tier, gate, i) => (bankedTotal >= gate ? i : tier), 0);
const fakeName = (id: string): string => id.toUpperCase().replace(/-/g, " ");
const clone = (state: OverlayState): OverlayState => structuredClone(state);

/** Unmask every outcome in a tier at or below `tier` — a fake reveal names them after their ids. */
function unmask(outcomes: OverlayOutcome[], tier: number): OverlayOutcome[] {
  return outcomes.map((o) => (o.tier <= tier && o.name === null ? { ...o, name: fakeName(o.id), glyph: "🎁" } : o));
}

/** Open every tier the banked total now reaches above `fromTier`: raises `next.tier`, unmasks, and lists the tiers opened. */
function openTiers(next: OverlayState, fromTier: number): number[] {
  const reached = tierFor(next.bankedTotal, next.gates);
  const tiersOpened: number[] = [];
  for (let t = fromTier + 1; t <= reached; t++) tiersOpened.push(t);
  next.tier = Math.max(fromTier, reached);
  next.outcomes = unmask(next.outcomes, next.tier);
  return tiersOpened;
}

/** Add `cents` of Progress: bank every crossing, open the tiers the total reaches. */
function cross(state: OverlayState, cents: number): { next: OverlayState; unlocks: number; tiersOpened: number[] } {
  const next = clone(state);
  const total = state.progressCents + cents;
  const unlocks = state.thresholdCents > 0 ? Math.floor(total / state.thresholdCents) : 0;
  next.progressCents = total - unlocks * state.thresholdCents;
  next.queue += unlocks;
  next.bankedTotal += unlocks;
  return { next, unlocks, tiersOpened: openTiers(next, state.tier) };
}

export function fakeContribution(state: OverlayState, theme: Theme, face: Face, source: ContributionSource, displayName: string | null): OverlayMessage {
  const avatar = avatarFor(displayName, theme);
  const credited = creditedCents(face);
  const { next, unlocks, tiersOpened } = cross(state, credited);
  return { type: "contribution", source, displayName, anonymous: displayName === null, avatar, avatarUrl: null, face, faceValueCents: faceValueCents(face), progressCents: credited, unlocksBanked: unlocks, tiersOpened, state: next };
}

/** A mod's +1 (`queue_adjust`): an Unlock with nobody behind it. */
export function fakeUnlock(state: OverlayState): OverlayMessage {
  const next = clone(state);
  next.queue += 1;
  next.bankedTotal += 1;
  return { type: "state", reason: "queue_adjust", tiersOpened: openTiers(next, state.tier), state: next };
}

const isLive = (o: OverlayOutcome, tier: number): boolean => o.tier <= tier && o.status === "live" && o.left > 0;

/** The client-side stand-in for the Engine's mini-draw: the default config's list for the outcome, one draw from it. */
function fakeMiniDraw(outcomeId: string, rng: () => number): { title: string; list: string[]; pick: string } | undefined {
  const cfg = defaultConfig();
  const def = cfg.outcomes.find((o) => o.id === outcomeId);
  if (def?.miniDraw === undefined) return undefined;
  const list = [...cfg.lists[def.miniDraw]];
  if (list.length === 0) return undefined;
  return { title: `${def.name} · ${def.occupancy.toUpperCase()}`, list, pick: list[Math.min(list.length - 1, Math.floor(rng() * list.length))]! };
}

/**
 * A Fire: one Unlock leaves the queue, a live outcome (odds ∝ left, like the Engine) goes left −1 / used +1; a mini-draw
 * outcome carries its draw from the default lists. Null when nothing can fire or the queue is empty — the Engine
 * rejects a fire with no Unlock behind it, so the bar must not fake one.
 */
export function fakeFire(state: OverlayState, fireSeq: number, rng: () => number = Math.random): OverlayMessage | null {
  if (state.queue === 0) return null;
  const live = state.outcomes.filter((o) => isLive(o, state.tier));
  if (live.length === 0) return null;
  const totalLeft = live.reduce((sum, o) => sum + o.left, 0);
  let pick = rng() * totalLeft;
  let chosen = live[live.length - 1]!;
  for (const o of live) {
    pick -= o.left;
    if (pick < 0) {
      chosen = o;
      break;
    }
  }
  const next = clone(state);
  next.queue = Math.max(0, next.queue - 1);
  const target = next.outcomes.find((o) => o.id === chosen.id)!;
  target.left -= 1;
  target.used += 1;
  next.drained = !next.outcomes.some((o) => isLive(o, next.tier));
  const miniDraw = fakeMiniDraw(chosen.id, rng);
  return { type: "fire", fireSeq, outcomeId: chosen.id, solo: null, group: [], stockAfter: target.left, ...(miniDraw === undefined ? {} : { miniDraw }), state: next };
}

/** The valve: the next lower suggested Threshold; Progress already past it banks at once (forward-only, never lost). */
export function fakeValve(state: OverlayState): OverlayMessage {
  const lower = VALVE_CENTS.find((c) => c < state.thresholdCents) ?? state.thresholdCents;
  const lowered = { ...clone(state), thresholdCents: lower };
  const { next, tiersOpened } = cross(lowered, 0);
  return { type: "state", reason: "threshold", tiersOpened, state: next };
}

/** Every outcome re-armed by what it has used — like the Engine's restock, `used` is history and stays. */
export function fakeRestock(state: OverlayState): OverlayMessage {
  const next = clone(state);
  next.outcomes = next.outcomes.map((o) => ({ ...o, left: o.left + o.used }));
  next.drained = false;
  return { type: "state", reason: "restock", tiersOpened: [], state: next };
}

/** Open the next tier outright (a gate edit): banks nothing, reveals the tier. Null when every tier is open. */
export function fakeTierOpen(state: OverlayState): OverlayMessage | null {
  const tier = state.tier + 1;
  if (tier >= state.gates.length) return null;
  const next = clone(state);
  next.tier = tier;
  next.bankedTotal = Math.max(next.bankedTotal, next.gates[tier] ?? 0);
  next.outcomes = unmask(next.outcomes, tier);
  return { type: "state", reason: "tier_adjust", tiersOpened: [tier], state: next };
}

/** Every open-tier outcome fired dry (its stock moves from left to used): the drained pool. */
export function fakeDrained(state: OverlayState): OverlayMessage {
  const next = clone(state);
  next.outcomes = next.outcomes.map((o) => (o.tier <= next.tier ? { ...o, used: o.used + o.left, left: 0 } : o));
  next.drained = true;
  return { type: "state", reason: "drained", tiersOpened: [], state: next };
}

/** Swap to another built-in theme (the config's, unchanged otherwise). */
export function fakeSkin(skin: OverlaySkin, themes: Record<string, Theme> = defaultConfig().themes): OverlayMessage {
  const other = Object.values(themes).find((t) => t.name !== skin.theme.name) ?? skin.theme;
  return { type: "skin", skin: { ...skin, theme: other } };
}

export function mountDebug(ctx: DebugContext, doc: Document = document, every: (fn: () => void, ms: number) => void = (fn, ms) => void setInterval(fn, ms)): HTMLElement {
  const bar = doc.createElement("div");
  bar.id = "bar";
  let fireSeq = 0;
  let nameIx = 0;
  const nextName = (): string => NAMES[nameIx++ % NAMES.length]!;
  const withState = (build: (state: OverlayState) => OverlayMessage | null): void => {
    const state = ctx.state();
    if (state === null) return;
    const msg = build(state);
    if (msg !== null) ctx.inject(msg);
  };
  const contribute = (face: Face, source: ContributionSource): void => withState((s) => fakeContribution(s, ctx.skin().theme, face, source, nextName()));

  const buttons: Array<[string, () => void, string?]> = [
    ["tip $3", () => contribute({ kind: "tip", cents: 300 }, "streamelements")],
    ["tip $15", () => contribute({ kind: "tip", cents: 1500 }, "streamelements")],
    ["500 bits", () => contribute({ kind: "bits", bits: 500 }, "twitch")],
    ["10k bits", () => contribute({ kind: "bits", bits: 10_000 }, "twitch")],
    ["tip $40", () => contribute({ kind: "tip", cents: 4000 }, "kofi")],
    ["25 gifts", () => contribute({ kind: "gift", tier: "1000", count: 25 }, "twitch")],
    ["+unlock", () => withState(fakeUnlock)],
    ["fire", () => withState((s) => fakeFire(s, ++fireSeq)), "fire"],
    ["valve", () => withState(fakeValve)],
    ["restock", () => withState(fakeRestock)],
    ["tier open", () => withState(fakeTierOpen)],
    ["drained", () => withState(fakeDrained)],
    ["theme swap", () => ctx.inject(fakeSkin(ctx.skin()))],
    ["hide chrome", () => doc.body.classList.toggle("barless")],
    [`step ${STEP_MS}ms`, () => ctx.step(STEP_MS)],
  ];
  const readout = doc.createElement("span");
  readout.className = "quality";
  const clock = doc.createElement("span");
  clock.className = "clock";
  const readClock = (): void => {
    readout.textContent = qualityReadoutText(ctx.quality());
    clock.textContent = `t=${Math.round(ctx.nowMs())}`;
  };
  readClock();
  every(readClock, READOUT_EVERY_MS);
  for (const [label, onClick, cls] of buttons) {
    const b = doc.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (cls !== undefined) b.className = cls;
    b.addEventListener("click", () => {
      onClick();
      readClock();
    });
    bar.appendChild(b);
  }
  bar.appendChild(readout);
  bar.appendChild(clock);
  doc.body.appendChild(bar);
  return bar;
}
