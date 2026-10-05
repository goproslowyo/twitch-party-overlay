/**
 * One short line per Ledger entry — the one wording the Dashboard's Ledger page and the console share (follow-up 1).
 * Display names only (never an email, token, cookie or raw payload); the face wording is the overlay's own `whatText`,
 * the money `money`. Vocabulary rule: an Unlock is "from" a contribution or "re-queued", never "banked".
 */
import { money, whatText } from "../overlay/copy.ts";
import type { Entry, EntryPayload } from "./types.ts";

export interface DescribeContext {
  /** The Outcome behind an id (glyph + name); unknown or absent → the id. */
  outcome?: (id: string) => { name: string; glyph: string } | undefined;
  /** An earlier entry by seq — a `fire` line names the contributor behind its Unlock. */
  entry?: (seq: number) => Entry | undefined;
  /** The fader after the entry landed: `→ $23 of $50` on a contribution (both or nothing). */
  progressCents?: number;
  thresholdCents?: number;
  /** Unlocks a contribution banked (the `unlock` entries written right after it): `· +2 UNLOCKS`. */
  unlocks?: number;
}

/** A contribution's message (Ko-fi note, tip message, "Ko-fi" on a Manual Credit) is clipped to this. */
export const MESSAGE_CLIP = 80;
const CONFIG_PATHS_SHOWN = 4;
/** How much of a What it is line a Ledger line shows, the ellipsis included (`clip`, like MESSAGE_CLIP). */
export const DESCRIPTION_SHOWN = 60;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The one truncation rule: a text longer than `max` is cut so that text + ellipsis is exactly `max` characters. */
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const handle = (displayName: string | null, anonymous: boolean): string => (anonymous || displayName === null ? "Anonymous" : `@${displayName}`);

/** The console shape: `#143 contribution system:streamelements — @dana tipped $10 (+$10) → $23 of $50`. */
export function entryLine(e: Entry, ctx: DescribeContext = {}): string {
  return `#${e.seq} ${e.type} ${e.actor} — ${describeEntry(e, ctx)}`;
}

export function describeEntry(e: Entry, ctx: DescribeContext = {}): string {
  switch (e.type) {
    case "contribution": {
      const p = (e as Entry<"contribution">).payload;
      const fader = ctx.progressCents !== undefined && ctx.thresholdCents !== undefined ? ` → ${money(ctx.progressCents)} of ${money(ctx.thresholdCents)}` : "";
      const unlocks = ctx.unlocks !== undefined && ctx.unlocks > 0 ? ` · +${ctx.unlocks} UNLOCK${ctx.unlocks === 1 ? "" : "S"}` : "";
      const message = p.message === undefined || p.message === "" ? "" : ` · ${clip(p.message, MESSAGE_CLIP)}`;
      return `${handle(p.displayName, p.anonymous)} ${whatText(p.face, p.source)} (+${money(p.progressCents)})${fader}${unlocks}${message}`;
    }
    case "void": {
      const p = (e as Entry<"void">).payload;
      return `voided #${p.contributionSeq} (${p.reason})`;
    }
    case "unlock": {
      const p = (e as Entry<"unlock">).payload;
      if (p.source === "rebank") return `unlock re-queued from fire #${p.fireSeq ?? "?"}`;
      if (p.source === "adjust") return "unlock added by queue adjustment";
      return p.contributionSeq === null ? "unlock from the threshold change" : `unlock from contribution #${p.contributionSeq}`;
    }
    case "fire": {
      const p = (e as Entry<"fire">).payload;
      const o = ctx.outcome?.(p.outcomeId);
      const contributor = contributorOf(p.unlockSeq, ctx);
      const mini = p.miniDraw === undefined ? "" : ` · ${p.miniDraw.title}: ${p.miniDraw.pick}`;
      return `${o === undefined ? p.outcomeId : `${o.glyph} ${o.name}`}${contributor === undefined ? "" : ` for ${contributor}`} (${p.stockAfter} left)${mini}`;
    }
    case "rebank": {
      const p = (e as Entry<"rebank">).payload;
      return `re-queued fire #${p.fireSeq} (${p.reason})`;
    }
    case "restock": {
      const p = (e as Entry<"restock">).payload;
      return `+${p.charges} ${outcomeName(p.outcomeId, ctx)}`;
    }
    case "outcome_status": {
      const p = (e as Entry<"outcome_status">).payload;
      return `${outcomeName(p.outcomeId, ctx)} → ${p.status}`;
    }
    case "queue_adjust": {
      const p = (e as Entry<"queue_adjust">).payload;
      return `queue ${p.delta > 0 ? "+" : ""}${p.delta} (${p.reason})`;
    }
    case "threshold":
      return `threshold → ${money((e as Entry<"threshold">).payload.cents)}`;
    case "config_change": {
      const { lists, rest } = splitListChanges((e as Entry<"config_change">).payload.diff);
      const items = [...lists.map((l) => `${l.name} ${l.added.length > 0 ? `+${l.added.length}` : ""}${l.added.length > 0 && l.removed.length > 0 ? " " : ""}${l.removed.length > 0 ? `−${l.removed.length}` : ""}`.trimEnd()), ...new Set(rest.map((d) => d.path))];
      const shownItems = items.slice(0, CONFIG_PATHS_SHOWN);
      return `${plural(items.length, "change")}: ${shownItems.join(", ")}${items.length > shownItems.length ? ", …" : ""}`; // the rest: describeEntryFull
    }
    case "auth_failure": {
      const p = (e as Entry<"auth_failure">).payload;
      return `${p.ip} ${p.path} — ${p.reason}`;
    }
    case "note":
      return (e as Entry<"note">).payload.text;
    case "stock": {
      const p = (e as Entry<"stock">).payload;
      return `${outcomeName(p.outcomeId, ctx)} left ${signed(p.delta)} (${p.reason})`;
    }
    case "outcome_change": {
      const p = (e as Entry<"outcome_change">).payload;
      const name = outcomeName(p.outcomeId, ctx);
      const changes = Object.entries(p.changes);
      if (p.action === "delete") return `${name} deleted`;
      if (p.action === "add") return `${name} added (${changes.map(([key, c]) => `${key} ${value(key, c.to)}`).join(", ")})`;
      return `${name}: ${changes.map(([key, c]) => change(key, c.from, c.to)).join(", ")}`;
    }
  }
}

const outcomeName = (id: string, ctx: DescribeContext): string => ctx.outcome?.(id)?.name ?? id;
/** `+2` / `−5` — a real minus sign, the way the Dashboard prints a Left change. */
const signed = (n: number): string => (n < 0 ? `−${-n}` : `+${n}`);
/**
 * A changed field's value: strings bare, anything else as JSON; an optional field that was absent (miniDraw, raffle) is
 * "none". The whole `description` rule lives here and in `change` below — nowhere else: an empty one is "none" (like an
 * absent miniDraw), a long one (up to 240 characters, and an edit carries two) is clipped to DESCRIPTION_SHOWN so one
 * Ledger line stays a line.
 */
const value = (key: string, v: unknown): string => {
  if (key === "description" && typeof v === "string") return v === "" ? "none" : clip(v, DESCRIPTION_SHOWN);
  return typeof v === "string" ? v : (JSON.stringify(v) ?? "none");
};
/** One edited field, `key from → to`; a description edited to nothing reads "description cleared" (the rest of the description rule is `value`). */
const change = (key: string, from: unknown, to: unknown): string => (key === "description" && to === "" ? "description cleared" : `${key} ${value(key, from)} → ${value(key, to)}`);

/** `@dana` / `Anonymous` behind a Fire's Unlock; undefined when the Unlock has no contribution (threshold change, queue adjustment) or the Ledger is not on hand. */
function contributorOf(unlockSeq: number, ctx: DescribeContext): string | undefined {
  const unlock = ctx.entry?.(unlockSeq);
  if (unlock === undefined || unlock.type !== "unlock") return undefined;
  const { contributionSeq } = (unlock as Entry<"unlock">).payload;
  if (contributionSeq === null) return undefined;
  const contribution = ctx.entry?.(contributionSeq);
  if (contribution === undefined || contribution.type !== "contribution") return undefined;
  const { displayName, anonymous } = (contribution as Entry<"contribution">).payload;
  return handle(displayName, anonymous);
}

/** The draw lists as the Ledger names them; anything else under `lists.` falls back to its key. */
const LIST_NAMES: Record<string, string> = { genreRoulette: "genre roulette", chatRules: "chat rules" };

interface ListChange {
  name: string;
  added: string[];
  removed: string[];
}

/**
 * A draw-list edit arrives as one diff line per index (`lists.genreRoulette.7: X → Y`), which reads as a reshuffle
 * when all that happened is an add or a remove (the streamer, 2026-09-09). Fold those lines into what was added and
 * what was removed per list: an item that appears on both sides only moved and is not news. Everything else in the
 * diff comes back untouched as `rest`.
 */
function splitListChanges(diff: EntryPayload["config_change"]["diff"]): { lists: ListChange[]; rest: EntryPayload["config_change"]["diff"] } {
  const byList = new Map<string, { before: Set<string>; after: Set<string> }>();
  const rest: EntryPayload["config_change"]["diff"] = [];
  for (const d of diff) {
    const m = /^lists\.([^.]+)\.\d+$/.exec(d.path);
    if (m === null) {
      rest.push(d);
      continue;
    }
    const key = m[1]!;
    const entry = byList.get(key) ?? { before: new Set<string>(), after: new Set<string>() };
    if (typeof d.from === "string") entry.before.add(d.from);
    if (typeof d.to === "string") entry.after.add(d.to);
    byList.set(key, entry);
  }
  const lists: ListChange[] = [];
  for (const [key, { before, after }] of byList) {
    lists.push({ name: LIST_NAMES[key] ?? key, added: [...after].filter((x) => !before.has(x)), removed: [...before].filter((x) => !after.has(x)) });
  }
  return { lists, rest: foldOutcomes(rest) };
}

/**
 * The Outcome pool is an array too, so a hand edit of config.json that inserts or removes an Outcome shifts every
 * one after it and the diff lists all of their fields (the Pool page's editor writes `outcome_change` by id instead).
 * Fold `outcomes.<n>.*` by id: an id only on the after side is one "outcomes: added <id>" line, only on
 * the before side "removed <id>", and a field edit on an Outcome that stayed put is named by its id, not its index.
 * Moves are not news.
 */
function foldOutcomes(diff: EntryPayload["config_change"]["diff"]): EntryPayload["config_change"]["diff"] {
  const idAt = new Map<number, { from?: unknown; to?: unknown }>();
  for (const d of diff) {
    const m = /^outcomes\.(\d+)\.id$/.exec(d.path);
    if (m !== null) idAt.set(Number(m[1]), { from: d.from, to: d.to });
  }
  if (idAt.size === 0) return diff; // nothing moved: every outcomes.<n>.field line is an edit in place — name it by id below
  const before = new Set([...idAt.values()].map((v) => v.from).filter((v): v is string => typeof v === "string"));
  const after = new Set([...idAt.values()].map((v) => v.to).filter((v): v is string => typeof v === "string"));
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  const shifted = new Set(idAt.keys());
  const out: EntryPayload["config_change"]["diff"] = [];
  if (added.length > 0) out.push({ path: "outcomes", from: undefined, to: `added ${added.join(", ")}` });
  if (removed.length > 0) out.push({ path: "outcomes", from: `removed ${removed.join(", ")}`, to: undefined });
  for (const d of diff) {
    const m = /^outcomes\.(\d+)\.(.+)$/.exec(d.path);
    if (m === null) out.push(d);
    else if (!shifted.has(Number(m[1]))) out.push(d); // an edit in place
  }
  return out;
}

/** A JSON value on one line for the Ledger page's "show all": strings bare, everything else as JSON. */
const shown = (v: unknown): string => (typeof v === "string" ? (v === "" ? "(empty)" : v) : v === undefined ? "(none)" : JSON.stringify(v));

/**
 * Everything `describeEntry` had to cut, one line per item, for the Ledger page's "Show all" — or null when the summary
 * already says it all. A `config_change` lists every setting with its before and after (the summary names four) and,
 * for the draw lists, what was added and what was removed rather than which index moved; a Contribution's clipped
 * message and an Outcome's clipped description come back whole.
 */
export function describeEntryFull(e: Entry): string[] | null {
  switch (e.type) {
    case "config_change": {
      const { lists, rest } = splitListChanges((e as Entry<"config_change">).payload.diff);
      const lines = [
        ...lists.flatMap((l) => [...(l.added.length > 0 ? [`${l.name}: added ${l.added.join(", ")}`] : []), ...(l.removed.length > 0 ? [`${l.name}: removed ${l.removed.join(", ")}`] : [])]),
        ...rest.map((d) => (d.path === "outcomes" ? `outcomes: ${String(d.to ?? d.from)}` : `${d.path}: ${shown(d.from)} → ${shown(d.to)}`)),
      ];
      // the summary only counts a list or pool change (+2 −1); the names are here — so any fold earns the disclosure
      return lists.length > 0 || rest.some((d) => d.path === "outcomes") || rest.length > CONFIG_PATHS_SHOWN ? lines : null;
    }
    case "contribution": {
      const m = (e as Entry<"contribution">).payload.message;
      return m !== undefined && m.length > MESSAGE_CLIP ? [m] : null;
    }
    case "outcome_change": {
      const d = (e as Entry<"outcome_change">).payload.changes.description;
      const to = d?.to;
      return typeof to === "string" && to.length > DESCRIPTION_SHOWN ? [`description: ${to}`] : null;
    }
    default:
      return null;
  }
}
