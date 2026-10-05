import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "./ledger.ts";

function tmpLedgerPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-ledger-"));
  return path.join(dir, "ledger.sqlite");
}

test("raw events dedupe on (source, sourceId)", () => {
  const l = new Ledger(":memory:");
  expect(l.recordRaw("kofi", "kofi:abc", { a: 1 }).duplicate).toBe(false);
  expect(l.recordRaw("kofi", "kofi:abc", { a: 1 }).duplicate).toBe(true);
  expect(l.recordRaw("twitch", "kofi:abc", {}).duplicate).toBe(false);
});

test("recordRaw returns the same id for a duplicate as for the first sight", () => {
  const l = new Ledger(":memory:");
  const first = l.recordRaw("kofi", "kofi:abc", { a: 1 });
  const again = l.recordRaw("kofi", "kofi:abc", { a: 2 });
  expect(again).toEqual({ id: first.id, duplicate: true });
  expect(l.recordRaw("kofi", "kofi:def", {}).id).toBe(first.id + 1);
});

test("entries are append-only with increasing seq and typed payloads", () => {
  const l = new Ledger(":memory:");
  const a = l.append("threshold", "streamer@local", { cents: 5000 });
  const b = l.append("note", "system:boot", { text: "hi" });
  expect([a.seq, b.seq]).toEqual([1, 2]);
  expect(l.all().map((e) => e.type)).toEqual(["threshold", "note"]);
  expect(l.since(1).map((e) => e.seq)).toEqual([2]);
  expect(l.page({ limit: 1 })[0]!.seq).toBe(2);

  expect(a.payload).toEqual({ cents: 5000 });
  expect(a.actor).toBe("streamer@local");
  expect(Number.isNaN(Date.parse(a.ts))).toBe(false);
  expect(l.all()).toEqual([a, b]);
  expect(l.get(2)).toEqual(b);
  expect(l.get(99)).toBeUndefined();
  expect(l.page({ before: 2, limit: 5 }).map((e) => e.seq)).toEqual([1]);
  expect(l.page({ limit: 5 }).map((e) => e.seq)).toEqual([2, 1]);
});

test("append accepts the stock-keeping kinds stock and outcome_change and stores their payloads as written", () => {
  const l = new Ledger(":memory:");
  const stock = l.append("stock", "streamer@local", { outcomeId: "stickers", delta: -2, reason: "left edit" });
  const change = l.append("outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { tier: { from: 0, to: 1 } } });
  expect(l.all().map((e) => e.type)).toEqual(["stock", "outcome_change"]);
  expect(l.get(stock.seq)?.payload).toEqual({ outcomeId: "stickers", delta: -2, reason: "left edit" });
  expect(l.get(change.seq)?.payload).toEqual({ outcomeId: "stickers", action: "edit", changes: { tier: { from: 0, to: 1 } } });
});

test("append rejects an unknown entry type at runtime", () => {
  const l = new Ledger(":memory:");
  expect(() => l.append("bogus" as any, "x", {} as any)).toThrow(/bogus/);
  expect(l.all()).toEqual([]);
});

test("appendMany is atomic", () => {
  const l = new Ledger(":memory:");
  expect(() =>
    l.appendMany([
      { type: "note", actor: "x", payload: { text: "ok" } },
      { type: "bogus" as any, actor: "x", payload: {} },
    ]),
  ).toThrow();
  expect(l.all()).toEqual([]);

  const entries = l.appendMany([
    { type: "unlock", actor: "system:engine", payload: { source: "threshold", contributionSeq: 1 } },
    { type: "note", actor: "x", payload: { text: "after" } },
  ]);
  expect(entries.map((e) => [e.seq, e.type])).toEqual([
    [1, "unlock"],
    [2, "note"],
  ]);
  expect(l.all()).toEqual(entries);
});

test("persists across reopen with WAL journaling", () => {
  const p = tmpLedgerPath();
  const l = new Ledger(p);
  expect(l.recordRaw("kofi", "kofi:abc", { a: 1 }).duplicate).toBe(false);
  l.append("threshold", "streamer@local", { cents: 5000 });
  l.append("note", "system:boot", { text: "hi" });
  const before = l.all();
  l.close();

  const reopened = new Ledger(p);
  expect(reopened.all()).toEqual(before);
  expect(reopened.recordRaw("kofi", "kofi:abc", { a: 1 }).duplicate).toBe(true);
  expect(reopened.append("note", "system:boot", { text: "again" }).seq).toBe(3);
  reopened.close();

  const probe = new Database(p);
  expect(probe.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  probe.close();
});

test("appendMany resolves a later item from the entries already appended in the batch", () => {
  const l = new Ledger(":memory:");
  l.append("note", "x", { text: "earlier" });
  const entries = l.appendMany([
    { type: "note", actor: "x", payload: { text: "head" } },
    (batch) => ({ type: "unlock", actor: "system:engine", payload: { source: "threshold", contributionSeq: batch[0]!.seq } }),
  ]);
  expect(entries.map((e) => e.seq)).toEqual([2, 3]);
  expect(entries[1]!.payload).toEqual({ source: "threshold", contributionSeq: 2 });

  expect(() =>
    l.appendMany([{ type: "note", actor: "x", payload: { text: "lost" } }, () => ({ type: "bogus" as any, actor: "x", payload: {} })]),
  ).toThrow();
  expect(l.all().map((e) => e.seq)).toEqual([1, 2, 3]);
});

test("transaction: a throw rolls back raw events and entries alike, so a retry is not a duplicate; nests via savepoints", () => {
  const l = new Ledger(":memory:");
  expect(() =>
    l.transaction(() => {
      l.recordRaw("kofi", "kofi:abc", { a: 1 });
      l.appendMany([{ type: "note", actor: "x", payload: { text: "lost" } }]);
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(l.all()).toEqual([]);
  expect(l.recordRaw("kofi", "kofi:abc", { a: 1 }).duplicate).toBe(false);

  // Commits on return and hands back the fn's value.
  expect(l.transaction(() => l.append("note", "x", { text: "kept" }).seq)).toBe(1);
  expect(l.all().map((e) => e.payload)).toEqual([{ text: "kept" }]);

  // Nested: an inner failure the outer fn catches undoes only the inner writes.
  const outerSeq = l.transaction(() => {
    const outer = l.append("note", "x", { text: "outer" });
    try {
      l.transaction(() => {
        l.append("note", "x", { text: "inner" });
        throw new Error("inner");
      });
    } catch {}
    return outer.seq;
  });
  expect(outerSeq).toBe(2);
  expect(l.all().map((e) => e.payload)).toEqual([{ text: "kept" }, { text: "outer" }]);
});

// ---- onAppend: the console-line subscription (follow-up 1) ----------------------------------------------------------

test("onAppend: a subscriber sees the entries of append and appendMany, in seq order, after the write; unsubscribe stops it", () => {
  const l = new Ledger(":memory:");
  const seen: number[][] = [];
  const off = l.onAppend((entries) => void seen.push(entries.map((e) => e.seq)));
  l.append("threshold", "streamer@local", { cents: 5000 });
  l.appendMany([
    { type: "note", actor: "x", payload: { text: "a" } },
    { type: "note", actor: "x", payload: { text: "b" } },
  ]);
  expect(seen).toEqual([[1], [2, 3]]);
  off();
  l.append("note", "x", { text: "c" });
  expect(seen).toEqual([[1], [2, 3]]);
});

test("onAppend: a throwing subscriber is reported on console.error and never breaks the write or the other subscribers", () => {
  const l = new Ledger(":memory:");
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    const seen: number[] = [];
    l.onAppend(() => {
      throw new Error("subscriber boom");
    });
    l.onAppend((entries) => void seen.push(...entries.map((e) => e.seq)));
    const entry = l.append("note", "x", { text: "still written" });
    expect(entry.seq).toBe(1);
    expect(l.get(1)?.payload).toEqual({ text: "still written" });
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("subscriber boom");
  } finally {
    console.error = original;
  }
});

test("onAppend: inside transaction() the subscriber runs once the OUTER transaction commits, sees every row of it, and nothing on a rollback", () => {
  const l = new Ledger(":memory:");
  const seen: number[][] = [];
  let seenDuringTx = -1;
  l.onAppend((entries) => void seen.push(entries.map((e) => e.seq)));
  l.transaction(() => {
    l.appendMany([{ type: "note", actor: "x", payload: { text: "a" } }]);
    l.append("note", "x", { text: "b" });
    seenDuringTx = seen.length;
  });
  expect(seenDuringTx).toBe(0);
  expect(seen).toEqual([[1, 2]]);
  expect(() =>
    l.transaction(() => {
      l.append("note", "x", { text: "rolled back" });
      throw new Error("abort");
    }),
  ).toThrow("abort");
  expect(seen).toEqual([[1, 2]]);
  expect(l.all()).toHaveLength(2);
});
