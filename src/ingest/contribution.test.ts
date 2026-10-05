import { test, expect } from "bun:test";
import { TWITCH_LOGIN, faceValueCents, exactCents, loginHintFor } from "./contribution.ts";

test("faceValueCents: gift is count × sticker price", () => {
  expect(faceValueCents({ kind: "gift", tier: "1000", count: 25 })).toBe(14975);
  expect(faceValueCents({ kind: "gift", tier: "2000", count: 2 })).toBe(1998);
});

test("faceValueCents: bits count 1¢ each at face", () => {
  expect(faceValueCents({ kind: "bits", bits: 500 })).toBe(500);
});

test("faceValueCents: tip is its cents; sub is the sticker price (prime = tier 1)", () => {
  expect(faceValueCents({ kind: "tip", cents: 1500 })).toBe(1500);
  expect(faceValueCents({ kind: "sub", tier: "1000" })).toBe(599);
  expect(faceValueCents({ kind: "sub", tier: "prime", months: 7 })).toBe(599);
  expect(faceValueCents({ kind: "sub", tier: "2000" })).toBe(999);
  expect(faceValueCents({ kind: "sub", tier: "3000" })).toBe(2499);
});

test("exactCents parses a decimal string into integer cents without floats", () => {
  expect(exactCents("3")).toBe(300);
  expect(exactCents("3.5")).toBe(350);
  expect(exactCents("3.00")).toBe(300);
  expect(exactCents("10.05")).toBe(1005);
  expect(exactCents("0.1")).toBe(10);
});

test("exactCents rejects sub-cent precision and malformed input", () => {
  expect(() => exactCents("3.499")).toThrow(RangeError);
  expect(() => exactCents("abc")).toThrow(RangeError);
  expect(() => exactCents("")).toThrow(RangeError);
  expect(() => exactCents("-3.00")).toThrow(RangeError);
});

test("loginHintFor: a Twitch-login-shaped name (4–16 of [a-z0-9_], leading letter, case-insensitive) → the lower-case login; anything else → undefined", () => {
  expect(TWITCH_LOGIN.source).toBe("^[a-z][a-z0-9_]{3,15}$");
  expect(loginHintFor("Styler")).toBe("styler");
  expect(loginHintFor("cool_user")).toBe("cool_user");
  expect(loginHintFor("  alice ")).toBe("alice");
  expect(loginHintFor("a".repeat(16))).toBe("a".repeat(16));
  for (const bad of ["Emma O'Connell PhD", "abc", "1abc", "_abc", "a".repeat(17), "cool-user", "cool.user", "", "   ", "@alice"]) expect(loginHintFor(bad)).toBeUndefined();
});
