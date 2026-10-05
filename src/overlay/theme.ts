/**
 * Theme → DOM: a Theme is a pure skin, so applying one is writing its colours to CSS variables on the
 * root; nothing in the overlay branches on which theme it is. `avatarFor` / `fnv1a` are the server's own functions,
 * re-exported so the client picks the same avatar for the same name as the server does for a contribution.
 */
import type { Theme } from "../config/schema.ts";

export { avatarFor, fnv1a } from "../server/overlay.ts";

const COLOR_VARS: ReadonlyArray<readonly [string, keyof Pick<Theme, "accent" | "accent2" | "gold" | "panel" | "line" | "bd1" | "bd2">]> = [
  ["--accent", "accent"],
  ["--accent2", "accent2"],
  ["--gold", "gold"],
  ["--panel", "panel"],
  ["--line", "line"],
  ["--bd1", "bd1"],
  ["--bd2", "bd2"],
];

/** Set `--accent --accent2 --gold --panel --line --t0 --t1 --t2 --bd1 --bd2` (one `--t<n>` per tier colour) on `root`. */
export function applyThemeVars(theme: Theme, root: HTMLElement): void {
  for (const [name, key] of COLOR_VARS) root.style.setProperty(name, theme[key]);
  theme.tiers.forEach((color, n) => root.style.setProperty(`--t${n}`, color));
}
