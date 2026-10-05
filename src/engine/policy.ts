/**
 * Conversion Policy: maps a Contribution's face to Progress, in integer cents.
 * Net-anchored with legible rounding — tips and bits credit at face value, subs at what the streamer keeps.
 * Rates are config and forward-only: the result is stored on the contribution entry and never recomputed.
 */
import type { Config } from "../config/schema.ts";
import type { Face } from "../ingest/contribution.ts";

export function progressCents(face: Face, policy: Config["policy"]): number {
  switch (face.kind) {
    case "tip":
      return Math.round((face.cents * policy.tipPercent) / 100);
    case "bits":
      return Math.round((face.bits * policy.bitsCentsPer100) / 100);
    case "sub":
      return policy.subCents[face.tier];
    case "gift":
      return face.count * policy.subCents[face.tier];
  }
}
