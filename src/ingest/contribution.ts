/** Contribution types. Money is integer cents everywhere. */

export type SubTier = "1000" | "2000" | "3000" | "prime";

export type Face =
  | { kind: "tip"; cents: number } // StreamElements or Ko-fi — one lane
  | { kind: "bits"; bits: number } // cheers and power-ups
  | { kind: "sub"; tier: SubTier; months?: number } // new sub or resub
  | { kind: "gift"; tier: SubTier; count: number }; // gifter-side gift event, count = total

export type ContributionSource = "twitch" | "streamelements" | "kofi" | "manual";

export interface Contribution {
  source: ContributionSource;
  sourceId: string; // stable dedupe key — see the Ledger's raw_events table
  face: Face;
  displayName: string | null; // null when anonymous or not public
  anonymous: boolean;
  message?: string;
  occurredAt: string; // ISO
  currency?: string; // "USD" unless a source says otherwise (stored, never converted)
  /**
   * The contributor's Twitch user id when the source knows it (the Avatar Picture): EventSub's `user_id` (null when the
   * event is anonymous), StreamElements' `providerId`. Absent = the source never knew (Ko-fi, Manual Credit, older Ledgers).
   * Written to the Ledger so a restart still resolves the picture; the picture URL itself is never stored.
   */
  twitchUserId?: string | null;
  /** A login-shaped name to resolve through Helix `login=` when there is no id (a StreamElements username, a typed Manual Credit name). Lower-case. */
  loginHint?: string;
}

/** The shape of a Twitch login (StreamElements' own `username` pattern): a letter, then 3–15 of `[a-z0-9_]`, case-insensitive. */
export const TWITCH_LOGIN = /^[a-z][a-z0-9_]{3,15}$/i;

/** `loginHint` for a free-text name: the lower-case login when the trimmed name is login-shaped, else undefined (no guessing). */
export function loginHintFor(name: string): string | undefined {
  const trimmed = name.trim();
  return TWITCH_LOGIN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** Twitch sticker prices in cents — what the viewer paid, not what the streamer nets. */
const STICKER_CENTS: Record<SubTier, number> = { "1000": 599, prime: 599, "2000": 999, "3000": 2499 };

/** Face value in cents, for Celebration intensity (never for Progress — that is the Conversion Policy's job). */
export function faceValueCents(face: Face): number {
  switch (face.kind) {
    case "tip":
      return face.cents;
    case "bits":
      return face.bits; // 1 bit = 1¢ face
    case "sub":
      return STICKER_CENTS[face.tier];
    case "gift":
      return face.count * STICKER_CENTS[face.tier];
  }
}

/**
 * Parse a decimal money string ("3", "3.5", "3.00") into integer cents without ever going through a float.
 * Throws RangeError for sub-cent precision ("3.499") or anything that is not a plain non-negative decimal.
 */
export function exactCents(amount: string): number {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m) throw new RangeError(`exactCents: not a decimal amount: ${JSON.stringify(amount)}`);
  const whole = m[1]!;
  const frac = m[2] ?? "";
  if (/[1-9]/.test(frac.slice(2))) throw new RangeError(`exactCents: sub-cent precision: ${JSON.stringify(amount)}`);
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}
