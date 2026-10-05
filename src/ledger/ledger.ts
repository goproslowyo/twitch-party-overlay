/**
 * The Ledger: the persistent local record of every Contribution, Unlock, Fire and Dashboard mutation.
 * SQLite via bun:sqlite in WAL mode. Both tables are append-only — there is no UPDATE or DELETE anywhere in this file.
 */
import { Database, type Statement } from "bun:sqlite";
import { ENTRY_TYPES, type Entry, type EntryPayload, type EntryType } from "./types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL, source_id TEXT NOT NULL, received_at TEXT NOT NULL, payload TEXT NOT NULL,
  UNIQUE(source, source_id)
);
CREATE TABLE IF NOT EXISTS entries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, type TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL
);
`;

const ENTRY_TYPE_SET: ReadonlySet<string> = new Set(ENTRY_TYPES);

export function isEntryType(value: unknown): value is EntryType {
  return typeof value === "string" && ENTRY_TYPE_SET.has(value);
}

export interface AppendItem {
  type: EntryType;
  actor: string;
  payload: unknown;
}

/**
 * One planned row of an appendMany batch: an item, or a function of the entries already appended in this batch — for a row
 * whose payload references a seq assigned earlier in the same transaction (an `unlock` naming its `contribution`).
 */
export type AppendPlan = AppendItem | ((batch: readonly Entry[]) => AppendItem);

/** An `onAppend` subscriber: the entries one committed transaction wrote, in seq order. */
export type AppendSubscriber = (entries: readonly Entry[]) => void;

/** An `entries` row as SQLite returns it — payload still JSON text. */
interface EntryRow {
  seq: number;
  ts: string;
  type: string;
  actor: string;
  payload: string;
}

function toEntry(row: EntryRow): Entry {
  return { seq: row.seq, ts: row.ts, type: row.type as EntryType, actor: row.actor, payload: JSON.parse(row.payload) };
}

const ENTRY_COLUMNS = "seq, ts, type, actor, payload";

export class Ledger {
  readonly #db: Database;
  readonly #insertRaw: Statement<undefined, [string, string, string, string]>;
  readonly #findRaw: Statement<{ id: number }, [string, string]>;
  readonly #insertEntry: Statement<EntryRow, [string, string, string, string]>;
  readonly #selectAll: Statement<EntryRow, []>;
  readonly #selectSince: Statement<EntryRow, [number]>;
  readonly #selectPage: Statement<EntryRow, [number]>;
  readonly #selectPageBefore: Statement<EntryRow, [number, number]>;
  readonly #selectOne: Statement<EntryRow, [number]>;
  readonly #appendManyTx: (items: readonly AppendPlan[]) => Entry[];
  readonly #subscribers = new Set<AppendSubscriber>();
  #depth = 0; // open transaction nesting; subscribers hear about a batch only once it reaches 0 by a commit
  #pending: Entry[] = []; // entries written inside the transaction still open

  constructor(path: string | ":memory:") {
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec(SCHEMA);

    this.#insertRaw = this.#db.prepare("INSERT INTO raw_events (source, source_id, received_at, payload) VALUES (?, ?, ?, ?)");
    this.#findRaw = this.#db.prepare("SELECT id FROM raw_events WHERE source = ? AND source_id = ?");
    this.#insertEntry = this.#db.prepare(`INSERT INTO entries (ts, type, actor, payload) VALUES (?, ?, ?, ?) RETURNING ${ENTRY_COLUMNS}`);
    this.#selectAll = this.#db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries ORDER BY seq ASC`);
    this.#selectSince = this.#db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE seq > ? ORDER BY seq ASC`);
    this.#selectPage = this.#db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries ORDER BY seq DESC LIMIT ?`);
    this.#selectPageBefore = this.#db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE seq < ? ORDER BY seq DESC LIMIT ?`);
    this.#selectOne = this.#db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE seq = ?`);

    // One transaction per appendMany: a throw anywhere (including an unknown type) rolls back every row of the batch.
    this.#appendManyTx = this.#db.transaction((items: readonly AppendPlan[]): Entry[] => {
      const ts = new Date().toISOString();
      const batch: Entry[] = [];
      for (const planned of items) {
        const { type, actor, payload } = typeof planned === "function" ? planned(batch) : planned;
        if (!isEntryType(type)) throw new TypeError(`Ledger: unknown entry type ${JSON.stringify(type)}`);
        batch.push(toEntry(this.#insertEntry.get(ts, type, actor, JSON.stringify(payload ?? null))!));
      }
      return batch;
    });
  }

  /** Returns { id, duplicate:false } on first sight, { id, duplicate:true } when (source, sourceId) already exists. Never throws on dupes. */
  recordRaw(source: string, sourceId: string, payload: unknown): { id: number; duplicate: boolean } {
    // Look up before inserting: INSERT OR IGNORE would burn an AUTOINCREMENT id on every duplicate. The connection is
    // single-threaded and synchronous, so nothing can slip in between the lookup and the insert.
    const existing = this.#findRaw.get(source, sourceId);
    if (existing !== null) return { id: existing.id, duplicate: true };
    const result = this.#insertRaw.run(source, sourceId, new Date().toISOString(), JSON.stringify(payload ?? null));
    return { id: Number(result.lastInsertRowid), duplicate: false };
  }

  append<T extends EntryType>(type: T, actor: string, payload: EntryPayload[T]): Entry<T> {
    return this.appendMany([{ type, actor, payload }])[0] as Entry<T>;
  }

  /** Atomic multi-append: all-or-nothing inside one transaction, returns entries in order. Later items may be planned from earlier ones (see AppendPlan). */
  appendMany(items: readonly AppendPlan[]): Entry[] {
    return this.#nested(() => {
      const entries = this.#appendManyTx(items);
      this.#pending.push(...entries);
      return entries;
    });
  }

  /**
   * Run `fn` as one SQLite transaction: a throw rolls back everything it wrote — raw events and entries alike — and
   * propagates; the return value is handed back after COMMIT. Nests: inside another transaction (or appendMany)
   * bun:sqlite opens a savepoint instead, so an inner failure the outer fn catches undoes only the inner writes.
   */
  transaction<T>(fn: () => T): T {
    return this.#nested(() => this.#db.transaction(fn)() as T);
  }

  /**
   * Hear every batch of entries once the transaction that wrote them has COMMITTED (never inside it — a nested
   * appendMany waits for the outermost transaction), in seq order. A subscriber that throws is reported on
   * console.error and costs nobody anything: not the write, not the other subscribers. Returns the unsubscribe.
   */
  onAppend(fn: AppendSubscriber): () => void {
    this.#subscribers.add(fn);
    return () => {
      this.#subscribers.delete(fn);
    };
  }

  /** Track transaction depth around a write; at depth 0 a commit hands the pending entries to the subscribers, a throw drops them. */
  #nested<T>(run: () => T): T {
    this.#depth++;
    let committed = false;
    try {
      const out = run();
      committed = true;
      return out;
    } finally {
      this.#depth--;
      if (this.#depth === 0) {
        const batch = this.#pending;
        this.#pending = [];
        if (committed && batch.length > 0) this.#notify(batch);
      }
    }
  }

  #notify(entries: readonly Entry[]): void {
    for (const fn of this.#subscribers) {
      try {
        fn(entries);
      } catch (e) {
        console.error(`Ledger: onAppend subscriber threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      }
    }
  }

  /** Ascending seq. */
  all(): Entry[] {
    return this.#selectAll.all().map(toEntry);
  }

  /** Entries with seq > the given one, ascending. */
  since(seq: number): Entry[] {
    return this.#selectSince.all(seq).map(toEntry);
  }

  /** Descending seq, for the Dashboard; `before` bounds the page to seq < before. */
  page(opts: { before?: number; limit: number }): Entry[] {
    const rows = opts.before === undefined ? this.#selectPage.all(opts.limit) : this.#selectPageBefore.all(opts.before, opts.limit);
    return rows.map(toEntry);
  }

  get(seq: number): Entry | undefined {
    const row = this.#selectOne.get(seq);
    return row === null ? undefined : toEntry(row);
  }

  close(): void {
    this.#db.close();
  }
}
