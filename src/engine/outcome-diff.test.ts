import { test, expect } from "bun:test";
import type { OutcomeDef } from "../config/schema.ts";
import { EDITABLE_FIELDS, outcomeChanges, slugId } from "./outcome-diff.ts";

const def = (extra: Partial<OutcomeDef> = {}): OutcomeDef => ({ id: "stickers", name: "STICKERS", glyph: "🎟️", shape: "giveaway", tier: 0, initialLeft: 5, restockable: false, occupancy: "instant", description: "A chat raffle for a sticker pack.", raffle: true, ...extra });

test("EDITABLE_FIELDS are the definition fields the editor may change — never id or initialLeft", () => {
  expect([...EDITABLE_FIELDS]).toEqual(["name", "glyph", "shape", "tier", "occupancy", "description", "restockable", "miniDraw", "raffle"]);
});

test("outcomeChanges: {} for identical defs; only the fields that differ, as {from, to}", () => {
  expect(outcomeChanges(def(), def())).toEqual({});
  expect(outcomeChanges(def(), def({ tier: 1 }))).toEqual({ tier: { from: 0, to: 1 } });
  expect(outcomeChanges(def(), def({ name: "STICKER PACK", restockable: true }))).toEqual({ name: { from: "STICKERS", to: "STICKER PACK" }, restockable: { from: false, to: true } });
  expect(outcomeChanges(def(), def({ miniDraw: "genreRoulette" }))).toEqual({ miniDraw: { from: undefined, to: "genreRoulette" } });
  expect(outcomeChanges(def(), def({ description: "" }))).toEqual({ description: { from: "A chat raffle for a sticker pack.", to: "" } });
});

test("outcomeChanges ignores id and initialLeft, and treats raffle undefined / false and a missing miniDraw / undefined as equal", () => {
  expect(outcomeChanges(def(), def({ id: "other", initialLeft: 99 }))).toEqual({});
  const noRaffle = def();
  delete noRaffle.raffle;
  expect(outcomeChanges(noRaffle, def({ raffle: false }))).toEqual({});
  expect(outcomeChanges(def({ raffle: false }), noRaffle)).toEqual({});
  expect(outcomeChanges(noRaffle, def({ raffle: true }))).toEqual({ raffle: { from: undefined, to: true } });
  expect(outcomeChanges(def(), def({ miniDraw: undefined }))).toEqual({});
});

test("slugId: lower-case kebab from the name, 'outcome' when nothing is left, -2 / -3 … until free", () => {
  expect(slugId("Vinyl Only!", new Set())).toBe("vinyl-only");
  expect(slugId("Vinyl Only", new Set(["vinyl-only"]))).toBe("vinyl-only-2");
  expect(slugId("Vinyl Only", new Set(["vinyl-only", "vinyl-only-2"]))).toBe("vinyl-only-3");
  expect(slugId("", new Set())).toBe("outcome");
  expect(slugId("!!!", new Set(["outcome"]))).toBe("outcome-2");
  expect(slugId("  ALIEN COSTUME · 30 MIN  ", new Set())).toBe("alien-costume-30-min");
  expect(slugId("Café Crème", new Set())).toBe("cafe-creme");
  expect(slugId("10 TRACKS IN 10 MIN", new Set())).toBe("10-tracks-in-10-min");
});
