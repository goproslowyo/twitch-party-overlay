/**
 * Twitch EventSub notification → Contribution. Pure: no I/O, no clock.
 *
 * Double-count traps handled here: `channel.bits.use` with `type: "cheer"` is already credited by `channel.cheer`, and a
 * gift recipient's `channel.subscribe` (`is_gift`) is credited gifter-side by `channel.subscription.gift`.
 *
 * Every credited event carries the contributor's `user_id` (the gifter's `user_*` fields on subscription.gift); it is
 * null when `is_anonymous` — that id is the Avatar Picture's key, so it rides on the Contribution into the Ledger.
 */
import type { Contribution, Face, SubTier } from "../contribution.ts";

export interface EventSubNotification {
  metadata: { message_id: string; message_timestamp: string; subscription_type: string };
  payload: { subscription: { type: string }; event: any };
}

const SUB_TIERS: readonly string[] = ["1000", "2000", "3000", "prime"] satisfies readonly SubTier[];

export function normalizeEventSub(msg: EventSubNotification): Contribution | null {
  const { subscription_type: type, message_id: messageId, message_timestamp: messageTimestamp } = msg.metadata;
  const event = msg.payload.event as Record<string, unknown>;
  const face = faceOf(type, event);
  if (face === null) return null;

  const anonymous = event.is_anonymous === true;
  const contribution: Contribution = {
    source: "twitch",
    sourceId: `eventsub:${type}:${messageId}`, // the delivery's own id — reused by Twitch's redeliveries, fresh for a repeat cheer
    face,
    displayName: !anonymous && typeof event.user_name === "string" ? event.user_name : null,
    anonymous,
    twitchUserId: !anonymous && typeof event.user_id === "string" && event.user_id !== "" ? event.user_id : null,
    occurredAt: new Date(messageTimestamp).toISOString(), // the Ledger's form: Twitch sends nanosecond RFC3339; keep ms precision
  };
  const message = messageOf(type, event);
  if (message !== undefined) contribution.message = message;
  return contribution;
}

function faceOf(type: string, event: Record<string, unknown>): Face | null {
  switch (type) {
    case "channel.cheer":
      return bits(event.bits);
    case "channel.bits.use":
      return event.type === "cheer" ? null : bits(event.bits); // power-ups only; cheers arrive via channel.cheer
    case "channel.subscribe": {
      if (event.is_gift === true) return null; // the gifter's channel.subscription.gift carries the credit
      const tier = tierOf(event.tier);
      return tier === null ? null : { kind: "sub", tier };
    }
    case "channel.subscription.message": {
      const tier = tierOf(event.tier);
      if (tier === null) return null;
      return typeof event.cumulative_months === "number" ? { kind: "sub", tier, months: event.cumulative_months } : { kind: "sub", tier };
    }
    case "channel.subscription.gift": {
      const tier = tierOf(event.tier);
      return tier === null || typeof event.total !== "number" ? null : { kind: "gift", tier, count: event.total };
    }
    default:
      return null;
  }
}

const bits = (v: unknown): Face | null => (typeof v === "number" ? { kind: "bits", bits: v } : null);
const tierOf = (v: unknown): SubTier | null => (typeof v === "string" && SUB_TIERS.includes(v) ? (v as SubTier) : null);

/** cheer carries `message` as a string; bits.use and subscription.message carry `message.text`. */
function messageOf(type: string, event: Record<string, unknown>): string | undefined {
  const raw = type === "channel.cheer" ? event.message : (event.message as { text?: unknown } | null | undefined)?.text;
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** One line a mod can Manual Credit from — who, what and when, straight off the raw event (display name only, never the whole payload). */
export function describeEvent(msg: EventSubNotification): string {
  const event = (msg.payload?.event ?? {}) as Record<string, unknown>;
  const who = event.is_anonymous === true ? "anonymous" : typeof event.user_name === "string" ? event.user_name : typeof event.chatter_user_name === "string" ? event.chatter_user_name : "unknown user";
  const facts = (["bits", "tier", "total", "cumulative_months", "type"] as const).filter((k) => event[k] !== undefined).map((k) => `${k}=${String(event[k])}`);
  return `${msg.metadata?.subscription_type ?? "event"} from ${who}${facts.length > 0 ? ` (${facts.join(", ")})` : ""} at ${msg.metadata?.message_timestamp ?? "?"}`;
}

/**
 * Cross-session dedupe key: `eventsub:<subscription_type>:<sha256 of the event with keys sorted recursively>`. Two
 * EventSub sessions deliver the same event under different message ids and timestamps, so neither takes part. The
 * EventSub client drops repeats of this within 5 s; the Ledger's `sourceId` (the message id, above) is independent.
 */
export function eventFingerprint(msg: EventSubNotification): string {
  const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical(msg.payload.event))).digest("hex");
  return `eventsub:${msg.metadata.subscription_type}:${hash}`;
}

/** The same value with every object's keys sorted, recursively, so JSON.stringify is order-independent. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, canonical(obj[k])]));
  }
  return value;
}
