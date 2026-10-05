/** ConfigStore: owns config.json — load/create, validated atomic writes, hot reload via fs.watch. */
import fs from "node:fs";
import path from "node:path";
import { defaultConfig, diffConfig, validateConfig, type Config, type Diff } from "./schema.ts";

type ChangeFn = (diff: Diff[], config: Config) => void;
type InvalidFn = (error: Error) => void;

const DEBOUNCE_MS = 200;

/** The directory watcher failed (an FSWatcher `error`): hand edits are no longer picked up. Reported through `invalid`. */
export class ConfigWatchError extends Error {
  constructor(cause: Error) {
    super(`config.json is no longer watched (${cause.message}) — hand edits apply at the next restart`);
    this.name = "ConfigWatchError";
  }
}

type WatchFn = (dir: string, listener: (event: string, filename: string | null) => void) => fs.FSWatcher;

type StoreOptions = {
  watch?: WatchFn;
  /** Where a note about a hand-edited file goes when it loads (a draw list tidied — see validateConfig's `loading`). Default console.warn. */
  log?: (line: string) => void;
};

export class ConfigStore {
  readonly #path: string;
  readonly #watch: WatchFn;
  readonly #log: (line: string) => void;
  #config: Config;
  #changeFns = new Set<ChangeFn>();
  #invalidFns = new Set<InvalidFn>();
  #watcher: fs.FSWatcher | null = null;
  #debounce: ReturnType<typeof setTimeout> | null = null;

  /**
   * Creates the file from defaultConfig() when missing; throws ConfigError when an existing file is invalid. A file that
   * loaded before never becomes invalid by a rule the Config page enforces on save: its draw lists are normalised (and
   * the tidy-up logged) instead — the file itself is left as written.
   */
  constructor(filePath: string, opts: StoreOptions = {}) {
    this.#path = filePath;
    this.#watch = opts.watch ?? ((dir, listener) => fs.watch(dir, listener));
    this.#log = opts.log ?? ((line) => console.warn(line));
    if (fs.existsSync(filePath)) {
      this.#config = this.#read();
    } else {
      this.#config = defaultConfig();
      this.#write(this.#config);
    }
  }

  /** The live config object — treat it as read-only; go through update() to change it. */
  get(): Config {
    return this.#config;
  }

  /** Validate, write atomically (tmp + rename), emit "change" with the diff (when non-empty). The caller records the actor in the Ledger. */
  update(next: Config): Diff[] {
    const validated = structuredClone(validateConfig(next));
    const diff = diffConfig(this.#config, validated);
    this.#write(validated);
    this.#config = validated;
    if (diff.length > 0) this.#emitChange(diff);
    return diff;
  }

  /** fs.watch on the parent directory (survives editors and our own tmp+rename) with a 200 ms debounce. Idempotent. */
  watch(): void {
    if (this.#watcher) return;
    const base = path.basename(this.#path);
    const watcher = this.#watch(path.dirname(this.#path), (_event, filename) => {
      // filename can be null on some platforms — then reload regardless; an unchanged file is a no-op below
      if (filename !== null && filename !== base) return;
      if (this.#debounce) clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => {
        this.#debounce = null;
        this.#reloadFromDisk();
      }, DEBOUNCE_MS);
    });
    // An FSWatcher `error` with no listener is an uncaught exception. The watcher is dead after it: forget it (so a later
    // watch() can re-arm) and tell the `invalid` listeners — the config in memory is untouched.
    watcher.on("error", (e: unknown) => {
      if (this.#watcher === watcher) this.#watcher = null;
      const error = new ConfigWatchError(e instanceof Error ? e : new Error(String(e)));
      for (const fn of [...this.#invalidFns]) fn(error);
    });
    this.#watcher = watcher;
  }

  /** Stop watching (no-op when not watching). */
  close(): void {
    if (this.#debounce) clearTimeout(this.#debounce);
    this.#debounce = null;
    this.#watcher?.close();
    this.#watcher = null;
  }

  on(event: "change", fn: ChangeFn): () => void;
  on(event: "invalid", fn: InvalidFn): () => void;
  on(event: "change" | "invalid", fn: ChangeFn | InvalidFn): () => void {
    if (event === "change") {
      const f = fn as ChangeFn;
      this.#changeFns.add(f);
      return () => void this.#changeFns.delete(f);
    }
    const f = fn as InvalidFn;
    this.#invalidFns.add(f);
    return () => void this.#invalidFns.delete(f);
  }

  #reloadFromDisk(): void {
    let next: Config;
    try {
      next = this.#read();
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      for (const fn of [...this.#invalidFns]) fn(error);
      return; // keep the previous config
    }
    const diff = diffConfig(this.#config, next);
    if (diff.length === 0) return; // our own write, or a no-op edit
    this.#config = next;
    this.#emitChange(diff);
  }

  #emitChange(diff: Diff[]): void {
    for (const fn of [...this.#changeFns]) fn(diff, this.#config);
  }

  /** The load path (boot, the watcher's reload): normalise rather than reject — update() is the strict one. */
  #read(): Config {
    const name = path.basename(this.#path);
    return validateConfig(JSON.parse(fs.readFileSync(this.#path, "utf8")), { loading: (note) => this.#log(`${name}: ${note}`) });
  }

  #write(config: Config): void {
    const dir = path.dirname(this.#path);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(this.#path)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
    fs.renameSync(tmp, this.#path);
  }
}
