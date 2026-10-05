/**
 * The overlay's WebSocket client: connect to `/overlay/ws` on the page's own host, hand every JSON
 * message to the model, and reconnect with doubling backoff when the socket drops — the hub sends a fresh snapshot on
 * every open, so a reconnect re-syncs the display without a page reload. The one thing the client ever sends is the
 * quality report (`send`); `createReporter` decides when — on a real change of level / mode / WebGL / stable
 * (never on the miss ratio, which moves every frame), on demand when a socket opens, and every `REPORT_EVERY_MS`
 * regardless. The socket constructor and the timers are injectable so the choreography is testable without a network.
 */
import { WS_PATH, type OverlayMessage, type OverlayReport } from "../server/overlay.ts";

export const MIN_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 10_000;
/** How often the quality report goes up even when nothing changed. */
export const REPORT_EVERY_MS = 15_000;

/** What the client needs from a socket — the browser's WebSocket satisfies it, and so does a test fake. */
export interface WsLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WsOptions {
  url: string;
  onMessage: (msg: OverlayMessage) => void;
  onStatus?: (connected: boolean) => void;
  create?: (url: string) => WsLike;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

export interface WsClient {
  /** The quality report, serialised, on the open socket; false (and nothing sent) while there is none. */
  send(report: OverlayReport): boolean;
  close(): void;
}

/** `ws://host/overlay/ws`, or `wss://` when the page itself is https. */
export function wsUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}${WS_PATH}`;
}

export function nextBackoff(currentMs: number, maxMs: number): number {
  return Math.min(maxMs, currentMs * 2);
}

export function connectOverlay(opts: WsOptions): WsClient {
  const create = opts.create ?? ((url: string) => new WebSocket(url) as unknown as WsLike);
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const minMs = opts.minBackoffMs ?? MIN_BACKOFF_MS;
  const maxMs = opts.maxBackoffMs ?? MAX_BACKOFF_MS;

  let backoffMs = minMs;
  let socket: WsLike | null = null;
  let opened = false;
  let timer: unknown = null;
  let closed = false;

  const open = (): void => {
    const ws = create(opts.url);
    socket = ws;
    ws.onopen = () => {
      if (ws !== socket) return;
      backoffMs = minMs;
      opened = true;
      opts.onStatus?.(true);
    };
    ws.onmessage = (ev) => {
      if (ws !== socket) return;
      const msg = parse(ev.data);
      if (msg !== null) opts.onMessage(msg);
    };
    ws.onerror = () => ws.close(); // the close event does the reconnecting, once
    ws.onclose = () => {
      if (ws !== socket || closed) return;
      socket = null;
      opened = false;
      opts.onStatus?.(false);
      const delay = backoffMs;
      backoffMs = nextBackoff(backoffMs, maxMs);
      timer = schedule(() => {
        timer = null;
        if (!closed) open();
      }, delay);
    };
  };

  open();

  return {
    send(report) {
      if (socket === null || !opened) return false;
      try {
        socket.send(JSON.stringify(report));
      } catch {
        return false; // a socket mid-close: the next report (15 s at most) goes on the new one
      }
      return true;
    },
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      timer = null;
      socket?.close();
      socket = null;
    },
  };
}

export interface Reporter {
  /** Every frame: sends only when the report's key has changed since the last send that went through. Cheap. */
  frame(): void;
  /** Sends regardless — on a socket (re)open; the tick calls it too. */
  force(): void;
}

/** What "the report changed" means: level, mode, WebGL and stable. The live `missRatio` rides every report but never triggers one. */
export function reportKey(r: OverlayReport): string {
  return `${r.level}|${r.mode}|${r.webgl}|${r.stable}`;
}

/**
 * The upstream report's cadence: `frame()` after every drawn frame, `force()` when a socket opens, and a tick every
 * `REPORT_EVERY_MS` (a timer is fine here: ws.ts is not a scene module; `every` is injectable for tests). A send the
 * socket refused leaves the change pending, so the next frame tries again.
 */
export function createReporter(report: () => OverlayReport, send: (report: OverlayReport) => boolean, every: (fn: () => void, ms: number) => unknown = (fn, ms) => setInterval(fn, ms)): Reporter {
  let lastKey: string | null = null;
  const push = (r: OverlayReport, key: string): void => {
    if (send(r)) lastKey = key;
  };
  const reporter: Reporter = {
    frame() {
      const r = report();
      const key = reportKey(r);
      if (key !== lastKey) push(r, key);
    },
    force() {
      const r = report();
      push(r, reportKey(r));
    },
  };
  every(reporter.force, REPORT_EVERY_MS);
  return reporter;
}

/** A frame is a message only when it is a JSON object with a string `type`; anything else is dropped. */
function parse(data: unknown): OverlayMessage | null {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") return value as OverlayMessage;
  } catch {
    // not JSON
  }
  return null;
}
