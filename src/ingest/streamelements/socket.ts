/**
 * StreamElements realtime client (the legacy Socket.IO generation).
 *
 * Socket.IO v2 to `https://realtime.streamelements.com` over the websocket transport only. After every `connect` —
 * the first one and every automatic reconnect — the client emits `authenticate {method: "jwt", token}` and waits for
 * `authenticated` (status true) or `unauthorized` (status false). Every `event` envelope is handed raw to `onEvent`
 * (the caller stores it); the ones with `type === "tip"` also become a Contribution through `normalizeSeTip`.
 *
 * This is the low-latency path only: there is no server-side replay, so the REST backfill (`rest.ts`) stays the
 * lossless backbone and the Ledger's `(source, sourceId)` uniqueness collapses a tip seen on both.
 */
import io from "socket.io-client";
import type { Contribution } from "../contribution.ts";
import { normalizeSeTip, type SeSocketEvent } from "./normalize.ts";

export const SE_REALTIME_URL = "https://realtime.streamelements.com";

export interface SeSocketOptions {
  url?: string; // default SE_REALTIME_URL
  jwt: string;
  onTip: (c: Contribution) => void;
  onStatus: (connected: boolean) => void; // true once authenticated; false on unauthorized / disconnect / stop
  onEvent?: (raw: unknown) => void; // every `event` envelope as received, before normalization
  log?: (line: string) => void;
  /** VERBOSE detail: every socket event by type. Default: nothing. */
  verbose?: (line: string) => void;
}

export class SeSocket {
  readonly #url: string;
  readonly #jwt: string;
  readonly #onTip: (c: Contribution) => void;
  readonly #onStatus: (connected: boolean) => void;
  readonly #onEvent: ((raw: unknown) => void) | undefined;
  readonly #log: (line: string) => void;
  readonly #verbose: (line: string) => void;
  #socket: SocketIOClient.Socket | null = null;

  constructor(opts: SeSocketOptions) {
    this.#url = opts.url ?? SE_REALTIME_URL;
    this.#jwt = opts.jwt;
    this.#onTip = opts.onTip;
    this.#onStatus = opts.onStatus;
    this.#onEvent = opts.onEvent;
    this.#log = opts.log ?? ((line) => console.log(`[streamelements] ${line}`));
    this.#verbose = opts.verbose ?? (() => {});
  }

  start(): void {
    if (this.#socket !== null) return;
    // forceNew: this instance owns its Manager (Socket.IO otherwise multiplexes one Manager per url).
    const socket = io(this.#url, { transports: ["websocket"], forceNew: true, reconnection: true });
    this.#socket = socket;
    socket.on("connect", () => {
      this.#log("connected, authenticating");
      socket.emit("authenticate", { method: "jwt", token: this.#jwt }); // on every (re)connect: SE forgets the session
    });
    socket.on("authenticated", () => {
      this.#log("authenticated");
      this.#onStatus(true);
    });
    socket.on("unauthorized", (payload: unknown) => {
      this.#log(`unauthorized: ${detail(payload)}`); // the server's words only; the token itself is never logged
      this.#onStatus(false);
    });
    socket.on("event", (raw: unknown) => this.#onRawEvent(raw));
    socket.on("disconnect", (reason: unknown) => {
      this.#log(`disconnected: ${String(reason)}`);
      this.#onStatus(false);
    });
    socket.on("connect_error", (err: unknown) => this.#log(`connect error: ${detail(err)}`));
    socket.on("reconnect_attempt", (n: unknown) => this.#log(`reconnect attempt ${String(n)}`));
    socket.on("error", (err: unknown) => this.#log(`socket error: ${detail(err)}`));
  }

  /** Close the socket and disable reconnection; the resulting `disconnect` reports status false. */
  stop(): void {
    const socket = this.#socket;
    if (socket === null) return;
    this.#socket = null;
    socket.io.reconnection(false);
    socket.close();
  }

  #onRawEvent(raw: unknown): void {
    this.#onEvent?.(raw);
    if (!isEnvelope(raw)) {
      this.#log("event without type/data ignored");
      return;
    }
    this.#verbose(`socket event: ${raw.type}`);
    if (raw.type !== "tip") return;
    const contribution = normalizeSeTip(raw);
    if (contribution !== null) this.#onTip(contribution);
  }
}

/** A typed envelope; for tips, `data` must carry a numeric amount and a username so no NaN ever reaches the ledger. */
function isEnvelope(raw: unknown): raw is SeSocketEvent {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as { type?: unknown; data?: { amount?: unknown; username?: unknown } | null };
  if (typeof r.type !== "string") return false;
  if (r.type !== "tip") return true;
  return typeof r.data === "object" && r.data !== null && typeof r.data.amount === "number" && typeof r.data.username === "string";
}

/** A one-line description of a server payload or error for the log. */
function detail(x: unknown): string {
  if (x instanceof Error) return x.message;
  if (typeof x === "object" && x !== null && typeof (x as { message?: unknown }).message === "string") return (x as { message: string }).message;
  return typeof x === "string" ? x : JSON.stringify(x) ?? String(x);
}
