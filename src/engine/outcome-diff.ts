/**
 * Pure helpers for the Outcome editor: which definition fields the editor may change, the `{from, to}` record
 * an `outcome_change` entry carries, and the id a new Outcome gets from its name. No Engine or Ledger in here.
 */
import type { OutcomeDef } from "../config/schema.ts";

/** The definition fields an editor act may change — never `id` (fixed at add) and never `initialLeft` (Left is Ledger stock). */
export const EDITABLE_FIELDS = ["name", "glyph", "shape", "tier", "occupancy", "description", "restockable", "miniDraw", "raffle"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

/** Only the changed fields, keyed by name — what `outcome_change.changes` holds. */
export type OutcomeChanges = Record<string, { from: unknown; to: unknown }>;

/** `raffle` absent and `raffle: false` mean the same Outcome; `miniDraw` absent and `undefined` too. */
const comparable = (field: EditableField, value: unknown): unknown => (field === "raffle" ? value === true : value);

/** Every EDITABLE_FIELD whose value differs between `before` and `after`, as `{from, to}` with the raw values. */
export function outcomeChanges(before: OutcomeDef, after: OutcomeDef): OutcomeChanges {
  const out: OutcomeChanges = {};
  for (const field of EDITABLE_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (!Object.is(comparable(field, from), comparable(field, to))) out[field] = { from, to };
  }
  return out;
}

/** Lower-case kebab-case from the name (accents stripped, anything else a separator); "outcome" when nothing survives; "-2", "-3" … until the id is free. */
export function slugId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "outcome";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}
