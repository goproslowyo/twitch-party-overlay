import { test, expect } from "bun:test";
import { defaultConfig, type Config } from "../config/schema.ts";
import type { Face } from "../ingest/contribution.ts";
import { progressCents } from "./policy.ts";

type Policy = Config["policy"];

function policy(overrides: Partial<Policy> = {}): Policy {
  return { ...defaultConfig().policy, ...overrides };
}

/** Expected values are the agreed rate table (the Conversion Policy as decided), not a restatement of the formula. */
const table: Array<{ name: string; face: Face; policy: Policy; expected: number }> = [
  { name: "tip 1500", face: { kind: "tip", cents: 1500 }, policy: policy(), expected: 1500 },
  { name: "tip 50 (a $0.50 gigantify-sized tip)", face: { kind: "tip", cents: 50 }, policy: policy(), expected: 50 },
  { name: "bits 500", face: { kind: "bits", bits: 500 }, policy: policy(), expected: 500 },
  { name: "bits 10000", face: { kind: "bits", bits: 10000 }, policy: policy(), expected: 10000 },
  { name: "bits 1", face: { kind: "bits", bits: 1 }, policy: policy(), expected: 1 },
  { name: "sub 1000", face: { kind: "sub", tier: "1000" }, policy: policy(), expected: 200 },
  { name: "sub prime", face: { kind: "sub", tier: "prime" }, policy: policy(), expected: 200 },
  { name: "sub 2000", face: { kind: "sub", tier: "2000" }, policy: policy(), expected: 350 },
  { name: "sub 3000", face: { kind: "sub", tier: "3000" }, policy: policy(), expected: 875 },
  { name: "gift 1000 × 25", face: { kind: "gift", tier: "1000", count: 25 }, policy: policy(), expected: 5000 },
  { name: "gift 2000 × 3", face: { kind: "gift", tier: "2000", count: 3 }, policy: policy(), expected: 1050 },
  { name: "bits 1000 with bitsCentsPer100: 75", face: { kind: "bits", bits: 1000 }, policy: policy({ bitsCentsPer100: 75 }), expected: 750 },
  { name: "tip 1000 with tipPercent: 90", face: { kind: "tip", cents: 1000 }, policy: policy({ tipPercent: 90 }), expected: 900 },
];

for (const row of table) {
  test(`progressCents: ${row.name} → ${row.expected}`, () => {
    expect(progressCents(row.face, row.policy)).toBe(row.expected);
  });
}

test("progressCents: Progress is always an integer number of cents", () => {
  expect(progressCents({ kind: "tip", cents: 1 }, policy({ tipPercent: 90 }))).toBe(1);
  expect(progressCents({ kind: "bits", bits: 1 }, policy({ bitsCentsPer100: 75 }))).toBe(1);
  expect(progressCents({ kind: "bits", bits: 1 }, policy({ bitsCentsPer100: 49 }))).toBe(0);
});
