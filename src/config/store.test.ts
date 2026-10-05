import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ConfigStore, ConfigWatchError } from "./store.ts";
import { DESCRIPTION_MAX, LIST_ITEM_MAX, defaultConfig, validateConfig, ConfigError, type Config, type Diff } from "./schema.ts";

function tmpConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-config-"));
  return path.join(dir, "config.json");
}

function nextEvent<T>(subscribe: (fn: (v: T) => void) => () => void, ms = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no event within ${ms} ms`));
    }, ms);
    const off = subscribe((v) => {
      clearTimeout(timer);
      off();
      resolve(v);
    });
  });
}

const nextChange = (store: ConfigStore) =>
  nextEvent<{ diff: Diff[]; config: Config }>((fn) => store.on("change", (diff, config) => fn({ diff, config })));
const nextInvalid = (store: ConfigStore) => nextEvent<Error>((fn) => store.on("invalid", fn));

/**
 * fs.watch arms FSEvents on a background thread: a write inside the first ~10 ms after watch() is silently missed
 * (measured 2/150 misses writing immediately, 0/150 after 50 ms). Real edits happen minutes after boot; tests do not.
 */
async function watchArmed(store: ConfigStore): Promise<void> {
  store.watch();
  await new Promise((r) => setTimeout(r, 100));
}

test("creates config.json from defaults when missing", () => {
  const p = tmpConfigPath();
  const store = new ConfigStore(p);
  expect(fs.existsSync(p)).toBe(true);
  expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual(defaultConfig());
  expect(store.get()).toEqual(defaultConfig());
});

test("loads an existing file instead of overwriting it; rejects an invalid one at boot", () => {
  const p = tmpConfigPath();
  const seeded = defaultConfig();
  seeded.threshold.cents = 2000;
  fs.writeFileSync(p, JSON.stringify(seeded));
  expect(new ConfigStore(p).get().threshold.cents).toBe(2000);

  const bad = tmpConfigPath();
  fs.writeFileSync(bad, JSON.stringify({ ...defaultConfig(), tiers: { gates: [1] } }));
  expect(() => new ConfigStore(bad)).toThrow(ConfigError);
});

/** A config.json as the streamer might hand-edit it: a genre pasted twice, a blank line, a 70-character rule, a 300-character What it is line. */
function handEdited(): { seeded: Config; genres: string[]; long: string; essay: string } {
  const seeded = defaultConfig();
  const genres = [...seeded.lists.genreRoulette];
  seeded.lists.genreRoulette = [...genres, genres[1]!, "   "];
  const long = "R".repeat(70);
  seeded.lists.chatRules = [...seeded.lists.chatRules, long];
  const essay = "D".repeat(300);
  seeded.outcomes[7]!.description = essay;
  return { seeded, genres, long, essay };
}
const HAND_EDIT_NOTES = [
  "config.json: lists.genreRoulette — dropped 2 blank/duplicate items",
  `config.json: lists.chatRules — trimmed 1 item to ${LIST_ITEM_MAX} chars`,
  `config.json: outcomes.7.description — trimmed to ${DESCRIPTION_MAX} chars`,
];

test("a hand-edited file never blocks boot: a duplicate or blank item is dropped, an over-long item or description is clamped, each logged — and what loaded then saves (update() with the loaded config does not throw)", () => {
  const p = tmpConfigPath();
  const { seeded, genres, long } = handEdited();
  fs.writeFileSync(p, JSON.stringify(seeded));
  const lines: string[] = [];
  const store = new ConfigStore(p, { log: (line) => lines.push(line) });
  expect(store.get().lists.genreRoulette).toEqual(genres);
  expect(store.get().lists.chatRules).toEqual([...defaultConfig().lists.chatRules, long.slice(0, LIST_ITEM_MAX)]);
  expect(store.get().outcomes[7]!.description).toBe("D".repeat(DESCRIPTION_MAX));
  expect(lines).toEqual(HAND_EDIT_NOTES);
  expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual(seeded); // the file is not rewritten behind the streamer's back

  expect(() => store.update(structuredClone(seeded))).toThrow(ConfigError); // the raw hand-edit is still no good as a save
  expect(() => validateConfig(structuredClone(store.get()))).not.toThrow(); // but the loaded config is
  expect(store.update(structuredClone(store.get()))).toEqual([]);
});

test("watch(): a hand-edited file reloads normalised (duplicate dropped, over-long clamped, logged) instead of being reported invalid", async () => {
  const p = tmpConfigPath();
  const lines: string[] = [];
  const store = new ConfigStore(p, { log: (line) => lines.push(line) });
  await watchArmed(store);
  try {
    let invalid = 0;
    store.on("invalid", () => invalid++);
    const pending = nextChange(store);
    const { seeded, genres, long } = handEdited();
    fs.writeFileSync(p, JSON.stringify(seeded, null, 2));
    const { diff, config } = await pending;
    expect(config.lists.genreRoulette).toEqual(genres);
    expect(config.lists.chatRules).toEqual([...defaultConfig().lists.chatRules, long.slice(0, LIST_ITEM_MAX)]);
    expect(diff).toEqual([
      { path: "outcomes.7.description", from: defaultConfig().outcomes[7]!.description, to: "D".repeat(DESCRIPTION_MAX) },
      { path: "lists.chatRules.6", from: undefined, to: long.slice(0, LIST_ITEM_MAX) },
    ]);
    expect(lines).toEqual(HAND_EDIT_NOTES);
    expect(invalid).toBe(0);
    expect(() => validateConfig(structuredClone(config))).not.toThrow(); // what loads also saves, on the watcher's path too
  } finally {
    store.close();
  }
});

test("update() validates, writes atomically, and emits change with the diff", () => {
  const p = tmpConfigPath();
  const store = new ConfigStore(p);
  const seen: Array<{ diff: Diff[]; config: Config }> = [];
  store.on("change", (diff, config) => seen.push({ diff, config }));

  const next = structuredClone(store.get());
  next.threshold.cents = 3500;
  const diff = store.update(next);

  expect(diff).toEqual([{ path: "threshold.cents", from: 5000, to: 3500 }]);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.diff).toEqual(diff);
  expect(seen[0]!.config.threshold.cents).toBe(3500);
  expect(store.get().threshold.cents).toBe(3500);
  expect(JSON.parse(fs.readFileSync(p, "utf8")).threshold.cents).toBe(3500);
  expect(fs.readdirSync(path.dirname(p))).toEqual(["config.json"]); // no tmp file left behind

  // a later mutation of the object handed to update() does not leak into the store
  next.threshold.cents = 1;
  expect(store.get().threshold.cents).toBe(3500);
});

test("update() with an invalid config throws and leaves store and file untouched", () => {
  const p = tmpConfigPath();
  const store = new ConfigStore(p);
  let changes = 0;
  store.on("change", () => changes++);
  const next = structuredClone(store.get());
  next.tiers.gates = [0, 6, 3];
  expect(() => store.update(next)).toThrow(ConfigError);
  expect(store.get().tiers.gates).toEqual([0, 3, 6]);
  expect(JSON.parse(fs.readFileSync(p, "utf8")).tiers.gates).toEqual([0, 3, 6]);
  expect(changes).toBe(0);
});

test("watch() picks up an external valid edit", async () => {
  const p = tmpConfigPath();
  const store = new ConfigStore(p);
  await watchArmed(store);
  try {
    const pending = nextChange(store);
    const edited = defaultConfig();
    edited.threshold.cents = 2500;
    fs.writeFileSync(p, JSON.stringify(edited, null, 2));
    const { diff, config } = await pending;
    expect(diff).toEqual([{ path: "threshold.cents", from: 5000, to: 2500 }]);
    expect(config.threshold.cents).toBe(2500);
    expect(store.get().threshold.cents).toBe(2500);
  } finally {
    store.close();
  }
});

test("watch(): an invalid external edit emits invalid and get() keeps the previous config", async () => {
  const p = tmpConfigPath();
  const store = new ConfigStore(p);
  await watchArmed(store);
  try {
    let changes = 0;
    store.on("change", () => changes++);

    const pendingParse = nextInvalid(store);
    fs.writeFileSync(p, "{ this is not json");
    expect(await pendingParse).toBeInstanceOf(Error);
    expect(store.get()).toEqual(defaultConfig());

    const pendingRules = nextInvalid(store);
    fs.writeFileSync(p, JSON.stringify({ ...defaultConfig(), tiers: { gates: [0, 6, 3] } }));
    expect(await pendingRules).toBeInstanceOf(ConfigError);
    expect(store.get()).toEqual(defaultConfig());
    expect(changes).toBe(0);
  } finally {
    store.close();
  }
});

test("on() returns an unsubscribe function", () => {
  const p = tmpConfigPath();
  const store = new ConfigStore(p);
  let calls = 0;
  const off = store.on("change", () => calls++);
  off();
  const next = structuredClone(store.get());
  next.threshold.cents = 1000;
  store.update(next);
  expect(calls).toBe(0);
});

test("watch(): an error event on the FSWatcher is reported through invalid (never thrown), the config stays, and watch() can re-arm", async () => {
  const p = tmpConfigPath();
  const watchers: EventEmitter[] = [];
  const watch = (): fs.FSWatcher => {
    const w = Object.assign(new EventEmitter(), { close: () => {} });
    watchers.push(w);
    return w as unknown as fs.FSWatcher;
  };
  const store = new ConfigStore(p, { watch });
  try {
    store.watch();
    store.watch(); // idempotent
    expect(watchers).toHaveLength(1);
    const pending = nextInvalid(store);
    watchers[0]!.emit("error", new Error("EMFILE: too many open files"));
    const error = await pending;
    expect(error).toBeInstanceOf(ConfigWatchError);
    expect(error.message).toBe("config.json is no longer watched (EMFILE: too many open files) — hand edits apply at the next restart");
    expect(store.get()).toEqual(defaultConfig());
    store.watch(); // the errored watcher is gone: a new one can be armed
    expect(watchers).toHaveLength(2);
  } finally {
    store.close();
  }
});

test("a config.json from before Room lights were removed loads with the `lights` block dropped: no error, no note, and the loaded config saves", () => {
  const p = tmpConfigPath();
  const seeded = defaultConfig() as unknown as Record<string, unknown>;
  seeded.lights = { enabled: true, transport: "govee", area: "", fireSeconds: 7, unlockSeconds: 5, exclude: ["Govee Ceiling Light"], roles: {}, flashBrightness: 100 };
  fs.writeFileSync(p, JSON.stringify(seeded));
  const lines: string[] = [];
  const store = new ConfigStore(p, { log: (line) => lines.push(line) });
  expect("lights" in store.get()).toBe(false);
  expect(lines).toEqual([]);
  expect(store.update(structuredClone(store.get()))).toEqual([]);
});
