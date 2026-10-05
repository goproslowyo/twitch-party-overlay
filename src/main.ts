/**
 * Process entry: env → boot() → signals. Everything that can be tested in-process lives in boot.ts.
 *
 *   DATA_DIR      default: the `data` folder beside the executable when this is the compiled binary, ./data when run from
 *                 source (bun src/main.ts). Printed on start.          CONFIG_FILE   default $DATA_DIR/config.json
 *   LEDGER_FILE   default $DATA_DIR/ledger.sqlite      SECRETS_FILE  default $DATA_DIR/secrets.env
 *   BIND_ALL=1    app listeners on 0.0.0.0 (Docker), overriding listeners.bindAll
 *   NO_OPEN=1     do not open the Dashboard in the browser on start (the compiled binary does, outside Docker)
 *   IN_DOCKER=1   set by the Dockerfile: no browser, no keep-awake child
 *   VERBOSE=1     the "is it working" signals: every unlock entry, EventSub welcome / subscribed / notification frames, StreamElements
 *                 socket events and non-empty backfill runs, token refreshes, overlay clients
 *   DEBUG=1       everything — VERBOSE plus keepalives, empty backfill runs and one line per HTTP request (implies VERBOSE)
 */
import fs from "node:fs";
import path from "node:path";
import pkg from "../package.json";
import { boot, type Booted, type BootOptions } from "./boot.ts";
import { currentRuntime, dashboardUrl, inDocker, isCompiled, keepAwakeCommand, openBrowserCommand, resolveDataDir, shouldOpenBrowser, type Runtime } from "./platform/runtime.ts";

export function version(): string {
  return pkg.version;
}

export function optionsFromEnv(env: Record<string, string | undefined> = process.env, rt: Runtime = currentRuntime()): BootOptions {
  return {
    dataDir: resolveDataDir(env, rt),
    configFile: env.CONFIG_FILE || undefined,
    ledgerFile: env.LEDGER_FILE || undefined,
    secretsFile: env.SECRETS_FILE || undefined,
    hostLanIp: env.HOST_LAN_IP || undefined,
    bindAll: env.BIND_ALL === "1" ? true : undefined,
    verbose: env.VERBOSE === "1" || env.DEBUG === "1",
    debug: env.DEBUG === "1",
  };
}

/** A spawned helper (the browser opener, the keep-awake child): all main() ever does with one is kill it on shutdown. */
export interface Child {
  kill(): void;
}

/** What main() needs from the outside; tests hand in fakes (a stub boot, an EventEmitter for the process). */
export interface MainDeps {
  boot: (opts: BootOptions) => Promise<Pick<Booted, "stop"> & Partial<Pick<Booted, "ports">>>;
  proc: { on(event: string, fn: (...args: any[]) => void): unknown; exit(code?: number): void; pid?: number }; // eslint-disable-line @typescript-eslint/no-explicit-any
  log: (line: string) => void;
  error: (line: string) => void;
  hardExitMs?: number; // a stop() that hangs past this is hard-exited with 1
  runtime?: Runtime; // default: this process
  /** Start a helper process; throws when the command does not exist. Default Bun.spawn with nothing attached. */
  spawn?: (argv: string[]) => Child;
  /** Is a command on PATH / does a file exist — for systemd-inhibit and /.dockerenv. */
  has?: (command: string) => boolean;
  exists?: (file: string) => boolean;
}

const HARD_EXIT_MS = 5_000;
const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

const defaultSpawn = (argv: string[]): Child => {
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  void child.exited.catch(() => {});
  return { kill: () => void child.kill() };
};
const defaultHas = (command: string): boolean => Bun.which(command) !== null;

export async function main(env: Record<string, string | undefined> = process.env, deps: MainDeps = { boot, proc: process, log: console.log, error: console.error }): Promise<void> {
  const { proc } = deps;
  const rt = deps.runtime ?? currentRuntime();
  const spawn = deps.spawn ?? defaultSpawn;
  const compiled = isCompiled(rt.execPath);
  const docker = inDocker(env, deps.exists ?? fs.existsSync);
  const helpers: Child[] = [];
  /** Best effort, one line on failure, never fatal: a streamer without xdg-open or caffeinate still gets a working overlay. */
  const helper = (what: string, argv: string[] | null): void => {
    if (argv === null) return;
    try {
      helpers.push(spawn(argv));
    } catch (e) {
      deps.log(`${what}: could not run ${argv[0]} (${e instanceof Error ? e.message : String(e)}); carrying on without it`);
    }
  };
  // Rejections nobody awaited (a fire-and-forget adapter call) are logged and the show goes on — never an exit. Registered
  // BEFORE boot: Bun exits 1 on an unhandled rejection, and boot already starts adapters.
  proc.on("unhandledRejection", (reason: unknown) => deps.error(`unhandled rejection: ${describe(reason)}`));

  deps.log(`twitch-party-overlay ${version()}`);
  const options = optionsFromEnv(env, rt);
  deps.log(`data folder: ${path.resolve(options.dataDir)}`);
  // The Dashboard's Shut down button ends up here too (boot → app → /api/shutdown → onShutdownRequest). `shutdown` needs
  // `booted`, so until boot returns the hook only remembers the request; it runs right after the real one is in place —
  // the listeners are up before boot() resolves, so a click can beat this wiring by a tick.
  let requested: string | null = null;
  let shutdown = (source: string): void => void (requested = source);
  const booted = await deps.boot({ ...options, onShutdownRequest: (source) => shutdown(source) });

  // The double-clicked download has nobody to type a URL or run caffeinate: it opens the Dashboard itself and keeps the
  // machine awake. From source (a developer) or in Docker (no browser, no power manager) neither happens.
  if (compiled && !docker) {
    helper("keep awake", keepAwakeCommand(rt.platform, proc.pid ?? process.pid, deps.has ?? defaultHas));
    if (shouldOpenBrowser(env, { compiled, docker }) && booted.ports !== undefined) {
      const url = dashboardUrl(booted.ports.streamer);
      deps.log(`opening ${url} in your browser (NO_OPEN=1 turns this off)`);
      helper("open browser", openBrowserCommand(rt.platform, url));
    }
  }

  let stopping = false;
  shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    deps.log(`${signal}: stopping`);
    for (const child of helpers) child.kill();
    // A stop() that never settles (a socket that will not close) must not keep the process alive: hard exit after the delay.
    const fallback = setTimeout(() => proc.exit(1), deps.hardExitMs ?? HARD_EXIT_MS);
    fallback.unref();
    void booted.stop().then(
      () => {
        clearTimeout(fallback);
        proc.exit(0);
      },
      (e) => {
        clearTimeout(fallback);
        deps.error(`stop failed: ${describe(e)}`);
        proc.exit(1);
      },
    );
  };
  // SIGINT: Ctrl-C everywhere. SIGTERM: Docker / kill. SIGBREAK: Ctrl-Break on Windows (no SIGTERM there). SIGHUP: the
  // terminal or console window closing. The Ledger is SQLite in WAL mode, so a window closed by force loses nothing either.
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) proc.on(signal, () => shutdown(signal));
  if (requested !== null) shutdown(requested);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`boot failed: ${describe(e)}`);
    process.exit(1);
  });
}
