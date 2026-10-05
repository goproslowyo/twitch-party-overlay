/**
 * The app router — one handler for both app listeners; `listener` says which one the request hit.
 *
 *   /login, /auth/twitch/*      → OAuth (login on the funnel, the broadcaster link on the streamer listener, callback on both)
 *   /logout                     → clear the session cookie, back to /
 *   /hooks/kofi/<path>          → Ko-fi webhook (funnel, POST, no session)
 *   /api/*                      → the JSON API, which needs a Principal: the streamer listener is always the Streamer,
 *                                 the funnel needs a valid session cookie (else 401 JSON; a cookie that fails signature
 *                                 verification is also an `auth_failure` entry — an expired one is not)
 *   /dashboard/client.js        → the Dashboard's one script (static, no session needed)
 *   / /ledger /pool /config /help → the Dashboard pages (GET), same Principal rule as the API except that a missing
 *                                 funnel session goes to /login (302) instead of a 401
 *   /setup, /api/setup/*        → the first-run Setup page, streamer listener only (404 on the funnel); `/` on the
 *                                 streamer listener redirects there until the Twitch app is saved and the broadcaster linked
 *   anything else               → 404
 *
 * An HttpError renders itself; anything else is a 500 with a generic message — the stack goes to `log`, never to the client.
 */
import type { ConfigStore } from "../config/store.ts";
import type { Secrets } from "../config/secrets.ts";
import type { Engine } from "../engine/engine.ts";
import { KOFI_AUDIT_PATH, createKofiHandler } from "../ingest/kofi/webhook.ts";
import type { Firebot } from "../integrations/firebot.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { createApi, type ApiDeps } from "./api.ts";
import { AUTH_FAILURE_ACTOR, clearSessionCookie, resolvePrincipal, sessionState, type AppListener, type Principal } from "./auth.ts";
import { CLIENT_JS_PATH, PAGE_PATHS, clientScript, createDashboard } from "./dashboard/pages.ts";
import { SETUP_API_PREFIX, SETUP_PATH, createSetup, setupNeeded, type SetupDeps } from "./dashboard/setup.ts";
import type { Health } from "./health.ts";
import { HttpError, clientIp, errorJson, notFound, redirect } from "./http-util.ts";
import { CALLBACK_PATH, type OAuth } from "./oauth.ts";
import type { ChatterSource, OverlayHub } from "./overlay.ts";

export interface AppDeps {
  config: ConfigStore;
  secrets: Secrets;
  ledger: Ledger;
  engine: Engine;
  health: Health;
  firebot: Firebot;
  oauth: OAuth;
  hub: OverlayHub;
  /** The Active Chatter roster: the Live count, the Config section's hot reload, the Debug buttons. boot.ts passes the real one. */
  chatters: ChatterSource;
  /** The session-cookie secret (`sessionSecret(secrets)` at boot — the same value OAuth signs with). */
  sessionSecret: string;
  /** Where unexpected errors go (message + stack). Default: console.error. */
  log?: (message: string) => void;
  /** DEBUG chatter: one line per request — method, path (never the query string), listener, status, duration. Default: nothing. */
  debug?: (line: string) => void;
  now?: () => Date;
  networkInterfaces?: ApiDeps["networkInterfaces"];
  /** This computer's own LAN address for the OBS overlay URL; boot.ts reads it from `$HOST_LAN_IP`. */
  hostLanIp?: string;
  /** `POST /api/shutdown`'s hook — main.ts's signal path (see BootOptions). Absent: the route answers 503. */
  onShutdownRequest?: ApiDeps["onShutdownRequest"];
  /** The Setup page's seams: boot.ts's adapter-reload hook, and the Check buttons' fetch / the webhook path for tests. */
  setup?: Pick<SetupDeps, "onSetupChange" | "fetchImpl" | "random">;
}

export interface App {
  handle(req: Request, listener: AppListener): Promise<Response>;
}

export const KOFI_HOOK_PREFIX = "/hooks/kofi/";
export const LOGIN_PATH = "/login";
export const LOGOUT_PATH = "/logout";
export const BROADCASTER_LINK_PATH = "/auth/twitch/broadcaster";
export const API_PREFIX = "/api/";

const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));
/** The path as a log line may print it: the Ko-fi hook's last segment is a secret, so anything under the prefix is masked. */
const logPath = (pathname: string): string => (pathname.startsWith(KOFI_HOOK_PREFIX) ? KOFI_AUDIT_PATH : pathname);

export function createApp(deps: AppDeps): App {
  const log = deps.log ?? ((message: string) => console.error(message));
  const debug = deps.debug ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const config = () => deps.config.get();
  const api = createApi({
    config: deps.config,
    ledger: deps.ledger,
    engine: deps.engine,
    health: deps.health,
    firebot: deps.firebot,
    hub: deps.hub,
    chatters: deps.chatters,
    now,
    networkInterfaces: deps.networkInterfaces,
    hostLanIp: deps.hostLanIp,
    log,
    ...(deps.onShutdownRequest === undefined ? {} : { onShutdownRequest: deps.onShutdownRequest }),
  });
  const kofi = createKofiHandler({ config, secrets: deps.secrets, engine: deps.engine, ledger: deps.ledger, log });
  const dashboard = createDashboard({ config: deps.config, ledger: deps.ledger, engine: deps.engine, health: deps.health, hub: deps.hub, chatters: deps.chatters, firebot: deps.firebot, networkInterfaces: deps.networkInterfaces, hostLanIp: deps.hostLanIp, now });
  const setup = createSetup({ config: deps.config, secrets: deps.secrets, ledger: deps.ledger, health: deps.health, hub: deps.hub, ...deps.setup });

  /**
   * The Principal for a session-gated route, or null. On the funnel a `tpo_session` that fails signature (or kind)
   * verification is somebody trying cookies on: recorded as an `auth_failure` (a passive tripwire) before the 401 /
   * 302. An expired session is ours, just old, and no cookie is a visitor — neither is recorded. The streamer listener
   * never reads the cookie at all: it is the Streamer, acting as the linked broadcaster once `channel` is linked.
   */
  const principalFor = (req: Request, pathname: string, listener: AppListener): Principal | null => {
    if (listener === "streamer") return resolvePrincipal(req, listener, deps.sessionSecret, now().getTime(), config().channel);
    const state = sessionState(req, deps.sessionSecret, now().getTime());
    if (typeof state !== "string") return state;
    if (state === "invalid") deps.ledger.append("auth_failure", AUTH_FAILURE_ACTOR, { ip: clientIp(req), path: pathname, reason: "invalid session cookie" });
    return null;
  };

  const dispatch = async (req: Request, pathname: string, listener: AppListener): Promise<Response> => {
    const method = req.method.toUpperCase();

    if (pathname === LOGIN_PATH) return listener === "funnel" && method === "GET" ? deps.oauth.start("login", listener, req) : notFound();
    if (pathname === BROADCASTER_LINK_PATH) return listener === "streamer" && method === "GET" ? deps.oauth.start("broadcaster", listener, req) : notFound();
    if (pathname === CALLBACK_PATH) return method === "GET" ? deps.oauth.callback(listener, req) : notFound();
    if (pathname === LOGOUT_PATH) return redirect("/", { "set-cookie": clearSessionCookie() });

    if (pathname.startsWith(KOFI_HOOK_PREFIX)) {
      if (listener !== "funnel" || method !== "POST") return notFound();
      return kofi(req, pathname.slice(KOFI_HOOK_PREFIX.length));
    }

    if (pathname.startsWith(API_PREFIX)) {
      const principal = principalFor(req, pathname, listener);
      if (principal === null) return errorJson(401, "UNAUTHORIZED", "login required");
      if (pathname.startsWith(SETUP_API_PREFIX)) return setup.api(req, { principal, listener }); // Setup: its own role + listener rule
      return api(req, { principal, listener });
    }

    if (pathname === CLIENT_JS_PATH) return method === "GET" ? clientScript() : notFound();

    // Setup: the first-run page, streamer listener only; the funnel 404s it. `/` on that listener goes there until Twitch is connected.
    if (pathname === SETUP_PATH) return listener === "streamer" && method === "GET" ? setup.page(req, { principal: principalFor(req, pathname, listener)!, listener }) : notFound();
    if (pathname === "/" && listener === "streamer" && method === "GET" && setupNeeded(deps.secrets, config())) return redirect(SETUP_PATH);

    if (PAGE_PATHS.has(pathname) && method === "GET") {
      const principal = principalFor(req, pathname, listener);
      if (principal === null) return redirect(LOGIN_PATH);
      return dashboard(req, { principal, listener });
    }

    return notFound();
  };

  return {
    async handle(req, listener) {
      const { pathname } = new URL(req.url);
      const shown = logPath(pathname);
      const started = performance.now();
      let res: Response;
      try {
        res = await dispatch(req, pathname, listener);
      } catch (e) {
        if (e instanceof HttpError) res = e.toResponse();
        else {
          log(`${req.method} ${shown} on ${listener}: ${describe(e)}`);
          res = errorJson(500, "INTERNAL", "internal error");
        }
      }
      debug(`${req.method} ${shown} on ${listener} ${res.status} ${Math.round(performance.now() - started)}ms`); // no query (an OAuth code lives there), no body, no cookie, no Ko-fi path
      return res;
    },
  };
}
