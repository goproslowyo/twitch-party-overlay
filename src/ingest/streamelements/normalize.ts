/**
 * StreamElements tip → Contribution. Pure: no I/O, no clock.
 *
 * The realtime socket delivers `type: "tip"` events (payment rail invisible; `amount` may be decimal), the REST backfill
 * (`GET /kappa/v2/tips/{channelId}`) delivers docs that also carry moderation state (`approved`, `deleted`).
 *
 * Avatar Picture source: `providerId`, when SE sends it, is the tipper's id on the envelope's `provider` platform
 * — a Twitch id only when that says `twitch` (or says nothing: older envelopes); without one a `username` that is
 * login-shaped becomes a Helix `login=` hint (SE's tipping page lets a tipper type any name, so a free-text name
 * gives nothing). The `avatar` field stays dropped — SE documents it only as "URI of user avatar" and every example is
 * their placeholder.
 */
import { loginHintFor, type Contribution } from "../contribution.ts";

/** Realtime envelope (official Websockets.md schema). */
export interface SeSocketEvent {
  _id: string;
  channel?: string;
  type: string;
  provider?: string;
  data: { tipId?: string; username: string; displayName?: string; providerId?: string; amount: number; currency?: string; message?: string; avatar?: string };
  createdAt: string;
  updatedAt?: string;
}

/** One doc of `GET /kappa/v2/tips/{channelId}` (api.yaml). */
export interface SeRestTipDoc {
  _id: string;
  channel?: string;
  provider?: string;
  status?: string;
  approved?: string;
  deleted?: boolean;
  transactionId?: string;
  donation: { user: { username: string; email?: string; providerId?: string }; message?: string; amount: number; currency?: string };
  createdAt: string;
  updatedAt?: string;
}

/**
 * Socket `event` → tip, or null for every other event type. The dedupe key is the **tip** id (`data.tipId`, which is the
 * `_id` of the same tip on REST) so a socket credit and its REST backfill collapse; the envelope `_id` (the activity id)
 * is only the fallback when `tipId` is absent.
 */
export function normalizeSeTip(evt: SeSocketEvent): Contribution | null {
  if (evt.type !== "tip") return null;
  const d = evt.data;
  const twitch = evt.provider === undefined || evt.provider === "twitch";
  return tip(d.tipId ?? evt._id, d.username, d.amount, evt.createdAt, d.message, d.currency, twitch ? d.providerId : undefined);
}

/**
 * REST doc → tip plus whether moderation denied it (`approved === "denied"` or `deleted`). The doc's `provider` is the
 * payment rail (paypal, stripe…), not the platform, so it says nothing about `providerId` — which rides as-is.
 */
export function normalizeSeRestTip(doc: SeRestTipDoc): { contribution: Contribution; denied: boolean } {
  const d = doc.donation;
  return {
    contribution: tip(doc._id, d.user.username, d.amount, doc.createdAt, d.message, d.currency, d.user.providerId),
    denied: doc.approved === "denied" || doc.deleted === true,
  };
}

function tip(id: string, username: string, amount: number, occurredAt: string, message?: string, currency?: string, providerId?: string): Contribution {
  const contribution: Contribution = {
    source: "streamelements",
    sourceId: `se:${id}`,
    face: { kind: "tip", cents: Math.round(amount * 100) }, // socket amounts can be decimal; never keep a float
    displayName: username,
    anonymous: false,
    occurredAt,
  };
  if (message !== undefined && message !== "") contribution.message = message;
  if (currency !== undefined) contribution.currency = currency;
  if (typeof providerId === "string" && providerId !== "") contribution.twitchUserId = providerId;
  else {
    const hint = loginHintFor(username);
    if (hint !== undefined) contribution.loginHint = hint;
  }
  return contribution;
}
