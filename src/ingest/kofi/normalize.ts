/**
 * Ko-fi webhook → Contribution. Pure: no I/O, no clock.
 *
 * Ko-fi posts `application/x-www-form-urlencoded` with one `data` field holding JSON. Only `Donation` and `Subscription`
 * credit; `Shop Order` / `Commission` are stored raw by the caller and never credited. Money is parsed with `exactCents`
 * (split on ".", never `parseFloat`).
 */
import { exactCents, type Contribution } from "../contribution.ts";

/** The `data` JSON, fields per Ko-fi's official example payload. */
export interface KofiPayload {
  verification_token: string;
  message_id: string; // idempotency key — retries reuse it
  timestamp: string;
  type: string; // "Donation" | "Subscription" | "Shop Order" | "Commission"
  is_public: boolean;
  from_name: string;
  message: string | null;
  amount: string; // decimal string, e.g. "3.00"
  url: string;
  email: string;
  currency: string;
  is_subscription_payment: boolean;
  is_first_subscription_payment: boolean;
  kofi_transaction_id: string;
  shop_items: unknown;
  tier_name: string | null;
  shipping: unknown;
}

const CREDITED_TYPES: ReadonlySet<string> = new Set(["Donation", "Subscription"]);

/** Parse the form body and JSON-decode its `data` field. Throws when there is no `data` or it is not JSON. */
export function parseKofiBody(formBody: string): { data: KofiPayload } {
  const data = new URLSearchParams(formBody).get("data");
  if (data === null) throw new Error("Ko-fi webhook body has no data field");
  return { data: JSON.parse(data) as KofiPayload };
}

/** Donation / Subscription → tip; other types → null. Throws RangeError (from exactCents) on a malformed amount. */
export function normalizeKofi(data: KofiPayload): Contribution | null {
  if (!CREDITED_TYPES.has(data.type)) return null;
  const contribution: Contribution = {
    source: "kofi",
    sourceId: `kofi:${data.message_id}`,
    face: { kind: "tip", cents: exactCents(data.amount) },
    displayName: data.is_public ? data.from_name : null,
    anonymous: !data.is_public,
    occurredAt: data.timestamp,
    currency: data.currency,
  };
  if (typeof data.message === "string" && data.message !== "") contribution.message = data.message;
  return contribution;
}
