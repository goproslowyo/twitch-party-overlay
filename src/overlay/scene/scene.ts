/**
 * The club scene on the one 2-D canvas (ported from the prototype's `makeParty`):
 * towers, the full-width dancefloor that continues under the rack, the pads, the backstage lock tile, the beams, the
 * windsock, the patrolling blimp and its sign — and, over all of it, the drop (`drop.ts`: wind, jumpers, reveals,
 * shuffle, celebrations). `sceneLayout` is the pure geometry — every x mirrored when the rack is on the left — and
 * `Scene` holds the motion state behind the scene interface: `step(tMs, dtMs)` advances everything on the loop's
 * clock only (the pads and towers move against the last drawn `View`) and returns the drop's moments for main.ts to
 * play (a reveal, the drained pool); `draw(view, tMs)` paints the `View` with the skin's theme and config. It never
 * reads a clock, never sets a filter, and every word it paints comes from copy.ts. The pads freeze while anyone is in
 * the air and through the reveals (`setDropsInAir` can hold them too); `wind` is the hook the windsock reads. The
 * Quality Level arrives as a `LevelSpec` thunk and is read where it is spent — the particle cap at a burst,
 * the sweeps / lasers / smoke knobs and the Sheet Scale at each draw. The Theme Sheet's sprites arrive as a thunk too
 * (null while decoding or for a procedural Theme): every module keeps its club-deck drawing when it is null
 * and paints the boards' Chrome Lounge when it is not — nothing branches on the Theme's identity, only on the sheet.
 * On the sheet there is no lock tile and no lock zone: the strip is equal slots (`PadLayout` `equal`) whose tail is one
 * anonymous lock pad per Outcome of the next Tier (`lockPads`), with the gold `TIER n · N HIDDEN / N UNLOCKS AWAY`
 * under that run (`drawLockLabel`); the club-deck keeps its tile. The sheet's moving pieces come from the same set:
 * the airship hangs no `$X of $Y` sign (a Celebration never prints a dollar figure — the rack carries the number), the
 * windsock stands beside the outer TIER 0 tower on the rack's far side (`windsockAt`), and `thank(tMs)` lays the
 * `thanks-glow` behind the Acknowledgement line for a second (a plate first, then additive). The room — the floor,
 * Dancers, towers, smoke, beams, lasers and windsock — paints at `config.floorOpacity`: straight onto the stage at 100,
 * else onto one Scene-owned room canvas that is blitted at that alpha (twice a frame: under the pads, then over them),
 * and not at all at 0; the pads, the drop, the airship and the motes never dim, and the light layer's laser and
 * tower-head bloom follow (`lights`).
 */
import { FLOOR_PERCENT_DEFAULT } from "../../config/schema.ts";
import type { Mote, OverlaySkin } from "../../server/overlay.ts";
import { DRAINED, lockedTile, tierName } from "../copy.ts";
import type { LightSources } from "../light/layer.ts";
import type { LevelSpec } from "../quality.ts";
import type { SpriteSet } from "../sprites.ts";
import type { View } from "../state.ts";
import { PATROL_Y, SHIP_LIGHT_R, SIGN_W, brandFace, createPatrol, drawBlimp, drawSign, passengers, shipLightAlpha, shipLightAt, type Patrol } from "./blimp.ts";
import { CEL_ENERGY_PER_TIER, Dancers, sweepPools } from "./dancers.ts";
import { Drop, type DropEvent, type DropFrame, type Fire } from "./drop.ts";
import type { Jumper } from "./jumper.ts";
import { Motes, jumperOrbit, moteSky, type MoteFrame } from "./motes.ts";
import { CLUB_LABEL_MS, Energy, createCrowd, createSmoke, crowdPhaseStep, drawFloor, drawLockTile, drawSmoke, floorGeometry, floorK, stepSmoke, type Dancer, type FloorCache, type SmokePuff } from "./floor.ts";
import { PadLayout, drawLockLabel, drawPads, livePads, lockPads, padHalo, padState, type Pad } from "./pads.ts";
import { particleLook, particleTints } from "./particles.ts";
import { TOWER_FOOT, TOWER_W, clubTowerTop, createTowers, drawBeams, drawLasers, drawTowerBodies, laserFans, sheetTowerX, stepTowers, towerColour, towerHead, towerX, type Tower, type TowerFrame } from "./towers.ts";
import { clamp, seededRandom, unitRgb } from "./util.ts";
import { POLE_H, drawWindsock, sheetSockTop } from "./windsock.ts";

export type { DropEvent, Fire } from "./drop.ts";

export interface SceneGeometry {
  /** The landing-pad strip over the floor, in canvas pixels. */
  padStrip: { x: number; y: number; w: number; h: number };
  /** Where a jumper leaves the blimp; `facing` is the blimp's heading (1 = right). */
  door: { x: number; y: number; facing: 1 | -1 };
  /** The top edge of the dancefloor. */
  floorTop: number;
}

export interface SceneLayout {
  flip: boolean;
  /** The floor's edges: the full frame width less the margins, under the rack on both sides. */
  floorX0: number;
  floorX1: number;
  /** The scene's own span beside the rack. */
  sceneL: number;
  sceneR: number;
  /** The ground line the prototype called `groundY`; the slab spans floorTop … floorBottom around it. */
  gy: number;
  floorTop: number;
  floorBottom: number;
  padStrip: { x: number; w: number };
  /** The backstage lock tile, on the rack's side of the pads; null when every tier is open — and always on a sheet, where the lock pads are the strip's. */
  lock: { x: number; w: number } | null;
  towerX: number[];
  windsockX: number;
  patrol: { min: number; max: number; home: number; facing: 1 | -1 };
  /** The sheet floor's lit horizon and vanishing point (`floorGeometry` at the config's floor share; the x mirrors with the rack). */
  horizonY: number;
  vanish: { x: number; y: number };
}

const FRAME_MARGIN = 40;
const RACK_MARGIN = 40 + 60; // the rack's 40 px inset plus the gap the scene keeps from it (the prototype's rackSpan)
const RACK_GAP = 10;
const TOWER_ZONE = 150;
const PAD_INSET = 30;
const LOCK_ZONE = 150;
const LOCK_PAD = 10;
const GROUND_FROM_BOTTOM = 112;
const SLAB_ABOVE = 6;
const SLAB_H = 100;
const WINDSOCK_IN = 4;
const WINDSOCK_UP = 120;
const PATROL_INSET = 230;
const PATROL_HOME = 330;
const PATROL_TOWERS = 6;
const FRAME_MS = 1000 / 60;
const SEED = 0x5eed;
const DROP_SEED = 0xd20;
/** The sky line the wind field and the descent are measured from (the prototype's `skyY`). */
export const SKY_Y = 60;
const PAD_STRIP_DOWN = 4;
const CEL_BASE_MS = 2500;
const CEL_SPAN_MS = 4500;
const CEL_BOUNCE_PX = 3;
const LASER_RATE = 0.03;
const LASERS_FROM_TIER = 3;
/** A Tier's new pads wear the reveal wash this long. */
const NEW_PAD_MS = 25_000;
/** The fireworks band (task-99 MUST 5): from this far under the sky line (the airship patrols at ~120) down to this far above the tallest tower head. */
const FIREWORK_UNDER_SKY = 80;
const FIREWORK_ABOVE_HEADS = 40;
const FIREWORK_BAND_MIN = 60;
/** The sheet windsock's pole stands this far in from the outer tower's inner edge. */
const WINDSOCK_BESIDE = 14;
/** The thanks-glow's life: one second, fading out. */
export const THANKS_GLOW_MS = 1000;
/**
 * `#thanks` in styles.css: `left: 50% ∓ (rackW / 2 + 50)`; `top: 70%` with `translate(-50%, 0)` when shown, so 70 % is the
 * box's TOP edge — the box is 24 px 800-weight system-ui text (~29 px line box) + 10 px padding × 2 + 2 px border × 2
 * ≈ 53 px tall, so its centre is THANKS_LINE_HALF_H under that. The glow is centred on the line's centre.
 */
const THANKS_LINE_Y = 0.7;
const THANKS_LINE_HALF_H = 26;
const THANKS_SHIFT_PX = 50;
/** The plate under the `lighter` glow: `plate` is 256 px, `thanks-glow` 512, so k 2 keeps every additive pixel on the plate. */
const THANKS_PLATE_K = 2;
const THANKS_PLATE_ALPHA = 0.6;
const THANKS_GLOW_ALPHA = 1;
// ---- the light layer's sources. Mirrors of layer.ts's PARTICLE_LEVEL / BLOOM_LEVEL / PARTICLE_STRIDE, pinned equal
// by scene.test.ts: the scene takes only types from light/, so the WebGL module stays out of its graph when WebGL is off.
/** From this level the layer draws particles; below it `lights()` hands over nothing. */
export const LIGHT_PARTICLE_LEVEL = 3;
/** From this level the layer draws bloom too; at Level 3 no segment or point is built (the layer would discard them). */
export const LIGHT_BLOOM_LEVEL = 4;
/** Floats per particle in `LightSources.particles`: x, y, size, r, g, b, a. */
export const LIGHT_PARTICLE_STRIDE = 7;
/**
 * Bloom strengths, each a share of the 2-D alpha it sits over — the additive halo must read wider and dimmer than the
 * stroke or lamp it wraps, never a white-out over the lasers or the heads (tuned by eye in a browser check).
 */
const LASER_BLOOM = 0.35;
const HEAD_BLOOM = 0.55;
const SHIP_LIGHT_BLOOM = 0.5;
const PAD_BLOOM = 0.3;
const PARTICLE_BLOOM = 0.4;
const SPARK_BLOOM = 0.45;
/** The `tower-head` lamp: 30 tall at HEAD_K 0.7 → a 10 px disc. */
const HEAD_LAMP_R = 10;
/** A pad's neon as a point radius at tile scale 1 — a soft pool under the halo frame (180 × 40), not a second halo. */
const PAD_HALO_R = 18;
/** A particle's glow sprite over its 2-D frame, and a firework spark's over its 2–4 px radius. */
const PARTICLE_GLOW_K = 1.6;
const SPARK_GLOW_K = 5;
const EMPTY_PARTICLES = new Float32Array(0);
const WHITE_RGB: readonly [number, number, number] = [1, 1, 1];

/** Every x of the scene for a `w × h` canvas with the rack on `side`, the sheet's floor `floorShare` of the height from the bottom (`overlay.floorPercent` / 100). */
export function sceneLayout(w: number, h: number, side: "left" | "right", rackWidth: number, lockVisible: boolean, floorShare = FLOOR_PERCENT_DEFAULT / 100): SceneLayout {
  const flip = side === "left";
  const rackSpan = rackWidth + RACK_MARGIN;
  const sceneL = flip ? rackSpan + RACK_GAP : FRAME_MARGIN;
  const sceneR = flip ? w - FRAME_MARGIN : w - rackSpan - RACK_GAP;
  const lockW = lockVisible ? LOCK_ZONE : 0;
  const padW = sceneR - sceneL - 2 * TOWER_ZONE - 2 * PAD_INSET - lockW;
  const padX = flip ? sceneL + TOWER_ZONE + PAD_INSET + lockW : sceneL + TOWER_ZONE + PAD_INSET;
  const lock = lockVisible ? { x: flip ? sceneL + TOWER_ZONE + PAD_INSET + LOCK_PAD : padX + padW + LOCK_PAD, w: LOCK_ZONE - 2 * LOCK_PAD } : null;
  const gy = h - GROUND_FROM_BOTTOM;
  const towers: number[] = [];
  for (let i = 0; i < PATROL_TOWERS; i++) towers.push(towerX({ sideI: i < 3 ? 0 : 1, tier: i % 3 } as Tower, sceneL, sceneR));
  return {
    flip,
    floorX0: FRAME_MARGIN,
    floorX1: w - FRAME_MARGIN,
    sceneL,
    sceneR,
    gy,
    floorTop: gy - SLAB_ABOVE,
    floorBottom: gy - SLAB_ABOVE + SLAB_H,
    padStrip: { x: padX, w: Math.max(0, padW) },
    lock,
    towerX: towers,
    windsockX: flip ? sceneL + TOWER_ZONE + WINDSOCK_IN : sceneR - TOWER_ZONE - WINDSOCK_IN,
    patrol: { min: sceneL + PATROL_INSET, max: sceneR - PATROL_INSET, home: flip ? w - PATROL_HOME : PATROL_HOME, facing: flip ? -1 : 1 },
    ...floorGeometry(w, h, flip, floorShare),
  };
}

/** The celebration's crowd tier from its intensity: 4 from 0.7, 3 from 0.45 (lasers), 2 from 0.2, else 1. */
export const celebrationTier = (i: number): number => (i >= 0.7 ? 4 : i >= 0.45 ? 3 : i >= 0.2 ? 2 : 1);

export class Scene {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D;
  readonly #skin: () => OverlaySkin;
  readonly #quality: () => LevelSpec;
  readonly #sprites: () => SpriteSet | null;
  readonly #rng = seededRandom(SEED);
  readonly #crowd: Dancer[];
  readonly #towers: Tower[];
  readonly #energy = new Energy();
  readonly #pads = new PadLayout();
  readonly #drop: Drop;
  /** The far floor's roster: built on the first step with a sheet, from the scene's own rng; the club-deck keeps its crowd, its centre bobbers wearing the roster's heads. */
  #dancers: Dancers | null = null;
  /** The club-deck's Hops: key → the Hop's start `tMs`; forgotten CLUB_LABEL_MS later in `step` (the plate's 4 s outlives the 500 ms lift). */
  readonly #clubHops = new Map<string, number>();
  /** The Contributor Motes on their own child rng, and the decoded Avatar Picture for a mote (null = draw the glyph). */
  readonly #motes: Motes;
  readonly #avatarImage: (m: Mote) => CanvasImageSource | null;
  readonly #chatterImage: (url: string | null) => CanvasImageSource | null;
  readonly #smoke: SmokePuff[] = createSmoke();
  /** The baked sheet floor for the current resolution and skin; the canvas comes from the stage's document on first use. */
  readonly #floorCache: FloorCache = { canvas: null, width: 0, height: 0, key: "" };
  /** The room's own canvas when `floorOpacity` is under 100 (made once, sized with the stage); null until needed or when the document can't make one. */
  #room: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null = null;
  /** The Tier whose new pads wear the reveal wash, and until when. */
  #fresh: { tier: number; until: number } | null = null;
  #patrol: Patrol | null = null;
  #width = 0;
  #super = 1;
  #height = 0;
  #k = 0;
  #crowdPhase = 0;
  #dropsInAir = 0;
  /** The last drawn view: what the pads and towers move against in `step`. */
  #view: View | null = null;
  /** The celebration under way: its crowd tier until `until`. */
  #cel = { until: 0, tier: 0 };
  #lasers = 0;
  /** Whether the last drawn view had a tier still to open — the layout the geometry answers with until the next draw. */
  #lockVisible = true;
  /** When the last Acknowledgement line landed — the sheet's glow runs THANKS_GLOW_MS from it. */
  #thanksAt: number | null = null;
  /** The `tMs` of the last `draw` — `lights()` answers for that frame (the sway, the swell, the blink). */
  #drawnAt = 0;
  /** The particle buffer `lights()` fills, grown to fit and reused every frame. */
  #particleBuf = EMPTY_PARTICLES;
  /** The mean ground wind from the drop's field — the windsock reads it every frame. */
  wind: () => { x: number; y: number } = () => ({ x: this.#drop.wind.ground(), y: 0 });

  constructor(canvas: HTMLCanvasElement, skin: () => OverlaySkin, quality: () => LevelSpec, sprites: () => SpriteSet | null = () => null, avatarImage: (m: Mote) => CanvasImageSource | null = () => null, chatterImage: (url: string | null) => CanvasImageSource | null = () => null) {
    this.#canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("overlay: the stage has no 2-D context");
    this.#ctx = ctx;
    this.#skin = skin;
    this.#quality = quality;
    this.#sprites = sprites;
    this.#crowd = createCrowd(this.#rng);
    this.#towers = createTowers(this.#rng);
    this.#drop = new Drop(seededRandom(DROP_SEED), () => skin().config, () => skin().theme, quality);
    this.#motes = new Motes(seededRandom(SEED + 2), () => skin().config.intensityAnchorCents);
    this.#avatarImage = avatarImage;
    this.#chatterImage = chatterImage;
  }

  /**
   * `width` × `height` are LOGICAL pixels — the 1080p space every constant in this file is written against.
   * `supersample` is how many real pixels back each of them: the backing store is that much bigger and a single
   * transform, re-applied each frame because `canvas.width =` resets it, keeps the drawing code in logical space.
   */
  resize(width: number, height: number, supersample = 1): void {
    this.#width = width;
    this.#height = height;
    this.#super = supersample;
    this.#canvas.width = Math.max(1, Math.round(width * supersample));
    this.#canvas.height = Math.max(1, Math.round(height * supersample));
    if (this.#room !== null) {
      this.#room.canvas.width = this.#canvas.width;
      this.#room.canvas.height = this.#canvas.height;
    }
  }

  /** Logical space → backing store. `setTransform` replaces rather than multiplies, so repeating it is safe. */
  #toLogical(ctx: CanvasRenderingContext2D): void {
    if (typeof ctx.setTransform === "function") ctx.setTransform(this.#super, 0, 0, this.#super, 0, 0);
  }

  /** The room's opacity from the config, 0..1. */
  #opacity(): number {
    return clamp(this.#skin().config.floorOpacity / 100, 0, 1);
  }

  /** The room canvas for a dimmed frame, made on first need; null where the document can't make one (then the room paints straight, undimmed). */
  #roomLayer(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
    if (this.#room !== null) return this.#room;
    const doc = this.#canvas.ownerDocument as Document | undefined;
    if (doc === undefined || typeof doc.createElement !== "function") return null;
    const canvas = doc.createElement("canvas");
    canvas.width = this.#canvas.width;
    canvas.height = this.#canvas.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return null;
    this.#room = { canvas, ctx };
    return this.#room;
  }

  /**
   * Paint one pass of the room at `opacity` over whatever is already on the stage: straight onto `ctx` at 1, skipped
   * at 0, else onto the room canvas and blitted at that alpha (the pass's own globalAlpha writes stay inside the
   * room canvas, so they compose with it).
   */
  #paintRoom(ctx: CanvasRenderingContext2D, opacity: number, paint: (target: CanvasRenderingContext2D) => void): void {
    if (opacity <= 0) return;
    const room = opacity < 1 ? this.#roomLayer() : null;
    if (room === null) {
      paint(ctx);
      return;
    }
    this.#toLogical(room.ctx);
    room.ctx.clearRect(0, 0, this.#width, this.#height);
    paint(room.ctx);
    ctx.globalAlpha = opacity;
    ctx.drawImage(room.canvas, 0, 0, this.#width, this.#height); // the room is a backing-store-sized canvas: land it on the logical box
    ctx.globalAlpha = 1;
  }

  /**
   * The room under the pads, dimmed without a layer: the stage is clear when this pass begins, so painting it
   * straight and then knocking `1 − opacity` of every pixel's alpha out with one `destination-out` rect multiplies
   * exactly the pass's alpha, the same picture as the room canvas blitted at `opacity`, minus a clear and a blit of the
   * whole frame. Only for a pass onto a cleared stage; the over-pads pass draws over the pads and keeps `#paintRoom`.
   */
  #paintRoomOnClearStage(ctx: CanvasRenderingContext2D, opacity: number, paint: (target: CanvasRenderingContext2D) => void): void {
    if (opacity <= 0) return;
    paint(ctx);
    if (opacity >= 1) return;
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = 1 - opacity;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.#width, this.#height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** The scene interface's name for `resize`. */
  layout(width: number, height: number): void {
    this.resize(width, height);
  }

  /** The layout for `view` (or the last one): the lock zone only on the club-deck with a tier still to open — on a sheet the lock pads live in the strip. */
  #layoutFor(view: Pick<View, "tier" | "gates"> | null): SceneLayout {
    const { config, theme } = this.#skin();
    if (view !== null) this.#lockVisible = view.tier + 1 < view.gates.length;
    return sceneLayout(this.#width, this.#height, config.side, config.rackWidth, this.#lockVisible && this.#sheet(theme) === null, config.floorPercent / 100);
  }

  /** The Theme Sheet's sprites when the Theme names one and it has decoded — the one thing the drawing branches on. */
  #sheet(theme: OverlaySkin["theme"]): SpriteSet | null {
    if (theme.sheet === "") return null;
    const set = this.#sprites();
    return set !== null && set.id === theme.sheet ? set : null;
  }

  /** The offscreen canvas for the baked floor, from the stage's document (none in a test without one: the floor is then baked to the frame). */
  #ensureFloorCache(): void {
    if (this.#floorCache.canvas !== null) return;
    const doc = this.#canvas.ownerDocument as Document | undefined;
    if (doc !== undefined && typeof doc.createElement === "function") this.#floorCache.canvas = doc.createElement("canvas");
  }

  #patrolFor(L: SceneLayout): Patrol {
    if (this.#patrol === null) this.#patrol = createPatrol(L.patrol.home, L.patrol.facing);
    return this.#patrol;
  }

  /** The touchdown line: the middle of the pad tiles. */
  #groundY(L: SceneLayout): number {
    return L.gy + PAD_STRIP_DOWN + (this.#skin().config.padHeight + 4) / 2;
  }

  /** What the Contributor Motes need this frame: the free sky, the wind field, the airship's centre, every jumper's rig for the orbit, whether the rack shows READY. */
  #moteFrame(L: SceneLayout, view: Pick<View, "queue">, sheet: boolean): MoteFrame {
    const patrol = this.#patrolFor(L);
    const wind = (x: number, y: number): { x: number; y: number } => {
      const w = this.#drop.wind.at(x, y);
      return { x: w.u, y: w.v };
    };
    return { ...moteSky(L, sheet), wind, airship: { x: patrol.x, y: patrol.y }, jumpers: this.#drop.jumpers.map((J) => jumperOrbit(J, sheet)), ready: view.queue > 0 };
  }

  #dropFrame(L: SceneLayout): DropFrame {
    const door = this.#patrolFor(L).door(1);
    return { pads: this.#pads.pads, strip: L.padStrip, door: { x: door.x, y: door.y }, skyY: SKY_Y, groundY: this.#groundY(L), sceneL: L.sceneL, sceneR: L.sceneR, fireworkSky: this.#fireworkSky(L) };
  }

  /** The sky fireworks are born in: under the airship's lane, above the tallest tower head of the towers in force (sheet: TIER 0 on the horizon; club-deck: its 270 px tower on the ground line). */
  #fireworkSky(L: SceneLayout): { top: number; bottom: number } {
    const sheet = this.#sheet(this.#skin().theme) !== null;
    const tallest = this.#towers.reduce((a, b) => (b.tier < a.tier ? b : a), this.#towers[0]!);
    const headY = sheet ? towerHead(tallest, { sceneL: L.sceneL, sceneR: L.sceneR, horizonY: L.horizonY, height: this.#height }).y : clubTowerTop(tallest, L.gy);
    const top = SKY_Y + FIREWORK_UNDER_SKY;
    return { top, bottom: Math.max(top + FIREWORK_BAND_MIN, headY - FIREWORK_ABOVE_HEADS) };
  }

  /**
   * Advance the motion (energy, crowd, blimp, towers, pads, the drop) — no drawing; `dtMs` is the loop's, never a
   * clock's. Returns the drop's moments for main.ts to play. Before the first `draw` there is no view: only the
   * envelope, the crowd and the blimp move.
   */
  step(tMs: number, dtMs: number): DropEvent[] {
    const k = dtMs / FRAME_MS;
    this.#k = k;
    this.#energy.step(tMs, k);
    this.#crowdPhase += crowdPhaseStep(dtMs, this.#energy.value);
    for (const [key, at] of this.#clubHops) if (tMs - at >= CLUB_LABEL_MS) this.#clubHops.delete(key);
    stepSmoke(this.#smoke, this.wind().x, k, this.#width);
    const L = this.#layoutFor(null);
    this.#patrolFor(L).step(tMs, k, L.patrol.min, L.patrol.max);
    const view = this.#view;
    if (view === null) return [];
    stepTowers(this.#towers, tMs, k, view.tier, this.#rng);
    const frozen = this.#dropsInAir > 0 || this.#drop.frozen();
    const sheet = this.#sheet(this.#skin().theme) !== null;
    const live = this.#drop.order(livePads(view.outcomes, view.tier));
    const pads = this.#pads.update(sheet ? [...live, ...lockPads(view.outcomes, view.tier)] : live, L.padStrip, k, frozen, this.#drop.slideRate(tMs), sheet);
    for (const p of pads) p.lift = this.#drop.lift(p.id, tMs);
    if (tMs >= this.#cel.until) this.#cel.tier = 0;
    this.#lasers += ((this.#cel.tier >= LASERS_FROM_TIER ? 1 : 0) - this.#lasers) * Math.min(1, LASER_RATE * k);
    // ---- Dancers: built once the sheet is there, on a child rng (their dice never touch the towers' sequence, whenever the sheet decodes); groups wave at the sweeps' pools; energy 1 at rest, a little more through a celebration
    if (sheet) {
      if (this.#dancers === null) this.#dancers = new Dancers(seededRandom(SEED + 1));
      this.#dancers.step(dtMs, tMs, sweepPools(this.#skin().theme, this.#towers, { t: tMs, gy: L.gy, sceneL: L.sceneL, sceneR: L.sceneR, horizonY: L.horizonY, height: this.#height }).map((p) => p.x), 1 + CEL_ENERGY_PER_TIER * this.#cel.tier);
    }
    const aloft = this.#drop.jumpers.map((J) => ({ fireSeq: J.fireSeq, x: J.x, y: J.y }));
    const events = this.#drop.step(tMs, dtMs, this.#dropFrame(L));
    // Contributor Motes: a jumper gone from the air this frame touched down where it was — its group bursts there; then every mote toward its place
    for (const a of aloft) if (!this.#drop.jumpers.some((J) => J.fireSeq === a.fireSeq)) this.#motes.landed(a.fireSeq, a.x, a.y, tMs);
    this.#motes.step(tMs, dtMs, this.#moteFrame(L, view, sheet));
    // the sheet's pad states: the ring under every jumper's target, the reveal wash on a freshly opened Tier's pads
    const air = new Set(this.#drop.jumpers.map((J) => J.padId));
    const fresh = this.#fresh;
    for (const p of pads) {
      p.under = air.has(p.id);
      p.fresh = fresh !== null && p.tier === fresh.tier ? clamp((fresh.until - tMs) / NEW_PAD_MS, 0, 1) : 0;
    }
    return events;
  }

  /**
   * Paint `view` at `tMs`. Club-deck: towers, floor, pads, lock tile, beams (+ lasers), windsock, blimp, sign, then
   * the drop's layers. Sheet: the lit floor first, then the towers on the horizon (the Dancers go between them on
   * a sheet), the pads with their lock run and its label, the mid-floor smoke, the sweeps and laser fans, and the rest
   * as before.
   */
  draw(view: View, tMs: number): void {
    const ctx = this.#ctx;
    const skin = this.#skin();
    const { theme, config } = skin;
    this.#view = view;
    this.#drawnAt = tMs;
    const L = this.#layoutFor(view);
    const padH = config.padHeight;
    const t = tMs;
    const pads = this.#pads.pads;
    const energy = this.#energy.value;
    const spec = this.#quality();
    const sprites = this.#sheet(theme);

    this.#toLogical(ctx);
    ctx.clearRect(0, 0, this.#width, this.#height);
    const towerFrame = { t, gy: L.gy, sceneL: L.sceneL, sceneR: L.sceneR, horizonY: L.horizonY, height: this.#height };
    const floorFrame = { x0: L.floorX0, x1: L.floorX1, gy: L.gy, t, energy, phase: this.#crowdPhase, bounce: this.#cel.tier * CEL_BOUNCE_PX, width: this.#width, height: this.#height, horizonY: L.horizonY, vanish: L.vanish, cache: this.#floorCache, chatters: view.chatters.slice(0, spec.chatters), nameLength: skin.chatters.nameLength, chatterImage: this.#chatterImage, hops: this.#clubHops };
    const opacity = this.#opacity();
    // ---- Dancers: the roster follows the View every frame, hidden room or not (the room's paint is skipped at floorOpacity 0; the comings and goings never are)
    this.#dancers?.sync(view.chatters, spec.chatters, { dwellMs: skin.chatters.dwellMs, nameLength: skin.chatters.nameLength }, tMs);
    // ---- the room under the pads: floor and towers (sheet: floor, Dancers, towers)
    this.#paintRoomOnClearStage(ctx, opacity, (target) => {
      if (sprites === null) {
        drawTowerBodies(target, theme, this.#towers, towerFrame, null, spec);
        drawFloor(target, theme, this.#crowd, floorFrame, null, spec);
      } else {
        this.#ensureFloorCache();
        drawFloor(target, theme, this.#crowd, floorFrame, sprites, spec);
        // the Active Chatters on the far floor, generics filling under 24, capped by the Level; rims lit by the pools when the Level has sweeps
        this.#dancers?.draw(target, theme, { horizonY: L.horizonY, gy: L.gy, sceneL: L.sceneL, sceneR: L.sceneR, scale: floorK(L.horizonY, this.#height) }, sprites, spec, spec.sweeps ? sweepPools(theme, this.#towers, towerFrame) : [], this.#chatterImage);
        drawTowerBodies(target, theme, this.#towers, towerFrame, sprites, spec);
      }
    });
    drawPads(ctx, theme, pads, L.gy, padH, energy, this.#drop.flashing(t), sprites, spec);
    if (view.tier + 1 < view.gates.length) {
      const next = view.tier + 1;
      const hidden = view.outcomes.reduce((n, o) => n + (o.tier === next ? 1 : 0), 0);
      const away = Math.max(0, (view.gates[next] ?? 0) - view.bankedTotal);
      const { big, sub } = lockedTile(next, hidden, away, theme);
      const lines = big.split(" · "); // `🔒`, `TIER n`, `N HIDDEN`
      if (L.lock !== null) drawLockTile(ctx, theme, L.lock, L.gy, padH, theme.tiers[next] ?? theme.accent, lines, sub);
      else drawLockLabel(ctx, theme, pads, L.gy, padH, [lines.slice(1).join(" · "), sub]); // the lock pads carry the 🔒
    }
    if (view.drained && !this.#drop.frozen()) {
      // the drained pool, once the last reveal has played — beside the lock tile if a tier is still to open
      ctx.font = "900 22px system-ui, sans-serif";
      ctx.fillStyle = theme.gold;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(DRAINED, L.padStrip.x + L.padStrip.w / 2, L.gy - 26);
    }
    // ---- the room over the pads: smoke, beams and lasers, the windsock on its pole
    const captions = view.gates.map((_, tier) => tierName(tier, theme));
    const sock = this.#windsockAt(L, sprites);
    this.#paintRoom(ctx, opacity, (target) => {
      drawSmoke(target, theme, this.#smoke, floorFrame, sprites, spec);
      drawBeams(target, theme, this.#towers, captions, towerFrame, sprites, spec);
      drawLasers(target, theme, this.#towers, this.#lasers, towerFrame, sprites, spec);
      drawWindsock(target, theme, sock.x, sock.topY, this.wind(), t, sprites, spec);
    });
    // Contributor Motes: the wire's motes, new keys spawned at the Acknowledgement line, drawn in the free sky over the towers and sweeps and under the airship
    const thankShift = config.rackWidth / 2 + THANKS_SHIFT_PX;
    this.#motes.sync(view.motes, t, { x: L.flip ? this.#width / 2 + thankShift : this.#width / 2 - thankShift, y: this.#height * THANKS_LINE_Y });
    this.#motes.draw(ctx, theme, sprites, spec, this.#avatarImage);
    const patrol = this.#patrolFor(L);
    drawBlimp(ctx, theme, { t, x: patrol.x, y: patrol.y, facing: patrol.facing, livery: brandFace(skin.channelName, config.cta, config.brand, t, config.brandAlternateMs), passengers: passengers(theme, t), queue: view.queue }, sprites, spec);
    if (sprites === null) drawSign(ctx, theme, { x: patrol.x - SIGN_W / 2, y: patrol.y + 118, hangFromY: patrol.y + 92, progressCents: view.progressDisplayCents, thresholdCents: view.thresholdCents, fullCount: view.fullCount }); // the sheet airship prints no dollar figure
    this.#drop.draw(ctx, theme, this.#dropFrame(L), t, sprites);
    if (sprites !== null) this.#drawThanks(ctx, theme, L, t, sprites, spec);
  }

  /**
   * Where the windsock's pole stands. Club-deck: the layout's spot inside the rack-side tower zone, the pole top
   * WINDSOCK_UP over the ground line and its foot POLE_H under that. Sheet: beside the outer TIER 0 tower on the rack's FAR side, its foot on the
   * horizon with the towers' (`footY`), the top a sprite pole's length up.
   */
  #windsockAt(L: SceneLayout, sprites: SpriteSet | null): { x: number; topY: number; footY: number } {
    if (sprites === null) return { x: L.windsockX, topY: L.gy - WINDSOCK_UP, footY: L.gy - WINDSOCK_UP + POLE_H };
    const outer = { sideI: L.flip ? 1 : 0, tier: 0 } as Tower;
    const tx = sheetTowerX(outer, { sceneL: L.sceneL, sceneR: L.sceneR });
    const footY = L.horizonY + TOWER_FOOT;
    return { x: L.flip ? tx - WINDSOCK_BESIDE : tx + TOWER_W + WINDSOCK_BESIDE, topY: sheetSockTop(footY), footY };
  }

  /** The windsock's pole: its x and the y its foot stands on, for the layout in force. */
  windsockAt(): { x: number; footY: number } {
    const { x, footY } = this.#windsockAt(this.#layoutFor(null), this.#sheet(this.#skin().theme));
    return { x, footY };
  }

  /** The thanks-glow behind the Acknowledgement line: a plate, then the gold glow additive, both fading out over THANKS_GLOW_MS. */
  #drawThanks(ctx: CanvasRenderingContext2D, theme: OverlaySkin["theme"], L: SceneLayout, t: number, sprites: SpriteSet, spec: LevelSpec): void {
    const at = this.#thanksAt;
    if (at === null) return;
    const age = (t - at) / THANKS_GLOW_MS;
    if (age < 0 || age >= 1) return;
    const shift = this.#skin().config.rackWidth / 2 + THANKS_SHIFT_PX;
    const x = L.flip ? this.#width / 2 + shift : this.#width / 2 - shift;
    const y = this.#height * THANKS_LINE_Y + THANKS_LINE_HALF_H;
    const s = spec.spriteScale;
    sprites.draw(ctx, "plate", s, x, y, { k: THANKS_PLATE_K, alpha: THANKS_PLATE_ALPHA * (1 - age) });
    ctx.globalCompositeOperation = "lighter";
    sprites.draw(ctx, "thanks-glow", s, x, y, { colour: theme.gold, alpha: THANKS_GLOW_ALPHA * (1 - age) });
    ctx.globalCompositeOperation = "source-over";
  }

  geometry(): SceneGeometry {
    const L = this.#layoutFor(null);
    const patrol = this.#patrol;
    const door = patrol === null ? { x: L.patrol.home + L.patrol.facing * 126, y: PATROL_Y, facing: L.patrol.facing } : patrol.door(1);
    const padH = this.#skin().config.padHeight;
    return { padStrip: { x: L.padStrip.x, y: L.gy + PAD_STRIP_DOWN, w: L.padStrip.w, h: padH + 4 }, door, floorTop: L.floorTop };
  }

  /** A hold on the pad layout from outside (the drop holds it on its own while anyone is in the air or a reveal is pending). */
  setDropsInAir(n: number): void {
    this.#dropsInAir = n;
  }

  /** A `drop` effect: a jumper leaves the door for the pad the server drew (or waits for a free slot); the Unlock's Contributor Motes arm to orbit it. */
  fire(fire: Fire, tMs: number): void {
    this.#drop.fire(fire, tMs);
    this.#motes.fire(fire.group, fire.fireSeq);
  }

  /** A `celebrate` effect: particles, fireworks, crowd bounce and lasers by intensity. */
  celebrate(intensity: number, avatar: string, tMs: number): void {
    this.#cel = { until: tMs + CEL_BASE_MS + CEL_SPAN_MS * intensity, tier: celebrationTier(intensity) };
    this.#drop.celebrate(intensity, avatar, tMs, this.#dropFrame(this.#layoutFor(null)));
  }

  /** A `tier_open` effect: with nobody in the air the new pads are dealt in and reshuffled at once; `tier`'s pads wear the reveal wash for 25 s. */
  tierOpen(tMs: number, tier?: number): void {
    if (tier !== undefined) this.#fresh = { tier, until: tMs + NEW_PAD_MS };
    this.#drop.tierOpen(tMs);
  }

  /** A `drained` effect: the moment plays (as a `drained` event from `step`) once the reveals are done. */
  drained(): void {
    this.#drop.drained();
  }

  /** A `thank` effect: the Acknowledgement line lands now — on a sheet the glow plays behind it for a second. */
  thank(tMs: number): void {
    this.#thanksAt = tMs;
  }

  /** A chat message from `key`: the sheet's Chatter Dancer hops, and the club-deck's bobber lifts with its name plate. */
  chatHop(key: string, tMs: number): void {
    this.#dancers?.hop(key, tMs);
    this.#clubHops.set(key, tMs);
  }

  /** A `cue` effect: `energy` with a value drives the envelope for 3 s; any other cue is not the scene's. */
  cue(name: string, value: number | undefined, tMs: number): void {
    if (name === "energy") this.#energy.cue(value, tMs);
  }

  /** The current pad layout (strip order). */
  pads(): readonly Pad[] {
    return this.#pads.pads;
  }

  /** The jumpers in the air right now. */
  jumpers(): readonly Jumper[] {
    return this.#drop.jumpers;
  }

  /** The pilots standing on their pads after touchdown, through their banners (MUST 1). */
  landed(): ReadonlyArray<{ fireSeq: number; padId: string; x: number }> {
    return this.#drop.landed;
  }

  /** The energy envelope's level right now, 0–1. */
  energy(): number {
    return this.#energy.value;
  }

  /** Whether the pads are held: anyone in the air, a reveal pending, or a hold from outside. */
  frozen(): boolean {
    return this.#dropsInAir > 0 || this.#drop.frozen();
  }

  /** Whether the shuffle is running at `tMs` (the pads sliding; not a Quiet Scene). */
  shuffling(tMs: number): boolean {
    return this.#drop.shuffling(tMs);
  }

  /**
   * The light layer's sources for the frame last drawn: the laser strokes exactly as stroked (same ends
   * and colour, so the bloom wraps them), the lit neon as points — the tower heads, the running light on its 1 Hz
   * swell, the lit pad halos — and the 2-D particles' positions, nothing simulated twice. Empty below Level 3, on the
   * club-deck (no sheet, no neon geometry) and before a first draw; particles only at Level 3, where the layer draws no
   * bloom. Every strength sits under the 2-D alpha it doubles: a halo wider and dimmer than the line.
   */
  lights(): LightSources {
    const view = this.#view;
    const spec = this.#quality();
    const { theme, config } = this.#skin();
    const sprites = this.#sheet(theme);
    if (view === null || sprites === null || spec.level < LIGHT_PARTICLE_LEVEL) return { segments: [], points: [], particles: EMPTY_PARTICLES };
    const particles = this.#particleBuffer(theme);
    if (spec.level < LIGHT_BLOOM_LEVEL) return { segments: [], points: [], particles };
    const L = this.#layoutFor(null);
    const t = this.#drawnAt;
    const f: TowerFrame = { t, gy: L.gy, sceneL: L.sceneL, sceneR: L.sceneR, horizonY: L.horizonY, height: this.#height };
    const opacity = this.#opacity(); // the room's bloom dims with the room; the pad halos and the running light do not
    return { segments: this.#laserSegments(theme, f, spec).map((s) => ({ ...s, strength: s.strength * opacity })).filter((s) => s.strength > 0), points: this.#neonPoints(theme, config.padHeight, L, f, t, opacity), particles };
  }

  /** Every laser stroke this frame draws (`laserFans`, as `drawLasers` strokes them), at a share of the stroke's alpha. */
  #laserSegments(theme: OverlaySkin["theme"], f: TowerFrame, spec: LevelSpec): LightSources["segments"] {
    if (!spec.lasers) return [];
    const out: LightSources["segments"] = [];
    for (const fan of laserFans(theme, this.#towers, this.#lasers, f)) {
      for (const s of fan.strokes) out.push({ x0: fan.cx, y0: fan.hy, x1: fan.cx + s.dx * s.len, y1: fan.hy + s.dy * s.len, colour: unitRgb(s.colour), strength: LASER_BLOOM * fan.alpha });
    }
    return out;
  }

  /** The lit tower heads, then the running light, then one point per lit pad halo (no lock pad, no DONE ember). */
  #neonPoints(theme: OverlaySkin["theme"], padH: number, L: SceneLayout, f: TowerFrame, t: number, roomOpacity = 1): LightSources["points"] {
    const out: LightSources["points"] = [];
    if (roomOpacity > 0) {
      this.#towers.forEach((T, i) => {
        if (T.lit <= 0.02) return;
        const head = towerHead(T, f);
        out.push({ x: head.x, y: head.y, r: HEAD_LAMP_R, colour: unitRgb(towerColour(theme, T, i)), strength: HEAD_BLOOM * T.lit * roomOpacity });
      });
    }
    const light = shipLightAt(this.#patrolFor(L));
    out.push({ x: light.x, y: light.y, r: SHIP_LIGHT_R, colour: unitRgb(theme.shipLight), strength: SHIP_LIGHT_BLOOM * shipLightAlpha(t) });
    const flash = this.#drop.flashing(t);
    const energy = this.#energy.value;
    for (const p of this.#pads.pads) {
      if (p.w < 3) continue;
      const st = padState(p, flash);
      if (st === "lock" || st === "done") continue;
      const h = padHalo(p, st, theme, L.gy, padH, energy);
      if (h !== null) out.push({ x: h.x, y: h.y, r: PAD_HALO_R * h.k, colour: unitRgb(h.colour), strength: PAD_BLOOM * h.alpha });
    }
    return out;
  }

  /**
   * `x, y, size, r, g, b, a` per 2-D particle in flight — the burst's sprites, then the firework sparks. Every one goes:
   * the 2-D list is already under the level's `particleCap` and the layer caps what it draws per level.
   */
  #particleBuffer(theme: OverlaySkin["theme"]): Float32Array {
    const P = this.#drop.particles.list;
    const S = this.#drop.fireworks.list;
    const n = P.length + S.length;
    if (n === 0) return EMPTY_PARTICLES;
    if (this.#particleBuf.length < n * LIGHT_PARTICLE_STRIDE) this.#particleBuf = new Float32Array(Math.max(n, 2 * (this.#particleBuf.length / LIGHT_PARTICLE_STRIDE)) * LIGHT_PARTICLE_STRIDE);
    const buf = this.#particleBuf;
    const tints = particleTints(theme).map(unitRgb);
    let o = 0;
    for (const p of P) {
      const c = tints[particleLook(p).tint]!;
      buf[o++] = p.x;
      buf[o++] = p.y;
      buf[o++] = p.size * PARTICLE_GLOW_K;
      buf[o++] = c[0];
      buf[o++] = c[1];
      buf[o++] = c[2];
      buf[o++] = PARTICLE_BLOOM * Math.min(1, p.life * 1.5);
    }
    // a burst's sparks share one colour and sit together in the list (`Fireworks.step` splices, keeping order): convert
    // once per burst per frame, not once per spark
    let sparkCol = "";
    let c: readonly [number, number, number] = WHITE_RGB;
    for (const s of S) {
      if (s.col !== sparkCol) {
        sparkCol = s.col;
        c = unitRgb(s.col);
      }
      buf[o++] = s.x;
      buf[o++] = s.y;
      buf[o++] = s.r * SPARK_GLOW_K;
      buf[o++] = c[0];
      buf[o++] = c[1];
      buf[o++] = c[2];
      buf[o++] = SPARK_BLOOM * s.life;
    }
    return buf.subarray(0, n * LIGHT_PARTICLE_STRIDE);
  }
}

export function createScene(canvas: HTMLCanvasElement, skin: () => OverlaySkin, quality: () => LevelSpec, sprites: () => SpriteSet | null = () => null, avatarImage: (m: Mote) => CanvasImageSource | null = () => null, chatterImage: (url: string | null) => CanvasImageSource | null = () => null): Scene {
  return new Scene(canvas, skin, quality, sprites, avatarImage, chatterImage);
}

export { TOWER_W };
