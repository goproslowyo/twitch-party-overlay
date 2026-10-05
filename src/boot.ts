/**
 * boot(): wire the service and start it.
 *
 *   env → Secrets → ConfigStore (identity seeded from Secrets once) → Ledger → Engine (replay) → Health (boot banner)
 *   → Firebot → Helix → OAuth → OverlayHub → app → listeners → adapters (Twitch EventSub, StreamElements)
 *   → config watch
 *
 * Adapters read config lazily through `() => Config`; a hand edit of config.json is picked up by the watcher, logged as a
 * `config_change` by `system:file` and pushed to every overlay as a `skin`. `stop()` takes it all down in reverse.
 * main.ts owns env parsing, signals and the process; everything here is in-process and testable on ephemeral ports.
 */
import fs from "node:fs";
import path from "node:path";
import { Secrets } from "./config/secrets.ts";
import type { Config } from "./config/schema.ts";
import { ConfigStore, ConfigWatchError } from "./config/store.ts";
import { Engine, EngineError } from "./engine/engine.ts";
import { reduce, type ReduceContext } from "./engine/state.ts";
import type { Contribution, Face } from "./ingest/contribution.ts";
import { SeBackfill, SeRest } from "./ingest/streamelements/rest.ts";
import { SeSocket } from "./ingest/streamelements/socket.ts";
import { CHAT_SUBSCRIPTION_TYPE, EventSubClient, mockSubscriptionsUrl, type EventSubStatus } from "./ingest/twitch/eventsub.ts";
import { Helix, TOKEN_KEYS, type FetchLike } from "./ingest/twitch/helix.ts";
import { describeEvent, normalizeEventSub, type EventSubNotification } from "./ingest/twitch/normalize.ts";
import { Firebot } from "./integrations/firebot.ts";
import { entryLine, type DescribeContext } from "./ledger/describe.ts";
import { Ledger } from "./ledger/ledger.ts";
import type { Entry } from "./ledger/types.ts";
import { FIREBOT_HEALTH_ID } from "./server/api.ts";
import { createApp } from "./server/app.ts";
import { sessionSecret } from "./server/auth.ts";
import { CHAT_HEALTH_ID, CHAT_UNHEARD_TEXT, Health } from "./server/health.ts";
import { startListeners, type Listeners } from "./server/listeners.ts";
import { CHAT_SCOPE, OAuth } from "./server/oauth.ts";
import { AvatarCache } from "./server/avatars.ts";
import { ChatterRoster, type ChatMessageEvent } from "./server/chatters.ts";
import { OverlayHub } from "./server/overlay.ts";
import { overlayRoutes } from "./server/overlay-page.ts";
import { SETUP_PATH, TWITCH_APP_KEYS, twitchAppConfigured, type SetupArea } from "./server/dashboard/setup.ts";

export interface BootOptions {
  dataDir: string;
  configFile?: string; // default <dataDir>/config.json
  ledgerFile?: string; // default <dataDir>/ledger.sqlite
  secretsFile?: string; // default <dataDir>/secrets.env
  /**
   * `HOST_LAN_IP`: this computer's own address on the network it is using, for the OBS overlay URL on Config. A container
   * cannot see the NICs of the computer it runs on, so `just up` looks it up on the host (scripts/lan-ip.sh) and passes it
   * in. Absent outside Docker, where the machine's own addresses are the right answer. See server/overlay-urls.ts.
   */
  hostLanIp?: string;
  /** `BIND_ALL=1`: app listeners on 0.0.0.0 whatever `listeners.bindAll` says. */
  bindAll?: boolean;
  /** Listener ports overriding the config's (0 = ephemeral) — tests; the file cannot hold a 0. */
  ports?: Partial<Ports>;
  log?: (line: string) => void; // default console.log
  /**
   * `VERBOSE=1`: the "is it working" lines through `log` too, roughly one per real event — every `unlock` entry, EventSub
   * welcome / subscribed / notification frames and duplicates dropped, StreamElements socket events and backfill runs that
   * found something (or failed), Helix token refreshes, overlay clients attaching / detaching. Default off.
   */
  verbose?: boolean;
  /** `DEBUG=1`: everything — VERBOSE plus keepalives, empty backfill runs and one line per HTTP request. Implies `verbose`. */
  debug?: boolean;
  now?: () => Date;
  /** Every Helix / id.twitch.tv call goes through this (tests: a fake Twitch, never the network). Default: global fetch. */
  fetchImpl?: FetchLike;
  /** How long every EventSub session must be down before the outage banner (tests shorten it). Default 15 s. */
  twitchDownGraceMs?: number;
  /**
   * The Dashboard's Shut down button (`POST /api/shutdown`): called once the 200 has gone out, with the source
   * (`"dashboard"`). main.ts hands in its signal path, so the button stops the process exactly the way SIGTERM does.
   * Without it the route answers 503 — a bare boot() (tests) has no process to stop.
   */
  onShutdownRequest?: (source: string) => void;
}

export interface Ports {
  streamer: number;
  funnel: number;
  overlay: number;
}

export interface Booted {
  ports: Ports;
  stop(): Promise<void>;
}

export const BOOT_HEALTH_ID = "boot";
export const CONFIG_HEALTH_ID = "config";
export const TWITCH_HEALTH_ID = "twitch";
export const TWITCH_LINK_HEALTH_ID = "twitch-link";
export const TWITCH_APP_HEALTH_ID = "twitch-app";
export const BIND_ALL_HEALTH_ID = "bind-all";
export const STREAMELEMENTS_HEALTH_ID = "streamelements";
export const NOT_LINKED_TEXT = `Twitch account not connected — open Setup on the computer running the overlay (${SETUP_PATH})`;
export const TWITCH_APP_MISSING_TEXT = `Twitch app not set up yet — open Setup on the computer running the overlay (${SETUP_PATH})`;

const TWITCH_ACTOR = "system:twitch";
const STREAMELEMENTS_ACTOR = "system:streamelements";
const SE_DENIED_REASON = "tip denied by StreamElements moderation";
/** Every session down for longer than this is an outage worth a banner; a reconnect inside it is routine. */
const TWITCH_DOWN_GRACE_MS = 15_000;
const MODS_REFRESH_MS = 60 * 60_000;
const CHAT_SWEEP_MS = 5_000; // roster lapse check
/** First StreamElements backfill on an empty Ledger: the last hour is plenty for a service that just came up. */
const SE_INITIAL_LOOKBACK_MS = 60 * 60_000;

/** Wizard identity values: copied from Secrets into config.json when the config field is still empty. */
const IDENTITY_SEEDS: ReadonlyArray<{ key: string; get: (c: Config) => string; set: (c: Config, v: string) => void }> = [
  { key: "CHANNEL_LOGIN", get: (c) => c.channel.login, set: (c, v) => void (c.channel.login = v) },
  { key: "FUNNEL_PUBLIC_URL", get: (c) => c.funnel.publicUrl, set: (c, v) => void (c.funnel.publicUrl = v) },
  { key: "KOFI_WEBHOOK_PATH", get: (c) => c.ingest.kofi.webhookPath, set: (c, v) => void (c.ingest.kofi.webhookPath = v) },
];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clock = (d: Date): string => d.toLocaleTimeString();
/** `HH:MM:SS` local — the console's timestamp, the same one the Dashboard's Ledger page shows. */
const stamp = (d: Date): string => d.toTimeString().slice(0, 8);
const isContribution = (e: Entry): e is Entry<"contribution"> => e.type === "contribution";

/** `Bun.Server.port` is only undefined for a unix socket, which the listeners never are. */
function portOf(server: Bun.Server<unknown>): number {
  if (server.port === undefined) throw new Error("listener has no TCP port");
  return server.port;
}

/**
 * Where a `change` came from. `update()` callers — the API's PUT, the broadcaster link, boot's seeding — write their own
 * `config_change` (with their own actor) and their own skin broadcast; the watcher's reload is the only other emitter, so
 * "not inside update()" means "the streamer edited the file by hand" → `system:file`.
 */
class ConfigFile extends ConfigStore {
  #updating = 0;

  get updating(): boolean {
    return this.#updating > 0;
  }

  override update(next: Config): ReturnType<ConfigStore["update"]> {
    this.#updating++;
    try {
      return super.update(next);
    } finally {
      this.#updating--;
    }
  }
}

export async function boot(opts: BootOptions): Promise<Booted> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const debug = opts.debug === true ? log : () => {};
  const verbose = opts.verbose === true || opts.debug === true ? log : () => {};
  const now = opts.now ?? (() => new Date());
  const dataDir = path.resolve(opts.dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const timers: Array<ReturnType<typeof setInterval>> = [];
  const stops: Array<() => void | Promise<void>> = [];

  // --- files ---------------------------------------------------------------------------------------------------------
  const secrets = new Secrets(opts.secretsFile ?? path.join(dataDir, "secrets.env"));
  const store = new ConfigFile(opts.configFile ?? path.join(dataDir, "config.json"), { log });
  const config = () => store.get();
  const ledger = new Ledger(opts.ledgerFile ?? path.join(dataDir, "ledger.sqlite"));
  stops.push(() => ledger.close());

  // --- core ----------------------------------------------------------------------------------------------------------
  const engine = new Engine(ledger, config, { now }); // before seedIdentity: its config_change must not pre-empt the Engine's threshold seed
  log(`replayed ${ledger.all().length} entries`);
  ledger.onAppend((entries) => logEntries(entries, engine, config(), ledger, now, log, verbose));
  seedIdentity(store, secrets, ledger);
  const health = new Health({ now });
  health.set(BOOT_HEALTH_ID, "info", `Service (re)started at ${clock(now())} — Ko-fi webhooks during downtime are lost; check the Ko-fi dashboard`);
  const firebot = new Firebot({ config, onWarn: (text) => health.set(FIREBOT_HEALTH_ID, "warn", text) });

  // The Twitch app keys are read from Secrets on every use, not copied once: the Setup page saves them through
  // `Secrets.set()` and the very next OAuth start / Helix call sees them. No restart, which a double-clicked binary has
  // nobody to perform anyway. The StreamElements JWT is the one secret an adapter reads at start; `onSetupChange` below
  // stops and starts that adapter in place for the same reason.
  const clientId = () => secrets.get(TWITCH_APP_KEYS.id) ?? "";
  const clientSecret = () => secrets.get(TWITCH_APP_KEYS.secret) ?? "";
  if (!twitchAppConfigured(secrets)) health.set(TWITCH_APP_HEALTH_ID, "warn", TWITCH_APP_MISSING_TEXT);
  const helix = new Helix({ clientId, clientSecret, secrets, now, verbose: (line) => verbose(`twitch: ${line}`), ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }) });
  const secret = sessionSecret(secrets); // once: OAuth signs with it, the app verifies with it
  const avatars = new AvatarCache(helix, { now: () => now().getTime(), warn: log }); // Avatar Pictures: Helix down is a log line, never a banner
  // Chatter Dancers: the Active Chatter roster; its callbacks reach the hub declared right below (they only run on chat, long after boot)
  const roster = new ChatterRoster({ config, avatars, now: () => now().getTime(), onChange: () => hub.chattersChanged(), onHop: (key) => hub.chatHop(key), log: verbose });
  const hub = new OverlayHub(engine, config, { log, verbose, health, avatars, chatters: roster }); // a quality step-down warns on the Live page
  timers.push(setInterval(() => roster.sweep(), CHAT_SWEEP_MS));

  const twitch = twitchAdapter({ config, secrets, helix, engine, roster, health, log, verbose, debug, now, downGraceMs: opts.twitchDownGraceMs ?? TWITCH_DOWN_GRACE_MS });
  const oauth = new OAuth({
    clientId,
    clientSecret,
    secrets,
    helix,
    config,
    ledger,
    dataDir,
    now,
    log,
    ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    onBroadcasterLinked: (userId, login) => {
      const next = structuredClone(config());
      next.channel.broadcasterId = userId;
      next.channel.login = login;
      const diff = store.update(next);
      if (diff.length > 0) {
        ledger.append("config_change", "system:auth", { diff });
        hub.skinChanged();
      }
      void oauth.refreshMods().catch((e) => log(`mods refresh after link failed: ${errorText(e)}`));
      // A fresh token may carry a scope the old one lacked (user:read:chat): read its scopes again and subscribe again.
      // stop() is a no-op when nothing ran; start() still answers the not-linked case. One reconnect at link time is fine.
      twitch.stop();
      twitch.start();
    },
  });
  timers.push(setInterval(() => void oauth.refreshMods().catch((e) => log(`hourly mods refresh failed: ${errorText(e)}`)), MODS_REFRESH_MS));

  const se = streamElementsAdapter({ config, secrets, engine, ledger, health, log, verbose, debug, now }); // started below, with the other adapters
  const onSetupChange = (area: SetupArea): void => {
    if (area === "streamelements") {
      se.stop(); // start() reads the JWT and `ingest.streamelements.enabled` afresh; a no-op when the switch is off
      se.start();
    }
    // "twitch": Helix and OAuth read the keys live (above); the broadcaster link that follows restarts EventSub itself.
    // "channel", "public", "firebot": Ko-fi, Firebot and the funnel's redirect URI all read config on every request.
  };
  const app = createApp({ config: store, secrets, ledger, engine, health, firebot, oauth, hub, chatters: roster, sessionSecret: secret, log, debug, now, hostLanIp: opts.hostLanIp, setup: { onSetupChange }, ...(opts.onShutdownRequest === undefined ? {} : { onShutdownRequest: opts.onShutdownRequest }) });

  // --- listeners -----------------------------------------------------------------------------------------------------
  const base = config();
  const listenerConfig: Config = {
    ...base,
    listeners: {
      streamerPort: opts.ports?.streamer ?? base.listeners.streamerPort,
      funnelPort: opts.ports?.funnel ?? base.listeners.funnelPort,
      overlayPort: opts.ports?.overlay ?? base.listeners.overlayPort,
      bindAll: opts.bindAll ?? base.listeners.bindAll,
      overlayOnLan: base.listeners.overlayOnLan,
    },
  };
  const listeners: Listeners = startListeners({
    config: listenerConfig,
    handlers: { app: (req, listener) => app.handle(req, listener), overlay: (req, server) => hub.overlayHttp(req, server), overlayWs: hub.wsHandler, overlayRoutes },
    onError: (listener, error) => log(`[${listener}] unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
  });
  const ports: Ports = { streamer: portOf(listeners.streamer), funnel: portOf(listeners.funnel), overlay: portOf(listeners.overlay) };
  const appHost = listenerConfig.listeners.bindAll ? "0.0.0.0" : "127.0.0.1";
  log(`listening streamer=${appHost}:${ports.streamer} funnel=${appHost}:${ports.funnel} overlay=${listeners.overlay.hostname}:${ports.overlay}`);
  log(listenerConfig.listeners.overlayOnLan || listenerConfig.listeners.bindAll ? `overlay for OBS: http://localhost:${ports.overlay}/overlay on this computer, or this computer's network address from another one` : `overlay for OBS: http://localhost:${ports.overlay}/overlay (this computer only; turn on "OBS runs on another computer" on the Config page for the LAN)`);
  if (base.listeners.bindAll && opts.bindAll === undefined) {
    // Docker sets BIND_ALL=1 and publishes 8700 on 127.0.0.1 only; the same flag in config.json outside Docker is a hole.
    const text = "listeners.bindAll is on — the streamer Dashboard is reachable from the LAN without login";
    log(`warning: ${text}`);
    health.set(BIND_ALL_HEALTH_ID, "warn", text);
  }

  // --- adapters (Ko-fi is inbound: the funnel listener already routes it) --------------------------------------------
  twitch.start();
  stops.push(() => twitch.stop());
  se.start();
  stops.push(() => se.stop());

  // --- config hot reload ---------------------------------------------------------------------------------------------
  store.on("change", (diff) => {
    if (store.updating) return; // an update() caller records its own entry and skin (see ConfigFile)
    ledger.append("config_change", "system:file", { diff });
    engine.reproject("system:file"); // a hand edit of `outcomes` applies now: new ids seeded, removed ids zeroed, the list rebuilt
    hub.skinChanged();
    health.clear(CONFIG_HEALTH_ID);
    log(`config.json reloaded: ${diff.map((d) => d.path).join(", ")}`);
  });
  store.on("invalid", (error) => {
    const text = error instanceof ConfigWatchError ? error.message : `config.json is invalid — last good config still in use: ${error.message}`;
    health.set(CONFIG_HEALTH_ID, "warn", text);
    log(error instanceof ConfigWatchError ? text : `config.json is invalid, keeping the last good config: ${error.message}`);
  });
  store.watch();

  let stopping: Promise<void> | null = null;
  return {
    ports,
    stop: () =>
      (stopping ??= (async () => {
        store.close();
        for (const t of timers) clearInterval(t);
        listeners.stop();
        for (const stop of stops.reverse()) await stop();
      })()),
  };
}

/**
 * One console line per committed Ledger entry: `HH:MM:SS #143 contribution system:streamelements — @dana tipped $10 (+$10)
 * → $23 of $50`. The Engine folds a batch into its State only after the transaction returns — after this has run — so
 * the fader position on a contribution line comes from folding the batch over the State as it stands, through the
 * Engine's own reducer (no second arithmetic). `unlock` entries are noise the contribution line already counts
 * (`+2 UNLOCKS`): they print under VERBOSE only.
 */
function logEntries(entries: readonly Entry[], engine: Engine, config: Config, ledger: Ledger, now: () => Date, log: (line: string) => void, verbose: (line: string) => void): void {
  const rctx: ReduceContext = { config, entry: (seq) => ledger.get(seq) };
  let state = engine.state;
  for (const e of entries) {
    state = reduce(state, e, rctx);
    const ctx: DescribeContext = { outcome: (id) => state.outcomes.find((o) => o.id === id), entry: (seq) => ledger.get(seq) };
    if (isContribution(e)) {
      ctx.progressCents = state.progressCents;
      ctx.thresholdCents = state.thresholdCents;
      ctx.unlocks = entries.filter((u) => u.type === "unlock" && (u as Entry<"unlock">).payload.contributionSeq === e.seq).length;
    }
    (e.type === "unlock" ? verbose : log)(`${stamp(now())} ${entryLine(e, ctx)}`);
  }
}

/** An empty identity field in config.json takes the wizard's value from Secrets — once; the file is the truth after that. */
function seedIdentity(store: ConfigFile, secrets: Secrets, ledger: Ledger): void {
  const next = structuredClone(store.get());
  let touched = false;
  for (const seed of IDENTITY_SEEDS) {
    const value = secrets.get(seed.key);
    if (value !== undefined && value !== "" && seed.get(next) === "") {
      seed.set(next, value);
      touched = true;
    }
  }
  if (!touched) return;
  const diff = store.update(next);
  if (diff.length > 0) ledger.append("config_change", "system:boot", { diff });
}

// ---------------------------------------------------------------------------------------------------------------------
// Twitch EventSub
// ---------------------------------------------------------------------------------------------------------------------

interface TwitchDeps {
  config: () => Config;
  secrets: Secrets;
  helix: Helix;
  engine: Engine;
  roster: Pick<ChatterRoster, "message">;
  health: Health;
  log: (line: string) => void;
  verbose: (line: string) => void;
  debug: (line: string) => void;
  now: () => Date;
  downGraceMs: number;
}

interface Adapter {
  start(): void;
  stop(): void;
}

/**
 * EventSub → Engine. Starts only with a linked broadcaster (token + id), else the not-linked banner; the broadcaster link
 * calls `start()` again. A notification that cannot be credited is a lost event: logged, and a banner tells the mods
 * what to Manual Credit. The outage banner needs every session down for more than 15 s.
 */
function twitchAdapter(d: TwitchDeps): Adapter {
  let client: EventSubClient | null = null;
  const up = new Map<number, boolean>();
  let downTimer: ReturnType<typeof setTimeout> | null = null;
  let chatHeard = false;

  const onNotification = (msg: EventSubNotification): void => {
    if (msg.metadata.subscription_type === CHAT_SUBSCRIPTION_TYPE) {
      // Chat is presence: the roster hears who spoke; the Engine and the Ledger never see the frame, let alone the text.
      if (!chatHeard) {
        chatHeard = true;
        d.health.clear(CHAT_HEALTH_ID);
      }
      const ev = msg.payload.event as Partial<ChatMessageEvent>;
      if (typeof ev.chatter_user_id === "string" && typeof ev.chatter_user_login === "string" && typeof ev.chatter_user_name === "string" && typeof ev.broadcaster_user_id === "string") {
        d.roster.message({ chatter_user_id: ev.chatter_user_id, chatter_user_login: ev.chatter_user_login, chatter_user_name: ev.chatter_user_name, broadcaster_user_id: ev.broadcaster_user_id, source_broadcaster_user_id: typeof ev.source_broadcaster_user_id === "string" ? ev.source_broadcaster_user_id : null });
      }
      return;
    }
    try {
      const c = normalizeEventSub(msg);
      if (c === null) return;
      d.engine.contribute(c, TWITCH_ACTOR, msg);
    } catch (e) {
      const id = msg.metadata?.message_id ?? "?";
      d.log(`twitch: event ${id} could not be credited: ${errorText(e)}`);
      d.health.set(`twitch-credit:${id}`, "warn", `Twitch event could not be credited — Manual Credit: ${describeEvent(msg)}`);
    }
  };

  /**
   * The chat line without waiting for the first POST to fail: read the token's scopes at start, beside the sockets (never
   * ahead of them: a hung id.twitch.tv must not hold up bits and subs). Unreachable Twitch is a log line; the subscription's
   * refusal decides later. An answer that lands after a restart (`c` no longer the client) is dropped: it was the old token's.
   */
  const checkChatScope = async (c: EventSubClient): Promise<void> => {
    try {
      const { scopes } = await d.helix.validate(await d.helix.token());
      if (scopes.includes(CHAT_SCOPE) || client !== c) return;
      d.log(`twitch: the broadcaster token has no ${CHAT_SCOPE} scope — chat is not heard until the broadcaster link is clicked again`);
      d.health.set(CHAT_HEALTH_ID, "warn", CHAT_UNHEARD_TEXT);
    } catch (e) {
      d.log(`twitch: could not read the token's scopes (${errorText(e)}); subscribing anyway`);
    }
  };

  const onStatus = (s: EventSubStatus): void => {
    if (client === null) return; // stop() reports every session down; that is not an outage
    up.set(s.session, s.connected);
    if (s.reason !== undefined) d.log(`twitch: session ${s.session} ${s.connected ? "up" : "down"} (${s.reason})`);
    if ([...up.values()].some(Boolean)) {
      if (downTimer !== null) clearTimeout(downTimer);
      downTimer = null;
      d.health.clear(TWITCH_HEALTH_ID);
    } else if (downTimer === null) {
      const since = clock(d.now());
      downTimer = setTimeout(() => {
        d.health.set(TWITCH_HEALTH_ID, "warn", `Twitch EventSub: all sessions disconnected — cheers/subs since ${since} may be missing; Manual Credit if needed`);
      }, d.downGraceMs);
    }
  };

  return {
    start() {
      if (client !== null) return;
      const { ingest, channel } = d.config();
      if (!ingest.twitch.enabled) return;
      if (d.secrets.get(TOKEN_KEYS.access) === undefined || channel.broadcasterId === "") {
        d.health.set(TWITCH_LINK_HEALTH_ID, "warn", NOT_LINKED_TEXT);
        return;
      }
      d.health.clear(TWITCH_LINK_HEALTH_ID);
      // The url is read here, once: a Config edit of ingest.twitch.eventsubUrl takes effect at the next start (README, wiring check).
      const subscriptionsUrl = mockSubscriptionsUrl(ingest.twitch.eventsubUrl);
      if (subscriptionsUrl !== undefined) d.log(`twitch: mock mode — subscriptions via ${subscriptionsUrl}`);
      client = new EventSubClient({
        url: ingest.twitch.eventsubUrl,
        sessions: ingest.twitch.sessions,
        keepaliveSeconds: ingest.twitch.keepaliveSeconds,
        helix: d.helix,
        ...(subscriptionsUrl === undefined ? {} : { subscriptionsUrl }),
        broadcasterId: channel.broadcasterId,
        onNotification,
        onStatus,
        onChatSubscribe: (s) => {
          if (s.ok) {
            chatHeard = true;
            d.health.clear(CHAT_HEALTH_ID);
          } else {
            d.log(`twitch: session ${s.session} chat refused (${s.reason ?? "no reason"})`);
            chatHeard = false; // the next frame heard (another session, a later reconnect) takes the line down again
            d.health.set(CHAT_HEALTH_ID, "warn", CHAT_UNHEARD_TEXT);
          }
        },
        now: d.now,
        log: (line) => d.log(`[eventsub] ${line}`),
        verbose: (line) => d.verbose(`[eventsub] ${line}`),
        debug: (line) => d.debug(`[eventsub] ${line}`),
      });
      const c = client;
      up.clear(); // a restart (the broadcaster link) forgets the old sessions: a stale `true` would mask an outage for good
      for (let n = 1; n <= ingest.twitch.sessions; n++) up.set(n, false);
      onStatus({ session: 1, connected: false }); // the grace period starts now: never connecting is an outage too
      chatHeard = false;
      void checkChatScope(c);
      c.start();
    },
    stop() {
      const c = client;
      client = null;
      if (downTimer !== null) clearTimeout(downTimer);
      downTimer = null;
      c?.stop();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// StreamElements
// ---------------------------------------------------------------------------------------------------------------------

interface SeDeps {
  config: () => Config;
  secrets: Secrets;
  engine: Engine;
  ledger: Ledger;
  health: Health;
  log: (line: string) => void;
  verbose: (line: string) => void;
  debug: (line: string) => void;
  now: () => Date;
}

/**
 * Realtime socket (low latency) + REST backfill (lossless), both crediting through one path that keeps the backfill
 * cursor at the newest `createdAt` credited. Backfill runs on every socket (re)connect and every `pollSeconds`; the
 * banner needs the socket down AND the last backfill failed. A denied tip is voided once by its sourceId.
 */
function streamElementsAdapter(d: SeDeps): Adapter {
  let socket: SeSocket | null = null;
  let backfill: SeBackfill | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let cursor = "";
  let socketUp = false;
  let backfillFailed = false;
  const voided = new Set<string>(); // sourceIds already handled by onDenied

  const evaluate = (): void => {
    if (socket === null) return; // stopped: the socket's final disconnect is not an outage
    if (!socketUp && backfillFailed) {
      d.health.set(STREAMELEMENTS_HEALTH_ID, "warn", `StreamElements: realtime socket down and REST backfill failing — tips since ${clock(new Date(cursor))} may be missing; Manual Credit if needed`);
    } else d.health.clear(STREAMELEMENTS_HEALTH_ID);
  };

  /** Credit through the Engine; true when it was new to the Ledger (a backfill re-reads the overlap, so most are not). */
  const credit = (c: Contribution, raw?: unknown): boolean => {
    try {
      const result = d.engine.contribute(c, STREAMELEMENTS_ACTOR, raw);
      if (Date.parse(c.occurredAt) > Date.parse(cursor)) cursor = c.occurredAt;
      return !result.duplicate;
    } catch (e) {
      d.log(`streamelements: tip ${c.sourceId} could not be credited: ${errorText(e)}`);
      d.health.set(`se-credit:${c.sourceId}`, "warn", `StreamElements tip could not be credited — Manual Credit: ${c.displayName ?? "anonymous"} ${describeFace(c.face)} at ${c.occurredAt}`);
      return false;
    }
  };

  const onDenied = (sourceId: string): void => {
    if (voided.has(sourceId)) return;
    const entry = d.ledger.all().find((e) => isContribution(e) && e.payload.source === "streamelements" && e.payload.sourceId === sourceId);
    if (entry === undefined) return; // never credited: nothing to undo
    voided.add(sourceId);
    try {
      d.engine.voidContribution(entry.seq, STREAMELEMENTS_ACTOR, SE_DENIED_REASON);
      d.log(`streamelements: voided ${sourceId} (seq ${entry.seq}): ${SE_DENIED_REASON}`);
    } catch (e) {
      if (e instanceof EngineError && e.code === "INVALID") return; // already voided (by a mod, or an earlier run)
      d.log(`streamelements: tip ${sourceId} (seq ${entry.seq}) could not be voided: ${errorText(e)}`);
      d.health.set(`se-void:${sourceId}`, "warn", `StreamElements denied a tip that is still credited — void ledger entry ${entry.seq} by hand`);
    }
  };

  // Drive the backfill ourselves rather than via `start()`: `runOnce()` resolves on failure too, and only a run we
  // awaited can tell us whether it succeeded (onError fires inside it) — which is what the banner condition needs.
  // The run summary line (docs, new, cursor) is SeBackfill's own: it prints under VERBOSE or DEBUG by what the run found.
  let lastRunFailed = false; // raised by onError during the run in flight; read and reset once it settles
  let running: Promise<void> | null = null; // callers landing mid-run share it (SeBackfill coalesces too; the flag needs one owner)
  const run = (): Promise<void> => {
    if (running !== null) return running;
    const b = backfill;
    if (b === null) return Promise.resolve();
    running = (async () => {
      try {
        await b.runOnce();
      } finally {
        running = null;
      }
      backfillFailed = lastRunFailed;
      lastRunFailed = false;
      evaluate();
    })();
    return running;
  };

  return {
    start() {
      if (socket !== null) return;
      const { ingest } = d.config();
      const jwt = d.secrets.get("STREAMELEMENTS_JWT");
      if (!ingest.streamelements.enabled || jwt === undefined || jwt === "") return;
      cursor = initialCursor(d.ledger, d.now());
      const log = (line: string) => d.log(`[streamelements] ${line}`);
      const rest = new SeRest({ jwt, log });
      let lastRaw: unknown; // the socket hands the raw envelope to onEvent right before onTip (same tick)
      backfill = new SeBackfill({
        rest,
        intervalMs: ingest.streamelements.pollSeconds * 1000, // unused: the interval below is ours (see `run`)
        cursor: () => cursor,
        onTip: (c) => credit(c), // true when new to the Ledger: the run summary's `new` count
        onDenied,
        onError: (err) => {
          lastRunFailed = true;
          log(`backfill failed: ${errorText(err)}`);
        },
        log,
        verbose: (line) => d.verbose(`[streamelements] ${line}`),
        debug: (line) => d.debug(`[streamelements] ${line}`),
      });
      socket = new SeSocket({
        jwt,
        onEvent: (raw) => void (lastRaw = raw),
        onTip: (c) => credit(c, lastRaw),
        onStatus: (connected) => {
          socketUp = connected;
          evaluate();
          if (connected) void run(); // backfill on every connect
        },
        log,
        verbose: (line) => d.verbose(`[streamelements] ${line}`),
      });
      socket.start();
      void run();
      poll = setInterval(() => void run(), ingest.streamelements.pollSeconds * 1000);
    },
    stop() {
      if (poll !== null) clearInterval(poll);
      poll = null;
      const s = socket;
      socket = null;
      backfill = null;
      s?.stop();
    },
  };
}

/** The newest StreamElements tip the Ledger already holds, else an hour ago. */
function initialCursor(ledger: Ledger, now: Date): string {
  let newest = "";
  for (const e of ledger.all()) {
    if (!isContribution(e) || e.payload.source !== "streamelements") continue;
    if (newest === "" || Date.parse(e.payload.occurredAt) > Date.parse(newest)) newest = e.payload.occurredAt;
  }
  return newest !== "" ? newest : new Date(now.getTime() - SE_INITIAL_LOOKBACK_MS).toISOString();
}

function describeFace(face: Face): string {
  switch (face.kind) {
    case "tip":
      return `tipped $${(face.cents / 100).toFixed(2)}`;
    case "bits":
      return `cheered ${face.bits} bits`;
    case "sub":
      return `subscribed (tier ${face.tier}${face.months !== undefined ? `, ${face.months} months` : ""})`;
    case "gift":
      return `gifted ${face.count} subs (tier ${face.tier})`;
  }
}
