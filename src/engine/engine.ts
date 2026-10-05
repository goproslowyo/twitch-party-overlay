/**
 * The Engine: every command becomes Ledger entries written in one `appendMany` transaction (`contribute`
 * wraps its raw-event record in the same one), and the live State is updated by folding those same entries through the
 * reducer `replay` uses — only AFTER the transaction has committed, so a failed COMMIT can never leave the projection
 * ahead of the Ledger. Listeners get the post-mutation state.
 */
import type { Config, OutcomeDef } from "../config/schema.ts";
import type { Contribution } from "../ingest/contribution.ts";
import type { AppendItem, AppendPlan, Ledger } from "../ledger/ledger.ts";
import type { Entry, EntryPayload, EntryType } from "../ledger/types.ts";
import { draw } from "./draw.ts";
import { progressCents } from "./policy.ts";
import { EngineError, crossings, isLive, reduce, replay, reprojectState, type OutcomeState, type ReduceContext, type State, type UnlockRef } from "./state.ts";

export { EngineError, type EngineErrorCode } from "./state.ts";

export interface FireResult {
  seq: number;
  unlock: UnlockRef;
  outcome: OutcomeState; // after decrement
  contributor: { displayName: string | null; anonymous: boolean } | null;
  miniDraw?: { title: string; list: string[]; pick: string };
  drained: boolean;
}

export type StateEventReason = "threshold" | "rebank" | "restock" | "outcome_status" | "queue_adjust" | "void" | "outcomes" | "stock";

export type EngineEvent =
  | { type: "contribution"; entry: Entry<"contribution">; unlocksBanked: number; tiersOpened: number[]; state: State }
  | { type: "fire"; entry: Entry<"fire">; fire: FireResult; state: State }
  | { type: "state"; reason: StateEventReason; tiersOpened: number[]; state: State };

export type ContributeResult = { duplicate: true } | { duplicate: false; entry: Entry<"contribution">; unlocksBanked: number; tiersOpened: number[] };

export interface EngineOptions {
  rng?: () => number;
  now?: () => Date;
}

/** Every value an Outcome's `status` may take — the Engine's rule, and the API's validation (one definition). */
export const OUTCOME_STATUSES: ReadonlySet<string> = new Set<OutcomeState["status"]>(["live", "suspended", "retired"]);

/** Mini-draw titles, by the list the Outcome draws from. */
const MINI_DRAW_TITLES: Record<NonNullable<OutcomeDef["miniDraw"]>, string> = {
  genreRoulette: "GENRE ROULETTE · 10–15 MIN",
  chatRules: "CHAT RULE · 10 MIN",
};

/** The tiers that opened going from `before` to `after` (they never close). */
function tiersBetween(before: State, after: State): number[] {
  const opened: number[] = [];
  for (let tier = before.tier + 1; tier <= after.tier; tier++) opened.push(tier);
  return opened;
}

/** A typed AppendItem: the payload is checked against the entry type. */
function item<T extends EntryType>(type: T, actor: string, payload: EntryPayload[T]): AppendItem {
  return { type, actor, payload };
}

export class Engine {
  readonly #ledger: Ledger;
  readonly #config: () => Config;
  readonly #rng: () => number; // the draw, then the mini-draw pick
  readonly #now: () => Date;
  readonly #listeners = new Set<(ev: EngineEvent) => void>();
  readonly #voided: Set<number>; // contributionSeqs that already have a `void` entry — a second void of the same one is INVALID
  readonly #rebanked: Set<number>; // fireSeqs that already have a `rebank` entry — a second rebank of the same Fire is INVALID
  #state: State;

  constructor(ledger: Ledger, config: () => Config, opts: EngineOptions = {}) {
    this.#ledger = ledger;
    this.#config = config;
    this.#rng = opts.rng ?? Math.random;
    this.#now = opts.now ?? (() => new Date());
    // The Ledger is the runtime truth for the Threshold: an empty Ledger gets the starting Threshold as entry 1, so a replay
    // after a Threshold edit (config.json carries only the current value) starts from the Threshold that was in force.
    let entries = ledger.all();
    const fresh = entries.length === 0;
    if (fresh) entries = [ledger.append("threshold", "system:boot", { cents: config().threshold.cents })];
    this.#state = replay(entries, config());
    this.#voided = new Set(entries.filter((e): e is Entry<"void"> => e.type === "void").map((e) => e.payload.contributionSeq));
    this.#rebanked = new Set(entries.filter((e): e is Entry<"rebank"> => e.type === "rebank").map((e) => e.payload.fireSeq));
    // A hand edit of `threshold.cents` while the service was down applies now, the way an API edit would: RECORDED as a
    // `threshold` entry (by system:file) so the Ledger stays the truth and replay stays exact — never a silent rebase.
    const edited = config().threshold.cents;
    if (edited !== this.#state.thresholdCents) this.setThreshold(edited, "system:file");
    // Stock is Ledger-only: every Outcome config lists gets its `initialLeft` as a `stock` seed the first time
    // the Ledger meets its id — by system:boot into a fresh Ledger, by system:file when an existing Ledger (a legacy one
    // with Fires but no `stock` entries, or one that missed a hand edit while the service was down) is behind config.
    this.reproject(fresh ? "system:boot" : "system:file");
  }

  /** The live projection — a fresh object after every mutation, never mutated in place. */
  get state(): State {
    return this.#state;
  }

  on(fn: (ev: EngineEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /**
   * Credit a Contribution: the raw event is recorded (dedupe on source + sourceId), then one `contribution` entry
   * followed by one `unlock` per Threshold crossing. Raw event and entries commit in ONE transaction: if anything
   * fails after `recordRaw`, the (source, sourceId) is not marked seen and a redelivery is credited, not deduped.
   */
  contribute(c: Contribution, actor: string, raw?: unknown): ContributeResult {
    const config = this.#config();
    const credited = progressCents(c.face, config.policy);
    if (!Number.isInteger(credited) || credited < 0) throw new EngineError("INVALID", `policy credited ${credited} cents for ${JSON.stringify(c.face)}; must be a non-negative integer`);

    const before = this.#state.progressCents;
    const unlocksBanked = crossings(before + credited, this.#state.thresholdCents);
    const contribution = item("contribution", actor, { ...c, progressCents: credited, policyVersion: config.policy.version });
    // The solo rule: unlock k (1-based) of this Contribution is `solo` when k > 1 or the Progress before it was exactly 0 —
    // this one person's money alone took it from zero to the Threshold. Every other Unlock is the crowd's and names nobody.
    const unlocks: AppendPlan[] = Array.from({ length: unlocksBanked }, (_, i) => (batch: readonly Entry[]) =>
      item("unlock", actor, { source: "threshold", contributionSeq: batch[0]!.seq, solo: i > 0 || before === 0 }),
    );

    // Only the writes run inside the transaction: `null` when the raw event is a duplicate, else the appended entries.
    const entries = this.#ledger.transaction((): Entry[] | null =>
      this.#ledger.recordRaw(c.source, c.sourceId, raw ?? c).duplicate ? null : this.#ledger.appendMany([contribution, ...unlocks]),
    );
    if (entries === null) return { duplicate: true };

    // Fold and emit after COMMIT: a failed commit leaves the projection untouched, a throwing listener cannot roll back a credit.
    const tiersOpened = this.#fold(entries, config);
    const entry = entries[0] as Entry<"contribution">;
    this.#emit({ type: "contribution", entry, unlocksBanked, tiersOpened, state: this.#state });
    return { duplicate: false, entry, unlocksBanked, tiersOpened };
  }

  /** Progress −= the credited cents, floored at 0; the Queue is untouched (an Unlock, once banked, is the crowd's). Once per Contribution. */
  voidContribution(seq: number, actor: string, reason: string): void {
    const target = this.#ledger.get(seq);
    if (target === undefined || target.type !== "contribution") throw new EngineError("UNKNOWN_ENTRY", `no contribution with seq ${seq}`);
    if (this.#voided.has(seq)) throw new EngineError("INVALID", `contribution ${seq} is already voided`);
    this.#mutate("void", [item("void", actor, { contributionSeq: seq, reason })]);
  }

  /** Forward-only Threshold edit: partial Progress carries in cents and banks immediately if it now crosses. */
  setThreshold(cents: number, actor: string): { unlocksBanked: number } {
    if (!Number.isInteger(cents) || cents <= 0) throw new EngineError("INVALID", `threshold must be a positive integer number of cents, got ${cents}`);
    const unlocksBanked = crossings(this.#state.progressCents, cents);
    const unlocks = Array.from({ length: unlocksBanked }, () => item("unlock", actor, { source: "threshold", contributionSeq: null }));
    this.#mutate("threshold", [item("threshold", actor, { cents }), ...unlocks]);
    return { unlocksBanked };
  }

  /** +N banks N Unlocks (they count toward gates); −N removes from the newest end and never takes the Queue below 0. */
  adjustQueue(delta: number, actor: string, reason: string): void {
    if (!Number.isInteger(delta) || delta === 0) throw new EngineError("INVALID", `queue delta must be a non-zero integer, got ${delta}`);
    if (delta > 0) {
      const unlocks = Array.from({ length: delta }, () => item("unlock", actor, { source: "adjust", contributionSeq: null }));
      this.#mutate("queue_adjust", [item("queue_adjust", actor, { delta, reason }), ...unlocks]);
      return;
    }
    const clamped = -Math.min(-delta, this.#state.queue.length);
    if (clamped === 0) throw new EngineError("INVALID", "the queue is already empty");
    this.#mutate("queue_adjust", [item("queue_adjust", actor, { delta: clamped, reason })]);
  }

  /**
   * Fire consumes queue[0] and draws over the live Outcomes with #rng; the roll and any mini-draw pick are recorded in the
   * `fire` entry, so the draw is auditable and never re-rolled. NO_UNLOCKS / POOL_DRAINED are raised before anything is written.
   */
  fire(actor: string): FireResult {
    const unlock = this.#state.queue[0];
    if (unlock === undefined) throw new EngineError("NO_UNLOCKS", "the queue is empty");
    const live = this.#state.outcomes.filter((o) => isLive(o, this.#state.tier));
    if (live.length === 0) throw new EngineError("POOL_DRAINED", "no live outcome has stock left");
    const config = this.#config();
    const { outcome, roll } = draw(live, this.#rng);
    const miniDraw = outcome.miniDraw === undefined ? undefined : this.#miniDraw(outcome.miniDraw, config);
    const payload: EntryPayload["fire"] = { unlockSeq: unlock.seq, outcomeId: outcome.id, roll, stockAfter: outcome.left - 1, ...(miniDraw === undefined ? {} : { miniDraw }) };

    const entries = this.#ledger.appendMany([item("fire", actor, payload)]);
    this.#fold(entries, config);
    const entry = entries[0] as Entry<"fire">;
    const fire: FireResult = {
      seq: entry.seq,
      unlock,
      outcome: this.#outcome(outcome.id),
      contributor: this.#contributor(unlock.contributionSeq),
      ...(entry.payload.miniDraw === undefined ? {} : { miniDraw: entry.payload.miniDraw }),
      drained: this.#state.drained,
    };
    this.#emit({ type: "fire", entry, fire, state: this.#state });
    return fire;
  }

  /** Refunds the Fire (left +1, used −1) and re-queues its Unlock at the FRONT (source "rebank", same contributionSeq and solo). Once per Fire. */
  rebank(fireSeq: number, actor: string, reason: string): void {
    const fired = this.#ledger.get(fireSeq);
    if (fired === undefined || fired.type !== "fire") throw new EngineError("UNKNOWN_ENTRY", `no fire with seq ${fireSeq}`);
    if (this.#rebanked.has(fireSeq)) throw new EngineError("INVALID", `fire ${fireSeq} is already rebanked`);
    const unlock = this.#ledger.get((fired as Entry<"fire">).payload.unlockSeq);
    const original = unlock !== undefined && unlock.type === "unlock" ? (unlock as Entry<"unlock">).payload : null;
    const contributionSeq = original?.contributionSeq ?? null;
    const solo = original?.solo ?? false; // the same Unlock comes back: whoever crossed alone still did
    this.#mutate("rebank", [item("rebank", actor, { fireSeq, reason }), item("unlock", actor, { source: "rebank", contributionSeq, fireSeq, solo })]);
  }

  /** Re-arm a restockable Outcome by a deliberate act — never automatically. */
  restock(outcomeId: string, charges: number, actor: string): void {
    const outcome = this.#outcome(outcomeId);
    if (!outcome.restockable) throw new EngineError("NOT_RESTOCKABLE", `${outcomeId} is a one-off`);
    if (!Number.isInteger(charges) || charges <= 0) throw new EngineError("INVALID", `charges must be a positive integer, got ${charges}`);
    this.#mutate("restock", [item("restock", actor, { outcomeId, charges })]);
  }

  /**
   * Re-read `config.outcomes` — the one hook boot, the file watcher and PUT /api/config all go through: the
   * Outcome list becomes config's definitions × the Ledger's stock records; every id the Ledger has never stocked gets its
   * `initialLeft` as a `stock` seed (reason "initial" — written even for 0, so the id counts as seeded and a later edit of
   * `initialLeft` changes nothing); every id that left config with Left still on it is zeroed (reason "removed") so the
   * Ledger, not a missing definition, says where that stock went. Emits `state` reason "outcomes" when the list changed
   * or anything was written; a second call with the same config writes and emits nothing.
   */
  reproject(actor: string): void {
    const config = this.#config();
    const before = this.#state;
    const listed = new Set(config.outcomes.map((o) => o.id));
    const items: AppendItem[] = [];
    for (const o of config.outcomes) if (before.records[o.id]?.seeded !== true) items.push(item("stock", actor, { outcomeId: o.id, delta: o.initialLeft, reason: "initial" }));
    for (const [outcomeId, r] of Object.entries(before.records)) if (!listed.has(outcomeId) && r.left > 0) items.push(item("stock", actor, { outcomeId, delta: -r.left, reason: "removed" }));
    if (items.length > 0) this.#fold(this.#ledger.appendMany(items), config);
    // Definition-only edits (a name, a tier) write nothing; the projection still has to follow config.
    this.#state = reprojectState(this.#state, config);
    if (items.length === 0 && JSON.stringify(before.outcomes) === JSON.stringify(this.#state.outcomes)) return;
    this.#emit({ type: "state", reason: "outcomes", tiersOpened: tiersBetween(before, this.#state), state: this.#state });
  }

  /**
   * The streamer's Left edit (any Outcome, one-offs included): ONE signed `stock` entry whose delta takes the id's record
   * to `left`, so `Left` reads exactly that afterwards — measured against the record's raw sum, which only differs from the
   * shown (clamped) Left on a legacy Ledger that over-fired before its seed. No entry when nothing changes.
   */
  setLeft(outcomeId: string, left: number, actor: string, reason: string): void {
    this.#outcome(outcomeId);
    if (!Number.isInteger(left) || left < 0) throw new EngineError("INVALID", `left must be a non-negative integer, got ${left}`);
    const delta = left - (this.#state.records[outcomeId]?.left ?? 0);
    if (delta === 0) return;
    this.#mutate("stock", [item("stock", actor, { outcomeId, delta, reason })]);
  }

  setOutcomeStatus(outcomeId: string, status: OutcomeState["status"], actor: string): void {
    this.#outcome(outcomeId);
    if (!OUTCOME_STATUSES.has(status)) throw new EngineError("INVALID", `unknown outcome status ${JSON.stringify(status)}`);
    this.#mutate("outcome_status", [item("outcome_status", actor, { outcomeId, status })]);
  }

  #outcome(outcomeId: string): OutcomeState {
    const outcome = this.#state.outcomes.find((o) => o.id === outcomeId);
    if (outcome === undefined) throw new EngineError("UNKNOWN_OUTCOME", `no outcome with id ${JSON.stringify(outcomeId)}`);
    return outcome;
  }

  /** One `rng()` call picks from the config list at Fire time; an empty list means no mini-draw. */
  #miniDraw(kind: NonNullable<OutcomeDef["miniDraw"]>, config: Config): FireResult["miniDraw"] {
    const list = config.lists[kind];
    if (list.length === 0) return undefined;
    const pick = list[Math.min(list.length - 1, Math.floor(this.#rng() * list.length))]!;
    return { title: MINI_DRAW_TITLES[kind], list: [...list], pick };
  }

  /**
   * Who crossed the Threshold for this Unlock — `null` for threshold-edit and queue-adjust Unlocks, and `null` once that
   * Contribution was voided (the solo exception requires the money to be real; a void leaves the Unlock banked but
   * nobody is credited for it).
   */
  #contributor(contributionSeq: number | null): FireResult["contributor"] {
    if (contributionSeq === null || this.#voided.has(contributionSeq)) return null;
    const entry = this.#ledger.get(contributionSeq);
    if (entry === undefined || entry.type !== "contribution") return null;
    const { displayName, anonymous } = (entry as Entry<"contribution">).payload;
    return { displayName, anonymous };
  }

  /** Write the entries in one transaction (`appendMany` is its own), then fold them and emit a "state" event. */
  #mutate(reason: StateEventReason, items: readonly AppendPlan[]): void {
    const entries = this.#ledger.appendMany(items);
    const tiersOpened = this.#fold(entries, this.#config());
    this.#emit({ type: "state", reason, tiersOpened, state: this.#state });
  }

  /**
   * Fold COMMITTED entries into the live projection — call it only after the transaction that wrote them has returned, so
   * the projection never runs ahead of the Ledger. Also the one place a `void` / `rebank` entry arms its once-only guard,
   * before any listener runs. Returns the tiers that opened.
   */
  #fold(entries: readonly Entry[], config: Config): number[] {
    const ctx: ReduceContext = { config, entry: (seq) => this.#ledger.get(seq) };
    const before = this.#state;
    this.#state = entries.reduce((state, entry) => reduce(state, entry, ctx), before);
    for (const e of entries) {
      if (e.type === "void") this.#voided.add((e as Entry<"void">).payload.contributionSeq);
      if (e.type === "rebank") this.#rebanked.add((e as Entry<"rebank">).payload.fireSeq);
    }
    return tiersBetween(before, this.#state);
  }

  #emit(ev: EngineEvent): void {
    for (const fn of this.#listeners) fn(ev);
  }
}
