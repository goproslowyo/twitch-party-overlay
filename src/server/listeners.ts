/**
 * The three listeners:
 *
 * | listener | bind (bare)    | bind (bindAll) | serves                                   |
 * | streamer | 127.0.0.1:8700 | 0.0.0.0:8700   | dashboard, API, help, broadcaster OAuth  |
 * | funnel   | 127.0.0.1:8701 | 0.0.0.0:8701   | dashboard, API, help, login OAuth, Ko-fi |
 * | overlay  | 127.0.0.1:8702 | 0.0.0.0:8702   | /overlay, its assets, /overlay/ws        |
 *
 * Both app listeners run the same handler; the listener name it receives is what decides the role (auth.ts). The
 * overlay listener knows nothing but the overlay routes — anything else is 404. It binds 127.0.0.1 by default, because
 * most streamers run OBS on the same computer: no firewall prompt, and the chat logins it draws stay off the LAN.
 * `listeners.overlayOnLan` (the Config page's "OBS runs on another computer") binds it to every interface; so does
 * bindAll (Docker, where the compose file decides what is published).
 *
 * The streamer listener alone sits behind `requireLocalHost`: every request on that port, before the handler and
 * before any upgrade, must be addressed to localhost / 127.0.0.1 / [::1] (and a write's Origin, if any, must be one of
 * those too), else a generic 403. A browser's Host for the Docker-published port is still localhost, so bindAll changes
 * nothing here; the funnel (behind Tailscale, its own hostname) and the overlay (LAN) are not checked.
 */
import type { HTMLBundle } from "bun";
import type { Config } from "../config/schema.ts";
import { requireLocalHost, type AppListener } from "./auth.ts";
import { HttpError, errorJson, notFound } from "./http-util.ts";

export type ListenerName = AppListener | "overlay";

export interface ListenerHandlers {
  /** Dashboard, API, help, OAuth — one handler for both app listeners; `listener` says which one the request hit. */
  app: (req: Request, listener: AppListener) => Response | Promise<Response>;
  /**
   * `/overlay`, its assets and `/overlay/ws` (call `server.upgrade(req)` and return undefined). Anything unhandled
   * (undefined without an upgrade) is answered 404 here; Bun ignores the return value once an upgrade succeeded.
   */
  overlay: (req: Request, server: Bun.Server<unknown>) => Response | undefined | Promise<Response | undefined>;
  overlayWs: Bun.WebSocketHandler<unknown>;
  /** The overlay page as a Bun HTML-import route (`/overlay` → bundle); Bun serves its hashed assets alongside. */
  overlayRoutes?: Record<string, HTMLBundle>;
}

export interface Listeners {
  streamer: Bun.Server<unknown>;
  funnel: Bun.Server<unknown>;
  overlay: Bun.Server<unknown>;
  stop(): void;
}

export interface StartListenersOptions {
  config: Config;
  handlers: ListenerHandlers;
  /** Unexpected handler errors (an `HttpError` is not one — it renders itself). Default: console.error. */
  onError?: (listener: ListenerName, error: unknown) => void;
}

const defaultOnError = (listener: ListenerName, error: unknown): void => {
  console.error(`[${listener}] unhandled error:`, error);
};

/** Run a handler; an HttpError becomes its own response, anything else a 500 that does not echo the error. */
async function guarded(listener: ListenerName, onError: NonNullable<StartListenersOptions["onError"]>, run: () => Response | undefined | Promise<Response | undefined>): Promise<Response> {
  try {
    return (await run()) ?? notFound();
  } catch (error) {
    if (error instanceof HttpError) return error.toResponse();
    onError(listener, error);
    return errorJson(500, "INTERNAL", "internal error");
  }
}

/** Where the overlay listener binds: 127.0.0.1 unless OBS is on another computer (`overlayOnLan`) or Docker (`bindAll`). */
export function overlayListenerHost({ bindAll, overlayOnLan }: Pick<Config["listeners"], "bindAll" | "overlayOnLan">): "0.0.0.0" | "127.0.0.1" {
  return bindAll || overlayOnLan ? "0.0.0.0" : "127.0.0.1";
}

export function startListeners({ config, handlers, onError = defaultOnError }: StartListenersOptions): Listeners {
  const { streamerPort, funnelPort, overlayPort, bindAll, overlayOnLan } = config.listeners;
  const appHost = bindAll ? "0.0.0.0" : "127.0.0.1";
  const overlayHost = overlayListenerHost({ bindAll, overlayOnLan });

  const serveApp = (listener: AppListener, port: number): Bun.Server<unknown> =>
    Bun.serve({
      hostname: appHost,
      port,
      development: false,
      fetch: (req) => guarded(listener, onError, () => (listener === "streamer" ? requireLocalHost(req) : null) ?? handlers.app(req, listener)),
    });

  const streamer = serveApp("streamer", streamerPort);
  const funnel = serveApp("funnel", funnelPort);
  const overlay: Bun.Server<unknown> = Bun.serve<unknown>({
    hostname: overlayHost,
    port: overlayPort,
    development: false,
    routes: handlers.overlayRoutes ?? {},
    fetch: (req, server) => guarded("overlay", onError, () => handlers.overlay(req, server)),
    websocket: handlers.overlayWs,
  });

  return {
    streamer,
    funnel,
    overlay,
    stop() {
      for (const server of [streamer, funnel, overlay]) void server.stop(true);
    },
  };
}
