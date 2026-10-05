import { test, expect } from "bun:test";
import { CHAT_WINDOW_MAX, CHAT_WINDOW_MIN, DESCRIPTION_MAX, DWELL_SECONDS_MAX, DWELL_SECONDS_MIN, DWELL_SECONDS_STEP, LIST_ITEM_MAX, NAME_LENGTH_MAX, NAME_LENGTH_MIN, defaultConfig, validateConfig, diffConfig, normaliseBots, ConfigError, type Config } from "./schema.ts";

test("default pool is 32 over 17/10/5", () => {
  const c = defaultConfig();
  const per = [0, 1, 2].map((t) => c.outcomes.filter((o) => o.tier === t).reduce((a, o) => a + o.initialLeft, 0));
  expect(per).toEqual([17, 10, 5]);
  expect(c.outcomes.filter((o) => o.restockable).length).toBe(15); // "restock re-arms exactly 15"
});

test("defaults match the locked policy and threshold", () => {
  const c = defaultConfig();
  expect(c.policy.subCents).toEqual({ "1000": 200, "2000": 350, "3000": 875, prime: 200 });
  expect(c.threshold.cents).toBe(5000);
  expect(c.tiers.gates).toEqual([0, 3, 6]);
});

test("defaults: overlay.theme is chrome-lounge — a fresh config.json wears the Chrome Lounge Theme; the two prototype themes stay in `themes`", () => {
  const c = defaultConfig();
  expect(c.overlay.theme).toBe("chrome-lounge");
  expect(c.themes[c.overlay.theme]!.sheet).toBe("chrome-lounge");
  expect(() => validateConfig(c)).not.toThrow();
});

test("defaults: two themes copied from the prototype", () => {
  const c = defaultConfig();
  expect(Object.keys(c.themes)).toEqual(["club-deck", "duck-farm", "chrome-lounge"]);
  expect(c.themes["club-deck"]!.tierLabel).toBe("TIER {n}");
  expect(c.themes["club-deck"]!.readyWord).toBe("READY");
  expect(c.themes["duck-farm"]!.tierLabel).toBe("POND {n}");
  expect(c.themes["duck-farm"]!.readyWord).toBe("IN THE COOP");
  expect(c.themes["duck-farm"]!.avatars).toEqual(["🦆", "🐥", "🪿", "🐣", "🦢", "🐤"]);
  for (const dropped of ["brand", "cta", "windsock"]) expect(Object.keys(c.themes["club-deck"]!)).not.toContain(dropped);
});

test("defaults: the Chrome Lounge Theme names its Sheet and carries the design-board palette", () => {
  const t = defaultConfig().themes["chrome-lounge"]!;
  expect(t.name).toBe("Chrome Lounge");
  expect(t.sheet).toBe("chrome-lounge");
  expect(t).toMatchObject({
    accent: "#ff9ecb",
    accent2: "#9df2d9",
    gold: "#ffe08a",
    tiers: ["#9df2d9", "#c7a6ff", "#ffc27a"],
    canopy: ["#ff9ecb", "#9df2d9"],
    ship: "#ff9ecb",
    shipStripe: "#9df2d9",
    shipLight: "#ff7a8a",
    panel: "rgba(10,8,22,.86)",
    line: "rgba(255,158,203,.55)",
    floor: ["#1a1636", "#07060e"],
    grid: "rgba(255,158,203,.28)",
    haze: "199,166,255",
    sky: "20,12,40",
    tower: "#14112a",
    rim: "rgba(199,166,255,.6)",
    lockTile: "#2a2540",
    windBits: ["✦", "·", "·"],
  });
  const club = defaultConfig().themes["club-deck"]!;
  expect(t.avatars).toEqual(club.avatars);
  for (const k of ["rackTitle", "unlockWord", "readyWord", "tierLabel"] as const) expect(t[k]).toBe(club[k]);
  expect(Object.keys(t).sort()).toEqual(Object.keys(club).sort()); // a full Theme: the validator accepts it as-is
  expect(() => validateConfig(structuredClone(defaultConfig()))).not.toThrow();
});

test("defaults: mini-draw outcomes name existing lists", () => {
  const c = defaultConfig();
  expect(c.outcomes.find((o) => o.id === "genre-roulette")?.miniDraw).toBe("genreRoulette");
  expect(c.outcomes.find((o) => o.id === "chat-rule-draw")?.miniDraw).toBe("chatRules");
  expect(c.lists.genreRoulette.length).toBe(14);
  expect(c.lists.chatRules.length).toBe(6);
});

test("defaultConfig returns a fresh deep copy each call", () => {
  const a = defaultConfig();
  a.outcomes[0]!.initialLeft = 99;
  a.tiers.gates.push(9);
  const b = defaultConfig();
  expect(b.outcomes[0]!.initialLeft).toBe(5);
  expect(b.tiers.gates).toEqual([0, 3, 6]);
});

test("validateConfig accepts the defaults and returns the same object", () => {
  const c = defaultConfig();
  expect(validateConfig(c)).toBe(c);
});

test("validation rejects duplicate outcome ids and bad gates", () => {
  const c = defaultConfig();
  c.outcomes.push({ ...c.outcomes[0]! });
  expect(() => validateConfig(c)).toThrow(/duplicate outcome id/i);
  const d = defaultConfig();
  d.tiers.gates = [0, 6, 3];
  expect(() => validateConfig(d)).toThrow(/gates/i);
});

test("validation lists every problem in one ConfigError", () => {
  const c = defaultConfig();
  c.listeners.funnelPort = c.listeners.streamerPort;
  c.threshold.cents = 0;
  c.overlay.theme = "nope";
  c.outcomes[0]!.tier = 7;
  (c.overlay as { side: string }).side = "up";
  let err: unknown;
  try {
    validateConfig(c);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  const msg = (err as Error).message;
  expect(msg).toMatch(/distinct/i);
  expect(msg).toMatch(/threshold\.cents/);
  expect(msg).toMatch(/overlay\.theme/);
  expect(msg).toMatch(/outcomes\.0\.tier/);
  expect(msg).toMatch(/overlay\.side/);
  expect((err as ConfigError).problems.length).toBe(5);
});

test("validation rejects a miniDraw that names no list and non-object input", () => {
  const c = defaultConfig();
  (c.outcomes.find((o) => o.id === "genre-roulette") as { miniDraw: string }).miniDraw = "bogus";
  expect(() => validateConfig(c)).toThrow(/miniDraw/);
  expect(() => validateConfig(null)).toThrow(ConfigError);
  expect(() => validateConfig("{}")).toThrow(ConfigError);
});

test("validation checks each draw-list item: a non-empty string of at most 60 characters, no exact repeats — the path names the item", () => {
  const c = defaultConfig();
  c.lists.genreRoulette[3] = "   ";
  c.lists.genreRoulette[5] = "X".repeat(61);
  c.lists.chatRules.push("THIRD-PERSON MODE"); // already at index 3
  let err: unknown;
  try {
    validateConfig(c);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  const problems = (err as ConfigError).problems;
  expect(problems).toHaveLength(3);
  expect(problems[0]).toMatch(/^lists\.genreRoulette\.3: must not be empty/);
  expect(problems[1]).toMatch(/^lists\.genreRoulette\.5: .*60/);
  expect(problems[2]).toMatch(/^lists\.chatRules\.6: duplicate .*THIRD-PERSON MODE/);
  // exactly 60 is fine; a list nothing draws from may be empty
  const d = defaultConfig();
  d.lists.chatRules = ["Y".repeat(60)];
  expect(() => validateConfig(d)).not.toThrow();
  const e = defaultConfig();
  e.outcomes = e.outcomes.filter((o) => o.miniDraw !== "chatRules");
  e.lists.chatRules = [];
  expect(() => validateConfig(e)).not.toThrow();
});

test("validation: a repeat is a repeat after trimming, and blank items are only blank — never also duplicates of each other", () => {
  const c = defaultConfig();
  c.lists.chatRules = ["A", " A"];
  let err: unknown;
  try {
    validateConfig(c);
  } catch (e) {
    err = e;
  }
  expect((err as ConfigError).problems).toEqual([`lists.chatRules.1: duplicate item ${JSON.stringify(" A")}`]);

  const d = defaultConfig();
  d.lists.chatRules = ["", " ", "\t"];
  try {
    validateConfig(d);
  } catch (e) {
    err = e;
  }
  const problems = (err as ConfigError).problems;
  expect(problems).toHaveLength(3);
  for (const problem of problems) expect(problem).toMatch(/^lists\.chatRules\.\d: must not be empty/);
});

test("loading (boot, hot reload): list items are normalised, not rejected — trimmed, blanks and repeats dropped, an over-long item clamped to LIST_ITEM_MAX, an over-long description clamped to DESCRIPTION_MAX — with one note per change; the same config saved through validateConfig() is rejected", () => {
  const c = defaultConfig();
  const genres = [...c.lists.genreRoulette];
  c.lists.genreRoulette = [...genres, "  ", genres[2]!, ` ${genres[0]} `];
  const long = "R".repeat(70);
  c.lists.chatRules = [...c.lists.chatRules, long];
  const essay = "D".repeat(300);
  c.outcomes[7]!.description = essay;
  expect(() => validateConfig(structuredClone(c))).toThrow(ConfigError);

  const notes: string[] = [];
  const loaded = validateConfig(structuredClone(c), { loading: (note) => notes.push(note) });
  expect(loaded.lists.genreRoulette).toEqual(genres);
  expect(loaded.lists.chatRules).toEqual([...defaultConfig().lists.chatRules, "R".repeat(LIST_ITEM_MAX)]);
  expect(loaded.outcomes[7]!.description).toBe("D".repeat(DESCRIPTION_MAX));
  expect(notes).toEqual([
    "lists.genreRoulette — dropped 3 blank/duplicate items",
    `lists.chatRules — trimmed 1 item to ${LIST_ITEM_MAX} chars`,
    `outcomes.7.description — trimmed to ${DESCRIPTION_MAX} chars`,
  ]);
  // whatever loads also saves — the strict path finds nothing wrong with what the load path produced
  expect(() => validateConfig(structuredClone(loaded))).not.toThrow();

  // a clamped item is trimmed after the cut, and two items that agree once cut are one item
  const d = defaultConfig();
  d.lists.chatRules = ["A".repeat(59) + " B", "A".repeat(59) + " C", ...d.lists.chatRules];
  const cut: string[] = [];
  const dl = validateConfig(d, { loading: (note) => cut.push(note) });
  expect(dl.lists.chatRules).toEqual(["A".repeat(59), ...defaultConfig().lists.chatRules]);
  expect(cut).toEqual([`lists.chatRules — dropped 1 blank/duplicate item, trimmed 1 item to ${LIST_ITEM_MAX} chars`]); // the dropped one counts once
  expect(() => validateConfig(structuredClone(dl))).not.toThrow();

  // a list that needs no normalising gets no note; a trimmed item is noted too
  const e = defaultConfig();
  e.lists.chatRules[0] = ` ${e.lists.chatRules[0]} `;
  const trimmed: string[] = [];
  expect(validateConfig(e, { loading: (note) => trimmed.push(note) }).lists.chatRules).toEqual(defaultConfig().lists.chatRules);
  expect(trimmed).toEqual(["lists.chatRules — trimmed 1 item"]);
  const clean: string[] = [];
  validateConfig(defaultConfig(), { loading: (note) => clean.push(note) });
  expect(clean).toEqual([]);
});

test("validation: emptying a list an Outcome still draws from names that Outcome and the list", () => {
  const c = defaultConfig();
  c.lists.genreRoulette = [];
  let err: unknown;
  try {
    validateConfig(c);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  const [problem, ...rest] = (err as ConfigError).problems;
  expect(rest).toEqual([]);
  expect(problem).toContain("lists.genreRoulette");
  expect(problem).toContain("GENRE ROULETTE");
});

test("diff reports leaf paths", () => {
  const a = defaultConfig(),
    b = structuredClone(a);
  b.threshold.cents = 3500;
  b.overlay.side = "left";
  expect(diffConfig(a, b)).toEqual([
    { path: "threshold.cents", from: 5000, to: 3500 },
    { path: "overlay.side", from: "right", to: "left" },
  ]);
});

test("diff walks arrays by index and reports added/removed leaves", () => {
  const a = defaultConfig(),
    b = structuredClone(a);
  b.tiers.gates = [0, 3, 6, 9];
  b.outcomes[0]!.initialLeft = 4;
  b.lists.chatRules.pop();
  expect(diffConfig(a, b)).toEqual([
    { path: "tiers.gates.3", from: undefined, to: 9 },
    { path: "outcomes.0.initialLeft", from: 5, to: 4 },
    { path: "lists.chatRules.5", from: "NATURE-DOCUMENTARY NARRATION OF THE CROWD", to: undefined },
  ]);
  expect(diffConfig(a, structuredClone(a))).toEqual([]);
});

test("defaults: firebot drives the imported !giveaway command (no presetId)", () => {
  const c = defaultConfig();
  expect(c.firebot).toEqual({ enabled: false, baseUrl: "http://localhost:7472", commandTrigger: "!giveaway", autoCloseSeconds: 0, chatter: "Bot" });
  expect(Object.keys(c.firebot)).not.toContain("presetId");
});

test("validation checks the firebot block: non-empty trigger, integer autoCloseSeconds >= 0, chatter Bot|Streamer; an older entrySeconds is dropped", () => {
  const c = defaultConfig();
  c.firebot.commandTrigger = "";
  c.firebot.autoCloseSeconds = -1;
  (c.firebot as { chatter: string }).chatter = "Mod";
  let err: unknown;
  try {
    validateConfig(c);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ConfigError);
  const msg = (err as Error).message;
  expect(msg).toMatch(/firebot\.commandTrigger/);
  expect(msg).toMatch(/firebot\.autoCloseSeconds/);
  expect(msg).toMatch(/firebot\.chatter/);
  expect((err as ConfigError).problems.length).toBe(3);

  const d = defaultConfig();
  d.firebot.autoCloseSeconds = 1.5;
  expect(() => validateConfig(d)).toThrow(/firebot\.autoCloseSeconds/);
  const e = defaultConfig();
  e.firebot.autoCloseSeconds = 0;
  e.firebot.chatter = "Streamer";
  expect(validateConfig(e)).toBe(e);

  const legacy = defaultConfig() as unknown as { firebot: Record<string, unknown> };
  delete legacy.firebot.autoCloseSeconds;
  legacy.firebot.entrySeconds = 120; // the pre-Giveaways-page timer: never carried forward
  const migrated = validateConfig(legacy as unknown as Config);
  expect(migrated.firebot.autoCloseSeconds).toBe(0);
  expect(Object.keys(migrated.firebot)).not.toContain("entrySeconds");
});

test("OutcomeDef carries initialLeft; a legacy `charges` key is read as initialLeft once and dropped", () => {
  const c = defaultConfig();
  expect(c.outcomes[0]!.initialLeft).toBe(5); // STICKERS
  expect("charges" in c.outcomes[0]!).toBe(false);
  const legacy = structuredClone(c) as unknown as { outcomes: Array<Record<string, unknown>> };
  delete legacy.outcomes[0]!.initialLeft;
  legacy.outcomes[0]!.charges = 7;
  const valid = validateConfig(legacy);
  expect(valid.outcomes[0]!.initialLeft).toBe(7);
  expect("charges" in valid.outcomes[0]!).toBe(false);
});

test("overlay.quality is 1..5 or auto, overlay.webgl is auto|off; particleCap and fps are gone", () => {
  const c = defaultConfig();
  expect(c.overlay.quality).toBe("auto");
  expect(c.overlay.webgl).toBe("auto");
  expect("particleCap" in c.overlay).toBe(false);
  expect("fps" in c.overlay).toBe(false);
  const bad = structuredClone(c) as unknown as { overlay: Record<string, unknown> };
  bad.overlay.quality = 6;
  expect(() => validateConfig(bad)).toThrow(/overlay\.quality/);
  bad.overlay.quality = "auto";
  bad.overlay.webgl = "on";
  expect(() => validateConfig(bad)).toThrow(/overlay\.webgl/);
});

test("legacy overlay.particleCap / overlay.fps keys are dropped silently on load", () => {
  const legacy = structuredClone(defaultConfig()) as unknown as { overlay: Record<string, unknown> };
  legacy.overlay.particleCap = 260;
  legacy.overlay.fps = 0;
  const valid = validateConfig(legacy);
  expect("particleCap" in valid.overlay).toBe(false);
  expect("fps" in valid.overlay).toBe(false);
});

test("Theme.sheet is empty or a bundled sheet id", () => {
  const c = defaultConfig();
  expect(c.themes["club-deck"]!.sheet).toBe("");
  const bad = structuredClone(c) as unknown as { themes: Record<string, Record<string, unknown>> };
  bad.themes["club-deck"]!.sheet = "velvet";
  expect(() => validateConfig(bad)).toThrow(/themes\.club-deck\.sheet/);
});

test("a config.json written before this schema still loads: quality/webgl/sheet default, charges becomes initialLeft, particleCap/fps go", () => {
  const legacy = structuredClone(defaultConfig()) as unknown as {
    outcomes: Array<Record<string, unknown>>;
    overlay: Record<string, unknown>;
    themes: Record<string, Record<string, unknown>>;
  };
  for (const o of legacy.outcomes) {
    o.charges = o.initialLeft;
    delete o.initialLeft;
  }
  legacy.overlay.particleCap = 260;
  legacy.overlay.fps = 0;
  delete legacy.overlay.quality;
  delete legacy.overlay.webgl;
  delete legacy.themes["chrome-lounge"]; // written before the Chrome Lounge Theme existed …
  legacy.overlay.theme = "club-deck"; // … so it names the theme it had (a config always carries `overlay.theme`; the default only fills a fresh one)
  for (const t of Object.values(legacy.themes)) delete t.sheet;

  const valid = validateConfig(legacy);
  expect(valid.overlay.quality).toBe("auto");
  expect(valid.overlay.webgl).toBe("auto");
  expect("particleCap" in valid.overlay).toBe(false);
  expect("fps" in valid.overlay).toBe(false);
  expect(Object.keys(valid.themes)).toEqual(["club-deck", "duck-farm", "chrome-lounge"]); // Chrome Lounge filled in from the defaults
  expect(valid.themes["club-deck"]!.sheet).toBe("");
  expect(valid.themes["duck-farm"]!.sheet).toBe("");
  expect(valid.themes["chrome-lounge"]!.sheet).toBe("chrome-lounge");
  const fresh = defaultConfig();
  valid.outcomes.forEach((o, i) => {
    expect(o.initialLeft).toBe(fresh.outcomes[i]!.initialLeft);
    expect("charges" in o).toBe(false);
  });
});

test("every default Outcome has a What it is line: a short description, never empty, within 240 characters, in mod-facing words", () => {
  const c = defaultConfig();
  for (const o of c.outcomes) {
    expect(typeof o.description).toBe("string");
    expect(o.description.trim().length).toBeGreaterThan(0);
    expect(o.description.length).toBeLessThanOrEqual(240);
    expect(o.description).not.toMatch(/\b(fire|fires|fired|firing|spin|spins|reward|rewards|prize|prizes|max|charges)\b/i);
  }
  expect(c.outcomes.find((o) => o.id === "friend-picks-three")!.description).toMatch(/friend/i);
  expect(c.outcomes.find((o) => o.id === "alter-ego")!.description).toMatch(/alter ego/i);
});

test("outcomes.N.description is a string of at most 240 characters; an explicit \"\" (the editor cleared it) survives load", () => {
  const notText = defaultConfig() as unknown as { outcomes: Array<Record<string, unknown>> };
  notText.outcomes[0]!.description = 7;
  expect(() => validateConfig(notText)).toThrow(/outcomes\.0\.description/);
  const long = defaultConfig();
  long.outcomes[1]!.description = "x".repeat(241);
  expect(() => validateConfig(long)).toThrow(/outcomes\.1\.description: at most 240 characters/);
  const edge = defaultConfig();
  edge.outcomes[1]!.description = "x".repeat(240);
  expect(validateConfig(edge).outcomes[1]!.description).toHaveLength(240);
  const cleared = defaultConfig();
  cleared.outcomes[2]!.description = "";
  expect(validateConfig(cleared).outcomes[2]!.description).toBe("");
});

test("a config.json written before the What it is line (v1.0.0, no `description` key) loads with the built-in line for each known id; an Outcome the streamer added gets \"\"", () => {
  const legacy = structuredClone(defaultConfig()) as unknown as { outcomes: Array<Record<string, unknown>> };
  for (const o of legacy.outcomes) delete o.description;
  legacy.outcomes.push({ ...legacy.outcomes[0]!, id: "vinyl-only", name: "VINYL ONLY" });
  const valid = validateConfig(legacy);
  const fresh = defaultConfig();
  expect(valid.outcomes).toHaveLength(fresh.outcomes.length + 1);
  fresh.outcomes.forEach((o, i) => {
    expect(valid.outcomes[i]!.id).toBe(o.id);
    expect(valid.outcomes[i]!.description).toBe(o.description);
    expect(valid.outcomes[i]!.description.length).toBeGreaterThan(0);
  });
  expect(valid.outcomes.at(-1)!.description).toBe("");
  // the reorder case: a legacy config with the rows in another order still fills by id, not by position
  const shuffled = structuredClone(legacy);
  shuffled.outcomes.reverse();
  for (const o of validateConfig(shuffled).outcomes) expect(o.description).toBe(fresh.outcomes.find((d) => d.id === o.id)?.description ?? "");
});

// Items are stored in CAPS (the pad shows them that way; the streamer asked for automatic capitalisation on the Dashboard
// editors, and a hand-edited file must come out the same). The load path upper-cases with a note; the save path
// upper-cases in place before the duplicate check — so "funk" next to "FUNK" is one duplicate problem, never two items.
test("draw-list items come out in CAPS: the load path upper-cases (noted) and dedupes on the upper-cased text; the save path upper-cases in place, and a lower-case repeat of an upper-case item is a duplicate", () => {
  const c = defaultConfig();
  c.lists.chatRules = ["funk it up", " House Rules ", "FUNK IT UP"];
  const notes: string[] = [];
  const loaded = validateConfig(structuredClone(c), { loading: (note) => notes.push(note) });
  expect(loaded.lists.chatRules).toEqual(["FUNK IT UP", "HOUSE RULES"]);
  expect(notes).toEqual(["lists.chatRules — dropped 1 blank/duplicate item, trimmed 1 item, upper-cased 2 items"]);
  expect(() => validateConfig(structuredClone(loaded))).not.toThrow(); // what loads also saves

  const s = defaultConfig();
  s.lists.chatRules = ["funk it up", "House Rules"];
  expect(validateConfig(s).lists.chatRules).toEqual(["FUNK IT UP", "HOUSE RULES"]);
  expect(s.lists.chatRules).toEqual(["FUNK IT UP", "HOUSE RULES"]); // in place — the object the store writes

  const d = defaultConfig();
  d.lists.chatRules = ["funk", "FUNK"];
  let err: unknown;
  try {
    validateConfig(d);
  } catch (e) {
    err = e;
  }
  expect((err as ConfigError).problems).toEqual([`lists.chatRules.1: duplicate item ${JSON.stringify("FUNK")}`]);

  // an already-CAPS config gets no note and no change
  const clean = defaultConfig();
  const none: string[] = [];
  expect(validateConfig(structuredClone(clean), { loading: (note) => none.push(note) }).lists).toEqual(clean.lists);
  expect(none).toEqual([]);
});

test("overlay.floorPercent: the dance floor's share of the frame from the bottom — default 33, a number 15..60, filled in for a config written before it existed (both paths)", () => {
  const c = defaultConfig();
  expect(c.overlay.floorPercent).toBe(33);
  const bad = structuredClone(c) as unknown as { overlay: Record<string, unknown> };
  bad.overlay.floorPercent = 61;
  expect(() => validateConfig(bad)).toThrow(/overlay\.floorPercent: must be in 15\.\.60/);
  bad.overlay.floorPercent = 14;
  expect(() => validateConfig(bad)).toThrow(/overlay\.floorPercent/);
  bad.overlay.floorPercent = "33";
  expect(() => validateConfig(bad)).toThrow(/overlay\.floorPercent/);
  const older = structuredClone(c) as unknown as { overlay: Record<string, unknown> };
  delete older.overlay.floorPercent;
  expect(validateConfig(structuredClone(older)).overlay.floorPercent).toBe(33);
  const notes: string[] = [];
  expect(validateConfig(older, { loading: (n) => notes.push(n) }).overlay.floorPercent).toBe(33);
  expect(notes).toEqual([]);
});

test("overlay.floorOpacity: the room's opacity — default 100, a number 0..100, filled in for a config written before it existed", () => {
  const c = defaultConfig();
  expect(c.overlay.floorOpacity).toBe(100);
  const bad = structuredClone(c) as unknown as { overlay: Record<string, unknown> };
  bad.overlay.floorOpacity = 101;
  expect(() => validateConfig(bad)).toThrow(/overlay\.floorOpacity: must be in 0\.\.100/);
  bad.overlay.floorOpacity = -1;
  expect(() => validateConfig(bad)).toThrow(/overlay\.floorOpacity/);
  const older = structuredClone(c) as unknown as { overlay: Record<string, unknown> };
  delete older.overlay.floorOpacity;
  expect(validateConfig(older).overlay.floorOpacity).toBe(100);
});

test("a config.json written while Room lights existed still loads: the `lights` block is dropped on load, with no problem and no note", () => {
  const old = defaultConfig() as unknown as Record<string, unknown>;
  old.lights = {
    enabled: true,
    transport: "govee",
    haBaseUrl: "http://homeassistant.local:8123",
    area: "Living Room",
    fireSeconds: 7,
    unlockSeconds: 5,
    scenes: { enabled: true, byShape: { challenge: "Strobe", giveaway: "", moment: "", stunt: "" } },
    idleScene: "Chill",
    exclude: ["Govee Ceiling Light"],
    roles: { "Curtain Lights Pro": "camera" },
    flashBrightness: 100,
  };
  const notes: string[] = [];
  const loaded = validateConfig(structuredClone(old), { loading: (note) => notes.push(note) });
  expect("lights" in loaded).toBe(false);
  expect(notes).toEqual([]); // nothing to tell the streamer: the feature is gone, the key goes with it
  expect(loaded).toEqual(defaultConfig());
  expect("lights" in validateConfig(structuredClone(old))).toBe(false); // the strict path (a Dashboard PUT) drops it too
});

test("themes: a Theme the defaults carry that a saved file lacks is filled in (both paths) — a config.json written before Chrome Lounge gains it, so the Config page can offer it; a saved edit of a default Theme is kept", () => {
  const stale = structuredClone(defaultConfig()) as unknown as { themes: Record<string, unknown>; overlay: { theme: string } };
  delete stale.themes["chrome-lounge"];
  stale.overlay.theme = "club-deck";
  const notes: string[] = [];
  const loaded = validateConfig(structuredClone(stale), { loading: (note) => notes.push(note) });
  expect(Object.keys(loaded.themes)).toContain("chrome-lounge");
  expect(loaded.themes["chrome-lounge"]).toEqual(defaultConfig().themes["chrome-lounge"]);
  expect(loaded.overlay.theme).toBe("club-deck"); // the streamer's pick stands
  expect(notes).toEqual(["themes — added chrome-lounge"]);
  expect(validateConfig(structuredClone(stale)).themes["chrome-lounge"]).toBeDefined();

  const edited = structuredClone(defaultConfig());
  edited.themes["chrome-lounge"]!.tierLabel = "ROOM {n}";
  expect(validateConfig(edited).themes["chrome-lounge"]!.tierLabel).toBe("ROOM {n}");
});

test("defaults: Chatter Dancers — a 15 minute Chat Window, 12 letters of name, 90 s dwell, the seeded Chat Bots in order", () => {
  const c = defaultConfig();
  expect(c.chatters).toEqual({
    windowMinutes: 15,
    nameLength: 12,
    dwellSeconds: 90,
    bots: ["streamdjbot", "sery_bot", "streamelements", "raidpal", "nightbot", "streamlabs", "moobot", "fossabot", "wizebot", "soundalerts", "botrix"],
  });
  expect([CHAT_WINDOW_MIN, CHAT_WINDOW_MAX, NAME_LENGTH_MIN, NAME_LENGTH_MAX, DWELL_SECONDS_MIN, DWELL_SECONDS_MAX, DWELL_SECONDS_STEP]).toEqual([5, 240, 4, 25, 30, 300, 5]);
  expect(() => validateConfig(c)).not.toThrow();
});

test("chatters migration: no block → the defaults including the seed (both paths); a block missing dwellSeconds → 90; bounds and non-strings refused; bots lower-cased, trimmed, deduped, blanks dropped (both paths)", () => {
  const old = defaultConfig() as unknown as Record<string, unknown>;
  delete old.chatters;
  expect(validateConfig(structuredClone(old)).chatters).toEqual(defaultConfig().chatters);
  expect(validateConfig(structuredClone(old), { loading: () => {} }).chatters.bots).toContain("streamdjbot");

  const partial = defaultConfig() as unknown as { chatters: Record<string, unknown> };
  delete partial.chatters.dwellSeconds;
  expect(validateConfig(partial).chatters.dwellSeconds).toBe(90);
  const noBots = defaultConfig() as unknown as { chatters: Record<string, unknown> };
  delete noBots.chatters.bots;
  expect(validateConfig(noBots).chatters.bots).toEqual(defaultConfig().chatters.bots);

  const bad = defaultConfig() as unknown as { chatters: Record<string, unknown> };
  bad.chatters.windowMinutes = 4;
  bad.chatters.nameLength = 26;
  bad.chatters.dwellSeconds = 29.5;
  bad.chatters.bots = ["ok", 7];
  let msg = "";
  try {
    validateConfig(bad);
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).toMatch(/chatters\.windowMinutes: must be in 5\.\.240, got 4/);
  expect(msg).toMatch(/chatters\.nameLength: must be in 4\.\.25, got 26/);
  expect(msg).toMatch(/chatters\.dwellSeconds: must be in 30\.\.300, got 29\.5/);
  expect(msg).toMatch(/chatters\.bots\.1: expected a string/);

  const messy = defaultConfig();
  messy.chatters.bots = [" NightBot ", "nightbot", "", "Sery_Bot"];
  expect(validateConfig(structuredClone(messy)).chatters.bots).toEqual(["nightbot", "sery_bot"]);
  expect(validateConfig(structuredClone(messy), { loading: () => {} }).chatters.bots).toEqual(["nightbot", "sery_bot"]);
  expect(normaliseBots(["A", "a", " b ", "", "B"])).toEqual(["a", "b"]);
});

test("listeners.overlayOnLan: default false, a boolean, filled in as false for a config written before it existed", () => {
  const c = defaultConfig();
  expect(c.listeners.overlayOnLan).toBe(false);
  const on = structuredClone(c);
  on.listeners.overlayOnLan = true;
  expect(validateConfig(on).listeners.overlayOnLan).toBe(true);
  const bad = structuredClone(c) as unknown as { listeners: Record<string, unknown> };
  bad.listeners.overlayOnLan = "yes";
  expect(() => validateConfig(bad)).toThrow(/listeners\.overlayOnLan/);
  const older = structuredClone(c) as unknown as { listeners: Record<string, unknown> };
  delete older.listeners.overlayOnLan;
  expect(validateConfig(structuredClone(older)).listeners.overlayOnLan).toBe(false);
  const notes: string[] = [];
  expect(validateConfig(older, { loading: (n) => notes.push(n) }).listeners.overlayOnLan).toBe(false);
  expect(notes).toEqual([]);
});
