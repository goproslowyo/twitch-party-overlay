/**
 * The landing pads (ported from the prototype's `computePads` and the LED tiles in
 * `makeFloor.draw`): one pill tile per live Outcome of an open tier, coloured by tier, glyph + `×N` only — never a
 * name. Club-deck: width ∝ the stock left. Theme Sheet (`equal`): every slot the same width — the boards' strip of equal
 * tiles, so nothing grows with the stock — and the strip's tail is one anonymous `lock` pad per Outcome of the
 * NEXT Tier (`lockPads`; the rule is never to name them, only count them), which turn into live pads with the `new` wash
 * in place when that Tier opens (same ids, same slots). A used-up pad greys out with a DONE tag and collapses so the rest
 * expand; while anyone is in the air the layout is FROZEN (a landing spot must not shift under a jumper), so a used-up
 * pad keeps its place until the thaw, and a tier dealt in meanwhile only gets pads if the strip has room it is not
 * using — the width the lock tile vacates when the last tier opens — appended at that end, never moving what is there.
 * `PadLayout` is the pure part — eased widths and positions on the loop's `k` — and `drawPads` paints it: club-deck as
 * the LED pills; with a Theme Sheet as the boards' extruded chrome tiles at ONE draw scale per tile (`k = slot / face`,
 * so no tile is stretched) — the `plate` squashed to a flat shadow under, `pad-halo` (additive), front + top faces
 * tinted the tier, `pad-gloss`, and per state the gold `under` ring while a jumper heads for it, the gold `hit` face on
 * the landing blink, the white `new` wash for 25 s after a Tier reveal, the grey `done` tile, the lockTile-dark `lock`
 * with its dashed rim in the Tier's colour and a 🔒 (`padSprites`). The glyph, the `×N`, DONE and the gold
 * `TIER n · N HIDDEN / N UNLOCKS AWAY` label under the lock run (`drawLockLabel`) stay text at runtime, whichever floor.
 */
import type { Theme } from "../../config/schema.ts";
import type { OverlayOutcome } from "../../server/overlay.ts";
import { DONE, compactCount } from "../copy.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import { glyph, roundRect } from "./util.ts";

export interface PadSource {
  id: string;
  tier: number;
  glyph: string;
  left: number;
  /** A lock pad: an Outcome of the next Tier, anonymous (sheet strips only). */
  locked?: boolean;
}

export interface Pad extends PadSource {
  x: number;
  w: number;
  /** Stock left: a DONE pad stays in the strip, greyed. */
  live: boolean;
  /** The shuffle: how far the tile is lifted off the floor right now. */
  lift: number;
  /** A jumper in the air is heading here (the Scene marks it each frame). */
  under?: boolean;
  /** The reveal wash's remaining share, 1 → 0 over 25 s after its Tier opened; 0 or absent = none. */
  fresh?: number;
}

const WIDTH_RATE = 0.08;
/** The share of the remaining slide taken per frame; the shuffle hands `update` a slower one. */
export const SLIDE_RATE = 0.14;
/** Vacated strip width below this is not worth a pad. */
const APPEND_MIN_PX = 3;
const PAD_RADIUS = 14;
const TILE_RADIUS = 11;
/** The strip sits this far under `gy` (scene.ts PAD_STRIP_DOWN); the club pill's centre is at gy + 6 + th / 2 and the sheet tile's top face is centred there too. */
const STRIP_DOWN = 4;
// the sheet's tile faces at 1× (scripts/sprites/draw.ts PAD_*): the top is 118 wide + a 14 px skew, 62 tall (the front 118 × 18 hangs under it);
// both Anchors sit at the front edge's centre, 59 px in from the face's left
const FACE_W = 132;
const FACE_H = 62;
const FRONT_H = 18;
const TOP_W = 118;
const ANCHOR_IN = 59;
const SKEW = 14;
/** Each tile keeps this much off its slot's edges. */
const TILE_GAP = 3;
const MIN_K = 0.05;
/** The boards' flat shadow: the `plate` (radius 128) squashed to rx ≈ 0.62 × the top's width, ry = 14 × the tile scale, 6 × k under the front face. */
const PLATE_R = 128;
const SHADOW_RX = 0.7 * TOP_W;
const SHADOW_RY = 14;
const SHADOW_DOWN = 6;
const SHADOW_ALPHA = 0.5;
/** The halo is wider than the tile it wraps (180 × 40 frame vs the 132 face), a little under the top face's centre. */
const HALO_K = 0.9;
const HALO_DOWN = 10;
const DONE_GREY = "#8a86a0";
const NEW_WASH_ALPHA = 0.85;
const LOCK_GLYPH_K = 22;
const LABEL_GAP = 26;
const LABEL_LEADING = 14;

/** The outcomes that get a pad: open tiers, unmasked, status live (a suspended/retired one leaves the strip), pool order. */
export function livePads(outcomes: readonly OverlayOutcome[], tier: number): PadSource[] {
  const out: PadSource[] = [];
  for (const o of outcomes) {
    if (o.tier > tier || o.name === null || o.status !== "live") continue;
    out.push({ id: o.id, tier: o.tier, glyph: o.glyph, left: o.left });
  }
  return out;
}

/** The strip's tail on a sheet: one anonymous lock pad per Outcome of the NEXT Tier (`tier + 1`) — the masked glyph, never a name. */
export function lockPads(outcomes: readonly OverlayOutcome[], tier: number): PadSource[] {
  const out: PadSource[] = [];
  for (const o of outcomes) {
    if (o.tier !== tier + 1) continue;
    out.push({ id: o.id, tier: o.tier, glyph: o.glyph, left: o.left, locked: true });
  }
  return out;
}

interface Slot {
  pad: Pad;
  /** Eased width share (before normalising to the strip). */
  share: number;
  /** Eased left edge. */
  x: number;
  /** Where the left edge is heading — the last laid-out position; a frozen strip keeps sliding here. */
  tx: number;
}

export class PadLayout {
  /** The pads in strip order; the array is reused frame to frame (a new one only when the set of ids changes). */
  pads: Pad[] = [];
  #slots = new Map<string, Slot>();
  #inited = false;

  /**
   * Advance one frame (`k` = dt / 16.67) toward the layout `live` asks for inside `strip` — in `live`'s order, so a
   * shuffle is a permuted list. `frozen` keeps every width, every target position and the order of the pads as they
   * were, refreshing only each pad's left / live flag — a tile still sliding when the freeze came finishes its
   * slide, so nothing overlaps under a jumper; ids new to a frozen strip are appended into the width the strip has
   * gained (`#appendFrozen`), or wait for the thaw. `slideRate` is the share of the remaining slide taken this frame.
   * `equal` (the sheet) gives every pad with anything to show — stock left, or locked — the same slot instead of a
   * share ∝ its stock; a DONE pad's slot still collapses.
   */
  update(live: readonly PadSource[], strip: { x: number; w: number }, k: number, frozen: boolean, slideRate = SLIDE_RATE, equal = false): Pad[] {
    if (frozen && this.#inited) {
      const fresh = live.filter((src) => !this.#slots.has(src.id));
      if (fresh.length > 0) this.#appendFrozen(fresh, strip, equal);
      for (const src of live) {
        const slot = this.#slots.get(src.id);
        if (slot !== undefined) {
          slot.pad.left = src.left;
          slot.pad.live = src.left > 0;
          slot.pad.locked = src.locked === true;
          slot.pad.glyph = src.glyph;
        }
      }
      for (const slot of this.#slots.values()) {
        slot.x += (slot.tx - slot.x) * Math.min(1, slideRate * k);
        slot.pad.x = slot.x;
      }
      return this.pads;
    }
    const total = live.reduce((a, o) => a + o.left, 0);
    const shown = live.reduce((a, o) => a + (o.left > 0 || o.locked === true ? 1 : 0), 0);
    let changed = false;
    for (const src of live) {
      const target = equal ? (src.left > 0 || src.locked === true ? 1 / Math.max(1, shown) : 0) : total > 0 ? src.left / total : 0;
      let slot = this.#slots.get(src.id);
      if (slot === undefined) {
        slot = { pad: { ...src, locked: src.locked === true, x: strip.x, w: 0, live: src.left > 0, lift: 0 }, share: this.#inited ? 0 : target, x: strip.x, tx: strip.x };
        this.#slots.set(src.id, slot);
        changed = true;
      }
      slot.share = this.#inited ? slot.share + (target - slot.share) * Math.min(1, WIDTH_RATE * k) : target;
      slot.pad.left = src.left;
      slot.pad.live = src.left > 0;
      slot.pad.locked = src.locked === true;
      slot.pad.glyph = src.glyph;
      slot.pad.tier = src.tier;
    }
    if (this.#slots.size !== live.length) {
      const keep = new Set(live.map((o) => o.id));
      for (const id of this.#slots.keys()) if (!keep.has(id)) this.#slots.delete(id);
      changed = true;
    }
    if (changed || live.some((o, i) => this.pads[i]?.id !== o.id)) this.pads = live.map((o) => this.#slots.get(o.id)!.pad); // strip order = the list's order, permuted by a shuffle
    const sum = live.reduce((a, o) => a + this.#slots.get(o.id)!.share, 0) || 1;
    let x = strip.x;
    for (const o of live) {
      const slot = this.#slots.get(o.id)!;
      const w = (slot.share / sum) * strip.w;
      slot.tx = x;
      slot.x = this.#inited ? slot.x + (x - slot.x) * Math.min(1, slideRate * k) : x;
      slot.pad.x = slot.x;
      slot.pad.w = w;
      x += w;
    }
    this.#inited = true;
    return this.pads;
  }

  /**
   * New pads for a frozen strip: laid edge to edge, ∝ the stock left, into the free width at whichever end the strip has
   * more of (the lock tile's, on the rack's side) — the pads already there keep their place and width exactly. With
   * no free width they wait for the thaw.
   */
  #appendFrozen(fresh: readonly PadSource[], strip: { x: number; w: number }, equal: boolean): void {
    let left = strip.x + strip.w;
    let right = strip.x;
    for (const slot of this.#slots.values()) {
      left = Math.min(left, slot.tx);
      right = Math.max(right, slot.tx + slot.pad.w);
    }
    const roomR = strip.x + strip.w - right;
    const roomL = left - strip.x;
    const atRight = roomR >= roomL;
    const room = atRight ? roomR : roomL;
    if (room < APPEND_MIN_PX) return;
    const total = fresh.reduce((a, o) => a + o.left, 0);
    let x = atRight ? right : strip.x;
    const added: Pad[] = [];
    for (const src of fresh) {
      const w = (equal || total <= 0 ? 1 / fresh.length : src.left / total) * room;
      const pad: Pad = { ...src, locked: src.locked === true, x, w, live: src.left > 0, lift: 0 };
      this.#slots.set(src.id, { pad, share: w / strip.w, x, tx: x });
      added.push(pad);
      x += w;
    }
    this.pads = atRight ? [...this.pads, ...added] : [...added, ...this.pads];
  }
}

export type PadState = "live" | "under" | "hit" | "lock" | "new" | "done";

export interface PadSprites {
  top: string;
  front: string;
  /** Drawn over the top face after the gloss: the gold ring, the white wash, the dashed lock rim. */
  over: string | null;
  /** Drawn over the front face: the gold ring's front. */
  overFront: string | null;
}

const PAD_SPRITES: Readonly<Record<PadState, PadSprites>> = {
  live: { top: "pad-top-live", front: "pad-front-live", over: null, overFront: null },
  under: { top: "pad-top-live", front: "pad-front-live", over: "pad-top-under", overFront: "pad-front-under" },
  hit: { top: "pad-top-hit", front: "pad-front-live", over: null, overFront: null },
  lock: { top: "pad-top-live", front: "pad-front-lock", over: "pad-top-lock", overFront: null },
  new: { top: "pad-top-live", front: "pad-front-live", over: "pad-top-new", overFront: null },
  done: { top: "pad-top-done", front: "pad-front-done", over: null, overFront: null },
};

/** The sheet frames a pad in `state` is built from. */
export const padSprites = (state: PadState): PadSprites => ({ ...PAD_SPRITES[state] });

/** A pad's state this frame: locked first, then used up, then the landing blink, then the ring under a jumper, then the reveal wash. */
export function padState(p: Pad, flashId: string | null): PadState {
  if (p.locked === true) return "lock";
  if (!p.live) return "done";
  if (p.id === flashId) return "hit";
  if (p.under === true) return "under";
  if ((p.fresh ?? 0) > 0) return "new";
  return "live";
}

/**
 * Where a slot's tile sits: ONE draw scale `k` fitting the face's width to the slot (capped so the tile is never taller
 * than the strip), the tile centred in its slot with its top face centred on the touchdown line (gy + 6 + th / 2), and
 * the Anchor (the front edge's centre) that puts it there.
 */
export function tilePlacement(p: Pad, gy: number, th: number): { cx: number; y: number; k: number } {
  const k = Math.max(MIN_K, Math.min((p.w - 2 * TILE_GAP) / FACE_W, th / FACE_H));
  return { cx: p.x + p.w / 2 - (FACE_W / 2 - ANCHOR_IN) * k, y: gy - p.lift + STRIP_DOWN + 2 + th / 2 + (FACE_H * k) / 2, k };
}

export interface PadHalo {
  x: number;
  y: number;
  /** The tile's draw scale (`tilePlacement`); the halo frame draws at `k × HALO_K`. */
  k: number;
  colour: string;
  alpha: number;
}

/**
 * The `pad-halo` a pad wears this frame on the sheet — a little under the top face's centre, in the tier's colour
 * (gold for the landing blink, a grey ember when DONE), brighter with the energy; none for a lock pad. Shared by
 * `drawPads` and the light layer's neon points, so the bloom sits exactly where the halo is.
 */
export function padHalo(p: Pad, st: PadState, theme: Theme, gy: number, th: number, energy: number): PadHalo | null {
  if (st === "lock") return null;
  const { cx, y, k } = tilePlacement(p, gy, th);
  const colour = st === "done" ? DONE_GREY : st === "hit" ? theme.gold : (theme.tiers[p.tier] ?? theme.accent);
  const alpha = st === "done" ? 0.22 : st === "hit" ? 0.95 : 0.55 + 0.25 * energy;
  return { x: cx + (SKEW / 2) * k, y: y - (FACE_H / 2 - HALO_DOWN) * k, k, colour, alpha };
}

/**
 * The tiles on the floor, lifted by `lift` while a shuffle moves them; the pad `flashId` names carries the landing
 * blink. Club-deck: base slab, tier-coloured pill, bottom stripe, glyph, `×N`; grey + DONE when used up. Sheet: plates,
 * then the halos (additive), then per pad its front and top faces, the gloss and the state's overlay; the words after.
 */
export function drawPads(ctx: CanvasRenderingContext2D, theme: Theme, pads: readonly Pad[], gy: number, th: number, energy: number, flashId: string | null = null, sprites: SpriteSet | null = null, spec: LevelSpec | null = null): void {
  if (sprites !== null && spec !== null) {
    drawSheetPads(ctx, theme, pads, gy, th, energy, flashId, sprites, spec);
    return;
  }
  for (const p of pads) {
    if (p.w < 3) continue;
    const tierColor = theme.tiers[p.tier] ?? theme.accent;
    const y = gy - p.lift;
    ctx.fillStyle = theme.floor[0] ?? theme.panel;
    roundRect(ctx, p.x + 2, y + 4, p.w - 4, th + 4, PAD_RADIUS);
    ctx.fill();
    const flash = p.id === flashId;
    ctx.fillStyle = flash ? "#fff" : p.live ? tierColor : "rgba(255,255,255,.10)";
    ctx.globalAlpha = flash ? 1 : p.live ? 0.6 + 0.15 * energy : 0.9;
    roundRect(ctx, p.x + 6, y + 8, p.w - 12, th - 4, TILE_RADIUS);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (p.live) {
      ctx.fillStyle = tierColor;
      ctx.fillRect(p.x + 12, y + th - 2, Math.max(0, p.w - 24), 4);
      if (p.w > 30) glyph(ctx, p.glyph, p.x + p.w / 2, y + 8 + (th - 4) / 2 - 2, Math.min(24, p.w * 0.5));
      if (p.left > 1 && p.w > 56) {
        ctx.font = "800 11px ui-monospace, monospace";
        ctx.fillStyle = "#000";
        ctx.textAlign = "right";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(compactCount(p.left), p.x + p.w - 12, y + 21);
      }
    } else if (p.w > 40) {
      ctx.font = "800 9px ui-monospace, monospace";
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(DONE, p.x + p.w / 2, y + 8 + (th - 4) / 2 + 2);
    }
  }
}

function drawSheetPads(ctx: CanvasRenderingContext2D, theme: Theme, pads: readonly Pad[], gy: number, th: number, energy: number, flashId: string | null, sprites: SpriteSet, spec: LevelSpec): void {
  const s = spec.spriteScale;
  const shown = pads.filter((p) => p.w >= 3);
  const tierColour = (p: Pad): string => theme.tiers[p.tier] ?? theme.accent;
  const tint = (p: Pad, st: PadState): string => (st === "hit" ? theme.gold : st === "lock" ? theme.lockTile : tierColour(p)); // `under` keeps its tier face: only the ring is gold
  // the flat shadows first, under every glow group
  for (const p of shown) {
    const { cx, y, k } = tilePlacement(p, gy, th);
    ctx.save();
    ctx.translate(cx + (SKEW / 2) * k, y + (FRONT_H + SHADOW_DOWN) * k);
    ctx.scale((SHADOW_RX * k) / PLATE_R, (SHADOW_RY * k) / PLATE_R);
    sprites.draw(ctx, "plate", s, 0, 0, { alpha: SHADOW_ALPHA });
    ctx.restore();
  }
  ctx.globalCompositeOperation = "lighter";
  for (const p of shown) {
    const h = padHalo(p, padState(p, flashId), theme, gy, th, energy);
    if (h === null) continue; // a lock pad does not glow
    sprites.draw(ctx, "pad-halo", s, h.x, h.y, { colour: h.colour, alpha: h.alpha, k: h.k * HALO_K });
  }
  ctx.globalCompositeOperation = "source-over";
  for (const p of shown) {
    const st = padState(p, flashId);
    const n = padSprites(st);
    const { cx, y, k } = tilePlacement(p, gy, th);
    const faceTint = st === "done" ? undefined : tint(p, st);
    sprites.draw(ctx, n.front, s, cx, y, { colour: faceTint, k });
    sprites.draw(ctx, n.top, s, cx, y, { colour: faceTint, k });
    if (st !== "done") sprites.draw(ctx, "pad-gloss", s, cx, y, { k });
    if (n.over !== null) sprites.draw(ctx, n.over, s, cx, y, st === "new" ? { colour: "#ffffff", alpha: NEW_WASH_ALPHA * (p.fresh ?? 0), k } : { colour: st === "lock" ? tierColour(p) : theme.gold, k });
    if (n.overFront !== null) sprites.draw(ctx, n.overFront, s, cx, y, { colour: theme.gold, k });
    const gx = cx + (SKEW / 2) * k; // the top face's centre line, half a skew right of the front's
    const gyc = y - (FACE_H * k) / 2; // the top face's centre
    const tileW = TOP_W * k;
    if (st === "lock") {
      if (tileW > 18) glyph(ctx, p.glyph, gx, gyc, Math.min(LOCK_GLYPH_K, tileW * 0.45));
    } else if (p.live) {
      if (tileW > 18) glyph(ctx, p.glyph, gx, gyc, Math.min(24, tileW * 0.55));
      if (p.left > 1 && tileW > 44) {
        ctx.font = "800 11px ui-monospace, monospace";
        ctx.fillStyle = "#000";
        ctx.textAlign = "right";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(compactCount(p.left), cx + (ANCHOR_IN + SKEW / 2) * k, y - FACE_H * k + 12);
      }
    } else if (tileW > 34) {
      ctx.font = "800 9px ui-monospace, monospace";
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(DONE, gx, gyc + 3);
    }
  }
}

/** The gold lines under the run of lock pads at the strip's end (`TIER n · N HIDDEN` / `N UNLOCKS AWAY`), centred on the run; nothing without a lock pad. */
export function drawLockLabel(ctx: CanvasRenderingContext2D, theme: Theme, pads: readonly Pad[], gy: number, th: number, lines: readonly string[]): void {
  const locks = pads.filter((p) => p.locked === true && p.w >= 3);
  if (locks.length === 0) return;
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  for (const p of locks) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x + p.w);
  }
  const { y, k } = tilePlacement(locks[0]!, gy, th);
  const cx = (x0 + x1) / 2;
  let ly = y + FRONT_H * k + LABEL_GAP;
  ctx.font = "800 11px ui-monospace, monospace";
  ctx.fillStyle = theme.gold;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (const line of lines) {
    ctx.fillText(line, cx, ly);
    ly += LABEL_LEADING;
  }
}
