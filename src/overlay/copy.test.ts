import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../config/schema.ts";
import type { ContributionSource, Face } from "../ingest/contribution.ts";
import { COLLECTING, DONE, DRAINED, DRAINED_NOW, DRAINED_STINGER, EVERY_TIER_OPEN, EXIT, LEGEND, LIVE, MENU, NOW, SHUFFLING, bigMoment, handle, miniDrawTitle, compactCount, esc, faderOf, fullLabel, gateText, landingBanner, landingWho, lockedTile, maskedName, money, nextUnlockLabel, nowGate, readyLabel, revealCounter, stockHeader, thankLine, tierOpenStinger, tierRow, tierName, unlockStinger, unlocksAway, unlocksReady, whatText } from "./copy.ts";

const themes = defaultConfig().themes;
const club = themes["club-deck"]!;
const duck = themes["duck-farm"]!;

describe("money", () => {
  test.each([
    [5000, "$50"],
    [450, "$4.50"],
    [100000, "$1,000"],
    [7, "$0.07"],
    [0, "$0"],
    [123456789, "$1,234,567.89"],
  ])("%d → %s", (cents, text) => {
    expect(money(cents)).toBe(text);
  });
});

describe("whatText — the acknowledgement's {what}", () => {
  const cases: Array<[string, Face, ContributionSource, string]> = [
    ["StreamElements tip, whole dollars", { kind: "tip", cents: 1500 }, "streamelements", "tipped $15"],
    ["StreamElements tip with cents", { kind: "tip", cents: 450 }, "streamelements", "tipped $4.50"],
    ["Ko-fi", { kind: "tip", cents: 1000 }, "kofi", "donated $10 on Ko-fi"],
    ["manual tip uses the tip wording", { kind: "tip", cents: 2000 }, "manual", "tipped $20"],
    ["bits", { kind: "bits", bits: 500 }, "twitch", "cheered 500 bits"],
    ["bits with a thousands separator", { kind: "bits", bits: 10000 }, "twitch", "cheered 10,000 bits"],
    ["one bit", { kind: "bits", bits: 1 }, "twitch", "cheered 1 bit"],
    ["tier 1 sub", { kind: "sub", tier: "1000" }, "twitch", "subscribed"],
    ["prime sub", { kind: "sub", tier: "prime" }, "twitch", "subscribed with Prime"],
    ["tier 2 sub", { kind: "sub", tier: "2000" }, "twitch", "subscribed at Tier 2"],
    ["tier 3 sub", { kind: "sub", tier: "3000" }, "twitch", "subscribed at Tier 3"],
    ["first month is not a resub", { kind: "sub", tier: "1000", months: 1 }, "twitch", "subscribed"],
    ["resub", { kind: "sub", tier: "1000", months: 7 }, "twitch", "resubscribed (7 months)"],
    ["resub at tier 2", { kind: "sub", tier: "2000", months: 7 }, "twitch", "resubscribed (7 months) at Tier 2"],
    ["prime resub", { kind: "sub", tier: "prime", months: 3 }, "twitch", "resubscribed (3 months)"],
    ["gift bomb", { kind: "gift", tier: "1000", count: 25 }, "twitch", "gifted 25 subs"],
    ["single gift", { kind: "gift", tier: "1000", count: 1 }, "twitch", "gifted 1 sub"],
    ["gifts at tier 2", { kind: "gift", tier: "2000", count: 5 }, "twitch", "gifted 5 subs at Tier 2"],
    ["manual gift credit uses the gift wording", { kind: "gift", tier: "3000", count: 2 }, "manual", "gifted 2 subs at Tier 3"],
  ];
  test.each(cases)("%s", (_label, face, source, text) => {
    expect(whatText(face, source)).toBe(text);
  });
});

describe("thankLine", () => {
  const PIC = "https://static-cdn.jtvnw.net/jtv_user_pictures/aaaa-profile_image-150x150.png";
  test("named, no picture: ✦ {avatar} @{name} {what} — thank you ✦", () => {
    const { html } = thankLine("alice", "🎧", null, "tipped $15", 0.42);
    expect(html).toBe("✦ 🎧 <b>@alice</b> tipped $15 — thank you ✦");
  });
  test("✦✦ above 0.6, ✦ at exactly 0.6", () => {
    expect(thankLine("alice", "🎧", null, "gifted 25 subs", 0.78).html).toBe("✦✦ 🎧 <b>@alice</b> gifted 25 subs — thank you ✦✦");
    expect(thankLine("alice", "🎧", null, "tipped $40", 0.6).html).toStartWith("✦ 🎧");
  });
  test("anonymous: Anonymous {what}, no @", () => {
    const { html } = thankLine(null, "🥁", null, "cheered 500 bits", 0.25);
    expect(html).toBe("✦ 🥁 <b>Anonymous</b> cheered 500 bits — thank you ✦");
    expect(html).not.toContain("@");
  });
  test("with an Avatar Picture: <img class=\"pic\" src data-glyph alt=\"\"> takes the glyph's place; the glyph rides along as data for the onerror swap and appears nowhere as text", () => {
    const { html } = thankLine("alice", "🎧", PIC, "tipped $15", 0.3);
    expect(html).toBe(`✦ <img class="pic" src="${PIC}" data-glyph="🎧" alt=""> <b>@alice</b> tipped $15 — thank you ✦`);
    expect(html.replace(/<img[^>]*>/, "")).not.toContain("🎧");
    expect(html).not.toContain("onerror"); // no inline JS: alerts.ts owns the fallback
    expect(thankLine("alice", "🎧", PIC, "gifted 25 subs", 0.9).html).toStartWith("✦✦ <img");
  });
  test("the picture URL is escaped, and only an https URL on the Twitch CDN is ever put in a src (anything else falls back to the glyph)", () => {
    const { html } = thankLine("alice", "🎧", 'https://static-cdn.jtvnw.net/a.png"><script>alert(1)</script>', "tipped $1", 0);
    expect(html).not.toContain("<script");
    expect(html).toContain('src="https://static-cdn.jtvnw.net/a.png&quot;&gt;&lt;script&gt;');
    for (const bad of ["javascript:alert(1)", "http://static-cdn.jtvnw.net/a.png", "https://x.test/a.png", "https://static-cdn.jtvnw.net.evil.test/a.png", "https://evil.test/static-cdn.jtvnw.net/a.png", "data:image/png;base64,AAAA", ""]) {
      expect(thankLine("alice", "🎧", bad, "tipped $1", 0).html).toBe("✦ 🎧 <b>@alice</b> tipped $1 — thank you ✦");
    }
  });
  test("anonymous never gets a picture even if one were passed (the server never does; the glyph stays as today)", () => {
    expect(thankLine(null, "🥁", PIC, "cheered 500 bits", 0.25).html).toBe("✦ 🥁 <b>Anonymous</b> cheered 500 bits — thank you ✦");
  });
  test("the name is HTML-escaped", () => {
    const { html } = thankLine('<img src=x onerror="alert(1)">', "🎧", null, "tipped $1", 0);
    expect(html).not.toContain("<img");
    expect(html).toContain("@&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
  test("esc covers the five HTML metacharacters", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(esc("plain — text ✦")).toBe("plain — text ✦");
  });
});

describe("stingers, labels, banners", () => {
  test("unlockStinger splits big over sub as the Unlock board does: `+1 UNLOCK` / `READY TO DROP`; stacked, the sub says how many came at once", () => {
    expect(unlockStinger(1)).toEqual({ big: "+1 UNLOCK", sub: "READY TO DROP" });
    expect(unlockStinger(3)).toEqual({ big: "+3 UNLOCKS", sub: "3 UNLOCKS EARNED IN ONE MOMENT · READY TO DROP" });
    expect(unlockStinger(2).big.length).toBeLessThan(12); // one 88 px line across the towers, never two
  });
  test("the drained stinger and NOW box (MUST 3 / SHOULD 5): `POOL DRAINED` big over the board's sub; the rack says `POOL DRAINED` / `mods may restock`, nothing to truncate", () => {
    expect(DRAINED_STINGER).toEqual({ big: "POOL DRAINED", sub: "EVERY OUTCOME PAID OUT · THE CROWD DID IT · MODS MAY RESTOCK" });
    expect(DRAINED_NOW).toEqual({ what: "POOL DRAINED", who: "mods may restock" });
  });
  test("fullLabel", () => {
    expect(fullLabel(1)).toBe("FULL");
    expect(fullLabel(3)).toBe("FULL ×3");
    expect(`${money(5000)} of ${money(5000)} · ${fullLabel(1)}`).toBe("$50 of $50 · FULL");
  });
  test("tierOpenStinger uses the theme's tier label", () => {
    expect(tierOpenStinger(1, 10, club)).toEqual({ big: "TIER 1 OPEN", sub: "10 OUTCOMES JUST REVEALED" });
    expect(tierOpenStinger(2, 1, club)).toEqual({ big: "TIER 2 OPEN", sub: "1 OUTCOME JUST REVEALED" });
    expect(tierOpenStinger(1, 10, duck).big).toBe("POND 1 OPEN");
  });
  test("gateText", () => {
    expect(gateText(3)).toBe("3 TO GO");
    expect(gateText(1)).toBe("1 TO GO");
  });
  test("landingBanner: {glyph} {NAME} with k LEFT, DONE at zero", () => {
    expect(landingBanner({ glyph: "🥧", name: "PIE TO THE FACE" }, 0)).toEqual({ big: "🥧 PIE TO THE FACE", sub: "DONE" });
    expect(landingBanner({ glyph: "🎟️", name: "STICKERS" }, 4)).toEqual({ big: "🎟️ STICKERS", sub: "4 LEFT" });
    expect(landingBanner({ glyph: "👕", name: "SHIRT" }, 1).sub).toBe("1 LEFT");
  });
  test("revealCounter", () => {
    expect(revealCounter(2, 3)).toBe("REVEAL 2 OF 3");
  });
  test("lockedTile: 🔒 · TIER n · k HIDDEN over m UNLOCKS AWAY; the theme's tier label when given", () => {
    expect(lockedTile(2, 5, 3)).toEqual({ big: "🔒 · TIER 2 · 5 HIDDEN", sub: "3 UNLOCKS AWAY" });
    expect(lockedTile(1, 1, 1)).toEqual({ big: "🔒 · TIER 1 · 1 HIDDEN", sub: "1 UNLOCK AWAY" });
    expect(lockedTile(2, 5, 3, duck).big).toBe("🔒 · POND 2 · 5 HIDDEN");
  });
  test("bigMoment: the handle uppercased over a kind word · THANK YOU — amounts belong to the acknowledgement line only", () => {
    const cases: Array<[string, string | null, Face, ContributionSource, { big: string; sub: string }]> = [
      ["StreamElements tip", "alice", { kind: "tip", cents: 10000 }, "streamelements", { big: "@ALICE", sub: "TIPPED · THANK YOU" }],
      ["Ko-fi", "bob", { kind: "tip", cents: 1000 }, "kofi", { big: "@BOB", sub: "DONATED ON KO-FI · THANK YOU" }],
      ["anonymous bits", null, { kind: "bits", bits: 10000 }, "twitch", { big: "ANONYMOUS", sub: "CHEERED · THANK YOU" }],
      ["prime sub", "cara", { kind: "sub", tier: "prime" }, "twitch", { big: "@CARA", sub: "SUBSCRIBED · THANK YOU" }],
      ["first month at tier 2 is a sub", "cara", { kind: "sub", tier: "2000", months: 1 }, "twitch", { big: "@CARA", sub: "SUBSCRIBED · THANK YOU" }],
      ["resub", "dan", { kind: "sub", tier: "1000", months: 7 }, "twitch", { big: "@DAN", sub: "RESUBSCRIBED · THANK YOU" }],
      ["gift bomb at tier 2", "eve", { kind: "gift", tier: "2000", count: 25 }, "twitch", { big: "@EVE", sub: "GIFTED SUBS · THANK YOU" }],
      ["manual tip credit uses the tip wording (Ko-fi wording is for source kofi only)", "fay", { kind: "tip", cents: 2000 }, "manual", { big: "@FAY", sub: "TIPPED · THANK YOU" }],
      ["manual gift credit uses the gift wording", "gus", { kind: "gift", tier: "3000", count: 2 }, "manual", { big: "@GUS", sub: "GIFTED SUBS · THANK YOU" }],
    ];
    for (const [label, name, face, source, expected] of cases) {
      const got = bigMoment(name, face, source);
      expect([label, got]).toEqual([label, expected]);
      expect(got.big).not.toMatch(/\d/);
      expect(got.sub).not.toMatch(/\d/);
    }
  });
  test("constants", () => {
    expect(DRAINED).toBe("POOL DRAINED — THE CROWD DID IT");
    expect(SHUFFLING).toBe("🔀 SHUFFLING THE PADS");
    expect(LEGEND).toEqual(["TIPS · BITS count in full", "SUBS count what the streamer keeps, not the sticker"]);
  });
});

describe("rack copy — the panel's labels, all from here", () => {
  test("fixed labels", () => {
    expect(MENU).toBe("MENU");
    expect(NOW).toBe("NOW");
    expect(LIVE).toBe("LIVE");
    expect(COLLECTING).toBe("COLLECTING…");
    expect(EVERY_TIER_OPEN).toBe("EVERY TIER OPEN");
  });

  test("theme words: NEXT UNLOCK / NEXT SPLASH; READY / IN THE COOP", () => {
    expect(nextUnlockLabel(club)).toBe("NEXT UNLOCK");
    expect(nextUnlockLabel(duck)).toBe("NEXT SPLASH");
    expect(readyLabel(club)).toBe("READY");
    expect(readyLabel(duck)).toBe("IN THE COOP");
  });

  test("faderOf: `of $50`, `of $50 · FULL`, `of $50 · FULL ×2`", () => {
    expect(faderOf(5000, 0)).toBe("of $50");
    expect(faderOf(5000, 1)).toBe("of $50 · FULL");
    expect(faderOf(3500, 3)).toBe("of $35 · FULL ×3");
  });

  test("tier rows and gates: `TIER 1 · 8`, `3 UNLOCKS AWAY` / `1 SPLASH AWAY`", () => {
    expect(tierRow(1, 8, club)).toBe("TIER 1 · 8");
    expect(tierRow(0, 12, duck)).toBe("POND 0 · 12");
    expect(unlocksAway(3, club)).toBe("3 UNLOCKS AWAY");
    expect(unlocksAway(1, duck)).toBe("1 SPLASH AWAY");
  });

  test("stock headers: open, just revealed, locked with the countdown", () => {
    expect(stockHeader(0, club, { kind: "open", fresh: false })).toBe("TIER 0");
    expect(stockHeader(1, club, { kind: "open", fresh: true })).toBe("TIER 1 · JUST REVEALED");
    expect(stockHeader(2, club, { kind: "locked", away: 6 })).toBe("🔒 TIER 2 · 6 UNLOCKS AWAY");
    expect(stockHeader(1, duck, { kind: "locked", away: 1 })).toBe("🔒 POND 1 · 1 SPLASH AWAY");
  });

  test("the NOW box: `2 UNLOCKS READY`, `TIER 1 · 3 UNLOCKS AWAY`; a landing names nobody (`4 LEFT`) unless one person crossed alone (`@alice · 4 LEFT`)", () => {
    expect(unlocksReady(1, club)).toBe("1 UNLOCK READY");
    expect(unlocksReady(2, duck)).toBe("2 SPLASHES READY");
    expect(nowGate(1, 3, club)).toBe("TIER 1 · 3 UNLOCKS AWAY");
    expect(landingWho(null, "4 LEFT")).toBe("4 LEFT");
    expect(landingWho("alice", "4 LEFT")).toBe("@alice · 4 LEFT");
    expect(landingWho(null, "DONE")).toBe("DONE"); // never "Anonymous" on a landing: the crowd did it
  });

  test("maskedName hides a name at ~its real length (3–14 dots); the compact count: ×N (there is no +N seat)", () => {
    expect(maskedName("SHIRT".length)).toBe("•••");
    expect(maskedName("GENRE ROULETTE".length)).toBe("•••••••••");
    expect(maskedName("ONE HAND BEHIND THE BACK".length)).toBe("••••••••••••••");
    expect(compactCount(5)).toBe("×5");
  });
});

describe("the scene — every word the canvas paints", () => {
  test("DONE is the used-up pad's tag and the landing banner's zero line; EXIT is the gondola door's sign", () => {
    expect(DONE).toBe("DONE");
    expect(landingBanner({ glyph: "🥧", name: "PIE TO THE FACE" }, 0).sub).toBe(DONE);
    expect(EXIT).toBe("EXIT");
  });

  test("tierName: the theme's tier label with the number filled in — the tower captions", () => {
    expect(tierName(0, club)).toBe("TIER 0");
    expect(tierName(2, duck)).toBe("POND 2");
  });
});

describe("the drop's strings", () => {
  test("handle: @name, Anonymous without one — the thank line and the big-text moment only; never over a jumper", () => {
    expect(handle("bassline_bea")).toBe("@bassline_bea");
    expect(handle(null)).toBe("Anonymous");
    expect(bigMoment(null, { kind: "gift", tier: "1000", count: 25 }, "twitch").big).toBe(handle(null).toUpperCase());
  });

  test("miniDrawTitle: the reel's title from the server's draw title", () => {
    expect(miniDrawTitle("🎲", "GENRE ROULETTE · 10–15 MIN")).toBe("🎲 GENRE ROULETTE · 10–15 MIN — DRAWING FROM THE LIST");
  });
});
