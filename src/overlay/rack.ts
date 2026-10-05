/**
 * The rack — the channel strip beside the scene (ported from the prototype's
 * `makeRackPanel`): header, NOW box, fader with a 12-LED ladder, legend, READY row, tier LEDs, and the whole pool as a
 * stock list (masked rows for locked tiers). `rackSpec` turns a `View` + skin into plain data — every string via
 * copy.ts — and `createRack` paints that data into the DOM (the prototype's class names, so the scene and the drop can reuse
 * them). The rack re-renders only when the model changed (`invalidate`) or one of its own beats (a landing hit, a NOW
 * override, a JUST REVEALED mark) runs out; the loop's `tMs` is its only clock.
 */
import type { Theme } from "../config/schema.ts";
import { LOCKED_GLYPH, type OverlaySkin } from "../server/overlay.ts";
import { COLLECTING, DRAINED_NOW, EVERY_TIER_OPEN, LEGEND, LIVE, MENU, NOW, compactCount, faderOf, gateText, maskedName, money, moreSeats, nextUnlockLabel, nowGate, readyLabel, stockHeader, tierRow, unlocksAway, unlocksReady } from "./copy.ts";
import { passengers } from "./scene/blimp.ts";
import type { View } from "./state.ts";

export const LED_COUNT = 12;
export const HIT_MS = 3200;
export const NOW_HOLD_MS = 5000;
const CELEBRATE_BASE_MS = 2200;
const CELEBRATE_STEP_MS = 600;
/** READY-row seats: the gondola's generic Passengers (never a contributor); past them a `+N` text seat and the count carry the rest. */
const SEATS = 4;

export interface RackNow {
  cls: string;
  what: string;
  who: string;
}

export interface RackRow {
  id: string;
  glyph: string;
  name: string;
  masked: boolean;
  pips: boolean[];
  dead: boolean;
  fresh: boolean;
  /** The compact grid's count (`×5`): what is left, or the size of a locked row; empty for a stock of one. */
  compact: string;
  shape: string;
  color: string;
}

export interface RackGroup {
  tier: number;
  color: string;
  locked: boolean;
  fresh: boolean;
  header: string;
  rows: RackRow[];
}

export interface RackSpec {
  title: string;
  menu: string;
  now: RackNow;
  fader: { amount: string; of: string; full: boolean; leds: number };
  legend: readonly [string, string];
  /** `more` is the `+N` seat past the four Passengers, "" when the queue fits. */
  ready: { label: string; seats: Array<{ avatar: string }>; count: string; more: string };
  tiers: Array<{ tier: number; color: string; on: boolean; next: boolean; label: string; gate: string }>;
  stock: RackGroup[];
  drained: boolean;
}

const tierColor = (theme: Theme, tier: number): string => theme.tiers[tier] ?? "";

/** LEDs lit for `progress` of `threshold`: the prototype's `i < progress / threshold × 12`. */
export function ledsLit(progressCents: number, thresholdCents: number): number {
  if (!(thresholdCents > 0)) return 0;
  return Math.min(LED_COUNT, Math.max(0, Math.ceil((progressCents / thresholdCents) * LED_COUNT)));
}

/** `tMs` is the loop's clock: the READY seats show the same Passengers as the gondola at that moment. */
export function rackSpec(view: View, skin: OverlaySkin, now?: RackNow, tMs = 0): RackSpec {
  const { theme } = skin;
  const tierCount = view.gates.length;
  const nextTier = view.tier + 1 < tierCount ? view.tier + 1 : null;
  const away = (tier: number): number => Math.max(0, (view.gates[tier] ?? 0) - view.bankedTotal);

  const idle: RackNow = view.drained
    ? { cls: "", what: DRAINED_NOW.what, who: DRAINED_NOW.who } // the board's NOW: nothing to truncate, no stale tier gate
    : {
        cls: "",
        what: view.queue > 0 ? unlocksReady(view.queue, theme) : COLLECTING,
        who: nextTier === null ? EVERY_TIER_OPEN : nowGate(nextTier, away(nextTier), theme),
      };

  const seats = passengers(theme, tMs)
    .slice(0, Math.min(view.queue, SEATS))
    .map((avatar) => ({ avatar }));

  const tiers = Array.from({ length: tierCount }, (_, t) => {
    const on = t <= view.tier;
    const next = t === nextTier;
    return {
      tier: t,
      color: tierColor(theme, t),
      on,
      next,
      label: tierRow(t, view.outcomes.filter((o) => o.tier === t).length, theme),
      gate: on ? LIVE : next ? gateText(away(t)) : unlocksAway(away(t), theme),
    };
  });

  const stock = Array.from({ length: tierCount }, (_, t): RackGroup => {
    const locked = t > view.tier;
    const fresh = view.justRevealed.some((j) => j.tier === t);
    return {
      tier: t,
      color: tierColor(theme, t),
      locked,
      fresh,
      header: stockHeader(t, theme, locked ? { kind: "locked", away: away(t) } : { kind: "open", fresh }),
      rows: view.outcomes
        .filter((o) => o.tier === t)
        .map((o): RackRow => {
          const masked = locked || o.name === null;
          const dead = !masked && (o.status !== "live" || o.left === 0); // suspended / retired: the Engine never draws it, so it reads as DONE
          const size = o.used + o.left;
          return {
            id: o.id,
            glyph: masked ? LOCKED_GLYPH : o.glyph,
            name: masked ? maskedName(o.nameLength) : (o.name ?? ""),
            masked,
            pips: Array.from({ length: size }, (_, i) => !dead && (masked || i >= o.used)), // the used ones first, dimmed; a locked row shows only its size
            dead,
            fresh,
            compact: size > 1 ? compactCount(masked ? size : o.left) : "",
            shape: theme.shape[o.shape],
            color: tierColor(theme, t),
          };
        }),
    };
  });

  return {
    title: theme.rackTitle,
    menu: MENU,
    now: now ?? idle,
    fader: { amount: money(view.progressDisplayCents), of: faderOf(view.thresholdCents, view.fullCount), full: view.fullCount > 0, leds: ledsLit(view.progressDisplayCents, view.thresholdCents) },
    legend: LEGEND,
    ready: { label: readyLabel(theme), seats, count: String(view.queue), more: view.queue > SEATS ? moreSeats(view.queue - SEATS) : "" },
    tiers,
    stock,
    drained: view.drained,
  };
}

/** The prototype's celebration tiers for the panel glow (`cel1`–`cel4`) from the continuous intensity. */
export function celebrationLevel(intensity: number): 1 | 2 | 3 | 4 {
  return intensity >= 0.7 ? 4 : intensity >= 0.45 ? 3 : intensity >= 0.2 ? 2 : 1;
}

// ---- DOM ------------------------------------------------------------------------------------------------------------

export interface Rack {
  readonly el: HTMLElement;
  /** Re-render on the next step (the model changed). */
  invalidate(): void;
  step(nowMs: number): void;
  /** A landing: the row goes gold for a beat. */
  hit(outcomeId: string, nowMs: number): void;
  /** Replace the NOW box for `holdMs` (a landing, a drift), then back to the idle text. */
  now(now: RackNow, nowMs: number, holdMs?: number): void;
  /** The panel's glow for a contribution, by intensity — and a re-render on the next step: the contribution moved the fader (task-99 MUST 4). */
  celebrate(intensity: number, nowMs: number): void;
}

export function createRack(root: HTMLElement, view: () => View, skin: () => OverlaySkin): Rack {
  const doc = root.ownerDocument;
  const el = (tag: string, cls: string, parent?: Element): HTMLElement => {
    const e = doc.createElement(tag);
    e.className = cls;
    parent?.appendChild(e);
    return e;
  };

  const panel = el("div", "rk-panel", root);
  panel.id = "rack";
  const head = el("div", "rk-head", panel);
  const brand = el("span", "brand", head);
  const menu = el("span", "lbl", head);
  const nowBox = el("div", "rk-now", panel);
  const nowLbl = el("div", "lbl", nowBox);
  const nowWhat = el("div", "what", nowBox);
  const whoEl = el("div", "who", nowBox);
  const fader = el("div", "rk-fader", panel);
  const ladder = el("div", "ladder", fader);
  const leds = Array.from({ length: LED_COUNT }, () => el("i", "", ladder));
  const nums = el("div", "nums", fader);
  const faderLbl = el("div", "lbl", nums);
  const amt = el("div", "amt", nums);
  const of = el("div", "of", nums);
  const legend = el("div", "rk-legend", panel);
  const legend1 = el("div", "", legend);
  const legend2 = el("div", "", legend);
  const queue = el("div", "rk-queue", panel);
  const queueLbl = el("div", "lbl", queue);
  const qrow = el("div", "qrow", queue);
  const tiersEl = el("div", "rk-tiers", panel);
  const stockEl = el("div", "rk-stock", panel);

  let dirty = true;
  let override: { now: RackNow; untilMs: number } | null = null;
  let glowUntilMs: number | null = null;
  const hits = new Map<string, number>();
  const rows = new Map<string, HTMLElement>();

  const setNow = (now: RackNow): void => {
    nowBox.className = `rk-now ${now.cls}`;
    nowWhat.textContent = now.what;
    whoEl.textContent = now.who;
  };

  const buildStock = (spec: RackSpec, compact: boolean, nowMs: number): void => {
    stockEl.textContent = "";
    rows.clear();
    for (const group of spec.stock) {
      const header = el("div", `grp${group.locked ? "" : " on"}`, stockEl);
      header.style.setProperty("--tc", group.color);
      header.textContent = group.header;
      const grid = compact ? el("div", "grid", stockEl) : null;
      for (const row of group.rows) {
        const hit = (hits.get(row.id) ?? 0) > nowMs;
        const r = el("div", `${compact ? "cell" : "row"}${row.masked ? " lock" : row.dead ? " dead" : ""}${row.fresh ? " new" : ""}${hit ? " hit" : ""}`, grid ?? stockEl);
        r.style.setProperty("--shape", row.shape);
        r.style.setProperty("--tc", row.color);
        el("span", "g", r).textContent = row.glyph;
        if (compact) {
          if (row.compact !== "") r.appendChild(doc.createTextNode(row.compact));
        } else {
          el("span", `nm${row.masked ? " masked" : ""}`, r).textContent = row.name;
          const pips = el("span", "pips", r);
          for (const on of row.pips) el("i", on ? "" : "off", pips);
        }
        rows.set(row.id, r);
      }
    }
  };

  const render = (nowMs: number): void => {
    dirty = false;
    const spec = rackSpec(view(), skin(), override?.now, nowMs);
    const { theme } = skin();
    brand.textContent = spec.title;
    menu.textContent = spec.menu;
    nowLbl.textContent = NOW;
    setNow(spec.now);
    amt.textContent = spec.fader.amount;
    of.textContent = spec.fader.of;
    faderLbl.textContent = nextUnlockLabel(theme);
    fader.classList.toggle("full", spec.fader.full);
    leds.forEach((led, i) => (led.className = i < spec.fader.leds ? (i === LED_COUNT - 1 ? "top on" : "on") : ""));
    legend1.textContent = spec.legend[0];
    legend2.textContent = spec.legend[1];
    queueLbl.textContent = spec.ready.label;
    qrow.textContent = "";
    for (const seat of spec.ready.seats) el("span", "j", qrow).textContent = seat.avatar;
    if (spec.ready.more !== "") el("span", "more", qrow).textContent = spec.ready.more;
    el("span", "n", qrow).textContent = spec.ready.count;
    tiersEl.textContent = "";
    for (const t of spec.tiers) {
      const d = el("div", `t${t.on ? " on" : ""}${t.next ? " next" : ""}`, tiersEl);
      d.style.setProperty("--tc", t.color);
      el("i", "", d);
      d.appendChild(doc.createTextNode(t.label));
      el("span", "g", d).textContent = t.gate;
    }
    buildStock(spec, false, nowMs);
    if (stockEl.scrollHeight > stockEl.clientHeight + 2) buildStock(spec, true, nowMs);
    panel.classList.toggle("dry", spec.drained);
    deadline = nextDeadline();
  };

  /**
   * The earliest moment one of the rack's own beats ends (a NOW override, the glow, a hit, a JUST REVEALED mark), or
   * null. Remembered at render time: the model drops an expired mark from `view.justRevealed` on its own tick, so the
   * rack must already know when to look again.
   */
  const nextDeadline = (): number | null => {
    const marks = [override?.untilMs ?? null, glowUntilMs, ...hits.values(), ...view().justRevealed.map((j) => j.until)].filter((v): v is number => v !== null);
    return marks.length === 0 ? null : Math.min(...marks);
  };
  let deadline: number | null = null;

  return {
    el: panel,
    invalidate() {
      dirty = true;
    },
    step(nowMs) {
      if (deadline !== null && nowMs >= deadline) {
        if (override !== null && nowMs >= override.untilMs) override = null;
        if (glowUntilMs !== null && nowMs >= glowUntilMs) {
          glowUntilMs = null;
          panel.classList.remove("cel1", "cel2", "cel3", "cel4");
        }
        for (const [id, until] of hits) if (nowMs >= until) hits.delete(id);
        dirty = true;
      }
      if (dirty) render(nowMs);
    },
    hit(outcomeId, nowMs) {
      hits.set(outcomeId, nowMs + HIT_MS);
      rows.get(outcomeId)?.classList.add("hit");
      deadline = nextDeadline();
    },
    now(now, nowMs, holdMs = NOW_HOLD_MS) {
      override = { now, untilMs: nowMs + holdMs };
      setNow(now);
      deadline = nextDeadline();
    },
    celebrate(intensity, nowMs) {
      const level = celebrationLevel(intensity);
      panel.classList.remove("cel1", "cel2", "cel3", "cel4");
      panel.classList.add(`cel${level}`);
      glowUntilMs = nowMs + CELEBRATE_BASE_MS + level * CELEBRATE_STEP_MS;
      deadline = nextDeadline();
      dirty = true; // the model's fader value changed with the contribution; a plain (non-crossing) tip has no other beat to re-render on
    },
  };
}
