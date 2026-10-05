/**
 * Overlay WebSocket hub: the one place Engine events become overlay messages. Every message carries the
 * post-mutation `OverlayState`, projected from the Engine's State with two rules the overlay must never be able to
 * break — outcomes in a tier that is not open yet travel as `name: null` / 🔒 (the overlay never learns a locked name),
 * and nobody is named for an Unlock: the Queue travels as a count, and the Contributor Motes (`motes`, and a fire's
 * `group`) are the only people on the wire — lists of everyone whose money is in an Unlock, each Mote's `name` there for
 * its glyph and picture only, its `avatarUrl` the cache's synchronous answer (`peek`: never a lookup, never a wait), its
 * `key` an opaque hash of the State's identity key (`moteWireKey`) — the Twitch user id, the login hint and the raw
 * `twitch:<id>` key itself all stay in the State. The sole exception is a fire's `solo` — the display name of one contributor whose money
 * alone took that Unlock from zero to its Threshold (the Engine marks the Unlock and names its contributor on the
 * `FireResult`; a voided or anonymous contribution names nobody, so the hub never reads the Ledger). A contribution's
 * avatar is a theme glyph chosen by `fnv1a(name)`, so the same name always gets the same glyph (the client
 * re-exports the same hash); its `avatarUrl` is the Avatar Picture from the `AvatarCache` when one is wired — a
 * cached contributor answers synchronously, a first sight starts its bounded lookup the moment the event arrives and only
 * *waits* for it in wire order, and every later message queues behind it so the wire never runs out of order — to the
 * sockets that were attached when the event fired (a socket attaching mid-wait already has a fresher snapshot). The id
 * and login hint stay in the Ledger; the overlay sees the URL only.
 */
import type { Config, OutcomeDef, OverlayConfig, Theme } from "../config/schema.ts";
import type { Engine, EngineEvent } from "../engine/engine.ts";
import { moteGroup, type MoteRecord, type OutcomeState, type State } from "../engine/state.ts";
import { faceValueCents, type ContributionSource, type Face } from "../ingest/contribution.ts";
import type { AvatarSource } from "./avatars.ts";
import { OVERLAY_QUALITY_HEALTH_ID, overlaySteppedDownText, type Health } from "./health.ts";

export interface OverlayOutcome {
  id: string;
  name: string | null; // null (and glyph 🔒) while the outcome's tier is closed
  nameLength: number;
  glyph: string;
  shape: OutcomeDef["shape"];
  tier: number;
  left: number;
  used: number;
  status: OutcomeState["status"];
}

/** A Contributor Mote: one person's share of one Unlock — `name` for the glyph / picture (null = anonymous: blank `avatar`, no picture). */
export interface Mote {
  key: string;
  name: string | null;
  avatar: string;
  avatarUrl: string | null;
  cents: number;
}

/** `collecting` = the Motes of the Unlock being earned now (oldest first); `ready[i]` = the group behind queue position i. */
export interface MoteWire {
  collecting: Mote[];
  ready: Mote[][];
}

export interface OverlayState {
  thresholdCents: number;
  progressCents: number;
  queue: number;
  bankedTotal: number;
  tier: number;
  gates: number[];
  outcomes: OverlayOutcome[];
  drained: boolean;
  motes: MoteWire;
}

export interface OverlaySkin {
  config: OverlayConfig;
  theme: Theme;
  channelName: string;
  /** Chatter Dancers, from `config.chatters`: rides every skin so a Config slider moves the floor live. */
  chatters: { windowMs: number; dwellMs: number; nameLength: number };
}

/** One Active Chatter as the overlay sees it. `key` is opaque (`chatterKey`); the Twitch id and login never travel. */
export interface Chatter {
  key: string;
  name: string;
  avatarUrl: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
}

/** The Active Chatter roster the hub reads (server/chatters.ts; the Debug routes drive `fake` / `hopRandom`). */
export interface ChatterSource {
  /** Active chatters, most recent message first. */
  list(): Chatter[];
  count(): number;
  /** Debug: a made-up person with a stock default picture walks on; repeat calls add more people. */
  fake(): Chatter;
  /** Debug: hop one random person on the floor (fake or real); null when nobody is there. */
  hopRandom(): Chatter | null;
}

export type OverlayMessage =
  | { type: "snapshot"; state: OverlayState; skin: OverlaySkin; chatters: Chatter[] }
  | { type: "contribution"; source: ContributionSource; displayName: string | null; anonymous: boolean; avatar: string; avatarUrl: string | null; face: Face; faceValueCents: number; progressCents: number; unlocksBanked: number; tiersOpened: number[]; state: OverlayState }
  | { type: "fire"; fireSeq: number; outcomeId: string; solo: string | null; group: Mote[]; stockAfter: number; miniDraw?: { title: string; list: string[]; pick: string }; state: OverlayState }
  | { type: "state"; reason: string; tiersOpened: number[]; state: OverlayState }
  | { type: "skin"; skin: OverlaySkin }
  | { type: "cue"; name: string; value?: number }
  | { type: "chatters"; chatters: Chatter[] }
  | { type: "chat-hop"; key: string };

/** Upstream, overlay → server (the one message the client ever sends). */
export interface OverlayReport {
  type: "quality";
  level: 1 | 2 | 3 | 4 | 5;
  mode: "auto" | "manual";
  missRatio: number;
  webgl: boolean;
  stable: boolean;
}

export interface OverlayHubOptions {
  /** Where a failed projection goes (event type + stack). Default: console.error. */
  log?: (message: string) => void;
  /** VERBOSE detail: a client attaching / detaching, with the count. Default: nothing. */
  verbose?: (line: string) => void;
  /** The Dashboard's banners: an Auto Quality step-down warns here until the overlay is stable again. */
  health?: Health;
  /** Avatar Pictures: where a contribution's `avatarUrl` comes from. Absent: every `avatarUrl` is null. */
  avatars?: AvatarSource;
  /** Chatter Dancers: the Active Chatter roster the snapshot and `chattersChanged` read. Absent: an empty list. */
  chatters?: ChatterSource;
}

/** What the hub needs from a socket — Bun's ServerWebSocket satisfies it, and so does a test fake. */
export interface OverlaySocket {
  send(data: string): unknown;
}

export const LOCKED_GLYPH = "🔒";
export const ANONYMOUS_KEY = "anonymous";
export const WS_PATH = "/overlay/ws";
export const PAGE_PATH = "/overlay";

/** What a contribution message will carry for its Avatar Picture; `error` when the lookup rejected (the message still goes out). */
interface Picture {
  url: string | null;
  error?: unknown;
}
const NO_PICTURE: Picture = { url: null };

const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const encoder = new TextEncoder();

/** 32-bit FNV-1a over the UTF-8 bytes of `text` — kept trivial so the overlay client can carry an identical copy. */
export function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A Mote's wire `key`: an opaque, stable hash of the State's identity key (`twitch:<id>` / name / `anon:<seq>`),
 * base-36 for brevity. The scene only needs one key per contributor that holds for the session; the raw key — and with
 * it the Twitch user id — stays in the State.
 */
export function moteWireKey(identityKey: string): string {
  return fnv1a(identityKey).toString(36);
}

/** A Chatter's wire `key`: the same opaque hash as a Mote's, over `chatter:<id>` — the Twitch user id stays on the server. */
export function chatterKey(twitchUserId: string): string {
  return fnv1a(`chatter:${twitchUserId}`).toString(36);
}

/** `theme.avatars[fnv1a(name ?? "anonymous") % n]`: the same name always gets the same avatar; anonymous hashes too. */
export function avatarFor(name: string | null, theme: Theme): string {
  const { avatars } = theme;
  if (avatars.length === 0) return "";
  return avatars[fnv1a(name ?? ANONYMOUS_KEY) % avatars.length]!;
}

/** Masking: an outcome in a closed tier travels with no name and the lock glyph; nothing else about it leaks either. */
export function maskOutcome(o: OutcomeState, openTier: number): OverlayOutcome {
  const open = o.tier <= openTier;
  return {
    id: o.id,
    name: open ? o.name : null,
    nameLength: o.name.length,
    glyph: open ? o.glyph : LOCKED_GLYPH,
    shape: o.shape,
    tier: o.tier,
    left: o.left,
    used: o.used,
    status: o.status,
  };
}

const LEVELS = new Set([1, 2, 3, 4, 5]);
const MODES = new Set(["auto", "manual"]);

/** The wire shape of an `OverlayReport`, field by field; null for anything else. */
export function parseReport(text: string): OverlayReport | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.type !== "quality") return null;
  if (typeof r.level !== "number" || !LEVELS.has(r.level)) return null;
  if (typeof r.mode !== "string" || !MODES.has(r.mode)) return null;
  if (typeof r.missRatio !== "number" || !Number.isFinite(r.missRatio) || r.missRatio < 0 || r.missRatio > 1) return null;
  if (typeof r.webgl !== "boolean" || typeof r.stable !== "boolean") return null;
  return { type: "quality", level: r.level as OverlayReport["level"], mode: r.mode as OverlayReport["mode"], missRatio: r.missRatio, webgl: r.webgl, stable: r.stable };
}

export class OverlayHub {
  readonly #engine: Engine;
  readonly #config: () => Config;
  readonly #log: (message: string) => void;
  readonly #verbose: (line: string) => void;
  readonly #health: Health | null;
  readonly #avatars: AvatarSource | null;
  readonly #chatters: ChatterSource | null;
  /** A first-sight picture lookup being waited on: every later Engine event dispatches behind it (in order), until it drains. */
  #queue: Promise<void> | null = null;
  readonly #sockets = new Set<OverlaySocket>();
  /** The latest quality report per attached socket — in memory only, gone with the socket. */
  readonly #reports = new Map<OverlaySocket, OverlayReport>();

  /** Bun `websocket` handler for the overlay listener: attach on open, detach on close, the quality report upstream. */
  readonly wsHandler: Bun.WebSocketHandler<unknown> = {
    open: (ws) => this.attach(ws),
    close: (ws) => this.detach(ws),
    message: (ws, data) => this.receive(ws, data),
  };

  constructor(engine: Engine, config: () => Config, opts: OverlayHubOptions = {}) {
    this.#engine = engine;
    this.#config = config;
    this.#log = opts.log ?? ((message: string) => console.error(message));
    this.#verbose = opts.verbose ?? (() => {});
    this.#health = opts.health ?? null;
    this.#avatars = opts.avatars ?? null;
    this.#chatters = opts.chatters ?? null;
    engine.on((ev) => this.#onEngine(ev));
  }

  snapshot(): OverlayMessage {
    return { type: "snapshot", state: this.#project(this.#engine.state), skin: this.#skin(), chatters: this.#chatters?.list() ?? [] };
  }

  /** The roster changed (someone arrived, hopped, or lapsed): every overlay gets the whole list — never queued behind a picture wait, it carries no state. */
  chattersChanged(): void {
    this.broadcast({ type: "chatters", chatters: this.#chatters?.list() ?? [] });
  }

  /** One message from someone on the floor: the client hops that dancer without diffing lists. */
  chatHop(key: string): void {
    this.broadcast({ type: "chat-hop", key });
  }

  /** Keep the socket and send it the snapshot right away, so a freshly (re)loaded overlay is complete before any event. */
  attach(ws: OverlaySocket): void {
    this.#sockets.add(ws);
    this.#verbose(`overlay: client connected (${this.#sockets.size} attached)`);
    this.#send(ws, JSON.stringify(this.snapshot()));
  }

  detach(ws: OverlaySocket): void {
    this.#reports.delete(ws);
    if (this.#sockets.delete(ws)) this.#verbose(`overlay: client disconnected (${this.#sockets.size} attached)`);
  }

  /**
   * A frame from an overlay: a valid `OverlayReport` is kept as that socket's latest (anything else is dropped without a
   * word — the client never sends anything else, so junk is not worth a log line). A level lower than the socket's
   * previous report while Auto is in charge and the overlay is not yet stable raises the Health warn; a stable report
   * clears it.
   */
  receive(ws: OverlaySocket, data: string | Buffer | ArrayBuffer | Uint8Array): void {
    if (!this.#sockets.has(ws)) return;
    const report = parseReport(typeof data === "string" ? data : new TextDecoder().decode(data));
    if (report === null) return;
    const previous = this.#reports.get(ws);
    this.#reports.set(ws, report);
    if (this.#health === null) return;
    if (previous !== undefined && report.mode === "auto" && report.level < previous.level && !report.stable) {
      this.#health.set(OVERLAY_QUALITY_HEALTH_ID, "warn", overlaySteppedDownText(report.level));
    } else if (report.stable) this.#health.clear(OVERLAY_QUALITY_HEALTH_ID);
  }

  /** The latest report of every connected overlay that has sent one, in attach order. */
  reports(): OverlayReport[] {
    const out: OverlayReport[] = [];
    for (const ws of this.#sockets) {
      const r = this.#reports.get(ws);
      if (r !== undefined) out.push(r);
    }
    return out;
  }

  broadcast(msg: OverlayMessage): void {
    this.#sendTo([...this.#sockets], msg);
  }

  /** One message to a chosen set of sockets — skipping any that detached in the meantime. */
  #sendTo(recipients: readonly OverlaySocket[], msg: OverlayMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of recipients) if (this.#sockets.has(ws)) this.#send(ws, data);
  }

  /** Config changed: every overlay adopts the current skin. */
  skinChanged(): void {
    this.broadcast({ type: "skin", skin: this.#skin() });
  }

  /**
   * The overlay listener's HTTP side: upgrades `/overlay/ws`, else undefined (→ 404). The page itself and its assets
   * are `Bun.serve` routes (overlay-page.ts), which Bun answers before this handler is asked.
   */
  overlayHttp(req: Request, server: Bun.Server<unknown>): Response | undefined {
    const { pathname } = new URL(req.url);
    if (pathname === WS_PATH) return server.upgrade(req, { data: undefined }) ? undefined : new Response("expected a websocket upgrade", { status: 426 });
    return undefined;
  }

  /** A socket that cannot take a message must not cost the other overlays theirs; Bun closes a dead one on its own. */
  #send(ws: OverlaySocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      // see above
    }
  }

  /**
   * Engine listeners run after the transaction committed, so whatever goes wrong in here stays in here: the message is
   * logged and dropped, and the streamer's Fire (or the Ko-fi delivery) that caused it still answers 200. The overlay catches
   * up on the next event or reload — it always carries the whole state.
   *
   * Two things are fixed the moment the event arrives: who hears it (the sockets attached now — one attaching later gets
   * a snapshot that already counts this event and must not hear it again, older, behind that), and the picture lookup
   * for a contribution's first sight, which starts now so a burst of unknown contributors costs the cache's bound once,
   * not once each. Dispatch is synchronous except for that one case: while a first sight is being waited on, every later
   * event waits its turn behind it — each still carries its own post-mutation state, so nothing is lost, only delayed —
   * and the synchronous fast path returns once the queue drains. The Ledger write and the Dashboard's response happened
   * before this listener ran and never wait.
   */
  #onEngine(ev: EngineEvent): void {
    const dropped = (e: unknown) => this.#log(`overlay: dropped ${ev.type} message: ${describe(e)}`);
    const recipients = [...this.#sockets];
    let picture: Picture | Promise<Picture>;
    let result: void | Promise<void>;
    try {
      picture = ev.type === "contribution" ? this.#picture(ev.entry.payload) : NO_PICTURE;
      if (this.#queue !== null) result = this.#queue.then(() => this.#dispatch(ev, recipients, picture));
      else result = this.#dispatch(ev, recipients, picture);
    } catch (e) {
      dropped(e);
      return;
    }
    if (result === undefined) return;
    const settled: Promise<void> = result.then(undefined, dropped).finally(() => {
      if (this.#queue === settled) this.#queue = null;
    });
    this.#queue = settled;
  }

  /**
   * A contribution's Avatar Picture: null at once for anonymous (never pictured, nor looked up, whatever the payload
   * carries), for no cache, and for an entry with neither id nor hint (older Ledger entries); the cache's answer at once
   * when it has one; else the lookup, started here and already settled into what the message will carry — never a
   * rejected promise, since it may sit in the queue unobserved (the cache never rejects; a defensive path).
   */
  #picture(payload: { anonymous: boolean; twitchUserId?: string | null; loginHint?: string | null }): Picture | Promise<Picture> {
    if (payload.anonymous || this.#avatars === null) return NO_PICTURE;
    const ref = { twitchUserId: payload.twitchUserId, loginHint: payload.loginHint };
    const cached = this.#avatars.cached(ref);
    if (cached !== undefined) return { url: cached };
    return this.#avatars.urlFor(ref).then(
      (url) => ({ url }),
      (error: unknown) => ({ url: null, error }),
    );
  }

  #dispatch(ev: EngineEvent, recipients: readonly OverlaySocket[], picture: Picture | Promise<Picture>): void | Promise<void> {
    const state = this.#project(ev.state);
    switch (ev.type) {
      case "contribution": {
        const { source, displayName, anonymous, face, progressCents } = ev.entry.payload;
        const send = (p: Picture): void => {
          this.#sendTo(recipients, {
            type: "contribution",
            source,
            displayName,
            anonymous,
            avatar: avatarFor(anonymous ? null : displayName, this.#theme()),
            avatarUrl: p.url,
            face,
            faceValueCents: faceValueCents(face),
            progressCents,
            unlocksBanked: ev.unlocksBanked,
            tiersOpened: ev.tiersOpened,
            state,
          });
          // the picture is optional; the money on screen is not — it went out, and this says only that
          if ("error" in p) this.#log(`overlay: contribution message sent without a picture (the avatar lookup rejected): ${describe(p.error)}`);
        };
        return picture instanceof Promise ? picture.then(send) : send(picture);
      }
      case "fire": {
        const { fire, entry } = ev;
        // The one name a drop may carry: the Engine marked the Unlock `solo` (that person's money alone took it from
        // zero to its Threshold), the contributor is still real (a void makes it null), and it is not anonymous.
        const solo = fire.unlock.solo && fire.contributor !== null && !fire.contributor.anonymous ? fire.contributor.displayName : null;
        const theme = this.#theme();
        this.#sendTo(recipients, {
          type: "fire",
          fireSeq: fire.seq,
          outcomeId: fire.outcome.id,
          solo,
          group: fire.unlock.group.map((r) => this.#mote(r, theme)), // the consumed Unlock's Contributor Motes
          stockAfter: entry.payload.stockAfter,
          ...(fire.miniDraw === undefined ? {} : { miniDraw: fire.miniDraw }),
          state,
        });
        return;
      }
      case "state":
        this.#sendTo(recipients, { type: "state", reason: ev.reason, tiersOpened: ev.tiersOpened, state });
        return;
    }
  }

  #project(state: State): OverlayState {
    const config = this.#config();
    const theme = this.#theme(config);
    return {
      thresholdCents: state.thresholdCents,
      progressCents: state.progressCents,
      queue: state.queue.length,
      bankedTotal: state.bankedTotal,
      tier: state.tier,
      gates: [...config.tiers.gates],
      outcomes: state.outcomes.map((o) => maskOutcome(o, state.tier)),
      drained: state.drained,
      motes: { collecting: moteGroup(state.collecting).map((r) => this.#mote(r, theme)), ready: state.queue.map((u) => u.group.map((r) => this.#mote(r, theme))) },
    };
  }

  /**
   * A record as the overlay sees it: the key hashed (`moteWireKey` — the raw `twitch:<id>` never travels), the glyph by
   * name, the picture the cache already has (anonymous: blank, none), the cents — no id, no hint.
   */
  #mote(r: MoteRecord, theme: Theme): Mote {
    const key = moteWireKey(r.key);
    if (r.name === null) return { key, name: null, avatar: "", avatarUrl: null, cents: r.cents };
    const avatarUrl = this.#avatars === null || (r.twitchUserId === null && r.loginHint === null) ? null : this.#avatars.peek({ twitchUserId: r.twitchUserId, loginHint: r.loginHint });
    return { key, name: r.name, avatar: avatarFor(r.name, theme), avatarUrl, cents: r.cents };
  }

  #skin(): OverlaySkin {
    const config = this.#config();
    const ch = config.chatters;
    return {
      config: config.overlay,
      theme: this.#theme(config),
      channelName: config.channel.displayName || config.channel.login,
      chatters: { windowMs: ch.windowMinutes * 60_000, dwellMs: ch.dwellSeconds * 1000, nameLength: ch.nameLength },
    };
  }

  /** `overlay.theme` is validated to be a key of `themes`. */
  #theme(config = this.#config()): Theme {
    return config.themes[config.overlay.theme]!;
  }
}
