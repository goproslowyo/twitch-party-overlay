/**
 * StreamElements REST backfill.
 *
 * `SeRest` wraps `https://api.streamelements.com/kappa/v2` with the personal JWT: `channelId()` = `GET /channels/me`,
 * `tipsSince()` = `GET /tips/{channelId}?after&sort=createdAt&limit=100` following `offset` until a short page.
 *
 * `SeBackfill` is the lossless backbone: every `intervalMs` (and whenever the caller asks via `runOnce()`, e.g. on a
 * socket reconnect) it fetches everything after the caller's cursor minus a 5-minute overlap, credits allowed tips
 * through `onTip` and reports moderation-denied ones through `onDenied` — the Ledger dedupes the overlap on `sourceId`.
 */
import type { Contribution } from "../contribution.ts";
import { normalizeSeRestTip, type SeRestTipDoc } from "./normalize.ts";

/** The callable part of `fetch` — `globalThis.fetch` satisfies it; tests inject a recorder. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const SE_API_URL = "https://api.streamelements.com/kappa/v2";
export const SE_PAGE_LIMIT = 100; // the API's maximum
export const SE_MAX_PAGES = 100; // 10 000 tips per backfill run — far beyond any show; past it the API is misbehaving
export const SE_BACKFILL_OVERLAP_MS = 5 * 60_000;

export interface SeRestOptions {
  baseUrl?: string; // default SE_API_URL
  jwt: string;
  fetchImpl?: FetchLike;
  log?: (line: string) => void;
}

export interface SeRestTip {
  contribution: Contribution;
  denied: boolean; // moderation denied or deleted → void, never credit
}

export class SeRest {
  readonly #baseUrl: string;
  readonly #jwt: string;
  readonly #fetch: FetchLike;
  readonly #log: (line: string) => void;

  constructor(opts: SeRestOptions) {
    this.#baseUrl = (opts.baseUrl ?? SE_API_URL).replace(/\/$/, "");
    this.#jwt = opts.jwt;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#log = opts.log ?? ((line) => console.log(`[streamelements] ${line}`));
  }

  /** `GET /channels/me` → the channel's `_id` (the path segment every other endpoint wants). */
  async channelId(): Promise<string> {
    return (await this.me()).id;
  }

  /** `GET /channels/me` → who the JWT belongs to: the `_id` and the `username` (the Setup page's Check button shows the name). */
  async me(): Promise<{ id: string; username: string }> {
    const body = (await this.#get("/channels/me")) as { _id?: unknown; username?: unknown };
    if (typeof body?._id !== "string" || body._id === "") throw new Error("StreamElements GET /channels/me → no _id in the response");
    return { id: body._id, username: typeof body.username === "string" ? body.username : "" };
  }

  /**
   * Every tip created after `afterIso`, oldest first, across as many pages as it takes (page = `SE_PAGE_LIMIT`, at most
   * `SE_MAX_PAGES`). A body without a `docs` array throws (an API shape change must never read as "nothing to backfill");
   * a single malformed doc is skipped and logged so the rest of the page — and every later run — still goes through.
   */
  async tipsSince(channelId: string, afterIso: string): Promise<SeRestTip[]> {
    const path = `/tips/${encodeURIComponent(channelId)}`;
    const out: SeRestTip[] = [];
    let offset = 0;
    let pages = 0;
    let docs: unknown[];
    do {
      if (pages >= SE_MAX_PAGES) throw new Error(`StreamElements tips: too many pages (${SE_MAX_PAGES} × ${SE_PAGE_LIMIT} after ${afterIso})`);
      const body = (await this.#get(path, { after: afterIso, sort: "createdAt", limit: String(SE_PAGE_LIMIT), offset: String(offset) })) as { docs?: unknown } | null;
      if (!Array.isArray(body?.docs)) throw new Error(`StreamElements GET ${path} → no docs array in the response`);
      docs = body.docs;
      pages++;
      for (const [i, doc] of docs.entries()) {
        if (isRestTipDoc(doc)) out.push(normalizeSeRestTip(doc));
        else this.#log(`tips: malformed doc skipped at offset ${offset + i}: ${describeDoc(doc)}`);
      }
      offset += docs.length;
    } while (docs.length >= SE_PAGE_LIMIT);
    return out;
  }

  async #get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.#fetch(url.toString(), { headers: { Authorization: `Bearer ${this.#jwt}`, Accept: "application/json" } });
    if (!res.ok) throw new Error(`StreamElements GET ${path} → ${res.status}`);
    return res.json();
  }
}

/** A doc `normalizeSeRestTip` can read without throwing or producing NaN cents: `_id`, `createdAt`, a numeric finite amount and a user. */
function isRestTipDoc(doc: unknown): doc is SeRestTipDoc {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as { _id?: unknown; createdAt?: unknown; donation?: { amount?: unknown; user?: { username?: unknown } | null } | null };
  if (typeof d._id !== "string" || typeof d.createdAt !== "string") return false;
  const donation = d.donation;
  if (typeof donation !== "object" || donation === null) return false;
  if (typeof donation.amount !== "number" || !Number.isFinite(donation.amount)) return false;
  return typeof donation.user === "object" && donation.user !== null && typeof donation.user.username === "string";
}

/** What to say about a malformed doc in the log: its `_id` when it has one (never the whole doc — it carries the tipper's email). */
function describeDoc(doc: unknown): string {
  if (typeof doc !== "object" || doc === null) return doc === null ? "null" : typeof doc;
  const id = (doc as { _id?: unknown })._id;
  return typeof id === "string" ? `_id ${id}` : `keys ${Object.keys(doc).join(",") || "(none)"}`;
}

export interface SeBackfillOptions {
  rest: SeRest;
  intervalMs: number;
  /** Credit the tip; return true when it was new to the Ledger (the run summary's `new` count — a backfill re-reads the overlap, so most are not). */
  onTip: (c: Contribution) => boolean | void;
  onDenied: (sourceId: string) => void;
  cursor: () => string; // the newest tip `createdAt` (ISO) the caller has seen; the poll starts 5 min before it
  onError?: (err: unknown) => void; // default: log
  log?: (line: string) => void;
  /** VERBOSE detail: the summary of a run that found at least one doc, or failed — `backfill run: N docs, M new, cursor …`. Default: nothing. */
  verbose?: (line: string) => void;
  /** DEBUG chatter: the same summary for a run that found nothing (`0 docs, 0 new`). Default: nothing. */
  debug?: (line: string) => void;
}

type Timer = ReturnType<typeof setInterval>;

export class SeBackfill {
  readonly #o: SeBackfillOptions;
  readonly #log: (line: string) => void;
  readonly #onError: (err: unknown) => void;
  readonly #verbose: (line: string) => void;
  readonly #debug: (line: string) => void;
  #channelId: string | null = null;
  #timer: Timer | null = null;
  #inflight: Promise<void> | null = null;

  constructor(opts: SeBackfillOptions) {
    this.#o = opts;
    this.#log = opts.log ?? ((line) => console.log(`[streamelements] ${line}`));
    this.#onError = opts.onError ?? ((err) => this.#log(`backfill failed: ${err instanceof Error ? err.message : String(err)}`));
    this.#verbose = opts.verbose ?? (() => {});
    this.#debug = opts.debug ?? (() => {});
  }

  /** Run once now, then every `intervalMs`. A tick that lands while a run is still in flight is skipped. */
  start(): void {
    if (this.#timer !== null) return;
    void this.runOnce();
    this.#timer = setInterval(() => void this.runOnce(), this.#o.intervalMs);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One backfill pass; never rejects (failures go to `onError`). Concurrent callers share the run in flight. */
  runOnce(): Promise<void> {
    this.#inflight ??= this.#run().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  /** One pass, then its summary: a run that found a doc or failed is a VERBOSE signal; an empty one is DEBUG chatter. */
  async #run(): Promise<void> {
    let docs = 0; // tips handed over (credited, duplicate or denied)
    let fresh = 0; // of those, new to the Ledger (onTip said so)
    let failed = false;
    try {
      this.#channelId ??= await this.#o.rest.channelId();
      const cursorMs = Date.parse(this.#o.cursor());
      if (!Number.isFinite(cursorMs)) throw new Error(`backfill cursor is not an ISO date: ${JSON.stringify(this.#o.cursor())}`);
      const after = new Date(cursorMs - SE_BACKFILL_OVERLAP_MS).toISOString();
      const tips = await this.#o.rest.tipsSince(this.#channelId, after);
      for (const { contribution, denied } of tips) {
        docs++;
        if (denied) this.#o.onDenied(contribution.sourceId);
        else if (this.#o.onTip(contribution) === true) fresh++;
      }
    } catch (err) {
      failed = true;
      this.#onError(err);
    }
    const summary = `${docs} docs, ${fresh} new, cursor ${this.#o.cursor()}`;
    if (failed) this.#verbose(`backfill run failed: ${summary}`);
    else (docs > 0 ? this.#verbose : this.#debug)(`backfill run: ${summary}`);
  }
}
