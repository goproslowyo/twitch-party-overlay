import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config/schema.ts";
import { avatarFor as serverAvatarFor, fnv1a as serverFnv1a } from "../server/overlay.ts";
import { applyThemeVars, avatarFor, fnv1a } from "./theme.ts";

const theme = defaultConfig().themes["club-deck"]!;

describe("theme.ts", () => {
  test("applyThemeVars sets the ten CSS variables on the root", () => {
    const set: Record<string, string> = {};
    const root = { style: { setProperty: (name: string, value: string) => void (set[name] = value) } } as unknown as HTMLElement;
    applyThemeVars(theme, root);
    expect(set).toEqual({
      "--accent": theme.accent,
      "--accent2": theme.accent2,
      "--gold": theme.gold,
      "--panel": theme.panel,
      "--line": theme.line,
      "--t0": theme.tiers[0]!,
      "--t1": theme.tiers[1]!,
      "--t2": theme.tiers[2]!,
      "--bd1": theme.bd1,
      "--bd2": theme.bd2,
    });
  });

  test("avatarFor / fnv1a are the server's own functions (same name → same avatar on both ends)", () => {
    expect(avatarFor).toBe(serverAvatarFor);
    expect(fnv1a).toBe(serverFnv1a);
    expect(theme.avatars).toContain(avatarFor("alice", theme));
    expect(avatarFor("alice", theme)).toBe(avatarFor("alice", theme));
    expect(fnv1a("")).toBe(0x811c9dc5);
  });
});
