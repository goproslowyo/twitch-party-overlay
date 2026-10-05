import { test, expect } from "bun:test";
import { draw } from "./draw.ts";
import { EngineError, type OutcomeState } from "./state.ts";

/** A live OutcomeState with the given stock left. */
function o(id: string, left: number): OutcomeState {
  return { id, name: id.toUpperCase(), glyph: "x", shape: "challenge", tier: 0, initialLeft: left, left, used: 0, restockable: true, occupancy: "instant", description: "", status: "live" };
}

test("draw is proportional to the stock left", () => {
  const live = [o("a", 5), o("b", 1)];
  expect(draw(live, () => 0.0).outcome.id).toBe("a"); expect(draw(live, () => 0.83).outcome.id).toBe("a"); expect(draw(live, () => 0.84).outcome.id).toBe("b");
});

test("draw records the roll it used and calls rng exactly once", () => {
  let calls = 0;
  const r = draw([o("a", 1), o("b", 1)], () => { calls++; return 0.5; });
  expect(r).toMatchObject({ roll: 0.5, outcome: { id: "b" } });
  expect(calls).toBe(1);
});

test("draw over a pool with nothing left is POOL_DRAINED", () => {
  let caught: unknown; try { draw([o("a", 0)], () => 0.0); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(EngineError); expect((caught as EngineError).code).toBe("POOL_DRAINED");
  expect(() => draw([], () => 0.0)).toThrow(/^POOL_DRAINED/);
});
