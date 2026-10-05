/** Ledger entry types and payloads. Every entry is append-only; cross-references use `seq`. */
import type { Contribution } from "../ingest/contribution.ts";

/** Every entry type, in one place: `EntryType` is derived from this list so the Ledger's runtime check can never drift from it. */
export const ENTRY_TYPES = [
  "contribution",
  "void",
  "unlock",
  "fire",
  "rebank",
  "restock",
  "outcome_status",
  "queue_adjust",
  "threshold",
  "config_change",
  "auth_failure",
  "note",
  "stock",
  "outcome_change",
] as const;

export type EntryType = (typeof ENTRY_TYPES)[number];

export interface Entry<T extends EntryType = EntryType> {
  seq: number;
  ts: string; // ISO-8601 UTC
  type: T;
  actor: string; // see the actor strings in server/auth.ts
  payload: EntryPayload[T];
}

export interface EntryPayload {
  contribution: Contribution & { progressCents: number; policyVersion: number };
  void: { contributionSeq: number; reason: string };
  unlock: { source: "threshold" | "rebank" | "adjust"; contributionSeq: number | null; fireSeq?: number; solo?: boolean }; // solo: one contributor's money alone took it from zero to the Threshold; absent in older Ledgers = false
  fire: { unlockSeq: number; outcomeId: string; roll: number; stockAfter: number; miniDraw?: { title: string; list: string[]; pick: string } };
  rebank: { fireSeq: number; reason: string }; // the engine also appends a new `unlock` (source "rebank") right after
  restock: { outcomeId: string; charges: number };
  outcome_status: { outcomeId: string; status: "live" | "suspended" | "retired" };
  queue_adjust: { delta: number; reason: string }; // the engine also appends |delta| `unlock`(source "adjust") entries when delta > 0
  threshold: { cents: number };
  config_change: { diff: Array<{ path: string; from: unknown; to: unknown }> };
  auth_failure: { ip: string; path: string; reason: string };
  note: { text: string; fireSeq?: number; winner?: string }; // fireSeq + winner: a giveaway winner recorded against a Fire (POST /api/fires/:seq/winner)
  /** Signed Left change — Streamer Left edits, seeds ("initial"), deletes ("deleted"), hand removals ("removed"). Left is the sum of these − Fires + refunds. */
  stock: { outcomeId: string; delta: number; reason: string };
  /** An editor act on one Outcome definition, keyed by id with only the changed fields (never the index-based `config_change` diff). */
  outcome_change: { outcomeId: string; action: "add" | "edit" | "delete"; changes: Record<string, { from: unknown; to: unknown }> };
}
