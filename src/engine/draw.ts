/**
 * The Fire draw: server-authoritative and auditable. Weights are the stock left; `roll = rng()` in
 * [0, 1); the pick is the first Outcome whose cumulative weight / total exceeds the roll. Pure — the caller records `roll`
 * in the `fire` entry so replay never re-rolls.
 */
import { EngineError, type OutcomeState } from "./state.ts";

export interface Draw {
  outcome: OutcomeState;
  roll: number;
}

export function draw(live: readonly OutcomeState[], rng: () => number): Draw {
  const total = live.reduce((sum, o) => sum + o.left, 0);
  if (total <= 0) throw new EngineError("POOL_DRAINED", "no live outcome has stock left");
  const roll = rng();
  let cumulative = 0;
  let last: OutcomeState | undefined;
  for (const outcome of live) {
    if (outcome.left <= 0) continue;
    cumulative += outcome.left;
    if (cumulative / total > roll) return { outcome, roll };
    last = outcome;
  }
  return { outcome: last!, roll }; // only when rng broke its contract (roll >= 1): the last Outcome with stock left
}
