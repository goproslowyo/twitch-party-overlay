/**
 * Every string the overlay puts on screen. The on-screen vocabulary rule binds this file:
 * the queue is READY, a crossing is an UNLOCK, a used-up Outcome is DONE, gates read "N TO GO" / "N UNLOCKS AWAY", and
 * no onomatopoeia or size words anywhere. `vocabulary.test.ts` sweeps every module here for the banned words. Money is
 * integer cents in, `$50` / `$4.50` / `$1,000` out. The Dashboard imports `money` from here.
 */
import type { Theme } from "../config/schema.ts";
import type { ContributionSource, Face, SubTier } from "../ingest/contribution.ts";
import type { OverlayOutcome } from "../server/overlay.ts";

const THANK_STAR_INTENSITY = 0.6; // above this the acknowledgement wears ✦✦
const DEFAULT_TIER_LABEL = "TIER {n}";
const THANK_YOU = "THANK YOU";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escape a text node: viewer names reach the overlay's DOM only through here. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Money: `$50`, `$4.50`, `$1,000` — cents shown only when non-zero. */
export function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const rem = abs % 100;
  return `${sign}$${dollars}${rem === 0 ? "" : `.${String(rem).padStart(2, "0")}`}`;
}

const count = (n: number): string => n.toLocaleString("en-US");
const plural = (n: number, word: string): string => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const PLURAL = (n: number, WORD: string): string => `${count(n)} ${WORD}${n === 1 ? "" : /(S|X|Z|CH|SH)$/.test(WORD) ? "ES" : "S"}`; // the shouting kind (UNLOCKS, SPLASHES)

/** " at Tier 2" / " at Tier 3" for the paid tiers above 1; nothing for Tier 1 or Prime (they have their own wording). */
function atTier(tier: SubTier): string {
  return tier === "2000" ? " at Tier 2" : tier === "3000" ? " at Tier 3" : "";
}

/** The tip lane's words split on the source: Ko-fi gets its own; StreamElements and manual credits say "tipped". */
const isKofi = (source: ContributionSource): boolean => source === "kofi";
/** A sub with more than one month on it is a resub; the first month (or no count at all) is a new sub. */
const isResub = (face: Extract<Face, { kind: "sub" }>): boolean => face.months !== undefined && face.months > 1;

/** The `{what}` of the acknowledgement line: the face amount in its own unit (the one place a figure appears in a celebration). */
export function whatText(face: Face, source: ContributionSource): string {
  switch (face.kind) {
    case "tip":
      return isKofi(source) ? `donated ${money(face.cents)} on Ko-fi` : `tipped ${money(face.cents)}`;
    case "bits":
      return `cheered ${plural(face.bits, "bit")}`;
    case "sub": {
      if (isResub(face)) return `resubscribed (${face.months} months)${atTier(face.tier)}`;
      return face.tier === "prime" ? "subscribed with Prime" : `subscribed${atTier(face.tier)}`;
    }
    case "gift":
      return `gifted ${plural(face.count, "sub")}${atTier(face.tier)}`;
  }
}

/** The kind of a contribution as one shouted word, no figure and no tier: `TIPPED`, `DONATED ON KO-FI`, `CHEERED`, `SUBSCRIBED`, `RESUBSCRIBED`, `GIFTED SUBS`. */
function kindWord(face: Face, source: ContributionSource): string {
  switch (face.kind) {
    case "tip":
      return isKofi(source) ? "DONATED ON KO-FI" : "TIPPED";
    case "bits":
      return "CHEERED";
    case "sub":
      return isResub(face) ? "RESUBSCRIBED" : "SUBSCRIBED";
    case "gift":
      return "GIFTED SUBS";
  }
}

/** Only an https URL on the Twitch CDN is ever put in an `<img src>`; anything else (or nothing) is the Avatar Glyph. */
const PICTURE_URL = /^https:\/\/static-cdn\.jtvnw\.net\//;

/**
 * `✦ {avatar} @{name} {what} — thank you ✦` (`✦✦` above 0.6); anonymous → `Anonymous {what}` without the `@`.
 * With an Avatar Picture the glyph's place is `<img class="pic" src="…" data-glyph="{avatar}" alt="">` — the glyph
 * travels as data so alerts.ts can swap it back in when the picture fails to load (no inline JS). Anonymous is never
 * pictured. Returned as HTML because the name is emphasised and escaped here, so the renderer can drop it straight into the DOM.
 */
export function thankLine(name: string | null, avatar: string, avatarUrl: string | null, what: string, intensity: number): { html: string } {
  const stars = intensity > THANK_STAR_INTENSITY ? "✦✦" : "✦";
  const who = name === null ? "Anonymous" : `@${name}`;
  const face = name !== null && avatarUrl !== null && PICTURE_URL.test(avatarUrl) ? `<img class="pic" src="${esc(avatarUrl)}" data-glyph="${esc(avatar)}" alt="">` : esc(avatar);
  return { html: `${stars} ${face} <b>${esc(who)}</b> ${esc(what)} — thank you ${stars}` };
}

/**
 * The Unlock stinger, big over sub as the Unlock board has it: `+1 UNLOCK` / `READY TO DROP`; stacked, `+3 UNLOCKS` /
 * `3 UNLOCKS EARNED IN ONE MOMENT · READY TO DROP`. The big line is short enough for one 88 px line across the towers.
 */
export function unlockStinger(n: number): { big: string; sub: string } {
  return { big: `+${PLURAL(n, "UNLOCK")}`, sub: n > 1 ? `${PLURAL(n, "UNLOCK")} EARNED IN ONE MOMENT · ${READY_TO_DROP}` : READY_TO_DROP };
}
const READY_TO_DROP = "READY TO DROP";

/** The fader's crossing label: `FULL`, stacked `FULL ×3` — shown after `$50 of $50 · `. */
export function fullLabel(n: number): string {
  return n > 1 ? `FULL ×${n}` : "FULL";
}

/** The theme's tier label with the number filled in: `TIER 1` / `POND 1` — the tower captions, the lock tile's line. */
export function tierName(tier: number, theme: Pick<Theme, "tierLabel">): string {
  return theme.tierLabel.replace("{n}", String(tier));
}
const tierLabel = tierName;

/** `TIER 1 OPEN` over `N OUTCOMES JUST REVEALED`, with the theme's tier word. */
export function tierOpenStinger(tier: number, revealedCount: number, theme: Pick<Theme, "tierLabel">): { big: string; sub: string } {
  return { big: `${tierLabel(tier, theme)} OPEN`, sub: `${PLURAL(revealedCount, "OUTCOME")} JUST REVEALED` };
}

/** `@name`, or `Anonymous` when there is no name — the big-text moment (and the thank line's own copy of it); never over a jumper. */
export function handle(name: string | null): string {
  return name === null ? "Anonymous" : `@${name}`;
}

/**
 * The big-moment stinger (from `bigIntensity` up): `@NAME` (`ANONYMOUS` without a name) over `TIPPED · THANK YOU` /
 * `CHEERED · THANK YOU` / `GIFTED SUBS · THANK YOU`… — the kind of contribution and nothing more. Amounts appear on the
 * acknowledgement line only (`whatText`); the big text, bursts and fireworks print no figures.
 */
export function bigMoment(name: string | null, face: Face, source: ContributionSource): { big: string; sub: string } {
  return { big: handle(name).toUpperCase(), sub: `${kindWord(face, source)} · ${THANK_YOU}` };
}

/** The rack's next-gate countdown: `3 TO GO`. */
export function gateText(remaining: number): string {
  return `${count(remaining)} TO GO`;
}

/** Landing banner: `{glyph} {NAME}` over `k LEFT`, or `DONE` at zero. */
export function landingBanner(outcome: Pick<OverlayOutcome, "glyph" | "name">, left: number): { big: string; sub: string } {
  return { big: `${outcome.glyph} ${outcome.name ?? ""}`.trimEnd(), sub: left > 0 ? `${count(left)} LEFT` : DONE };
}

/** Multi-fire reveals queue one at a time: `REVEAL 2 OF 3`. */
export function revealCounter(n: number, total: number): string {
  return `REVEAL ${n} OF ${total}`;
}

/** A used-up Outcome, on its pad and in the landing banner — never "spent". */
export const DONE = "DONE";
/** The drained pool's floor label, over the strip. */
export const DRAINED = "POOL DRAINED — THE CROWD DID IT";
/** The drained stinger, big over sub as the Drained board has it (one 88 px line, never two). */
export const DRAINED_STINGER: { readonly big: string; readonly sub: string } = { big: "POOL DRAINED", sub: "EVERY OUTCOME PAID OUT · THE CROWD DID IT · MODS MAY RESTOCK" };
/** The rack's NOW box while drained: what fits its one line, over the board's small line. */
export const DRAINED_NOW: { readonly what: string; readonly who: string } = { what: "POOL DRAINED", who: "mods may restock" };
export const SHUFFLING = "🔀 SHUFFLING THE PADS";
export const LEGEND: readonly [string, string] = ["TIPS · BITS count in full", "SUBS count what the streamer keeps, not the sticker"];

/** The backstage mystery tile: `🔒 · TIER 2 · 5 HIDDEN` over `3 UNLOCKS AWAY` — never a name. */
export function lockedTile(tier: number, hidden: number, away: number, theme: Pick<Theme, "tierLabel"> = { tierLabel: DEFAULT_TIER_LABEL }): { big: string; sub: string } {
  return { big: `🔒 · ${tierLabel(tier, theme)} · ${count(hidden)} HIDDEN`, sub: `${PLURAL(away, "UNLOCK")} AWAY` };
}

// ---- the rack panel — every label the channel strip shows -------------------------------------------------

export const MENU = "MENU";
export const NOW = "NOW";
export const LIVE = "LIVE";
export const COLLECTING = "COLLECTING…";
export const EVERY_TIER_OPEN = "EVERY TIER OPEN";
const JUST_REVEALED = "JUST REVEALED";
const MASK_CHAR = "•";
const MASK_RATIO = 0.62; // a masked name at ~its real length, as the prototype drew it
const MASK_MIN = 3;
const MASK_MAX = 14;

/** `NEXT UNLOCK` — the fader's label, with the theme's word. */
export function nextUnlockLabel(theme: Pick<Theme, "unlockWord">): string {
  return `NEXT ${theme.unlockWord}`;
}

/** The queue's label: the theme's `readyWord` (READY / IN THE COOP). */
export function readyLabel(theme: Pick<Theme, "readyWord">): string {
  return theme.readyWord;
}

/** The fader's second line: `of $50`, `of $50 · FULL`, `of $50 · FULL ×2`. */
export function faderOf(thresholdCents: number, fullCount: number): string {
  return `of ${money(thresholdCents)}${fullCount > 0 ? ` · ${fullLabel(fullCount)}` : ""}`;
}

/** A tier LED row: `TIER 1 · 8` (the tier's outcome count). */
export function tierRow(tier: number, outcomeCount: number, theme: Pick<Theme, "tierLabel">): string {
  return `${tierLabel(tier, theme)} · ${count(outcomeCount)}`;
}

/** `3 UNLOCKS AWAY` / `1 SPLASH AWAY` — the countdown to a gate that is not the next one (the next reads `N TO GO`). */
export function unlocksAway(remaining: number, theme: Pick<Theme, "unlockWord">): string {
  return `${PLURAL(remaining, theme.unlockWord)} AWAY`;
}

export type StockHeaderStatus = { kind: "open"; fresh: boolean } | { kind: "locked"; away: number };

/** A stock group's header: `TIER 0`, `TIER 1 · JUST REVEALED`, `🔒 TIER 2 · 6 UNLOCKS AWAY` (the lock says locked; it has to fit one 300 px line at 1080p). */
export function stockHeader(tier: number, theme: Pick<Theme, "tierLabel" | "unlockWord">, status: StockHeaderStatus): string {
  const label = tierLabel(tier, theme);
  if (status.kind === "locked") return `🔒 ${label} · ${unlocksAway(status.away, theme)}`;
  return status.fresh ? `${label} · ${JUST_REVEALED}` : label;
}

/** The idle NOW line with Unlocks waiting: `2 UNLOCKS READY`. */
export function unlocksReady(n: number, theme: Pick<Theme, "unlockWord">): string {
  return `${PLURAL(n, theme.unlockWord)} READY`;
}

/** The idle NOW status: `TIER 1 · 3 UNLOCKS AWAY`. */
export function nowGate(tier: number, away: number, theme: Pick<Theme, "tierLabel" | "unlockWord">): string {
  return `${tierLabel(tier, theme)} · ${unlocksAway(away, theme)}`;
}

/**
 * The line under a landing (the banner and the rack's NOW box): the stock line alone — `4 LEFT` / `DONE` — because an
 * Unlock is the crowd's and names nobody; the sole exception is `solo`, the one contributor whose money alone took
 * it from zero to its Threshold: `@alice · 4 LEFT`. Never "Anonymous" here.
 */
export function landingWho(solo: string | null, sub: string): string {
  return solo === null ? sub : `@${solo} · ${sub}`;
}

/** A locked outcome's name as dots at ~its real length — the rack shows the size of what is coming, never the name. */
export function maskedName(nameLength: number): string {
  return MASK_CHAR.repeat(Math.min(MASK_MAX, Math.max(MASK_MIN, Math.round(nameLength * MASK_RATIO))));
}

/** The READY row's overflow seat past its four Passengers: `+3` — how many more, never who. */
export function moreSeats(n: number): string {
  return `+${count(n)}`;
}

/** The compact grid's charge count: `×5`. */
export function compactCount(n: number): string {
  return `×${count(n)}`;
}

// ---- the scene — the canvas paints nothing it did not get from here ----------------------------------------

/** The sign over the gondola door the jumpers leave by. */
export const EXIT = "EXIT";

// ---- the drop ----------------------------------------------------------------------------------------------------

/** The mini-draw reel's title: `🎲 GENRE ROULETTE · 10–15 MIN — DRAWING FROM THE LIST` (the server names the draw). */
export function miniDrawTitle(glyph: string, title: string): string {
  return `${glyph} ${title} — DRAWING FROM THE LIST`;
}
