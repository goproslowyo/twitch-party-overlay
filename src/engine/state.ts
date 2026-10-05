/**
 * The projection: State is a pure fold of Ledger entries. `replay` and the live Engine both go through the
 * one `reduce` below — there is no second mutation path. Each fact has one source entry: a `contribution` moves Progress
 * and carries across Thresholds (arithmetic only); an `unlock` is what puts an Unlock in the Queue; a `threshold` entry
 * sets the Threshold; a `fire` consumes the Unlock it names and one of the Outcome's stock (`left` −1, `used` +1); a
 * `rebank` refunds it (the `unlock` that follows it re-queues the Unlock); `void`, `restock`, `outcome_status`, `queue_adjust` as documented on their cases.
 *
 * Stock is Ledger-only: `records` folds `stock` / `restock` / `fire` / `rebank` / `outcome_status` per Outcome id —
 * every id the Ledger ever touched, whether or not config still lists it — and `outcomes` is always `project(config, records)`:
 * the definitions config lists now, each joined to its record (none yet → left 0, used 0, live). Nothing reads `initialLeft`
 * here; the Engine seeds it as the first `stock` entry when it first meets an id.
 *
 * A record's `left` is the UNCLAMPED signed sum, so the fold is order-independent: a legacy Ledger whose Fires precede the
 * seed folds to initialLeft − fires once the seed arrives at the tail, instead of losing the Fires to a per-step floor.
 * `project` clamps to 0 on the way to `OutcomeState.left`, which is what `isLive` / `drained` and the screen read.
 *
 * Contributor Motes ride the same fold. `collecting` is one `MoteRecord` per contributor whose money is
 * in the Unlock being earned now; every `UnlockRef` carries its `group` — everyone whose money is in THAT Unlock. One rule,
 * no exception: a Contribution's credit is split across [what the current Unlock still needed, T, T, …, remainder] and
 * its mote belongs to every Unlock a share landed in (the $200 tip at $62 of $100 is in the first group for $38, alone in
 * the second for $100, and collecting for $62 — the five people whose $62 came first are in the first group only). Nobody
 * owns an Unlock: a group is a list, a record's `name` is for its glyph and picture, and the identity key is
 * `twitch:<id>` when known, else the lower-cased display name, and one fresh `anon:<seq>` per anonymous contribution.
 */
import type { Config, OutcomeDef } from "../config/schema.ts";
import type { Entry, EntryType } from "../ledger/types.ts";

/** The Ledger's fold for one Outcome id: what `project` joins to the definition. */
export interface StockRecord {
  left: number; // Σ signed `stock` deltas + legacy restocks − fires + rebank refunds — unclamped, may be negative (project clamps)
  used: number; // fires − rebanks
  status: "live" | "suspended" | "retired";
  seeded: boolean; // a `stock` entry has been written for this id (the Engine seeds `initialLeft` exactly once)
}

export interface OutcomeState extends OutcomeDef {
  status: StockRecord["status"];
  left: number;
  used: number;
}

/** One Contributor Mote: one person's money toward one Unlock. `name` is the latest display name (for the glyph / picture), null = anonymous, a blank mote. */
export interface MoteRecord {
  key: string; // `moteKey` — State only; the wire's `Mote.key` is its fnv1a hash (`moteWireKey`), so a `twitch:<id>` key never leaves the State
  name: string | null;
  twitchUserId: string | null; // for the Avatar Picture lookup; stays in the State (the wire gets the picture URL, and the hashed key)
  loginHint: string | null; // ditto, when there is no id
  cents: number; // this person's share of THIS Unlock (or of the one collecting)
  firstSeq: number; // the Contribution that started the record
  lastSeq: number; // the latest Contribution in it — the wire's order
}

export interface UnlockRef {
  seq: number; // the `unlock` entry
  contributionSeq: number | null; // the crossing Contribution; null for threshold-edit and queue-adjust unlocks
  /** The crossing Contribution alone took this Unlock from zero to the Threshold — the one case a drop may name someone. */
  solo: boolean;
  /** Everyone whose money is in this Unlock, in lastSeq order; [] for an adjust Unlock or a legacy Ledger. A list — never an owner. */
  group: MoteRecord[];
}

export interface State {
  policyVersion: number;
  thresholdCents: number;
  progressCents: number;
  queue: UnlockRef[]; // banked, un-Fired, FIFO (oldest first) — Fire consumes queue[0]
  bankedTotal: number; // gate counter: threshold crossings + positive queue adjustments; rebanks excluded
  firedTotal: number;
  tier: number; // highest open tier index (opens when bankedTotal >= gates[n]; never closes)
  records: Record<string, StockRecord>; // per id, every id the Ledger ever touched (kept when config drops the definition)
  outcomes: OutcomeState[]; // always project(config, records)
  drained: boolean; // no live outcome: live = tier <= state.tier && status === "live" && left > 0
  lastSeq: number;
  collecting: Record<string, MoteRecord>; // by `moteKey`: the motes of the Unlock being earned now
  pendingGroups: MoteRecord[][]; // groups a `contribution` / `threshold` entry banked, each taken by the `unlock` (source "threshold") that follows it
  firedGroups: Record<number, MoteRecord[]>; // by fireSeq: the group a Fire consumed, kept so the `unlock` a rebank appends can carry it back. Retained for the Ledger's life on purpose: any past fire may be rebanked (a rebank takes its entry; nothing else ever prunes)
}

export type EngineErrorCode = "NO_UNLOCKS" | "POOL_DRAINED" | "NOT_RESTOCKABLE" | "UNKNOWN_OUTCOME" | "UNKNOWN_ENTRY" | "INVALID";

/** Raised by the Engine (and by the reducer for entries it cannot apply). The message always starts with the code. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  constructor(code: EngineErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`);
    this.name = "EngineError";
    this.code = code;
  }
}

/** What the reducer needs beyond the entry itself. */
export interface ReduceContext {
  config: Config;
  /** An earlier entry by seq — `void` reads the credited cents off the contribution it voids, `rebank` the Outcome off the fire it refunds. */
  entry(seq: number): Entry | undefined;
}

/** `Entry` as a discriminated union, so a switch on `type` narrows `payload`. */
type SomeEntry = { [T in EntryType]: Entry<T> }[EntryType];

/** The state before entry 1. `thresholdCents` defaults to config's; replay passes what the Ledger says (see `startingThresholdCents`). */
export function initialState(config: Config, thresholdCents: number = config.threshold.cents): State {
  return settle(
    {
      policyVersion: config.policy.version,
      thresholdCents,
      progressCents: 0,
      queue: [],
      bankedTotal: 0,
      firedTotal: 0,
      tier: 0,
      records: {},
      outcomes: project(config, {}),
      drained: false,
      lastSeq: 0,
      collecting: {},
      pendingGroups: [],
      firedGroups: {},
    },
    0,
    config,
  );
}

const EMPTY_RECORD: StockRecord = { left: 0, used: 0, status: "live", seeded: false };

/**
 * The Outcome list: config's definitions, in config order, each joined to its Ledger record (none yet → left 0, used 0, live).
 * The one place the signed sum is clamped: `OutcomeState.left` is never negative, the record underneath may be.
 */
export function project(config: Config, records: Record<string, StockRecord>): OutcomeState[] {
  return config.outcomes.map((o): OutcomeState => {
    const { left, used, status } = records[o.id] ?? EMPTY_RECORD;
    return { ...o, status, left: Math.max(0, left), used };
  });
}

/** The same Ledger under a new config (an editor act or a hand edit): `outcomes` re-projected from `records`, then settled. */
export function reprojectState(state: State, config: Config): State {
  return settle({ ...state, outcomes: project(config, state.records) }, state.lastSeq, config);
}

/** Pure: the state after `entry`. Never mutates `state`. */
export function reduce(state: State, entry: Entry, ctx: ReduceContext): State {
  return settle(apply(state, entry as SomeEntry, ctx), entry.seq, ctx.config);
}

/** Pure replay of a whole ledger. */
export function replay(entries: readonly Entry[], config: Config): State {
  const bySeq = new Map(entries.map((e) => [e.seq, e] as const));
  const ctx: ReduceContext = { config, entry: (seq) => bySeq.get(seq) };
  return entries.reduce((state, entry) => reduce(state, entry, ctx), initialState(config, startingThresholdCents(entries, config.threshold.cents)));
}

/**
 * The Threshold replay starts from. The Ledger is the runtime truth for the Threshold (the Engine seeds one `threshold`
 * entry into an empty Ledger, and every edit appends another), while config.json only carries the CURRENT value — so a
 * replay seeded from config after an edit would credit the earliest Contributions under a Threshold that was not yet in
 * force. Rule: the cents of the FIRST `threshold` entry whenever it precedes the first `contribution`; otherwise (a
 * legacy Ledger with Contributions before any `threshold` entry, or no `threshold` entry at all) the fallback — config's.
 */
export function startingThresholdCents(entries: readonly Entry[], fallbackCents: number): number {
  for (const e of entries) {
    if (e.type === "threshold") return (e as Entry<"threshold">).payload.cents;
    if (e.type === "contribution") return fallbackCents;
  }
  return fallbackCents;
}

/** The crossing rule: `while (progress >= threshold) progress -= threshold` — returns the carried remainder. */
export function carry(progressCents: number, thresholdCents: number): number {
  if (thresholdCents <= 0) return progressCents; // never valid (config + Engine guard it); guards the loop all the same
  while (progressCents >= thresholdCents) progressCents -= thresholdCents;
  return progressCents;
}

/** How many Unlocks `carry` would bank. */
export function crossings(progressCents: number, thresholdCents: number): number {
  return thresholdCents <= 0 ? 0 : Math.floor(progressCents / thresholdCents);
}

/** What a mote's identity is read from — the Contribution payload (older entries have no `twitchUserId`). */
export interface MoteIdentity {
  anonymous: boolean;
  displayName: string | null;
  twitchUserId?: string | null;
  loginHint?: string | null;
}

/**
 * The identity key: `twitch:<id>` when the source knew the id, else the lower-cased (trimmed) display name, and
 * `anon:<seq>` for an anonymous contribution — or one with no usable name — so anonymous money is never merged, whatever
 * else the payload carries. No merge across lanes beyond that: the same person by id and by name is two keys.
 */
export function moteKey(c: MoteIdentity, seq: number): string {
  if (isBlank(c)) return `anon:${seq}`;
  if (c.twitchUserId) return `twitch:${c.twitchUserId}`;
  return c.displayName!.trim().toLowerCase();
}

/** A blank mote: anonymous, or nobody to name — no name, no ids, never merged. */
function isBlank(c: MoteIdentity): boolean {
  return c.anonymous || (c.displayName ?? "").trim() === "";
}

/** A fresh record for `cents` of contribution `seq`'s money. */
function moteRecord(key: string, c: MoteIdentity, seq: number, cents: number): MoteRecord {
  if (isBlank(c)) return { key, name: null, twitchUserId: null, loginHint: null, cents, firstSeq: seq, lastSeq: seq };
  return { key, name: c.displayName, twitchUserId: c.twitchUserId ?? null, loginHint: c.loginHint ?? null, cents, firstSeq: seq, lastSeq: seq };
}

/** `collecting` with `cents` more of `seq`'s money under `key`: a repeat giver's one record grows (newest name, ids kept), anyone else gets a record. */
function addMote(collecting: Record<string, MoteRecord>, key: string, c: MoteIdentity, seq: number, cents: number): Record<string, MoteRecord> {
  const prior = collecting[key];
  const fresh = moteRecord(key, c, seq, cents);
  const record: MoteRecord = prior === undefined ? fresh : { ...fresh, twitchUserId: prior.twitchUserId ?? fresh.twitchUserId, loginHint: prior.loginHint ?? fresh.loginHint, cents: prior.cents + cents, firstSeq: prior.firstSeq };
  return { ...collecting, [key]: record };
}

/** A group from a collecting map: the wire's order, oldest `lastSeq` first (unique — one Contribution touches one key). */
export function moteGroup(collecting: Record<string, MoteRecord>): MoteRecord[] {
  return Object.values(collecting).sort((a, b) => a.lastSeq - b.lastSeq);
}

function apply(state: State, entry: SomeEntry, ctx: ReduceContext): State {
  switch (entry.type) {
    case "contribution": {
      const { progressCents: credited } = entry.payload;
      const before = state.progressCents;
      const T = state.thresholdCents;
      const progressCents = carry(before + credited, T);
      if (credited <= 0) return { ...state, progressCents }; // no money in the Unlock, no mote
      const key = moteKey(entry.payload, entry.seq);
      const n = crossings(before + credited, T);
      if (n === 0) return { ...state, progressCents, collecting: addMote(state.collecting, key, entry.payload, entry.seq, credited) };
      // The credit split across [what this Unlock still needed, T, T, …, remainder]: the first crossing's group is everyone
      // collecting plus this share; each further full crossing is this person alone; the remainder starts the next collecting.
      const first = moteGroup(addMote(state.collecting, key, entry.payload, entry.seq, T - before));
      const full = Array.from({ length: n - 1 }, () => [moteRecord(key, entry.payload, entry.seq, T)]);
      const collecting = progressCents > 0 ? { [key]: moteRecord(key, entry.payload, entry.seq, progressCents) } : {};
      return { ...state, progressCents, collecting, pendingGroups: [...state.pendingGroups, first, ...full] };
    }

    case "threshold": {
      const { cents } = entry.payload;
      const n = crossings(state.progressCents, cents);
      const progressCents = carry(state.progressCents, cents);
      if (n === 0) return { ...state, thresholdCents: cents, progressCents };
      // An edit that banks: the whole collecting rides the first new Unlock, the rest carry nobody (nobody's money crossed twice).
      const groups: MoteRecord[][] = [moteGroup(state.collecting), ...Array.from({ length: n - 1 }, (): MoteRecord[] => [])];
      return { ...state, thresholdCents: cents, progressCents, collecting: {}, pendingGroups: [...state.pendingGroups, ...groups] };
    }

    case "unlock": {
      const { source, contributionSeq, fireSeq } = entry.payload;
      const solo = entry.payload.solo ?? false; // older Ledgers have no `solo`: the crowd's
      if (source === "rebank") {
        // A rebank re-queues an Unlock the crowd already earned: front of the Queue, not a new gate count, the same group.
        const group = fireSeq === undefined ? [] : (state.firedGroups[fireSeq] ?? []);
        const firedGroups = { ...state.firedGroups };
        if (fireSeq !== undefined) delete firedGroups[fireSeq];
        return { ...state, queue: [{ seq: entry.seq, contributionSeq, solo, group }, ...state.queue], firedGroups };
      }
      // A threshold crossing takes the next group its contribution / threshold entry queued; an adjust (or a legacy Ledger with none queued) carries nobody.
      const takes = source === "threshold" && state.pendingGroups.length > 0;
      const ref: UnlockRef = { seq: entry.seq, contributionSeq, solo, group: takes ? state.pendingGroups[0]! : [] };
      return { ...state, queue: [...state.queue, ref], bankedTotal: state.bankedTotal + 1, pendingGroups: takes ? state.pendingGroups.slice(1) : state.pendingGroups };
    }

    case "queue_adjust": {
      // A positive delta is represented by the `unlock` (source "adjust") entries that follow it.
      const { delta } = entry.payload;
      if (delta >= 0) return state;
      return { ...state, queue: state.queue.slice(0, Math.max(0, state.queue.length + delta)) };
    }

    case "void": {
      const target = ctx.entry(entry.payload.contributionSeq) as SomeEntry | undefined;
      if (target === undefined || target.type !== "contribution") return state; // the live Engine rejects these before they are written
      const { progressCents: credited } = target.payload;
      // The key's collecting mote shrinks by the voided credit (floored away like the Progress); banked groups are untouched — the Unlock stays.
      const key = moteKey(target.payload, target.seq);
      const record = state.collecting[key];
      let collecting = state.collecting;
      if (record !== undefined) {
        collecting = { ...state.collecting };
        if (record.cents - credited <= 0) delete collecting[key];
        else collecting[key] = { ...record, cents: record.cents - credited };
      }
      return { ...state, progressCents: Math.max(0, state.progressCents - credited), collecting };
    }

    case "stock": {
      // Signed; the first one for an id is its seed. The record keeps the raw sum; `project` clamps.
      const { outcomeId, delta } = entry.payload;
      return withRecord(state, ctx.config, outcomeId, (r) => ({ ...r, left: r.left + delta, seeded: true }));
    }

    case "restock": {
      // Legacy positive-only Mod restock; not a seed.
      const { outcomeId, charges } = entry.payload;
      return withRecord(state, ctx.config, outcomeId, (r) => ({ ...r, left: r.left + charges }));
    }

    case "outcome_status": {
      const { outcomeId, status } = entry.payload;
      return withRecord(state, ctx.config, outcomeId, (r) => ({ ...r, status }));
    }

    case "fire": {
      // Consumes the Unlock the entry names (the Engine always fires queue[0]) and one of the drawn Outcome's stock.
      // The group rides the fire event from the consumed UnlockRef; it is also kept by fireSeq for the `unlock` a rebank appends.
      const { unlockSeq, outcomeId } = entry.payload;
      const consumed = state.queue.find((u) => u.seq === unlockSeq);
      const queue = state.queue.filter((u) => u.seq !== unlockSeq);
      const firedGroups = consumed === undefined ? state.firedGroups : { ...state.firedGroups, [entry.seq]: consumed.group };
      // `left` may go negative here (a legacy Ledger's Fires before the seed); the seed at the tail brings the sum back.
      return withRecord({ ...state, queue, firedTotal: state.firedTotal + 1, firedGroups }, ctx.config, outcomeId, (r) => ({ ...r, left: r.left - 1, used: r.used + 1 }));
    }

    case "rebank": {
      // Refunds the fired stock; the `unlock` (source "rebank") the Engine appends right after re-queues the Unlock.
      const fired = ctx.entry(entry.payload.fireSeq) as SomeEntry | undefined;
      if (fired === undefined || fired.type !== "fire") return state; // the live Engine rejects these before they are written
      return withRecord({ ...state, firedTotal: state.firedTotal - 1 }, ctx.config, fired.payload.outcomeId, (r) => ({ ...r, left: r.left + 1, used: Math.max(0, r.used - 1) }));
    }

    case "outcome_change": // a definition change is config's business; the next reprojection picks it up
    case "config_change":
    case "auth_failure":
    case "note":
      return state;
  }
}

/**
 * Upserts the id's record (an id config never listed still gets one) and re-projects `outcomes` from the result.
 *
 * Deliberately projects against `ctx.config` as it is NOW, not a config captured with the state: the Engine calls
 * `reprojectState` on every config change the moment it lands, so the current config is always the truth and a
 * record-touching entry seeing a definition added since the last entry is consistent with that, never a surprise.
 */
function withRecord(state: State, config: Config, outcomeId: string, change: (r: StockRecord) => StockRecord): State {
  const records = { ...state.records, [outcomeId]: change(state.records[outcomeId] ?? EMPTY_RECORD) };
  return { ...state, records, outcomes: project(config, records) };
}

/** Live = in an open tier, status "live", stock left — the pool a Fire draws over. */
export function isLive(o: OutcomeState, tier: number): boolean {
  return o.tier <= tier && o.status === "live" && o.left > 0;
}

/** After every entry: open tiers the banked count has reached (they never close), recompute `drained`, stamp `lastSeq`. */
function settle(state: State, seq: number, config: Config): State {
  const { gates } = config.tiers;
  let tier = state.tier;
  while (tier + 1 < gates.length && state.bankedTotal >= gates[tier + 1]!) tier++;
  const drained = !state.outcomes.some((o) => isLive(o, tier));
  return { ...state, tier, drained, lastSeq: seq };
}
