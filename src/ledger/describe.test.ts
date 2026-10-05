import { test, expect } from "bun:test";
import type { Entry, EntryType } from "./types.ts";
import { describeEntryFull, describeEntry, entryLine, type DescribeContext, DESCRIPTION_SHOWN, MESSAGE_CLIP } from "./describe.ts";

const TS = "2026-09-12T20:00:00.000Z";
const entry = <T extends EntryType>(seq: number, type: T, actor: string, payload: Entry<T>["payload"]): Entry<T> => ({ seq, ts: TS, type, actor, payload });

const tip = (seq: number, displayName: string | null, cents: number, extra: Partial<Entry<"contribution">["payload"]> = {}) =>
  entry(seq, "contribution", "system:streamelements", {
    source: "streamelements",
    sourceId: `se:${seq}`,
    face: { kind: "tip", cents },
    displayName,
    anonymous: displayName === null,
    occurredAt: TS,
    progressCents: cents,
    policyVersion: 1,
    ...extra,
  });

const outcomes: Record<string, { name: string; glyph: string }> = {
  spotlight: { name: "ARTIST SPOTLIGHT", glyph: "🎤" },
  pie: { name: "PIE TO THE FACE", glyph: "🥧" },
  stickers: { name: "STICKERS", glyph: "🎟️" },
  "vinyl-only": { name: "VINYL ONLY", glyph: "💿" },
};
const ctx: DescribeContext = { outcome: (id) => outcomes[id] };

test("contribution: @name + the face wording (whatText), the credited cents, the fader position and the Unlocks it banked", () => {
  expect(describeEntry(tip(143, "dana", 1000), { progressCents: 2300, thresholdCents: 5000 })).toBe("@dana tipped $10 (+$10) → $23 of $50");
  expect(describeEntry(tip(143, "dana", 1000), { progressCents: 300, thresholdCents: 5000, unlocks: 2 })).toBe("@dana tipped $10 (+$10) → $3 of $50 · +2 UNLOCKS");
  expect(describeEntry(tip(143, "dana", 1000), { progressCents: 300, thresholdCents: 5000, unlocks: 1 })).toBe("@dana tipped $10 (+$10) → $3 of $50 · +1 UNLOCK");
  expect(describeEntry(tip(143, "dana", 1000))).toBe("@dana tipped $10 (+$10)"); // no fader position known: none printed
});

test("contribution: anonymous, a message (clipped), Ko-fi / bits / sub / gift faces, credited cents that differ from the face", () => {
  expect(describeEntry(tip(1, null, 500))).toBe("Anonymous tipped $5 (+$5)");
  expect(describeEntry(tip(1, "dana", 1000, { message: "Ko-fi" }))).toBe("@dana tipped $10 (+$10) · Ko-fi");
  expect(describeEntry(tip(1, "dana", 1000, { message: "x".repeat(100) }))).toBe(`@dana tipped $10 (+$10) · ${"x".repeat(79)}…`);
  expect(describeEntry(tip(1, "dana", 1000, { source: "kofi" }))).toBe("@dana donated $10 on Ko-fi (+$10)");
  expect(describeEntry(tip(1, "dana", 0, { source: "twitch", face: { kind: "bits", bits: 500 }, progressCents: 500 }))).toBe("@dana cheered 500 bits (+$5)");
  expect(describeEntry(tip(1, "dana", 0, { source: "twitch", face: { kind: "sub", tier: "2000" }, progressCents: 250 }))).toBe("@dana subscribed at Tier 2 (+$2.50)");
  expect(describeEntry(tip(1, "dana", 0, { source: "twitch", face: { kind: "sub", tier: "1000", months: 5 }, progressCents: 250 }))).toBe("@dana resubscribed (5 months) (+$2.50)");
  expect(describeEntry(tip(1, "dana", 0, { source: "twitch", face: { kind: "gift", tier: "1000", count: 5 }, progressCents: 1250 }))).toBe("@dana gifted 5 subs (+$12.50)");
});

test("void, rebank, restock, outcome_status, queue_adjust, threshold, config_change, auth_failure, note", () => {
  expect(describeEntry(entry(145, "void", "twitch:sam", { contributionSeq: 143, reason: "tip denied by StreamElements moderation" }))).toBe("voided #143 (tip denied by StreamElements moderation)");
  expect(describeEntry(entry(146, "rebank", "twitch:sam", { fireSeq: 144, reason: "guest not up for it" }))).toBe("re-queued fire #144 (guest not up for it)");
  expect(describeEntry(entry(1, "restock", "twitch:sam", { outcomeId: "pie", charges: 3 }), ctx)).toBe("+3 PIE TO THE FACE");
  expect(describeEntry(entry(1, "restock", "twitch:sam", { outcomeId: "gone", charges: 3 }), ctx)).toBe("+3 gone"); // an Outcome no longer in config: its id
  expect(describeEntry(entry(1, "outcome_status", "twitch:sam", { outcomeId: "pie", status: "suspended" }), ctx)).toBe("PIE TO THE FACE → suspended");
  expect(describeEntry(entry(1, "queue_adjust", "twitch:sam", { delta: 1, reason: "missed cheer" }))).toBe("queue +1 (missed cheer)");
  expect(describeEntry(entry(1, "queue_adjust", "twitch:sam", { delta: -2, reason: "double count" }))).toBe("queue -2 (double count)");
  expect(describeEntry(entry(147, "threshold", "streamer@local", { cents: 3500 }))).toBe("threshold → $35");
  expect(describeEntry(entry(148, "config_change", "twitch:sam", { diff: [{ path: "overlay.side", from: "right", to: "left" }] }))).toBe("1 change: overlay.side");
  expect(
    describeEntry(
      entry(148, "config_change", "twitch:sam", {
        diff: ["a", "b", "c", "d", "e"].map((path) => ({ path, from: 0, to: 1 })),
      }),
    ),
  ).toBe("5 changes: a, b, c, d, …");
  expect(describeEntry(entry(149, "auth_failure", "system:auth", { ip: "203.0.113.5", path: "/help", reason: "invalid session cookie" }))).toBe("203.0.113.5 /help — invalid session cookie");
  expect(describeEntry(entry(150, "note", "twitch:sam", { text: "winner of fire #144: dana", fireSeq: 144, winner: "dana" }))).toBe("winner of fire #144: dana");
});

test("stock: the Outcome's name, the signed Left change (a real minus sign) and the reason", () => {
  expect(describeEntry(entry(1, "stock", "streamer@local", { outcomeId: "stickers", delta: 2, reason: "left edit" }), ctx)).toBe("STICKERS left +2 (left edit)");
  expect(describeEntry(entry(1, "stock", "streamer@local", { outcomeId: "stickers", delta: -5, reason: "deleted" }), ctx)).toBe("STICKERS left −5 (deleted)");
  expect(describeEntry(entry(1, "stock", "system:boot", { outcomeId: "gone", delta: 3, reason: "initial" }), ctx)).toBe("gone left +3 (initial)"); // an Outcome no longer in config: its id
});

test("outcome_change: edit lists the changed fields in key order (strings bare, other values JSON); add shows the new values; delete just says so", () => {
  const edit = entry(1, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { tier: { from: 0, to: 1 }, name: { from: "STICKERS", to: "STICKER PACK" } } });
  expect(describeEntry(edit, ctx)).toBe("STICKERS: tier 0 → 1, name STICKERS → STICKER PACK");
  const add = entry(2, "outcome_change", "streamer@local", { outcomeId: "vinyl-only", action: "add", changes: { tier: { from: undefined, to: 0 }, left: { from: undefined, to: 2 } } });
  expect(describeEntry(add, ctx)).toBe("VINYL ONLY added (tier 0, left 2)");
  const del = entry(3, "outcome_change", "streamer@local", { outcomeId: "vinyl-only", action: "delete", changes: {} });
  expect(describeEntry(del, ctx)).toBe("VINYL ONLY deleted");
  expect(describeEntry(entry(4, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { restockable: { from: false, to: true } } }), ctx)).toBe("STICKERS: restockable false → true");
  expect(describeEntry(entry(5, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { miniDraw: { from: undefined, to: "genreRoulette" } } }), ctx)).toBe("STICKERS: miniDraw none → genreRoulette");
  expect(describeEntry(del)).toBe("vinyl-only deleted"); // no context: the id
});

test("outcome_change: a description shows at most 60 characters, ellipsis included — the same clip as a contribution's message — so one Ledger line never carries two full What it is lines; clearing it says so", () => {
  const long = "A chat raffle for a USB stick loaded with a curated rekordbox export. When it comes up Firebot draws the winner.";
  const short = "Oven mitts on for the next transition.";
  const shown = `${long.slice(0, DESCRIPTION_SHOWN - 1)}…`;
  expect(shown).toHaveLength(DESCRIPTION_SHOWN);
  expect(describeEntry(entry(6, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { description: { from: short, to: long } } }), ctx)).toBe(
    `STICKERS: description ${short} → ${shown}`,
  );
  // one truncation rule: a 100-character Ko-fi note is cut the same way at MESSAGE_CLIP (79 + …)
  const note = "n".repeat(100);
  expect(describeEntry(entry(13, "contribution", "system:kofi", { face: "tip", source: "kofi", progressCents: 500, displayName: "dana", anonymous: false, message: note } as never), ctx)).toContain(` · ${"n".repeat(MESSAGE_CLIP - 1)}…`);
  expect(describeEntry(entry(7, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { description: { from: long, to: "" } } }), ctx)).toBe(`STICKERS: description cleared`);
  expect(describeEntry(entry(8, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { description: { from: "", to: short } } }), ctx)).toBe(`STICKERS: description none → ${short}`); // an empty one reads "none", like an absent miniDraw
  expect(describeEntry(entry(9, "outcome_change", "streamer@local", { outcomeId: "vinyl-only", action: "add", changes: { tier: { from: undefined, to: 0 }, description: { from: undefined, to: long } } }), ctx)).toBe(`VINYL ONLY added (tier 0, description ${shown})`);
  expect(describeEntry(entry(10, "outcome_change", "streamer@local", { outcomeId: "vinyl-only", action: "add", changes: { tier: { from: undefined, to: 0 }, description: { from: undefined, to: "" } } }), ctx)).toBe(`VINYL ONLY added (tier 0, description none)`);
  // exactly 60 characters stays whole (61 is clipped); a name that long is never truncated (description only)
  const sixty = "x".repeat(DESCRIPTION_SHOWN);
  expect(describeEntry(entry(14, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { description: { from: "", to: sixty + "y" } } }), ctx)).toContain(`→ ${sixty.slice(0, -1)}…`);
  expect(describeEntry(entry(11, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { description: { from: "", to: sixty } } }), ctx)).toContain(`→ ${sixty}`);
  expect(describeEntry(entry(12, "outcome_change", "streamer@local", { outcomeId: "stickers", action: "edit", changes: { name: { from: "STICKERS", to: sixty + "y" } } }), ctx)).toBe(`STICKERS: name STICKERS → ${sixty}y`);
});

test("unlock: where it came from — a contribution, a Threshold change, a re-queued fire, a queue adjustment (never 'banked')", () => {
  expect(describeEntry(entry(151, "unlock", "system:streamelements", { source: "threshold", contributionSeq: 143 }))).toBe("unlock from contribution #143");
  expect(describeEntry(entry(151, "unlock", "streamer@local", { source: "threshold", contributionSeq: null }))).toBe("unlock from the threshold change");
  expect(describeEntry(entry(151, "unlock", "twitch:sam", { source: "rebank", contributionSeq: 143, fireSeq: 144 }))).toBe("unlock re-queued from fire #144");
  expect(describeEntry(entry(151, "unlock", "twitch:sam", { source: "adjust", contributionSeq: null }))).toBe("unlock added by queue adjustment");
});

test("fire: glyph + name, the contributor behind its Unlock, the stock left, and the mini-draw pick", () => {
  const ledger = new Map<number, Entry>();
  ledger.set(143, tip(143, "dana", 5000));
  ledger.set(151, entry(151, "unlock", "system:streamelements", { source: "threshold", contributionSeq: 143 }));
  ledger.set(152, entry(152, "unlock", "streamer@local", { source: "threshold", contributionSeq: null }));
  ledger.set(153, tip(153, null, 5000));
  ledger.set(154, entry(154, "unlock", "system:streamelements", { source: "threshold", contributionSeq: 153 }));
  const full: DescribeContext = { ...ctx, entry: (seq) => ledger.get(seq) };
  const fire = (unlockSeq: number, extra: Partial<Entry<"fire">["payload"]> = {}) => entry(144, "fire", "streamer@local", { unlockSeq, outcomeId: "spotlight", roll: 0.2, stockAfter: 1, ...extra });
  expect(describeEntry(fire(151), full)).toBe("🎤 ARTIST SPOTLIGHT for @dana (1 left)");
  expect(describeEntry(fire(152), full)).toBe("🎤 ARTIST SPOTLIGHT (1 left)"); // a threshold-change Unlock has no contributor
  expect(describeEntry(fire(154), full)).toBe("🎤 ARTIST SPOTLIGHT for Anonymous (1 left)");
  expect(describeEntry(fire(151, { miniDraw: { title: "GENRE ROULETTE · 10–15 MIN", list: ["House", "Techno"], pick: "House" } }), full)).toBe("🎤 ARTIST SPOTLIGHT for @dana (1 left) · GENRE ROULETTE · 10–15 MIN: House");
  expect(describeEntry(fire(151, { outcomeId: "gone" }), full)).toBe("gone for @dana (1 left)"); // no glyph, the id
  expect(describeEntry(fire(151))).toBe("spotlight (1 left)"); // no context at all
});

test("entryLine: `#seq type actor — description`, the console shape", () => {
  expect(entryLine(tip(143, "dana", 1000), { progressCents: 2300, thresholdCents: 5000 })).toBe("#143 contribution system:streamelements — @dana tipped $10 (+$10) → $23 of $50");
  expect(entryLine(entry(147, "threshold", "streamer@local", { cents: 3500 }))).toBe("#147 threshold streamer@local — threshold → $35");
});

test("no line ever says banked or spent, and none carries a raw payload dump", () => {
  const lines = [
    describeEntry(tip(1, "dana", 1000, { sourceId: "se:secret-looking-id" })),
    describeEntry(entry(2, "unlock", "x", { source: "threshold", contributionSeq: 1 })),
    describeEntry(entry(3, "unlock", "x", { source: "rebank", contributionSeq: 1, fireSeq: 2 })),
    describeEntry(entry(4, "rebank", "x", { fireSeq: 2, reason: "r" })),
  ];
  for (const line of lines) {
    expect(line).not.toMatch(/banked|spent|prize/i);
    expect(line).not.toContain("{");
    expect(line).not.toContain("secret-looking-id");
  }
});

test("describeEntryFull: a config_change lists every setting with before → after; a draw-list edit folds to what was added and removed (moves are not news); the summary counts the folded items", () => {
  const at = (path: string, from: unknown, to: unknown) => ({ path, from, to });
  const mk = (diff: Array<{ path: string; from: unknown; to: unknown }>) => ({ seq: 1, ts: "2026-09-12T20:00:00.000Z", actor: "dj", type: "config_change", payload: { diff } }) as unknown as Entry<"config_change">;

  // the streamer removed HARDSTYLE and added JAMTRONICA: nine index lines, two facts
  const shuffle = mk([
    at("lists.genreRoulette.5", "HARDSTYLE / HARDCORE", "JUNGLE"),
    at("lists.genreRoulette.6", "JUNGLE", "SYNTHWAVE / 80S"),
    at("lists.genreRoulette.7", "HIP-HOP / TRAP", "REGGAETON / LATIN"),
    at("lists.genreRoulette.8", "DUB TECHNO / MINIMAL", "FUNK / SOUL"),
    at("lists.genreRoulette.9", "PSYTRANCE", "DOWNTEMPO / AMBIENT"),
    at("lists.genreRoulette.10", "SYNTHWAVE / 80S", "JAMTRONICA / JAM BANDS"),
    at("lists.genreRoulette.11", "REGGAETON / LATIN", undefined),
    at("lists.genreRoulette.12", "FUNK / SOUL", undefined),
    at("lists.genreRoulette.13", "DOWNTEMPO / AMBIENT", undefined),
  ]);
  expect(describeEntry(shuffle, ctx)).toBe("1 change: genre roulette +1 −4");
  expect(describeEntryFull(shuffle)).toEqual(["genre roulette: added JAMTRONICA / JAM BANDS", "genre roulette: removed HARDSTYLE / HARDCORE, HIP-HOP / TRAP, DUB TECHNO / MINIMAL, PSYTRANCE"]);

  // one item appended: the summary only counts it, Show all names it
  const one = mk([at("lists.chatRules.4", undefined, "NO CAPS")]);
  expect(describeEntry(one, ctx)).toBe("1 change: chat rules +1");
  expect(describeEntryFull(one)).toEqual(["chat rules: added NO CAPS"]);

  // plain settings past four: every path with before → after, in full
  const many = mk([1, 2, 3, 4, 5].map((i) => at(`overlay.knob${i}`, i, i * 10)));
  expect(describeEntry(many, ctx)).toBe("5 changes: overlay.knob1, overlay.knob2, overlay.knob3, overlay.knob4, …");
  expect(describeEntryFull(many)).toEqual(["overlay.knob1: 1 → 10", "overlay.knob2: 2 → 20", "overlay.knob3: 3 → 30", "overlay.knob4: 4 → 40", "overlay.knob5: 5 → 50"]);
  expect(describeEntryFull(mk([at("threshold.cents", 5000, 2500)]))).toBeNull();

  // the Outcome pool by id: an insert at 1 shifts everything after it; the fold says what was added and removed, and keeps an edit in place
  const pool = mk([
    at("outcomes.1.id", "shirt-t0", "mystery-box"),
    at("outcomes.1.name", "SHIRT", "MYSTERY BOX"),
    at("outcomes.2.id", "artist-spotlight", "shirt-t0"),
    at("outcomes.2.name", "ARTIST SPOTLIGHT", "SHIRT"),
    at("outcomes.3.id", undefined, "artist-spotlight"),
    at("outcomes.3.name", undefined, "ARTIST SPOTLIGHT"),
    at("outcomes.0.description", "old", "new"),
  ]);
  expect(describeEntry(pool, ctx)).toBe("2 changes: outcomes, outcomes.0.description");
  expect(describeEntryFull(pool)).toEqual(["outcomes: added mystery-box", "outcomes.0.description: old → new"]);
  expect(describeEntryFull({ seq: 2, ts: "2026-09-12T20:00:00.000Z", actor: "dj", type: "note", payload: { text: "hi" } } as unknown as Entry<"note">)).toBeNull();
});
