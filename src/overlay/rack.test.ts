import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config/schema.ts";
import { LOCKED_GLYPH, type OverlayOutcome, type OverlaySkin } from "../server/overlay.ts";
import { DRAINED, LEGEND } from "./copy.ts";
import { createRack, rackSpec } from "./rack.ts";
import type { View } from "./state.ts";

const base = defaultConfig();
const club = base.themes["club-deck"]!;
const duck = base.themes["duck-farm"]!;
const skin = (theme = club): OverlaySkin => ({ config: base.overlay, theme, channelName: "dj", chatters: { windowMs: 900_000, dwellMs: 90_000, nameLength: 12 } });

/** The pool as the rack sees it: names masked above `tier`, like the hub projects and the model re-masks. */
function outcomes(tier: number, edit?: (o: OverlayOutcome) => void): OverlayOutcome[] {
  return base.outcomes.map((o) => {
    const open = o.tier <= tier;
    const out: OverlayOutcome = { id: o.id, name: open ? o.name : null, nameLength: o.name.length, glyph: open ? o.glyph : LOCKED_GLYPH, shape: o.shape, tier: o.tier, left: o.initialLeft, used: 0, status: "live" };
    edit?.(out);
    return out;
  });
}

function view(over: Partial<View> = {}): View {
  const tier = over.tier ?? 0;
  return { thresholdCents: 5000, progressDisplayCents: 1300, fullCount: 0, queue: 0, bankedTotal: 0, tier, gates: [0, 3, 6], outcomes: outcomes(tier), drained: false, justRevealed: [], motes: { collecting: [], ready: [] }, chatters: [], ...over };
}

describe("rackSpec — the rack panel as data", () => {
  test("the snapshot at $13 of $50: header, idle NOW, fader with 4 of 12 LEDs, legend, empty READY row, tier LEDs, 12 live rows + masked Tier 1/2 rows", () => {
    const s = rackSpec(view(), skin());
    expect(s.title).toBe("UNLOCKS");
    expect(s.menu).toBe("MENU");
    expect(s.now).toEqual({ cls: "", what: "COLLECTING…", who: "TIER 1 · 3 UNLOCKS AWAY" });
    expect(s.fader).toEqual({ amount: "$13", of: "of $50", full: false, leds: 4 });
    expect(s.legend).toEqual(LEGEND);
    expect(s.ready).toEqual({ label: "READY", seats: [], count: "0", more: "" });
    expect(s.tiers).toEqual([
      { tier: 0, color: club.tiers[0]!, on: true, next: false, label: "TIER 0 · 12", gate: "LIVE" },
      { tier: 1, color: club.tiers[1]!, on: false, next: true, label: "TIER 1 · 8", gate: "3 TO GO" },
      { tier: 2, color: club.tiers[2]!, on: false, next: false, label: "TIER 2 · 5", gate: "6 UNLOCKS AWAY" },
    ]);
    expect(s.drained).toBe(false);

    expect(s.stock.map((g) => [g.tier, g.locked, g.fresh, g.header, g.rows.length])).toEqual([
      [0, false, false, "TIER 0", 12],
      [1, true, false, "🔒 TIER 1 · 3 UNLOCKS AWAY", 8],
      [2, true, false, "🔒 TIER 2 · 6 UNLOCKS AWAY", 5],
    ]);
    const stickers = s.stock[0]!.rows[0]!;
    expect(stickers).toEqual({ id: "stickers", glyph: "🎟️", name: "STICKERS", masked: false, pips: [true, true, true, true, true], dead: false, fresh: false, compact: "×5", shape: club.shape.giveaway, color: club.tiers[0]! });
    expect(s.stock[0]!.rows[1]!.compact).toBe(""); // a stock of one needs no count
    const roulette = s.stock[1]!.rows.find((r) => r.id === "genre-roulette")!;
    expect(roulette).toEqual({ id: "genre-roulette", glyph: "🔒", name: "•".repeat(9), masked: true, pips: [true], dead: false, fresh: false, compact: "", shape: club.shape.challenge, color: club.tiers[1]! });
    expect(s.stock[1]!.rows.find((r) => r.id === "shirt-t1")).toMatchObject({ name: "•••", compact: "×2", pips: [true, true] }); // 5 letters → 3, the floor
    for (const row of [...s.stock[1]!.rows, ...s.stock[2]!.rows]) expect(row.name).toMatch(/^•+$/);
    expect(JSON.stringify(s)).not.toContain("PIE TO THE FACE");
  });

  test("a FULL hold: the fader pins at the threshold in gold with every LED lit and the stacked label", () => {
    const s = rackSpec(view({ progressDisplayCents: 5000, fullCount: 2 }), skin());
    expect(s.fader).toEqual({ amount: "$50", of: "of $50 · FULL ×2", full: true, leds: 12 });
    expect(rackSpec(view({ progressDisplayCents: 5000, fullCount: 1 }), skin()).fader.of).toBe("of $50 · FULL");
    expect(rackSpec(view({ progressDisplayCents: 0 }), skin()).fader.leds).toBe(0);
    expect(rackSpec(view({ progressDisplayCents: 4999 }), skin()).fader.leds).toBe(12);
  });

  test("READY: min(queue, 4) generic seats cycling the theme's avatars by index — never a contributor — and the count; NOW says how many are ready", () => {
    const s = rackSpec(view({ queue: 2, bankedTotal: 2 }), skin());
    expect(s.ready).toEqual({ label: "READY", seats: [{ avatar: club.avatars[0]! }, { avatar: club.avatars[1]! }], count: "2", more: "" });
    expect(s.now).toEqual({ cls: "", what: "2 UNLOCKS READY", who: "TIER 1 · 1 UNLOCK AWAY" });
    expect(s.tiers[1]!.gate).toBe("1 TO GO");

    const big = rackSpec(view({ queue: 8, bankedTotal: 8, tier: 2, outcomes: outcomes(2) }), skin());
    expect(big.ready.seats).toEqual(club.avatars.slice(0, 4).map((avatar) => ({ avatar })));
    expect(big.ready.count).toBe("8");
    expect(big.ready.more).toBe("+4"); // past four Passengers a "+N" text seat carries the rest — a count, never a name
    expect(JSON.stringify(big.ready)).not.toMatch(/ghost|@/);
    expect(rackSpec(view({ queue: 4, bankedTotal: 4 }), skin()).ready.more).toBe(""); // four seats, nobody over
    expect(rackSpec(view({ queue: 5, bankedTotal: 5 }), skin()).ready.more).toBe("+1");
    expect(rackSpec(view({ queue: 1, bankedTotal: 1 }), skin()).now.what).toBe("1 UNLOCK READY");
    const few = { ...club, avatars: ["🦆", "🐥", "🪿"] };
    expect(rackSpec(view({ queue: 4, bankedTotal: 4 }), skin(few)).ready.seats.map((s) => s.avatar)).toEqual(["🦆", "🐥", "🪿", "🦆"]);
    // the same Passengers as the gondola's, rotating one seat every 9 s of the loop's clock
    expect(rackSpec(view({ queue: 2, bankedTotal: 2 }), skin(), undefined, 9000).ready.seats).toEqual([{ avatar: club.avatars[1]! }, { avatar: club.avatars[2]! }]);
  });

  test("pips are used + left, the used ones dimmed first: used 2, left 3 → [off, off, on, on, on]; the compact count is what is left", () => {
    const s = rackSpec(view({ outcomes: outcomes(0, (o) => void (o.id === "stickers" && ((o.used = 2), (o.left = 3)))) }), skin());
    expect(s.stock[0]!.rows[0]).toMatchObject({ id: "stickers", dead: false, pips: [false, false, true, true, true], compact: "×3" });
    const masked = rackSpec(view({ outcomes: outcomes(0, (o) => void (o.id === "shirt-t1" && ((o.used = 1), (o.left = 1)))) }), skin());
    expect(masked.stock[1]!.rows.find((r) => r.id === "shirt-t1")).toMatchObject({ masked: true, pips: [true, true], compact: "×2" }); // a locked row shows its size, never its stock
  });

  test("a tier just revealed: its LED is live, its header wears JUST REVEALED, its rows are unmasked and fresh; the next tier counts from the new total", () => {
    const s = rackSpec(view({ tier: 1, bankedTotal: 3, queue: 3, justRevealed: [{ tier: 1, until: 30_000 }] }), skin());
    expect(s.tiers[1]).toMatchObject({ on: true, next: false, gate: "LIVE" });
    expect(s.tiers[2]).toMatchObject({ on: false, next: true, gate: "3 TO GO" });
    expect(s.stock[1]).toMatchObject({ locked: false, fresh: true, header: "TIER 1 · JUST REVEALED" });
    expect(s.stock[1]!.rows.every((r) => r.fresh && !r.masked)).toBe(true);
    expect(s.stock[1]!.rows.find((r) => r.id === "genre-roulette")).toMatchObject({ glyph: "🎲", name: "GENRE ROULETTE" });
    expect(s.stock[0]!.rows.every((r) => !r.fresh)).toBe(true);
    expect(s.stock[2]!.header).toBe("🔒 TIER 2 · 3 UNLOCKS AWAY");
    expect(s.now.who).toBe("TIER 2 · 3 UNLOCKS AWAY");
  });

  test("every tier open: no countdown anywhere; a used-up outcome is dead; the drained pool says so in the NOW box", () => {
    const s = rackSpec(view({ tier: 2, bankedTotal: 6, outcomes: outcomes(2, (o) => void ((o.used = o.left), (o.left = 0))), drained: true }), skin());
    expect(s.now).toEqual({ cls: "", what: "POOL DRAINED", who: "mods may restock" }); // the board's NOW; the full DRAINED line is the floor's, it does not fit the box
    expect(s.drained).toBe(true);
    expect(s.tiers.map((t) => t.gate)).toEqual(["LIVE", "LIVE", "LIVE"]);
    expect(s.stock.map((g) => g.header)).toEqual(["TIER 0", "TIER 1", "TIER 2"]);
    expect(s.stock[0]!.rows[0]).toMatchObject({ dead: true, pips: [false, false, false, false, false], compact: "×0" });
  });

  test("a NOW override (a landing) replaces the idle text for as long as the rack holds it", () => {
    const s = rackSpec(view(), skin(), { cls: "hit", what: "🎟️ STICKERS", who: "@alice · 4 LEFT" });
    expect(s.now).toEqual({ cls: "hit", what: "🎟️ STICKERS", who: "@alice · 4 LEFT" });
  });

  test("the theme is a skin: duck-farm words and colours, nothing else changes", () => {
    const s = rackSpec(view({ queue: 2, bankedTotal: 2 }), skin(duck));
    expect(s.title).toBe(duck.rackTitle);
    expect(s.ready.label).toBe("IN THE COOP");
    expect(s.now).toEqual({ cls: "", what: "2 SPLASHES READY", who: "POND 1 · 1 SPLASH AWAY" });
    expect(s.tiers[0]).toMatchObject({ label: "POND 0 · 12", color: duck.tiers[0]! });
    expect(s.tiers[2]!.gate).toBe("4 SPLASHES AWAY");
    expect(s.stock[1]!.header).toBe("🔒 POND 1 · 1 SPLASH AWAY");
    expect(s.stock[0]!.rows[0]!.shape).toBe(duck.shape.giveaway);
  });

  test("a suspended or retired outcome is a dead row (dimmed, no lit pips), never a live one; behind a locked tier it stays masked", () => {
    const s = rackSpec(view({ outcomes: outcomes(0, (o) => void (o.status = o.id === "stickers" ? "suspended" : o.id === "shirt-t0" ? "retired" : o.id === "genre-roulette" ? "suspended" : "live")) }), skin());
    expect(s.stock[0]!.rows.find((r) => r.id === "stickers")).toMatchObject({ dead: true, masked: false, name: "STICKERS", pips: [false, false, false, false, false] });
    expect(s.stock[0]!.rows.find((r) => r.id === "shirt-t0")).toMatchObject({ dead: true, masked: false, pips: [false] });
    expect(s.stock[0]!.rows.filter((r) => r.id !== "stickers" && r.id !== "shirt-t0").every((r) => !r.dead && r.pips.every(Boolean))).toBe(true);
    expect(s.stock[1]!.rows.find((r) => r.id === "genre-roulette")).toMatchObject({ masked: true, dead: false, pips: [true] });
    expect(s.tiers[0]!.label).toBe("TIER 0 · 12");
  });

  test("the vocabulary rule holds for every string the rack shows", () => {
    for (const v of [view(), view({ tier: 2, bankedTotal: 9, queue: 4, drained: true, outcomes: outcomes(2, (o) => void ((o.used = o.left), (o.left = 0))) })]) {
      expect(JSON.stringify(rackSpec(v, skin()))).not.toMatch(/\b(banked|spent)\b/i);
    }
  });
});

// ---- the DOM side: the fader must move on the frame after a plain contribution (task-99 MUST 4) --------------------

interface FakeEl {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  children: FakeEl[];
  classes: Set<string>;
  classList: { add(...c: string[]): void; remove(...c: string[]): void; toggle(c: string, on?: boolean): boolean };
  style: { setProperty(k: string, v: string): void };
  appendChild(child: FakeEl): FakeEl;
}

/** The least Document `createRack` needs: elements that remember their children, classes and text. */
function fakeRoot(): { root: HTMLElement; find: (cls: string) => FakeEl } {
  const createElement = (tag: string): FakeEl => {
    const classes = new Set<string>();
    let text = "";
    const el: FakeEl = {
      tag,
      id: "",
      get className() {
        return [...classes].join(" ");
      },
      set className(v: string) {
        classes.clear();
        for (const c of v.split(/\s+/)) if (c !== "") classes.add(c);
      },
      get textContent() {
        return text;
      },
      set textContent(v: string) {
        text = v;
        if (v === "") el.children.length = 0; // as the DOM does: setting text drops the children
      },
      children: [],
      classes,
      classList: { add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)), toggle: (c, on) => ((on ?? !classes.has(c)) ? (classes.add(c), true) : (classes.delete(c), false)) },
      style: { setProperty: () => undefined },
      appendChild(child) {
        el.children.push(child);
        return child;
      },
    };
    return el;
  };
  const doc = { createElement, createTextNode: (text: string) => ({ ...createElement("#text"), textContent: text }) };
  const root = { ...createElement("div"), ownerDocument: doc };
  const find = (cls: string): FakeEl => {
    const walk = (el: FakeEl): FakeEl | null => {
      if (el.classes.has(cls)) return el;
      for (const c of el.children) {
        const hit = walk(c);
        if (hit !== null) return hit;
      }
      return null;
    };
    const hit = walk(root);
    if (hit === null) throw new Error(`no .${cls}`);
    return hit;
  };
  return { root: root as unknown as HTMLElement, find };
}

describe("createRack — the fader follows the model on the next step after a contribution (MUST 4)", () => {
  test("celebrate() marks the rack dirty: a plain (non-crossing) tip re-renders the amount on the following step, not seconds later when the glow ends", () => {
    const { root, find } = fakeRoot();
    let v = view({ progressDisplayCents: 0 });
    const rack = createRack(root, () => v, () => skin());
    rack.step(0);
    expect(find("amt").textContent).toBe("$0");
    // alice tips $3: the model's view is already right (progressDisplayCents 300) and the `celebrate` effect reaches the rack …
    v = view({ progressDisplayCents: 300 });
    rack.celebrate(0.05, 100);
    rack.step(116);
    // … so the fader reads $3 within a frame, not `$0 of $50` under a `$3` thank line
    expect(find("amt").textContent).toBe("$3");
    expect(find("of").textContent).toBe("of $50");
    expect(find("rk-panel").classes.has("cel1")).toBe(true);
  });

  test("the READY row's +N seat is in the DOM only past four Passengers", () => {
    const { root, find } = fakeRoot();
    let v = view({ queue: 6, bankedTotal: 6, tier: 2, outcomes: outcomes(2) });
    const rack = createRack(root, () => v, () => skin());
    rack.step(0);
    expect(find("qrow").children.map((c) => [c.className, c.textContent])).toEqual([...Array.from({ length: 4 }, (_, i) => ["j", club.avatars[i]!]), ["more", "+2"], ["n", "6"]]);
    v = view({ queue: 2, bankedTotal: 2 });
    rack.invalidate();
    rack.step(16);
    expect(find("qrow").children.map((c) => c.className)).toEqual(["j", "j", "n"]);
  });
});
