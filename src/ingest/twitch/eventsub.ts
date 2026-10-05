/**
 * Twitch EventSub WebSocket client, following Twitch's documented rules:
 *
 * - N parallel sessions (config `sessions`); each subscribes the 5 money types plus `channel.chat.message` (a soft
 *   subscription: refused → reported, never a dropped socket) with the broadcaster's user token within 10 s of
 *   `session_welcome` (app tokens fail on WebSocket transport).
 * - Keepalive watchdog: no message within `keepalive_timeout_seconds` (from the welcome, else config) + 5 s → the socket
 *   is dead; close it and reconnect with backoff 1 s → 2 → 4 … 30 s, then re-subscribe (a dropped session's
 *   subscriptions are disabled by Twitch; there is no replay).
 * - `session_reconnect` → open `reconnect_url` verbatim, keep the old socket until the new welcome, then close it.
 *   Subscriptions migrate, so nothing is re-POSTed.
 * - `revocation` → status stays connected with `reason: "revoked:<type>"` (the Health banner's business).
 * - Every session delivers every event under its own message id: cross-session dedupe on `eventFingerprint` for 5 s
 *   before `onNotification`; a content-identical repeat outside that window is a new event (a repeat cheer is real
 *   money). The Ledger's `(source, sourceId)` uniqueness on the message id catches Twitch's own redeliveries.
 * - Consumer callbacks (`onStatus`, `onNotification`) are guarded: a throwing handler is logged and never cancels a
 *   reconnect or a stop.
 * - Mock mode: the Twitch CLI's `twitch event websocket start-server` speaks plain `ws://` and validates subscriptions
 *   against ITS sessions at `http://<host:port>/eventsub/subscriptions` (real Twitch rejects its session ids). With
 *   `subscriptionsUrl` set the 6 POSTs go there instead of Helix — same headers, same body; without it, nothing changes.
 */
import { HelixError, type Helix } from "./helix.ts";
import { describeEvent, eventFingerprint, type EventSubNotification } from "./normalize.ts";

export interface EventSubStatus {
  session: number; // 1-based
  connected: boolean;
  reason?: string;
}

export interface EventSubClientOptions {
  url: string; // config ingest.twitch.eventsubUrl
  sessions: number;
  keepaliveSeconds: number;
  helix: Helix;
  /** Where the subscription POSTs go instead of `<helix>/eventsub/subscriptions` — `mockSubscriptionsUrl(url)` for the Twitch CLI mock. */
  subscriptionsUrl?: string;
  broadcasterId: string;
  onNotification: (msg: EventSubNotification) => void;
  onStatus: (s: EventSubStatus) => void;
  /** Chat: once per subscribed session, after the money POSTs stood — `ok: false` with Twitch's refusal when the token lacks `user:read:chat`. Default: nothing. */
  onChatSubscribe?: (s: ChatSubscribeStatus) => void;
  /** The retry ladder for a refused chat subscription; tests shorten it. Default `CHAT_RETRY_DELAYS_MS`. */
  chatRetryDelaysMs?: readonly number[];
  WebSocketImpl?: typeof WebSocket;
  now?: () => Date; // dedupe clock
  log?: (line: string) => void;
  /** VERBOSE detail: every welcome, the types each session subscribed, every notification frame and every cross-session duplicate dropped. Default: nothing. */
  verbose?: (line: string) => void;
  /** DEBUG chatter: every keepalive frame. Default: nothing. */
  debug?: (line: string) => void;
}

export interface Subscription {
  type: string;
  version: string;
  /** Wanted, not required (chat): a refusal is reported through `onChatSubscribe` and the session stays up on the rest. Money types are never soft. */
  soft?: boolean;
}
export const CHAT_SUBSCRIPTION_TYPE = "channel.chat.message";
export const SUBSCRIPTIONS: readonly Subscription[] = [
  { type: "channel.cheer", version: "1" },
  { type: "channel.bits.use", version: "1" },
  { type: "channel.subscribe", version: "1" },
  { type: "channel.subscription.message", version: "1" },
  { type: "channel.subscription.gift", version: "1" },
  { type: CHAT_SUBSCRIPTION_TYPE, version: "1", soft: true },
];
const MONEY = SUBSCRIPTIONS.filter((s) => s.soft !== true);

/** A refused chat subscription is retried alone on the same session after each of these, then left until the next broadcaster link. */
export const CHAT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000, 45_000];

export interface ChatSubscribeStatus {
  session: number; // 1-based
  ok: boolean;
  reason?: string; // the refusal, when !ok
}

/** Money types listen on the channel; chat reads as the broadcaster (`user_id`), whose token this is — the only shape `user:read:chat` allows on a user token. */
function conditionFor(type: string, broadcasterId: string): Record<string, string> {
  return type === CHAT_SUBSCRIPTION_TYPE ? { broadcaster_user_id: broadcasterId, user_id: broadcasterId } : { broadcaster_user_id: broadcasterId };
}

/** A content-identical repeat inside this window is the other session's copy; outside it, it is a new event. */
export const CROSS_SESSION_DEDUPE_MS = 5_000;
const KEEPALIVE_GRACE_MS = 5_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

type Resolved = Required<Omit<EventSubClientOptions, "onNotification" | "subscriptionsUrl">> & Pick<EventSubClientOptions, "subscriptionsUrl">;

/**
 * The Twitch CLI mock's subscriptions endpoint for a plain `ws://` eventsub url: `http://<same host:port>/eventsub/subscriptions`.
 * Real Twitch is `wss://` only, so a plain socket url can only be the mock; anything else (wss://, the mock's `--ssl`
 * mode, an unparseable string) is not mock mode → undefined, and the client subscribes through Helix as always.
 */
export function mockSubscriptionsUrl(eventsubUrl: string): string | undefined {
  let u: URL;
  try {
    u = new URL(eventsubUrl);
  } catch {
    return undefined;
  }
  if (u.protocol !== "ws:") return undefined;
  return `http://${u.host}/eventsub/subscriptions`;
}
type Timer = ReturnType<typeof setTimeout>;

interface Message {
  metadata?: { message_type?: unknown; subscription_type?: unknown };
  payload?: { session?: { id?: unknown; keepalive_timeout_seconds?: unknown; reconnect_url?: unknown }; subscription?: { type?: unknown } };
}

/** One socket's lifecycle. A Session holds an `active` link and, mid-migration, a `pending` one. */
interface Link {
  ws: WebSocket;
  watchdog: Timer | null;
  keepaliveMs: number;
  superseded: boolean; // closed on purpose (migration, stop): its close event is not a disconnect
  dropReason?: string; // set when the watchdog / a subscribe failure closed it
  chatRetry: Timer | null; // the pending chat re-subscribe, cleared with the link
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The error's message, and for a Helix refusal Twitch's body after it: `Helix POST … → 429: {"error":"Too Many Requests",…}`. */
const refusalText = (e: unknown): string => (e instanceof HelixError && e.body !== "" ? `${e.message}: ${e.body}` : errorText(e));

class Session {
  readonly #n: number;
  readonly #o: Resolved;
  readonly #deliver: (msg: EventSubNotification) => void;
  #active: Link | null = null;
  #pending: Link | null = null;
  #retry: Timer | null = null;
  #attempts = 0; // consecutive failed connects; drives the backoff
  #stopped = false;

  constructor(n: number, o: Resolved, deliver: (msg: EventSubNotification) => void) {
    this.#n = n;
    this.#o = o;
    this.#deliver = deliver;
  }

  start(): void {
    this.#stopped = false;
    this.#open(this.#freshUrl(), "fresh");
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    if (this.#active) this.#discard(this.#active);
    if (this.#pending) this.#discard(this.#pending);
    this.#active = this.#pending = null;
    this.#status({ connected: false, reason: "stopped" });
  }

  #freshUrl(): string {
    const u = new URL(this.#o.url);
    u.searchParams.set("keepalive_timeout_seconds", String(this.#o.keepaliveSeconds));
    return u.toString();
  }

  #open(url: string, mode: "fresh" | "migrate"): void {
    const link: Link = { ws: new this.#o.WebSocketImpl(url), watchdog: null, keepaliveMs: this.#o.keepaliveSeconds * 1000, superseded: false, chatRetry: null };
    if (mode === "migrate") this.#pending = link;
    else this.#active = link;
    this.#arm(link); // a socket that never welcomes is as dead as one that stops sending keepalives
    link.ws.addEventListener("message", (e) => this.#onMessage(link, e.data));
    link.ws.addEventListener("error", () => this.#log(`socket error`));
    link.ws.addEventListener("close", (e) => this.#onClose(link, e));
  }

  #onMessage(link: Link, data: unknown): void {
    if (link.superseded) return; // discarded (migration, stop): a late welcome must not re-arm the watchdog or re-subscribe
    let msg: Message;
    try {
      msg = JSON.parse(String(data)) as Message;
    } catch {
      this.#log("unparseable message ignored");
      return;
    }
    this.#arm(link); // any message resets the watchdog (protocol pings don't reach here, matching Twitch's rule)
    switch (msg.metadata?.message_type) {
      case "session_welcome":
        this.#verbose(`welcome${link === this.#pending ? " (reconnect url)" : ""}`);
        this.#onWelcome(link, msg);
        return;
      case "session_keepalive":
        this.#debug("keepalive");
        return;
      case "notification":
        this.#verbose(`notification ${describeEvent(msg as unknown as EventSubNotification)}`);
        this.#deliver(msg as unknown as EventSubNotification);
        return;
      case "session_reconnect":
        this.#onReconnect(link, msg);
        return;
      case "revocation": {
        const type = String(msg.payload?.subscription?.type ?? msg.metadata?.subscription_type ?? "unknown");
        this.#log(`subscription revoked: ${type}`);
        this.#status({ connected: true, reason: `revoked:${type}` });
        return;
      }
      default:
        this.#log(`unknown message_type ${String(msg.metadata?.message_type)} ignored`);
    }
  }

  #onWelcome(link: Link, msg: Message): void {
    const ka = msg.payload?.session?.keepalive_timeout_seconds;
    if (typeof ka === "number" && ka > 0) link.keepaliveMs = ka * 1000;
    this.#arm(link);

    if (link === this.#pending) {
      const old = this.#active;
      this.#pending = null;
      this.#active = link;
      if (old) this.#discard(old); // only now: the new socket is live and carries the migrated subscriptions
      this.#attempts = 0;
      this.#log("migrated to the reconnect url");
      this.#status({ connected: true, reason: "migrated" });
      return;
    }

    const sessionId = msg.payload?.session?.id;
    if (typeof sessionId !== "string") {
      this.#drop(link, "welcome without a session id");
      return;
    }
    void this.#subscribe(link, sessionId);
  }

  /**
   * The 6 subscriptions, fired together so they land well inside Twitch's 10 s window. Against Twitch one refused MONEY
   * type drops the socket (a half-subscribed session would lose money silently). Against the Twitch CLI mock (mock mode)
   * a money type it does not know — `channel.bits.use` as of CLI 1.1.24 — is logged and skipped, and the session connects
   * on the rest; only every money POST refused drops it. Chat is soft everywhere: refused → one log line,
   * `onChatSubscribe({ ok: false })`, the socket stays, and the chat POST alone is retried on the ladder
   * (`#scheduleChatRetry`).
   */
  async #subscribe(link: Link, sessionId: string): Promise<void> {
    const mock = this.#o.subscriptionsUrl !== undefined;
    const target = mock ? { url: this.#o.subscriptionsUrl } : {}; // mock mode only; otherwise Helix, as ever
    const results = await Promise.allSettled(
      SUBSCRIPTIONS.map((s) =>
        this.#o.helix.post(
          "eventsub/subscriptions",
          { type: s.type, version: s.version, condition: conditionFor(s.type, this.#o.broadcasterId), transport: { method: "websocket", session_id: sessionId } },
          target,
        ),
      ),
    );
    const refused = results.flatMap((r, i) => (r.status === "rejected" ? [{ ...SUBSCRIPTIONS[i]!, error: refusalText(r.reason) }] : []));
    const money = refused.filter((r) => r.soft !== true);
    if (money.length > 0 && (!mock || money.length === MONEY.length)) {
      if (this.#active === link && !link.superseded) this.#drop(link, `subscribe failed: ${money[0]!.error}`);
      return;
    }
    for (const r of money) this.#log(`mock server refused ${r.type} (${r.error}) — skipped, ${MONEY.length - money.length} of ${MONEY.length} subscribed`);
    if (this.#active !== link || link.superseded) return; // closed while we were subscribing
    const chatIndex = SUBSCRIPTIONS.findIndex((s) => s.type === CHAT_SUBSCRIPTION_TYPE);
    const chatResult = results[chatIndex]!;
    const chatReason = chatResult.status === "rejected" ? errorText(chatResult.reason) : undefined;
    const chat = refused.find((r) => r.type === CHAT_SUBSCRIPTION_TYPE);
    if (chat !== undefined) {
      const retryNote = this.#o.chatRetryDelaysMs.length > 0 ? `; retrying in ${this.#o.chatRetryDelaysMs[0]! / 1000} s` : "";
      this.#log(`chat subscription refused (${chat.error}) — the money events stay up, chat is not heard${retryNote}`);
    }
    const accepted = SUBSCRIPTIONS.map((s) => s.type).filter((type) => !refused.some((r) => r.type === type));
    this.#verbose(`subscribed ${accepted.join(", ")}`);
    this.#attempts = 0;
    this.#status({ connected: true });
    this.#chat(chat === undefined ? { ok: true } : { ok: false, reason: chatReason });
    if (chat !== undefined) this.#scheduleChatRetry(link, sessionId, 0, chat.error);
  }

  /**
   * Re-POST only `channel.chat.message` on the same session after `chatRetryDelaysMs[attempt]`; never the money
   * types, never a socket drop. A link closed or superseded before the timer fires (a drop, a migration, stop) takes the
   * timer with it (`#clearChatRetry`), and a fresh session subscribes all six as ever. Past the ladder: one line, done
   * until the next broadcaster link.
   */
  #scheduleChatRetry(link: Link, sessionId: string, attempt: number, lastError: string): void {
    const delays = this.#o.chatRetryDelaysMs;
    if (attempt >= delays.length) {
      this.#log(`chat subscription refused ${attempt + 1} times (${lastError}) — not retrying until the next broadcaster link`);
      return;
    }
    link.chatRetry = setTimeout(() => {
      link.chatRetry = null;
      void this.#retryChat(link, sessionId, attempt);
    }, delays[attempt]!);
  }

  async #retryChat(link: Link, sessionId: string, attempt: number): Promise<void> {
    if (this.#stopped || this.#active !== link || link.superseded) return;
    const s = SUBSCRIPTIONS.find((x) => x.type === CHAT_SUBSCRIPTION_TYPE)!;
    const mock = this.#o.subscriptionsUrl !== undefined;
    const target = mock ? { url: this.#o.subscriptionsUrl } : {};
    try {
      await this.#o.helix.post("eventsub/subscriptions", { type: s.type, version: s.version, condition: conditionFor(s.type, this.#o.broadcasterId), transport: { method: "websocket", session_id: sessionId } }, target);
    } catch (e) {
      if (this.#stopped || this.#active !== link || link.superseded) return;
      const error = refusalText(e);
      const next = this.#o.chatRetryDelaysMs[attempt + 1];
      if (next !== undefined) this.#log(`chat subscription refused again (${error}) — retrying in ${next / 1000} s`);
      this.#scheduleChatRetry(link, sessionId, attempt + 1, error);
      return;
    }
    if (this.#stopped || this.#active !== link || link.superseded) return;
    this.#log(`chat subscription accepted on retry ${attempt + 1} — chat is heard`);
    this.#chat({ ok: true });
  }

  #clearChatRetry(link: Link): void {
    if (link.chatRetry !== null) clearTimeout(link.chatRetry);
    link.chatRetry = null;
  }

  #onReconnect(link: Link, msg: Message): void {
    const url = msg.payload?.session?.reconnect_url;
    if (typeof url !== "string") {
      this.#log("session_reconnect without reconnect_url ignored");
      return;
    }
    if (this.#pending) this.#discard(this.#pending);
    this.#log("session_reconnect: opening the reconnect url");
    try {
      this.#open(url, "migrate");
    } catch (e) {
      // A url the WebSocket constructor rejects must not throw out of a socket callback. Twitch will close this socket
      // shortly anyway: drop it now, so the normal backoff path reconnects fresh and re-subscribes.
      this.#drop(link, `reconnect url rejected (${errorText(e)}); reconnecting fresh`);
    }
  }

  #onClose(link: Link, e: CloseEvent): void {
    if (link.watchdog !== null) clearTimeout(link.watchdog);
    link.watchdog = null;
    this.#clearChatRetry(link);
    if (link.superseded) return;
    const reason = link.dropReason ?? `closed: ${e.code}${e.reason ? ` ${e.reason}` : ""}`;
    if (link === this.#pending) {
      this.#pending = null;
      this.#log(`reconnect target closed (${reason})`);
      if (!this.#active && !this.#stopped) this.#scheduleReconnect(); // else the old socket is still up; Twitch closing it takes the path below
      return;
    }
    if (link !== this.#active) return; // stale
    this.#active = null;
    this.#log(`disconnected (${reason})`);
    // Scheduled before the status goes out: a throwing status handler must never cost the session its reconnect. With
    // a migration in flight, the pending socket's welcome (or its close) decides what happens next instead.
    if (!this.#pending && !this.#stopped) this.#scheduleReconnect();
    this.#status({ connected: false, reason });
  }

  #scheduleReconnect(): void {
    const delay = Math.min(BACKOFF_MIN_MS * 2 ** this.#attempts, BACKOFF_MAX_MS);
    this.#attempts++;
    this.#log(`reconnecting in ${delay} ms`);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      if (!this.#stopped) this.#open(this.#freshUrl(), "fresh");
    }, delay);
  }

  /** (Re)start the watchdog: silence for keepalive + 5 s means the socket is dead. */
  #arm(link: Link): void {
    if (link.watchdog !== null) clearTimeout(link.watchdog);
    link.watchdog = setTimeout(() => this.#drop(link, `keepalive timeout: silent for ${(link.keepaliveMs + KEEPALIVE_GRACE_MS) / 1000} s`), link.keepaliveMs + KEEPALIVE_GRACE_MS);
  }

  /**
   * Close a socket we judged dead; #onClose reports `link.dropReason`. The wire reason is a fixed short word: a close
   * reason over 123 UTF-8 bytes makes `ws.close()` throw, which would leave the socket open and the session half-subscribed.
   */
  #drop(link: Link, reason: string): void {
    link.dropReason = reason;
    this.#log(reason);
    this.#close(link, 4000, "dropped");
  }

  /** Close a socket on purpose (migration, stop): no status, no reconnect. */
  #discard(link: Link): void {
    link.superseded = true;
    if (link.watchdog !== null) clearTimeout(link.watchdog);
    link.watchdog = null;
    this.#clearChatRetry(link);
    this.#close(link, 1000, "superseded");
  }

  #close(link: Link, code: number, reason: string): void {
    try {
      link.ws.close(code, reason);
    } catch (e) {
      this.#log(`close failed: ${errorText(e)}`);
    }
  }

  /** Guarded consumer callback: a throwing `onStatus` is logged, never propagated into the session's state machine. */
  #status(s: Omit<EventSubStatus, "session">): void {
    try {
      this.#o.onStatus({ session: this.#n, ...s });
    } catch (e) {
      this.#log(`onStatus threw: ${errorText(e)}`);
    }
  }

  #chat(s: Omit<ChatSubscribeStatus, "session">): void {
    try {
      this.#o.onChatSubscribe({ session: this.#n, ...s });
    } catch (e) {
      this.#log(`onChatSubscribe threw: ${errorText(e)}`);
    }
  }

  #log(line: string): void {
    this.#o.log(`session ${this.#n}: ${line}`);
  }

  #verbose(line: string): void {
    this.#o.verbose(`session ${this.#n}: ${line}`);
  }

  #debug(line: string): void {
    this.#o.debug(`session ${this.#n}: ${line}`);
  }
}

export class EventSubClient {
  readonly #sessions: Session[];
  readonly #onNotification: (msg: EventSubNotification) => void;
  readonly #now: () => Date;
  readonly #log: (line: string) => void;
  readonly #verbose: (line: string) => void;
  readonly #seen = new Map<string, number>(); // eventFingerprint → first seen (ms)
  #started = false;

  constructor(opts: EventSubClientOptions) {
    const resolved: Resolved = {
      url: opts.url,
      sessions: opts.sessions,
      keepaliveSeconds: opts.keepaliveSeconds,
      helix: opts.helix,
      ...(opts.subscriptionsUrl === undefined ? {} : { subscriptionsUrl: opts.subscriptionsUrl }),
      broadcasterId: opts.broadcasterId,
      onStatus: opts.onStatus,
      onChatSubscribe: opts.onChatSubscribe ?? (() => {}),
      chatRetryDelaysMs: opts.chatRetryDelaysMs ?? CHAT_RETRY_DELAYS_MS,
      WebSocketImpl: opts.WebSocketImpl ?? WebSocket,
      now: opts.now ?? (() => new Date()),
      log: opts.log ?? ((line) => console.log(`[eventsub] ${line}`)),
      verbose: opts.verbose ?? (() => {}),
      debug: opts.debug ?? (() => {}),
    };
    this.#onNotification = opts.onNotification;
    this.#now = resolved.now;
    this.#log = resolved.log;
    this.#verbose = resolved.verbose;
    this.#sessions = Array.from({ length: Math.max(1, Math.floor(opts.sessions)) }, (_, i) => new Session(i + 1, resolved, (m) => this.#deliver(m)));
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const s of this.#sessions) s.start();
  }

  /** Close every socket and clear every timer; each session reports `connected: false, reason: "stopped"`. */
  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    for (const s of this.#sessions) s.stop();
    this.#seen.clear();
  }

  /** Cross-session dedupe: the first sighting of a fingerprint is delivered; a repeat within 5 s is the other session's copy. */
  #deliver(msg: EventSubNotification): void {
    if (typeof msg.metadata?.subscription_type !== "string" || msg.payload?.event === undefined) {
      this.#log("notification without subscription_type/event ignored");
      return;
    }
    const now = this.#now().getTime();
    for (const [key, seenAt] of this.#seen) if (now - seenAt >= CROSS_SESSION_DEDUPE_MS) this.#seen.delete(key);
    const key = eventFingerprint(msg);
    if (this.#seen.has(key)) {
      this.#verbose(`duplicate ignored ${msg.metadata.message_id}`);
      return;
    }
    this.#seen.set(key, now);
    try {
      this.#onNotification(msg);
    } catch (e) {
      this.#log(`onNotification threw: ${errorText(e)}`);
    }
  }
}
