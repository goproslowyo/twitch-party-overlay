/** Config schema, defaults, validation and diff. config.json is the single source of truth. */
import type { SubTier } from "../ingest/contribution.ts";

export interface Config {
  channel: { login: string; broadcasterId: string; displayName: string };
  /**
   * `overlayOnLan`: the overlay listener binds 127.0.0.1 unless this is on, in which case it binds every interface
   * so OBS on another computer can load it (and the Config page lists this machine's network addresses). Needs a restart.
   */
  listeners: { streamerPort: number; funnelPort: number; overlayPort: number; bindAll: boolean; overlayOnLan: boolean };
  funnel: { publicUrl: string }; // e.g. https://laptop.tail1234.ts.net — no trailing slash
  policy: { version: number; tipPercent: number; bitsCentsPer100: number; subCents: Record<SubTier, number> };
  threshold: { cents: number; suggestedCents: number[] };
  tiers: { gates: number[] }; // banked-count gates per tier index; gates[0] is always 0
  outcomes: OutcomeDef[];
  lists: { genreRoulette: string[]; chatRules: string[] };
  firebot: { enabled: boolean; baseUrl: string; commandTrigger: string; autoCloseSeconds: number; chatter: "Bot" | "Streamer" }; // autoCloseSeconds 0 = entries stay open until Close & draw on the Giveaways page
  chatters: ChattersConfig;
  ingest: {
    twitch: { enabled: boolean; eventsubUrl: string; sessions: number; keepaliveSeconds: number };
    streamelements: { enabled: boolean; pollSeconds: number };
    kofi: { enabled: boolean; webhookPath: string };
  };
  overlay: OverlayConfig;
  themes: Record<string, Theme>;
}

export interface OutcomeDef {
  id: string; // kebab-case, unique
  name: string; // UPPERCASE display name as approved
  glyph: string; // emoji
  shape: "challenge" | "giveaway" | "moment" | "stunt";
  tier: number;
  initialLeft: number; // read once when the Ledger first meets this id; never shown in the editor
  restockable: boolean;
  occupancy: string; // free text ("instant", "1 transition", ...)
  description: string; // the What it is line: the ⓘ on the Pool page, for the streamer and the mods; "" = nothing to say
  miniDraw?: "genreRoulette" | "chatRules"; // draws one item from config.lists[miniDraw] at Fire time
  raffle?: boolean; // Firebot raffle on Fire (giveaways)
}

/**
 * Chatter Dancers: who counts as an Active Chatter and how the floor treats them. `bots` is a lower-case login
 * list (normaliseBots) — anyone on it never gets a dancer; the seed is the bots seen in this channel and the usual suspects.
 */
export interface ChattersConfig {
  windowMinutes: number; // the Chat Window: minutes since someone's last message before they leave the floor
  nameLength: number; // letters of a name shown before it is cut short
  dwellSeconds: number; // when the floor is full: seconds each person gets before the next one walks on
  bots: string[]; // lower-case logins, trimmed, deduped, no blanks
}
export const CHAT_WINDOW_DEFAULT = 15;
export const CHAT_WINDOW_MIN = 5;
export const CHAT_WINDOW_MAX = 240;
export const NAME_LENGTH_DEFAULT = 12;
export const NAME_LENGTH_MIN = 4;
export const NAME_LENGTH_MAX = 25;
export const DWELL_SECONDS_DEFAULT = 90;
export const DWELL_SECONDS_MIN = 30;
export const DWELL_SECONDS_MAX = 300;
export const DWELL_SECONDS_STEP = 5; // the slider's step; the validator only asks for an integer in range
export const DEFAULT_CHAT_BOTS: readonly string[] = ["streamdjbot", "sery_bot", "streamelements", "raidpal", "nightbot", "streamlabs", "moobot", "fossabot", "wizebot", "soundalerts", "botrix"];

/** Lower-case, trimmed, blanks dropped, deduped, order kept — the Chat Bot list as it is stored and matched. */
export function normaliseBots(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const login = item.trim().toLowerCase();
    if (login !== "" && !out.includes(login)) out.push(login);
  }
  return out;
}

export type QualitySetting = 1 | 2 | 3 | 4 | 5 | "auto";
/**
 * How many real pixels back each of the overlay's 1080p pixels. The overlay is laid out for 1920 × 1080 whatever size
 * the OBS Browser source is, so this changes sharpness and cost, never the layout. 1× draws 1920 × 1080 and lets the
 * browser scale it up, costing the same at 4K as at 1080p; 2× draws every pixel of a 4K source, four times the fill,
 * which Auto Quality will answer by thinning the show if the PC cannot keep up.
 */
export type RenderScale = "1x" | "1.5x" | "2x";

export interface OverlayConfig {
  side: "left" | "right";
  brand: string;
  cta: string;
  brandAlternateMs: number;
  theme: string;
  intensityAnchorCents: number;
  bigIntensity: number;
  maxAir: number;
  descentMs: number;
  fullHoldMs: number;
  fullHoldBigMs: number;
  thankDwellMinMs: number;
  thankDwellMaxMs: number;
  revealMs: number;
  revealMiniDrawMs: number;
  shuffleMs: number;
  justRevealedMs: number;
  rackWidth: number;
  padHeight: number;
  /**
   * How much of the frame, from the bottom up, the sheet's dance floor takes — a whole percent, FLOOR_PERCENT_MIN..MAX.
   * The horizon sits at (100 − this) % of the height; the towers, lasers, haze, smoke and Dancers scale with the floor's depth.
   */
  floorPercent: number;
  /**
   * The room's opacity, 0..100: the floor, Dancers, towers, smoke, beams, lasers and windsock fade together so the cam
   * shows through (when an Outcome is watched on camera); the pads, the drop, the airship, the rack and every
   * Acknowledgement stay at full. 0 paints no room at all.
   */
  floorOpacity: number;
  /** A fixed Quality Level, or "auto" (the overlay steps itself). */
  quality: QualitySetting;
  /** How many real pixels back each 1080p pixel. See `RenderScale`. */
  renderScale: RenderScale;
  webgl: "auto" | "off";
}

/** The Theme Sheets baked into the bundle; `Theme.sheet` names one, or "" for the procedural look. */
export const SHEET_IDS = ["chrome-lounge"] as const;
export type SheetId = (typeof SHEET_IDS)[number];

/** Pure skin; nothing in the overlay branches on the theme's identity. */
export interface Theme {
  name: string;
  sheet: "" | SheetId;
  rackTitle: string;
  unlockWord: string;
  readyWord: string;
  tierLabel: string; // "TIER {n}"
  accent: string;
  accent2: string;
  gold: string;
  panel: string;
  line: string;
  shape: Record<OutcomeDef["shape"], string>;
  tiers: string[];
  canopy: string[];
  avatars: string[];
  floor: string[];
  floorEdge: string;
  grid: string;
  haze: string;
  wall: string;
  sky: string;
  tower: string;
  ship: string;
  shipStripe: string;
  shipLight: string;
  crowd: string;
  rim: string;
  lockTile: string;
  windBits: string[];
  bd1: string;
  bd2: string;
  cam: string;
}

/** One leaf-level change between two configs; `path` is dotted ("threshold.cents", "outcomes.3.initialLeft"). */
export interface Diff {
  path: string;
  from: unknown;
  to: unknown;
}

export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    const n = problems.length;
    super(`invalid config (${n} problem${n === 1 ? "" : "s"}):\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const OUTCOME_SHAPES = ["challenge", "giveaway", "moment", "stunt"] as const;
const SUB_TIERS = ["1000", "2000", "3000", "prime"] as const satisfies readonly SubTier[];
const MINI_DRAWS = ["genreRoulette", "chatRules"] as const;
/** Longest draw-list item (one pad label); the Config page says so in its hint. */
export const LIST_ITEM_MAX = 60;
const OVERLAY_SIDES = ["left", "right"] as const;
/**
 * `overlay.floorPercent`: the dance floor's share of the frame from the bottom. A third by default: the camera and whatever
 * sits above it stay clear (the 2026-09-05 boards drew 440 / 1080 ≈ 41 %, which covered too much of the frame in OBS).
 */
export const FLOOR_PERCENT_DEFAULT = 33;
export const FLOOR_PERCENT_MIN = 15;
export const FLOOR_PERCENT_MAX = 60;
/** `overlay.floorOpacity`: the room's opacity in percent; full by default. */
export const FLOOR_OPACITY_DEFAULT = 100;
const FIREBOT_CHATTERS = ["Bot", "Streamer"] as const;
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** The What it is line is one or two short sentences — a tooltip, not a paragraph. */
export const DESCRIPTION_MAX = 240;

// ---------------------------------------------------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------------------------------------------------

const O = (
  id: string,
  name: string,
  glyph: string,
  shape: OutcomeDef["shape"],
  tier: number,
  initialLeft: number,
  restockable: boolean,
  occupancy: string,
  description: string,
  extra: Pick<OutcomeDef, "miniDraw" | "raffle"> = {},
): OutcomeDef => ({ id, name, glyph, shape, tier, initialLeft, restockable, occupancy, description, ...extra });

/**
 * The starter pool: 32 charges over three tiers (17 / 10 / 5), 15 of them restockable. Nothing here assumes a DJ, a
 * particular game or a particular night; every line is something a stranger could run on their first stream. The pool the
 * overlay was first built for, a DJ party, is kept as `examples/outcome-pool-dj-party.json` and pasted in on the Config
 * page. The order matters to tests that pick "the last tier-0 outcome", so keep the shape when editing.
 */
const DEFAULT_OUTCOMES: OutcomeDef[] = [
  O("stickers", "STICKERS", "🎟️", "giveaway", 0, 5, false, "instant", "A chat raffle for a sticker pack. The winner is drawn in chat, and gets their claim link from the streamer straight after.", { raffle: true }),
  O("shirt-t0", "SHIRT", "👕", "giveaway", 0, 1, false, "instant", "A chat raffle for a shirt. The winner is drawn in chat, and gets their claim link from the streamer straight after.", { raffle: true }),
  O("chat-picks-next", "CHAT PICKS WHAT'S NEXT", "🗳️", "moment", 0, 2, true, "~10 min", "The mods run a poll on what happens next: a game, a level, a song, a topic. You go with the winner, no veto."),
  O("no-hud", "NO HUD", "🚫", "challenge", 0, 1, true, "~5 min", "Turn off whatever you lean on for the next five minutes: the HUD, the minimap, the waveform, the notes."),
  O("oven-mitts", "OVEN MITTS ON", "🧤", "challenge", 0, 1, true, "~5 min", "Oven mitts on for the next five minutes, whatever you are doing."),
  O("library-shuffle", "LIBRARY SHUFFLE", "🔀", "challenge", 0, 1, true, "~1 round", "Scroll your library blind, stop anywhere, and play whatever you land on. No take-backs."),
  O("one-hand-only", "ONE HAND ONLY", "🖐️", "challenge", 0, 1, true, "~5 min", "One hand behind your back for the next five minutes."),
  O("friend-picks-three", "A FRIEND PICKS THREE", "📦", "challenge", 0, 1, true, "~3 rounds", "Hand over the controls: a friend or a mod picks your next three moves, songs or rounds, and you take them as they come."),
  O("accent-switch", "ACCENT SWITCH", "🗣️", "challenge", 0, 1, true, "~2 min", "Chat picks an accent and you talk in it for the next two minutes."),
  O("eyes-off-chat", "EYES OFF CHAT", "👀", "challenge", 0, 1, true, "~5 min", "Chat is hidden for five minutes. A mod relays anything that matters."),
  O("dance-party", "DANCE PARTY", "🕺", "challenge", 0, 1, true, "~1 song", "Put a song on, stand up, and dance the whole thing on camera."),
  O("costume-30-min", "COSTUME · 30 MIN", "🎭", "challenge", 0, 1, true, "passive 30 min", "Put on a costume, a wig or a silly hat, whatever is in the house, and keep it on for the next 30 minutes while you carry on as normal."),
  O("shirt-t1", "SHIRT", "👕", "giveaway", 1, 2, false, "instant", "A chat raffle for a shirt. The winner is drawn in chat, and gets their claim link from the streamer straight after.", { raffle: true }),
  O("mystery-box", "MYSTERY BOX", "🎁", "giveaway", 1, 2, false, "instant + mail", "A chat raffle for a small box of surprises, mailed to the winner. Firebot draws the winner when it comes up.", { raffle: true }),
  O("genre-roulette", "GENRE ROULETTE", "🎲", "challenge", 1, 1, true, "10–15 min", "The overlay draws one genre from your list and you stay in it for 10–15 minutes: a music genre, a game genre, whatever your list holds. The list lives on the Config page.", { miniDraw: "genreRoulette" }),
  O("ten-in-ten", "TEN IN TEN", "⏱️", "challenge", 1, 1, true, "10 min", "Ten of something in ten minutes: ten songs, ten rounds, ten viewer questions. About a minute each. Keep it moving."),
  O("blindfold", "BLINDFOLD", "🙈", "challenge", 1, 1, true, "~1 round", "Blindfold on for one whole round, song or minute, whichever fits what you are doing."),
  O("chopsticks-only", "CHOPSTICKS ONLY", "🥢", "challenge", 1, 1, true, "~5 min", "Chopsticks only on the keyboard, the mouse, the controller or the decks for the next five minutes."),
  O("chat-rule-draw", "CHAT-RULE DRAW", "📜", "challenge", 1, 1, true, "10 min passive", "The overlay draws one rule from the chat-rule list and you play by it for about 10 minutes: third-person mode, say, or sports-commentator play-by-play. The list lives on the Config page.", { miniDraw: "chatRules" }),
  O("bonus-stream-unlock", "BONUS STREAM UNLOCK", "📅", "moment", 1, 1, false, "instant (communal)", "Chat has unlocked an extra stream. Commit to it and announce it on the spot; the date is set later. Nothing else to do tonight."),
  O("pie-to-the-face", "PIE TO THE FACE", "🥧", "stunt", 2, 1, false, "instant, legendary", "You take a pie to the face, on camera, right now."),
  O("guest-takeover", "GUEST TAKEOVER", "🤝", "stunt", 2, 1, false, "30–45 min", "A friend or co-streamer takes over for 30–45 minutes. Suspend this one once your guest has called it a night."),
  // the prototype's makePool() has this one-off, by design ("mod discretion").
  O("alter-ego", "ALTER EGO", "🪩", "stunt", 2, 1, false, "costume bit", "Your alter ego takes over: a wig, a shirt, a new name and a new voice, and you stream as them for a bit."),
  O("custom-commission", "CUSTOM COMMISSION", "🎨", "giveaway", 2, 1, false, "post-stream", "A chat raffle for something made after the stream: a drawing, a playlist, a video shout-out. The winner picks the subject.", { raffle: true }),
  O("party-polaroid", "PARTY POLAROID", "📸", "giveaway", 2, 1, false, "instant + mail", "A chat raffle for a polaroid from tonight's stream, signed and mailed to the winner.", { raffle: true }),
];

/** Themes copied from the prototype page (its THEMES.club / THEMES.duck). */
const DEFAULT_THEMES: Record<string, Theme> = {
  "club-deck": {
    name: "Club-Deck",
    sheet: "",
    rackTitle: "UNLOCKS",
    accent: "#26f0ff",
    accent2: "#ff3df0",
    gold: "#ffd166",
    panel: "rgba(8,8,22,.86)",
    line: "rgba(38,240,255,.45)",
    shape: { challenge: "#ff3df0", giveaway: "#ffd166", moment: "#26f0ff", stunt: "#ff6b6b" },
    tiers: ["#3ddc97", "#b388ff", "#ff9f1c"],
    tierLabel: "TIER {n}",
    unlockWord: "UNLOCK",
    readyWord: "READY",
    canopy: ["#ff3df0", "#26f0ff"],
    avatars: ["🎧", "🕺", "💃", "🎹", "🥁", "🎷", "🪩", "🔊"],
    floor: ["#1b1b3d", "#0d0d22"],
    floorEdge: "#2b2b5a",
    grid: "rgba(38,240,255,.16)",
    haze: "38,240,255",
    wall: "60,40,140",
    sky: "20,10,60",
    tower: "#2a2a4a",
    ship: "#1a1a30",
    shipStripe: "#26f0ff",
    shipLight: "#ff3df0",
    crowd: "#0a0a18",
    rim: "rgba(38,240,255,.45)",
    lockTile: "#141428",
    windBits: ["♪", "♫", "·", "·"],
    bd1: "#3a0ca3",
    bd2: "#0a9396",
    cam: "🎧",
  },
  "duck-farm": {
    name: "Duck-Farm (duck test)",
    sheet: "",
    rackTitle: "SPLASHES",
    accent: "#ffb703",
    accent2: "#8ecae6",
    gold: "#ffd166",
    panel: "rgba(30,22,8,.86)",
    line: "rgba(255,183,3,.45)",
    shape: { challenge: "#f4a261", giveaway: "#ffd166", moment: "#8ecae6", stunt: "#e76f51" },
    tiers: ["#90be6d", "#f9c74f", "#f3722c"],
    tierLabel: "POND {n}",
    unlockWord: "SPLASH",
    readyWord: "IN THE COOP",
    canopy: ["#ffb703", "#8ecae6"],
    avatars: ["🦆", "🐥", "🪿", "🐣", "🦢", "🐤"],
    floor: ["#2d4a1e", "#1a2c10"],
    floorEdge: "#4a6a2a",
    grid: "rgba(255,183,3,.14)",
    haze: "255,183,3",
    wall: "80,110,40",
    sky: "40,60,20",
    tower: "#5a3a18",
    ship: "#6f4518",
    shipStripe: "#ffb703",
    shipLight: "#8ecae6",
    crowd: "#15220c",
    rim: "rgba(255,183,3,.45)",
    lockTile: "#2a2a14",
    windBits: ["🍃", "🪶", "·"],
    bd1: "#606c38",
    bd2: "#0077b6",
    cam: "🦆",
  },
  // the approved Chrome Lounge look: its sprites come from the bundled Sheet; palette from the design boards
  "chrome-lounge": {
    name: "Chrome Lounge",
    sheet: "chrome-lounge",
    rackTitle: "UNLOCKS",
    accent: "#ff9ecb",
    accent2: "#9df2d9",
    gold: "#ffe08a",
    panel: "rgba(10,8,22,.86)",
    line: "rgba(255,158,203,.55)",
    shape: { challenge: "#ff9ecb", giveaway: "#ffe08a", moment: "#9df2d9", stunt: "#ff7a8a" },
    tiers: ["#9df2d9", "#c7a6ff", "#ffc27a"],
    tierLabel: "TIER {n}",
    unlockWord: "UNLOCK",
    readyWord: "READY",
    canopy: ["#ff9ecb", "#9df2d9"],
    avatars: ["🎧", "🕺", "💃", "🎹", "🥁", "🎷", "🪩", "🔊"],
    floor: ["#1a1636", "#07060e"],
    floorEdge: "#2a2450",
    grid: "rgba(255,158,203,.28)",
    haze: "199,166,255",
    wall: "40,30,80",
    sky: "20,12,40",
    tower: "#14112a",
    ship: "#ff9ecb",
    shipStripe: "#9df2d9",
    shipLight: "#ff7a8a",
    crowd: "#0a0818",
    rim: "rgba(199,166,255,.6)",
    lockTile: "#2a2540",
    windBits: ["✦", "·", "·"],
    bd1: "#3a2a7a",
    bd2: "#1f6f66",
    cam: "🎧",
  },
};

const DEFAULTS: Config = {
  channel: { login: "", broadcasterId: "", displayName: "" },
  listeners: { streamerPort: 8700, funnelPort: 8701, overlayPort: 8702, bindAll: false, overlayOnLan: false },
  funnel: { publicUrl: "" },
  policy: { version: 1, tipPercent: 100, bitsCentsPer100: 100, subCents: { "1000": 200, "2000": 350, "3000": 875, prime: 200 } },
  threshold: { cents: 5000, suggestedCents: [5000, 3500, 2500, 2000, 1000] },
  tiers: { gates: [0, 3, 6] },
  outcomes: DEFAULT_OUTCOMES,
  lists: {
    // seeds to prune
    genreRoulette: [
      "DISCO / NU-DISCO",
      "UK GARAGE",
      "BREAKS / BREAKBEAT",
      "DUBSTEP",
      "TRANCE",
      "HARDSTYLE / HARDCORE",
      "JUNGLE",
      "HIP-HOP / TRAP",
      "DUB TECHNO / MINIMAL",
      "PSYTRANCE",
      "SYNTHWAVE / 80S",
      "REGGAETON / LATIN",
      "FUNK / SOUL",
      "DOWNTEMPO / AMBIENT",
    ],
    chatRules: [
      "BOXING-MC TRACK ANNOUNCEMENTS",
      "SPORTS-COMMENTATOR PLAY-BY-PLAY",
      "COMPLIMENT A RANDOM CHATTER BY NAME",
      "THIRD-PERSON MODE",
      "CHAT PICKS YOUR NAME FOR 10 MIN",
      "NATURE-DOCUMENTARY NARRATION OF THE CROWD",
    ],
  },
  firebot: { enabled: false, baseUrl: "http://localhost:7472", commandTrigger: "!giveaway", autoCloseSeconds: 0, chatter: "Bot" },
  chatters: { windowMinutes: CHAT_WINDOW_DEFAULT, nameLength: NAME_LENGTH_DEFAULT, dwellSeconds: DWELL_SECONDS_DEFAULT, bots: [...DEFAULT_CHAT_BOTS] },
  ingest: {
    twitch: { enabled: true, eventsubUrl: "wss://eventsub.wss.twitch.tv/ws", sessions: 2, keepaliveSeconds: 10 },
    // Optional extras are OFF until the Setup page's switch; a config.json that already says true keeps saying so.
    streamelements: { enabled: false, pollSeconds: 20 },
    kofi: { enabled: false, webhookPath: "" },
  },
  overlay: {
    side: "right",
    brand: "",
    cta: "TIP · CHEER · SUB · GIFT",
    brandAlternateMs: 12000,
    theme: "chrome-lounge", // the default Theme; club-deck and duck-farm stay in `themes` for a config that names them
    intensityAnchorCents: 60000,
    bigIntensity: 0.6,
    maxAir: 6,
    descentMs: 12000,
    fullHoldMs: 900,
    fullHoldBigMs: 1700,
    thankDwellMinMs: 4000,
    thankDwellMaxMs: 7000,
    revealMs: 3400,
    revealMiniDrawMs: 8500,
    shuffleMs: 3600,
    justRevealedMs: 25000,
    rackWidth: 300,
    padHeight: 50,
    floorPercent: FLOOR_PERCENT_DEFAULT,
    floorOpacity: FLOOR_OPACITY_DEFAULT,
    quality: "auto",
    renderScale: "1x",
    webgl: "auto",
  },
  themes: DEFAULT_THEMES,
};

/** A fresh deep copy every call — callers may mutate the result freely. */
export function defaultConfig(): Config {
  return structuredClone(DEFAULTS);
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation (hand-written; collects every problem, then throws one ConfigError)
// ---------------------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown): string => (v === undefined ? "undefined" : JSON.stringify(v));

class Problems {
  readonly list: string[] = [];
  add(msg: string): void {
    this.list.push(msg);
  }
  obj(at: string, v: unknown): v is Rec {
    if (isRecord(v)) return true;
    this.add(`${at}: expected an object, got ${show(v)}`);
    return false;
  }
  arr(at: string, v: unknown): v is unknown[] {
    if (Array.isArray(v)) return true;
    this.add(`${at}: expected an array, got ${show(v)}`);
    return false;
  }
  str(at: string, v: unknown): v is string {
    if (typeof v === "string") return true;
    this.add(`${at}: expected a string, got ${show(v)}`);
    return false;
  }
  bool(at: string, v: unknown): v is boolean {
    if (typeof v === "boolean") return true;
    this.add(`${at}: expected a boolean, got ${show(v)}`);
    return false;
  }
  /** Finite number, optionally bounded (inclusive). */
  num(at: string, v: unknown, { min, max }: { min?: number; max?: number } = {}): v is number {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      this.add(`${at}: expected a number, got ${show(v)}`);
      return false;
    }
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
      const range = max === undefined ? `>= ${min}` : `in ${min}..${max}`;
      this.add(`${at}: must be ${range}, got ${v}`);
      return false;
    }
    return true;
  }
  int(at: string, v: unknown, bounds: { min?: number; max?: number } = {}): v is number {
    if (!this.num(at, v, bounds)) return false;
    if (Number.isInteger(v)) return true;
    this.add(`${at}: must be an integer, got ${v}`);
    return false;
  }
  strArr(at: string, v: unknown): v is string[] {
    if (!this.arr(at, v)) return false;
    return v.map((item, i) => this.str(`${at}.${i}`, item)).every(Boolean);
  }
  oneOf<T extends string>(at: string, v: unknown, values: readonly T[]): v is T {
    if (typeof v === "string" && (values as readonly string[]).includes(v)) return true;
    this.add(`${at}: must be one of ${values.join(" | ")}, got ${show(v)}`);
    return false;
  }
}

const THEME_STRING_KEYS = [
  "name", "sheet", "rackTitle", "unlockWord", "readyWord", "tierLabel",
  "accent", "accent2", "gold", "panel", "line",
  "floorEdge", "grid", "haze", "wall", "sky",
  "tower", "ship", "shipStripe", "shipLight", "crowd", "rim", "lockTile",
  "bd1", "bd2", "cam",
] as const satisfies readonly (keyof Theme)[];
const THEME_STRING_ARRAY_KEYS = ["tiers", "canopy", "avatars", "floor", "windBits"] as const satisfies readonly (keyof Theme)[];
const OVERLAY_NUMBER_KEYS = [
  "brandAlternateMs", "intensityAnchorCents", "bigIntensity", "maxAir", "descentMs",
  "fullHoldMs", "fullHoldBigMs", "thankDwellMinMs", "thankDwellMaxMs",
  "revealMs", "revealMiniDrawMs", "shuffleMs", "justRevealedMs",
  "rackWidth", "padHeight",
] as const satisfies readonly (keyof OverlayConfig)[];
const WEBGL_SETTINGS = ["auto", "off"] as const satisfies readonly OverlayConfig["webgl"][];
/** Overlay keys older configs carry that mean nothing now (`quality` replaced them); dropped on load. */
const LEGACY_OVERLAY_KEYS = ["particleCap", "fps"] as const;

function validateTheme(p: Problems, at: string, t: unknown): void {
  if (!p.obj(at, t)) return;
  // a theme written before Theme Sheets has no `sheet`: procedural, same as ""
  if (t.sheet === undefined) t.sheet = "";
  for (const k of THEME_STRING_KEYS) p.str(`${at}.${k}`, t[k]);
  if (typeof t.sheet === "string" && t.sheet !== "" && !(SHEET_IDS as readonly string[]).includes(t.sheet)) {
    p.add(`${at}.sheet: must be "" or one of ${SHEET_IDS.join(" | ")}, got ${show(t.sheet)}`);
  }
  for (const k of THEME_STRING_ARRAY_KEYS) p.strArr(`${at}.${k}`, t[k]);
  if (p.obj(`${at}.shape`, t.shape)) for (const s of OUTCOME_SHAPES) p.str(`${at}.shape.${s}`, t.shape[s]);
}

export type ValidateOptions = {
  /**
   * Set when reading config.json (boot, the watcher's reload) rather than saving an edit. A file that loaded before must
   * never block boot, so what the Config page would have refused is normalised instead of rejected — draw-list items
   * trimmed, blank and exact-repeat items dropped, an over-long item cut to LIST_ITEM_MAX, an over-long description cut
   * to DESCRIPTION_MAX — with one note per change (`lists.chatRules — dropped 2 …`, `outcomes.7.description — trimmed …`).
   * whatever this path produces passes the strict path, so a config that boots always saves (every PUT re-validates
   * strictly through ConfigStore.update()). The Dashboard's PUT goes without it and gets the strict rules.
   */
  loading?: (note: string) => void;
};

/**
 * In place: trim each item, upper-case it (items show in CAPS on the pad, so they are stored that way — the Pool page
 * rows and the Config textareas send caps; a hand-edited file catches up here), cut one longer than LIST_ITEM_MAX
 * (trimmed again after the cut), drop blanks and exact repeats of the upper-cased text; the note says what changed, or
 * is undefined.
 */
function normaliseList(list: string[]): string | undefined {
  const kept: string[] = [];
  let trimmed = 0;
  let cased = 0;
  let clamped = 0;
  for (const item of list) {
    const tidy = item.trim();
    let text = tidy.toUpperCase();
    const over = text.length > LIST_ITEM_MAX;
    if (over) text = text.slice(0, LIST_ITEM_MAX).trim();
    if (text === "" || kept.includes(text)) continue; // a dropped item is only "dropped", however it was tidied
    if (over) clamped++;
    else if (tidy !== item) trimmed++;
    if (tidy !== tidy.toUpperCase()) cased++;
    kept.push(text);
  }
  const dropped = list.length - kept.length;
  if (dropped === 0 && trimmed === 0 && cased === 0 && clamped === 0) return undefined;
  list.splice(0, list.length, ...kept);
  const parts: string[] = [];
  if (dropped > 0) parts.push(`dropped ${dropped} blank/duplicate item${dropped === 1 ? "" : "s"}`);
  if (trimmed > 0) parts.push(`trimmed ${trimmed} item${trimmed === 1 ? "" : "s"}`);
  if (cased > 0) parts.push(`upper-cased ${cased} item${cased === 1 ? "" : "s"}`);
  if (clamped > 0) parts.push(`trimmed ${clamped} item${clamped === 1 ? "" : "s"} to ${LIST_ITEM_MAX} chars`);
  return parts.join(", ");
}

/** Throws ConfigError listing every problem; returns the same object (typed) when valid. */
export function validateConfig(input: unknown, { loading }: ValidateOptions = {}): Config {
  const p = new Problems();
  if (!p.obj("config", input)) throw new ConfigError(p.list);
  const c = input;

  if (p.obj("channel", c.channel)) {
    for (const k of ["login", "broadcasterId", "displayName"]) p.str(`channel.${k}`, c.channel[k]);
  }

  if (p.obj("listeners", c.listeners)) {
    const l = c.listeners;
    const ports = ["streamerPort", "funnelPort", "overlayPort"].filter((k) => p.int(`listeners.${k}`, l[k], { min: 1, max: 65535 })).map((k) => l[k] as number);
    if (ports.length === 3 && new Set(ports).size !== 3) p.add(`listeners: ports must be distinct, got ${ports.join(", ")}`);
    p.bool("listeners.bindAll", l.bindAll);
    // a config written before `overlayOnLan` existed has none: off, so OBS on the same computer is the default
    if (l.overlayOnLan === undefined) l.overlayOnLan = false;
    p.bool("listeners.overlayOnLan", l.overlayOnLan);
  }

  if (p.obj("funnel", c.funnel) && p.str("funnel.publicUrl", c.funnel.publicUrl) && c.funnel.publicUrl.endsWith("/")) {
    p.add(`funnel.publicUrl: must not end with a slash, got ${show(c.funnel.publicUrl)}`);
  }

  if (p.obj("policy", c.policy)) {
    const pol = c.policy;
    for (const k of ["version", "tipPercent", "bitsCentsPer100"]) p.int(`policy.${k}`, pol[k], { min: 0 });
    if (p.obj("policy.subCents", pol.subCents)) for (const t of SUB_TIERS) p.int(`policy.subCents.${t}`, pol.subCents[t], { min: 0 });
  }

  if (p.obj("threshold", c.threshold)) {
    p.int("threshold.cents", c.threshold.cents, { min: 1 });
    if (p.arr("threshold.suggestedCents", c.threshold.suggestedCents)) {
      c.threshold.suggestedCents.forEach((v, i) => p.int(`threshold.suggestedCents.${i}`, v, { min: 1 }));
    }
  }

  let gateCount = 0; // 0 = gates unusable; tier checks are skipped rather than piling on
  if (p.obj("tiers", c.tiers) && p.arr("tiers.gates", c.tiers.gates)) {
    const gates = c.tiers.gates;
    if (gates.map((g, i) => p.int(`tiers.gates.${i}`, g, { min: 0 })).every(Boolean)) {
      const nums = gates as number[];
      if (nums[0] !== 0) p.add(`tiers.gates: gates[0] must be 0, got ${show(nums[0])}`);
      if (nums.some((g, i) => i > 0 && g <= nums[i - 1]!)) p.add(`tiers.gates: must be strictly increasing, got [${nums.join(", ")}]`);
      gateCount = nums.length;
    }
  }

  const lists: Partial<Record<(typeof MINI_DRAWS)[number], string[]>> = {};
  if (p.obj("lists", c.lists)) {
    for (const k of MINI_DRAWS) {
      if (!p.strArr(`lists.${k}`, c.lists[k])) continue;
      const list = c.lists[k];
      lists[k] = list;
      if (loading) {
        // a hand-edited file: tidy what the Config page would have refused, so the same config saves later
        const note = normaliseList(list);
        if (note !== undefined) loading(`lists.${k} — ${note}`);
        continue;
      }
      // each item is one row on the Pool page, one line on the Config page and one pad label on the overlay: non-empty,
      // short, no exact repeats — and stored in CAPS. The Dashboard editors send caps already; the JSON editor's
      // lower-case is upper-cased here, in place, before the duplicate check (so "funk" next to "FUNK" is a duplicate).
      const seen = new Set<string>();
      list.forEach((item, i) => {
        const at = `lists.${k}.${i}`;
        const upper = item.toUpperCase();
        list[i] = upper;
        const text = upper.trim();
        if (text === "") return void p.add(`${at}: must not be empty`);
        if (upper.length > LIST_ITEM_MAX) p.add(`${at}: must be at most ${LIST_ITEM_MAX} characters, got ${upper.length}`);
        if (seen.has(text)) p.add(`${at}: duplicate item ${show(upper)}`);
        seen.add(text);
      });
    }
  }

  if (p.arr("outcomes", c.outcomes)) {
    const seen = new Set<string>();
    c.outcomes.forEach((o, i) => {
      const at = `outcomes.${i}`;
      if (!p.obj(at, o)) return;
      // a config written before Used / Left called the starting stock `charges`: read it as initialLeft once, then drop it
      if (o.initialLeft === undefined && typeof o.charges === "number") o.initialLeft = o.charges;
      delete o.charges;
      if (p.str(`${at}.id`, o.id)) {
        if (!KEBAB_CASE.test(o.id)) p.add(`${at}.id: must be kebab-case, got ${show(o.id)}`);
        if (seen.has(o.id)) p.add(`${at}.id: duplicate outcome id ${show(o.id)}`);
        seen.add(o.id);
      }
      p.str(`${at}.name`, o.name);
      p.str(`${at}.glyph`, o.glyph);
      p.oneOf(`${at}.shape`, o.shape, OUTCOME_SHAPES);
      if (p.int(`${at}.tier`, o.tier, { min: 0 }) && gateCount > 0 && o.tier >= gateCount) {
        p.add(`${at}.tier: ${o.tier} has no gate (tiers.gates has ${gateCount} entries)`);
      }
      p.int(`${at}.initialLeft`, o.initialLeft, { min: 0 });
      p.bool(`${at}.restockable`, o.restockable);
      p.str(`${at}.occupancy`, o.occupancy);
      // a config written before the What it is line has no `description` key: fill the built-in line for a
      // known id so an upgraded Dashboard still explains its rows; an id the streamer added has nothing to say yet ("").
      // An explicit "" (the editor cleared it) is kept — only an absent key is filled.
      if (o.description === undefined) o.description = DEFAULT_OUTCOMES.find((d) => d.id === o.id)?.description ?? "";
      if (p.str(`${at}.description`, o.description) && o.description.length > DESCRIPTION_MAX) {
        if (loading) {
          // a hand-edited essay: keep what fits, so the file still saves
          o.description = o.description.slice(0, DESCRIPTION_MAX).trim();
          loading(`${at}.description — trimmed to ${DESCRIPTION_MAX} chars`);
        } else p.add(`${at}.description: at most ${DESCRIPTION_MAX} characters, got ${o.description.length}`);
      }
      if (o.miniDraw !== undefined && p.oneOf(`${at}.miniDraw`, o.miniDraw, MINI_DRAWS)) {
        const list = lists[o.miniDraw];
        if (list !== undefined && list.length === 0) {
          p.add(`lists.${o.miniDraw}: is empty, but ${typeof o.name === "string" ? o.name : o.id} (${at}) still draws from it — keep at least one item, or clear that Outcome's mini-draw`);
        }
      }
      if (o.raffle !== undefined) p.bool(`${at}.raffle`, o.raffle);
    });
  }

  if (p.obj("firebot", c.firebot)) {
    p.bool("firebot.enabled", c.firebot.enabled);
    p.str("firebot.baseUrl", c.firebot.baseUrl);
    if (p.str("firebot.commandTrigger", c.firebot.commandTrigger) && c.firebot.commandTrigger.trim() === "") {
      p.add("firebot.commandTrigger: must not be empty");
    }
    // a config written before the Giveaways page timed every raffle (entrySeconds, 120 by default); the timer is now
    // opt-in and the old key means nothing — dropped, so entries stay open until Close & draw
    delete (c.firebot as Record<string, unknown>).entrySeconds;
    if (c.firebot.autoCloseSeconds === undefined) c.firebot.autoCloseSeconds = 0;
    p.int("firebot.autoCloseSeconds", c.firebot.autoCloseSeconds, { min: 0 });
    p.oneOf("firebot.chatter", c.firebot.chatter, FIREBOT_CHATTERS);
  }

  // a config written while Room lights existed (v1.1.0 to v1.15.1) still carries a `lights` block: the feature is gone,
  // so the key is dropped on both paths, with no problem and no note
  delete c.lights;

  // a config written before Chatter Dancers has no `chatters` block: the defaults, the seeded Chat Bots included
  if (c.chatters === undefined) c.chatters = structuredClone(DEFAULTS.chatters);
  if (p.obj("chatters", c.chatters)) {
    const ch = c.chatters;
    if (ch.windowMinutes === undefined) ch.windowMinutes = CHAT_WINDOW_DEFAULT;
    if (ch.nameLength === undefined) ch.nameLength = NAME_LENGTH_DEFAULT;
    if (ch.dwellSeconds === undefined) ch.dwellSeconds = DWELL_SECONDS_DEFAULT;
    if (ch.bots === undefined) ch.bots = [...DEFAULT_CHAT_BOTS];
    p.int("chatters.windowMinutes", ch.windowMinutes, { min: CHAT_WINDOW_MIN, max: CHAT_WINDOW_MAX });
    p.int("chatters.nameLength", ch.nameLength, { min: NAME_LENGTH_MIN, max: NAME_LENGTH_MAX });
    p.int("chatters.dwellSeconds", ch.dwellSeconds, { min: DWELL_SECONDS_MIN, max: DWELL_SECONDS_MAX });
    if (p.strArr("chatters.bots", ch.bots)) ch.bots = normaliseBots(ch.bots); // both paths: stored the way it is matched
  }

  if (p.obj("ingest", c.ingest)) {
    const g = c.ingest;
    if (p.obj("ingest.twitch", g.twitch)) {
      p.bool("ingest.twitch.enabled", g.twitch.enabled);
      p.str("ingest.twitch.eventsubUrl", g.twitch.eventsubUrl);
      p.int("ingest.twitch.sessions", g.twitch.sessions, { min: 1 });
      p.int("ingest.twitch.keepaliveSeconds", g.twitch.keepaliveSeconds, { min: 1 });
    }
    if (p.obj("ingest.streamelements", g.streamelements)) {
      p.bool("ingest.streamelements.enabled", g.streamelements.enabled);
      p.int("ingest.streamelements.pollSeconds", g.streamelements.pollSeconds, { min: 1 });
    }
    if (p.obj("ingest.kofi", g.kofi)) {
      p.bool("ingest.kofi.enabled", g.kofi.enabled);
      p.str("ingest.kofi.webhookPath", g.kofi.webhookPath);
    }
  }

  let themeKeys: string[] | null = null;
  if (p.obj("themes", c.themes)) {
    // a themes map written before a default Theme existed (a config.json from before Chrome Lounge) lacks it: filled
    // in from the defaults so the Config page can offer it; a Theme the file does carry is the streamer's, kept as-is
    for (const k of Object.keys(DEFAULT_THEMES)) {
      if (c.themes[k] === undefined) {
        c.themes[k] = structuredClone(DEFAULT_THEMES[k]);
        loading?.(`themes — added ${k}`);
      }
    }
    themeKeys = Object.keys(c.themes);
    for (const k of themeKeys) validateTheme(p, `themes.${k}`, c.themes[k]);
  }

  if (p.obj("overlay", c.overlay)) {
    const o = c.overlay;
    p.oneOf("overlay.side", o.side, OVERLAY_SIDES);
    p.str("overlay.brand", o.brand);
    p.str("overlay.cta", o.cta);
    if (p.str("overlay.theme", o.theme) && themeKeys !== null && !themeKeys.includes(o.theme)) {
      p.add(`overlay.theme: ${show(o.theme)} is not a key of themes (${themeKeys.join(", ")})`);
    }
    for (const k of OVERLAY_NUMBER_KEYS) p.num(`overlay.${k}`, o[k], { min: 0 });
    // an overlay block written before the floor's share was a setting has no `floorPercent`: the default (a third)
    if (o.floorPercent === undefined) o.floorPercent = FLOOR_PERCENT_DEFAULT;
    p.num("overlay.floorPercent", o.floorPercent, { min: FLOOR_PERCENT_MIN, max: FLOOR_PERCENT_MAX });
    if (o.floorOpacity === undefined) o.floorOpacity = FLOOR_OPACITY_DEFAULT;
    p.num("overlay.floorOpacity", o.floorOpacity, { min: 0, max: 100 });
    // an overlay block written before Quality Levels (particleCap / fps, dropped below) has neither key: both mean Auto
    if (o.quality === undefined) o.quality = "auto";
    if (o.renderScale === undefined) o.renderScale = "1x"; // added with the 4K browser source
    if (!(o.renderScale === "1x" || o.renderScale === "1.5x" || o.renderScale === "2x")) {
      p.add(`overlay.renderScale: must be "1x", "1.5x" or "2x", got ${show(o.renderScale)}`);
    }
    if (o.webgl === undefined) o.webgl = "auto";
    if (!(o.quality === "auto" || (Number.isInteger(o.quality) && (o.quality as number) >= 1 && (o.quality as number) <= 5))) {
      p.add(`overlay.quality: must be 1..5 or "auto", got ${show(o.quality)}`);
    }
    p.oneOf("overlay.webgl", o.webgl, WEBGL_SETTINGS);
    for (const k of LEGACY_OVERLAY_KEYS) delete o[k];
  }

  if (p.list.length > 0) throw new ConfigError(p.list);
  return input as unknown as Config;
}

// ---------------------------------------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------------------------------------

const isBranch = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function walk(a: unknown, b: unknown, path: string, out: Diff[]): void {
  if (isBranch(a) && isBranch(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = Object.keys(a);
    for (const k of Object.keys(b)) if (!(k in a)) keys.push(k);
    for (const k of keys) walk(a[k], b[k], path === "" ? k : `${path}.${k}`, out);
    return;
  }
  if (!Object.is(a, b)) out.push({ path, from: a, to: b });
}

/** Leaf-level changes from `a` to `b` as dotted paths, in `a`'s key order (keys only in `b` follow). */
export function diffConfig(a: Config, b: Config): Diff[] {
  const out: Diff[] = [];
  walk(a, b, "", out);
  return out;
}
