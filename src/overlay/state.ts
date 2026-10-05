/**
 * The overlay's display state, between the hub's messages and the renderers. `OverlayModel` turns server messages into a `View` (what
 * to draw right now) plus `Effect`s (moments to play) — pure: no DOM, no timers; every clock reading arrives as `nowMs`
 * through `apply`/`tick`, so the choreography is testable to the millisecond.
 *
 * The one thing that is not "adopt the message's state" is a crossing. A contribution that banks
 * Unlocks pins the fader at `$Y of $Y · FULL` (`FULL ×n` when stacked) for a beat — `fullHoldMs`, or `fullHoldBigMs`
 * when its intensity reaches `bigIntensity` so its own moment lands first — then the `+n UNLOCK` stinger fires, the
 * display drops to the remainder and the state is adopted (the READY count moves with the stinger, not before). Tier
 * reveals follow the stinger `TIER_STAGGER_MS` apart, and the rack unmasks a tier's names only when its `tier_open` plays: `view.tier` lags the state's tier until each reveal has had its moment. A fire lags the same way:
 * the fired outcome keeps its pre-fire Used / Left (and reads live) in `view.outcomes` until main.ts calls `revealed(fireSeq)`
 * at the moment the jumper's banner names it — so the pad and the rack row never give the landing away.
 */
import type { OverlayConfig } from "../config/schema.ts";
import type { ContributionSource, Face } from "../ingest/contribution.ts";
import { LOCKED_GLYPH, type Chatter, type Mote, type MoteWire, type OverlayMessage, type OverlayOutcome, type OverlaySkin, type OverlayState } from "../server/overlay.ts";
import { intensity, thankDwellMs } from "./celebration.ts";
import { thankLine, whatText } from "./copy.ts";

/** Gap between consecutive tier reveals, and between the unlock stinger and the first of them. */
export const TIER_STAGGER_MS = 900;

type ContributionMessage = Extract<OverlayMessage, { type: "contribution" }>;
type FireMessage = Extract<OverlayMessage, { type: "fire" }>;
type MiniDraw = NonNullable<FireMessage["miniDraw"]>;

export interface View {
  thresholdCents: number;
  /** What the fader shows: the real progress, or the Threshold while a crossing holds at FULL. */
  progressDisplayCents: number;
  /** Unlocks the current FULL hold announces; 0 when not holding. */
  fullCount: number;
  queue: number;
  bankedTotal: number;
  /** The highest tier revealed on screen — lags the state's tier until each `tier_open` has played. */
  tier: number;
  gates: number[];
  /** As the rack draws them: names (and glyphs) masked above `tier`. */
  outcomes: OverlayOutcome[];
  drained: boolean;
  /** Tiers wearing the gold JUST REVEALED mark, each until its `until`. */
  justRevealed: Array<{ tier: number; until: number }>;
  /**
   * The Contributor Motes as the wire has them — adopted with the state, so a crossing's group turns READY with the count, at the stinger.
   * Under a FULL hold a crossing contributor's mote first appears at the stinger, already inside a READY group; treat a key first seen in `ready` as a spawn.
   */
  motes: MoteWire;
  /** Chatter Dancers: the Active Chatter roster as the wire has it — adopted from the snapshot and every `chatters` message, never touched by anything else. */
  chatters: Chatter[];
}

export type Effect =
  | { kind: "thank"; html: string; dwellMs: number; intensity: number }
  | { kind: "celebrate"; intensity: number; face: Face; source: ContributionSource; name: string | null }
  | { kind: "full"; count: number; untilMs: number }
  | { kind: "unlock_stinger"; count: number }
  | { kind: "tier_open"; tier: number }
  | { kind: "drop"; fireSeq: number; outcomeId: string; solo: string | null; group: Mote[]; miniDraw?: MiniDraw; stockAfter: number }
  | { kind: "drained" }
  | { kind: "resync" }
  | { kind: "cue"; name: string; value?: number }
  | { kind: "skin"; skin: OverlaySkin }
  | { kind: "chat-hop"; key: string };

/** A crossing being held at FULL: what the stinger will say and the state the display adopts when the beat is over. */
interface Hold {
  untilMs: number;
  count: number;
  state: OverlayState;
  tiersOpened: number[];
}

/** A fire whose jumper is still in the air: what its outcome showed before it (both numbers: the pips must not move either), until the reveal. */
interface PendingFire {
  fireSeq: number;
  outcomeId: string;
  leftBefore: number;
  usedBefore: number;
}

export class OverlayModel {
  readonly view: View = { thresholdCents: 0, progressDisplayCents: 0, fullCount: 0, queue: 0, bankedTotal: 0, tier: 0, gates: [], outcomes: [], drained: false, justRevealed: [], motes: { collecting: [], ready: [] }, chatters: [] };
  #cfg: OverlayConfig;
  #state: OverlayState | null = null; // the last adopted state: the unmasked truth behind `view.outcomes`
  #hold: Hold | null = null;
  #reveals: Array<{ tier: number; atMs: number }> = []; // tier_open effects still to play, in time order
  #pendingFires: PendingFire[] = []; // fires not yet revealed, in fire order

  constructor(cfg: OverlayConfig) {
    this.#cfg = cfg;
  }

  apply(msg: OverlayMessage, nowMs: number): Effect[] {
    const effects = this.tick(nowMs);
    switch (msg.type) {
      case "snapshot":
        // a fresh truth (first load, reconnect): nothing from before it is owed
        this.#cfg = msg.skin.config;
        this.#hold = null;
        this.#reveals = [];
        this.#pendingFires = [];
        this.view.justRevealed = [];
        effects.push({ kind: "skin", skin: msg.skin });
        this.#adopt(msg.state);
        this.view.chatters = [...msg.chatters];
        effects.push({ kind: "resync" });
        break;
      case "contribution":
        this.#contribution(msg, nowMs, effects);
        break;
      case "fire":
        this.#flush(nowMs, effects); // the streamer fired: the Unlock must be on screen before it jumps
        this.#pendingFires.push(this.#pending(msg));
        effects.push({ kind: "drop", fireSeq: msg.fireSeq, outcomeId: msg.outcomeId, solo: msg.solo, group: msg.group, stockAfter: msg.stockAfter, ...(msg.miniDraw === undefined ? {} : { miniDraw: msg.miniDraw }) });
        if (this.#adopt(msg.state)) effects.push({ kind: "drained" });
        break;
      case "state":
        this.#flush(nowMs, effects);
        effects.push({ kind: "resync" });
        this.#scheduleReveals(msg.tiersOpened, nowMs);
        if (this.#adopt(msg.state)) effects.push({ kind: "drained" });
        break;
      case "skin":
        this.#cfg = msg.skin.config;
        effects.push({ kind: "skin", skin: msg.skin });
        break;
      case "cue":
        effects.push({ kind: "cue", name: msg.name, ...(msg.value === undefined ? {} : { value: msg.value }) });
        break;
      case "chatters":
        this.view.chatters = [...msg.chatters];
        break;
      case "chat-hop":
        effects.push({ kind: "chat-hop", key: msg.key });
        break;
    }
    this.#release(nowMs, effects);
    return effects;
  }

  /** What the fired outcome showed before this fire — from the adopted state, or worked back from the message when there is none yet. */
  #pending(msg: FireMessage): PendingFire {
    const before = this.#state?.outcomes.find((o) => o.id === msg.outcomeId);
    const after = msg.state.outcomes.find((o) => o.id === msg.outcomeId);
    return { fireSeq: msg.fireSeq, outcomeId: msg.outcomeId, leftBefore: before?.left ?? msg.stockAfter + 1, usedBefore: before?.used ?? Math.max(0, (after?.used ?? 1) - 1) };
  }

  /** The jumper for `fireSeq` has been named on screen: its outcome shows the post-fire truth from now on. Unknown seqs are a no-op. */
  revealed(fireSeq: number): void {
    const i = this.#pendingFires.findIndex((f) => f.fireSeq === fireSeq);
    if (i < 0) return;
    this.#pendingFires.splice(i, 1);
    this.#refreshOutcomes();
  }

  /** Advance the clock: end a FULL hold that is due, play the reveals that are due, expire JUST REVEALED marks. */
  tick(nowMs: number): Effect[] {
    const effects: Effect[] = [];
    if (this.#hold !== null && nowMs >= this.#hold.untilMs) this.#flush(this.#hold.untilMs, effects);
    this.#release(nowMs, effects);
    return effects;
  }

  #contribution(msg: ContributionMessage, nowMs: number, effects: Effect[]): void {
    const i = intensity(msg.faceValueCents, this.#cfg.intensityAnchorCents);
    const name = msg.anonymous ? null : msg.displayName;
    effects.push({ kind: "thank", html: thankLine(name, msg.avatar, msg.avatarUrl, whatText(msg.face, msg.source), i).html, dwellMs: thankDwellMs(i, this.#cfg), intensity: i });
    effects.push({ kind: "celebrate", intensity: i, face: msg.face, source: msg.source, name });
    if (msg.unlocksBanked > 0) {
      // a crossing during a hold joins it: one stacked FULL, one stinger, the beat restarted from the newest crossing
      const holdMs = i >= this.#cfg.bigIntensity ? this.#cfg.fullHoldBigMs : this.#cfg.fullHoldMs;
      const prior = this.#hold;
      const hold: Hold = {
        untilMs: Math.max(prior?.untilMs ?? 0, nowMs + holdMs),
        count: (prior?.count ?? 0) + msg.unlocksBanked,
        state: msg.state,
        tiersOpened: [...(prior?.tiersOpened ?? []), ...msg.tiersOpened],
      };
      this.#hold = hold;
      this.view.thresholdCents = msg.state.thresholdCents;
      this.view.progressDisplayCents = msg.state.thresholdCents;
      this.view.fullCount = hold.count;
      effects.push({ kind: "full", count: hold.count, untilMs: hold.untilMs });
    } else if (this.#hold !== null) {
      this.#hold.state = msg.state; // the fader stays FULL; the newest truth is what the hold ends on
    } else if (this.#adopt(msg.state)) {
      effects.push({ kind: "drained" });
    }
  }

  /** End the FULL hold (if any) at `atMs`: the stinger, then the state it was holding back, then its tier reveals. */
  #flush(atMs: number, effects: Effect[]): void {
    const hold = this.#hold;
    if (hold === null) return;
    this.#hold = null;
    effects.push({ kind: "unlock_stinger", count: hold.count });
    this.#scheduleReveals(hold.tiersOpened, atMs + TIER_STAGGER_MS);
    if (this.#adopt(hold.state)) effects.push({ kind: "drained" });
  }

  /** Take `state` as the display's truth. Returns whether the pool drained with it (the moment fires once). */
  #adopt(state: OverlayState): boolean {
    const wasDrained = this.view.drained;
    this.#state = state;
    const v = this.view;
    v.thresholdCents = state.thresholdCents;
    v.progressDisplayCents = state.progressCents;
    v.fullCount = 0;
    v.queue = state.queue;
    v.bankedTotal = state.bankedTotal;
    v.gates = [...state.gates];
    v.drained = state.drained;
    v.motes = { collecting: [...state.motes.collecting], ready: state.motes.ready.map((g) => [...g]) };
    this.#showTier(this.#shownTier(state.tier));
    return !wasDrained && state.drained;
  }

  /** The tier the rack may show: the state's, held just below the first reveal still waiting to play. */
  #shownTier(stateTier: number): number {
    const waiting = this.#reveals.map((r) => r.tier);
    return waiting.length === 0 ? stateTier : Math.min(stateTier, Math.min(...waiting) - 1);
  }

  /** Set `view.tier` and re-mask the outcomes above it from the adopted state. */
  #showTier(tier: number): void {
    this.view.tier = tier;
    this.#refreshOutcomes();
  }

  /**
   * `view.outcomes` from the adopted state: masked above `view.tier`; an outcome with a fire still to be revealed shows
   * what it had before the EARLIEST of them, live — two fires on one outcome read 3 → 2 → 1 as each is revealed.
   */
  #refreshOutcomes(): void {
    const tier = this.view.tier;
    this.view.outcomes = (this.#state?.outcomes ?? []).map((o) => {
      const shown: OverlayOutcome = o.tier <= tier ? { ...o } : { ...o, name: null, glyph: LOCKED_GLYPH };
      const pending = this.#pendingFires.find((f) => f.outcomeId === o.id);
      return pending === undefined ? shown : { ...shown, left: pending.leftBefore, used: pending.usedBefore, status: "live" };
    });
  }

  /** Queue `tier_open`s from `fromMs`, `TIER_STAGGER_MS` apart, after anything already queued; tiers already shown or queued are skipped. */
  #scheduleReveals(tiers: readonly number[], fromMs: number): void {
    const last = this.#reveals[this.#reveals.length - 1];
    let atMs = last === undefined ? fromMs : Math.max(fromMs, last.atMs + TIER_STAGGER_MS);
    for (const tier of [...tiers].sort((a, b) => a - b)) {
      if (tier <= this.view.tier || this.#reveals.some((r) => r.tier === tier)) continue;
      this.#reveals.push({ tier, atMs });
      atMs += TIER_STAGGER_MS;
    }
  }

  /** Play every reveal that is due, in order, and drop JUST REVEALED marks that have run out. */
  #release(nowMs: number, effects: Effect[]): void {
    while (this.#reveals.length > 0 && this.#reveals[0]!.atMs <= nowMs) {
      const { tier } = this.#reveals.shift()!;
      effects.push({ kind: "tier_open", tier });
      this.view.justRevealed.push({ tier, until: nowMs + this.#cfg.justRevealedMs });
      this.#showTier(Math.max(this.view.tier, tier));
    }
    if (this.view.justRevealed.length > 0) this.view.justRevealed = this.view.justRevealed.filter((j) => j.until > nowMs);
  }
}

/**
 * `model.apply` for the edges that must never throw (the socket's `onmessage`, the debug bar): a frame the model
 * rejects is logged and dropped — null — so one malformed message cannot wedge the overlay.
 */
export function tryApply(model: Pick<OverlayModel, "apply">, msg: OverlayMessage, nowMs: number): Effect[] | null {
  try {
    return model.apply(msg, nowMs);
  } catch (err) {
    console.error(`overlay: rejected a ${msg.type} message`, err);
    return null;
  }
}
