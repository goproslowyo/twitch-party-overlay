/**
 * The overlay page: connect to the hub, feed every message to the `OverlayModel`, and let the
 * renderers draw what its `view` and effects say. The model owns all timing; this file only routes — effects to the
 * rack, the alerts and the scene, and the scene's own moments (a reveal at touchdown, the drained pool once the
 * reveals are done) back to the banner, the rack and the reel — and runs the frame loop. The Quality Level
 * is the `QualityController`'s: the config setting, `?quality=N` in debug, or Auto fed every frame's raw interval, the
 * time spent inside the frame callback and whether the scene is Quiet; the loop's fps cap and the scene's caps read it
 * live, and the report goes up the socket on a real change (level / mode / WebGL / stable) and every 15 s. `window.__overlay = { model, scene, quality, step, inject }` is always mounted so a test or
 * the debug bar can drive the page at synthetic time; `?debug=1` adds the client-only chrome from debug.ts. The default
 * page is transparent with nothing but the rack and the alerts (an OBS browser source).
 */
import { defaultConfig } from "../config/schema.ts";
import type { OverlayMessage, OverlaySkin, OverlayState } from "../server/overlay.ts";
import { createAlerts } from "./alerts.ts";
import { ImageCache } from "./avatars.ts";
import { bigText, softPulse } from "./celebration.ts";
import { DRAINED_STINGER, bigMoment, landingBanner, landingWho, miniDrawTitle, revealCounter, tierOpenStinger, unlockStinger } from "./copy.ts";
import { forcedLevel, mountDebug } from "./debug.ts";
import { LightLayer, detectWebGL } from "./light/layer.ts";
import { createLoop } from "./loop.ts";
import { QualityController } from "./quality.ts";
import { createRack } from "./rack.ts";
import { createScene, type DropEvent, type Scene } from "./scene/scene.ts";
import { viewportFor } from "./render-scale.ts";
import { loadSpriteSet, type SpriteSet } from "./sprites.ts";
import { OverlayModel, tryApply, type Effect } from "./state.ts";
import { applyThemeVars, avatarFor } from "./theme.ts";
import { connectOverlay, createReporter, wsUrl } from "./ws.ts";

export interface OverlayApi {
  model: OverlayModel;
  /** The scene, for a test to read the pads and the jumpers (`scene.pads()`, `scene.jumpers()`). */
  scene: Scene;
  /** The Quality Level in force and Auto's status (`quality.spec`, `quality.status`). */
  quality: QualityController;
  /** Run one frame at synthetic time (what the rAF callback does with the browser's clock). */
  step(tMs: number): boolean;
  /** Apply an overlay message as if the hub had sent it; returns the effects it produced. */
  inject(msg: OverlayMessage): Effect[];
  /** The Theme Sheet's sprites once preloaded, or null while the Theme is procedural or the sheets are still decoding. */
  sprites(): SpriteSet | null;
  /** The skin in force (theme, config, the chatters block) — for the debug bar and a screenshot script. */
  skin(): OverlaySkin;
}

declare global {
  interface Window {
    __overlay: OverlayApi;
  }
}

/** Until the first snapshot the page wears the built-in default skin (and stays hidden). */
function defaultSkin(): OverlaySkin {
  const cfg = defaultConfig();
  return { config: cfg.overlay, theme: cfg.themes[cfg.overlay.theme]!, channelName: "", chatters: { windowMs: cfg.chatters.windowMinutes * 60_000, dwellMs: cfg.chatters.dwellSeconds * 1000, nameLength: cfg.chatters.nameLength } };
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`overlay: missing #${id}`);
  return el;
}

function main(): void {
  const params = new URLSearchParams(location.search);
  const debug = params.get("debug") === "1";
  const body = document.body;
  const rootEl = document.documentElement;

  let skin = defaultSkin();
  let state: OverlayState | null = null;
  const model = new OverlayModel(skin.config);
  const quality = new QualityController(() => skin.config.quality, debug ? forcedLevel(params) : null);

  // The Theme Sheet: all three Sheet Scales preload once a Theme names one, so a Quality step never waits on
  // a fetch; a Theme with `sheet: ""` loads nothing. The scene reads the set through the thunk — null until decoded.
  let sprites: SpriteSet | null = null;

  const root = byId("root");
  const avatars = new ImageCache(); // the Contributor Motes' Avatar Pictures: decoded by URL, the glyph until then
  const scene = createScene(byId("stage") as HTMLCanvasElement, () => skin, () => quality.spec, () => sprites, (m) => avatars.get(m.avatarUrl), (url) => avatars.get(url)); // the same cache serves the Chatter Dancers' heads
  const rack = createRack(byId("hud"), () => model.view, () => skin); // inside the 1080p logical box, not the raw source
  const alerts = createAlerts({ thanks: byId("thanks"), stinger: byId("stinger"), banner: byId("banner"), flash: byId("flash"), minidraw: byId("minidraw") });

  // The WebGL light layer: optional and only ever additive, on #light over the stage. `detectWebGL`
  // answers the skin's `overlay.webgl` once a snapshot names it; null (off, no WebGL2, a software renderer) leaves the
  // canvas blank and the report saying `webgl: false` — nothing else changes. Dropping the layer (the setting flips to
  // "off", the context is lost) blanks the canvas — no frozen last frame over the 2-D scene — and keeps the context:
  // the same one builds the next layer when "auto" comes back, and it is never given up through `WEBGL_lose_context`,
  // which makes Chromium's compositor stop presenting the 2-D stage (seen in a browser check). A context lost for
  // real is left to the browser to restore (`preventDefault` below) and the layer is rebuilt on `webglcontextrestored`;
  // the reporter sees each flip on the next frame and says so once. `webgl` is live only while `light` is.
  const lightCanvas = byId("light") as HTMLCanvasElement;
  let light: LightLayer | null = null;
  let lightSetting: OverlaySkin["config"]["webgl"] | null = null;
  const dropLight = (why: string): void => {
    if (light === null) return;
    light.release();
    light = null;
    console.info(`overlay: light layer off — ${why}`);
  };
  const buildLight = (): void => {
    const gl = detectWebGL(lightCanvas, lightSetting ?? "off");
    if (gl === null || gl.isContextLost()) return; // lost for real: `webglcontextrestored` builds once the browser has it back
    try {
      light = new LightLayer(gl);
      console.info("overlay: light layer on");
    } catch (err) {
      console.warn("overlay: light layer failed to build — staying off", err);
    }
  };
  const syncLight = (setting: OverlaySkin["config"]["webgl"]): void => {
    if (setting === lightSetting) return;
    lightSetting = setting;
    dropLight(`overlay.webgl is ${setting}`);
    buildLight();
  };
  const resizeLight = (w: number, h: number): void => {
    lightCanvas.width = w;
    lightCanvas.height = h;
    light?.resize(w, h);
  };
  const drawLight = (tMs: number): void => light?.draw(scene.lights(), quality.spec.level, tMs);
  lightCanvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault(); // the browser may then restore it; `webglcontextrestored` rebuilds while the setting allows
    dropLight("the WebGL context was lost");
  });
  lightCanvas.addEventListener("webglcontextrestored", () => {
    if (light === null) buildLight();
  });

  // The overlay is laid out for 1920 x 1080 whatever the Browser source is (render-scale.ts). #hud wears the scale that
  // fits the DOM layer to the source; the stage draws in that same logical space, backed by `renderScale` real pixels
  // per logical one (1x / 1.5x / 2x). The light layer stays at logical size: it is bloom and glow, where extra pixels
  // buy nothing and cost the most.
  // The overlay is laid out for 1920 x 1080 whatever the Browser source is (render-scale.ts). #hud wears the zoom that
  // scales the DOM layer to fill; the stage draws in that same logical space, backed by `supersample` real pixels per
  // logical one. The light layer stays at logical size: it is bloom and glow, where extra pixels buy nothing.
  /** What one logical pixel is backed by right now. Read fresh every time: the skin, the sheet and the window size
   *  arrive in any order, and whichever lands last has to be able to settle the sheet on its own. */
  const detailNow = (): number => viewportFor(skin.config.renderScale, window.innerWidth, window.innerHeight).supersample;

  const resize = (): void => {
    const view = viewportFor(skin.config.renderScale, window.innerWidth, window.innerHeight);
    rootEl.style.setProperty("--hud", String(view.zoom));
    rootEl.style.setProperty("--hud-w", `${view.logical.width}px`);
    rootEl.style.setProperty("--hud-h", `${view.logical.height}px`);
    scene.resize(view.logical.width, view.logical.height, view.supersample);
    sprites?.setDetail(view.supersample); // frames come off a sheet big enough for the size they will be drawn at
    resizeLight(view.logical.width, view.logical.height);
    rack.invalidate(); // the stock list's compact-grid fallback is a measurement: re-fit at the new size
  };
  window.addEventListener("resize", resize);
  resize();

  const sheetLoads = new Set<string>();
  const sheetTries = new Map<string, number>();
  /** A snapshot arrives on every socket open, and a flapping hub reconnects every 10 s: retries must be bounded. */
  const SHEET_TRIES = 3;
  const preloadSheet = (sheet: OverlaySkin["theme"]["sheet"]): void => {
    if (sheet === "" || sheetLoads.has(sheet)) return;
    const tried = sheetTries.get(sheet) ?? 0;
    if (tried >= SHEET_TRIES) return; // it has had its chances; the scene draws without sprites rather than thrashing
    sheetTries.set(sheet, tried + 1);
    sheetLoads.add(sheet);
    loadSpriteSet(sheet).then(
      (set) => {
        sprites = set;
        set.setDetail(detailNow());
        console.info(`overlay: sheet ${set.id} ready (${set.names().length} frames)`);
      },
      (err: unknown) => {
        // Let it be tried again. The sheets now carry a deadline, and a source that is throttled hard enough to miss
        // it would otherwise be left with no art at all for the life of the page — worse than the stall it replaced.
        sheetLoads.delete(sheet); // let the next snapshot try again, up to SHEET_TRIES
        console.error(`overlay: sheet ${sheet} failed to load (try ${sheetTries.get(sheet) ?? 0} of ${SHEET_TRIES})`, err);
      },
    );
  };

  const applySkin = (next: OverlaySkin): void => {
    const scaleChanged = next.config.renderScale !== skin.config.renderScale;
    skin = next;
    preloadSheet(next.theme.sheet);
    syncLight(next.config.webgl);
    if (scaleChanged) resize(); // a new drawing resolution takes effect without reloading the Browser source
    sprites?.setDetail(detailNow()); // unconditional: the first snapshot may be what tells us 2x was wanted all along
    applyThemeVars(next.theme, rootEl);
    rootEl.style.setProperty("--rack-w", `${next.config.rackWidth}px`);
    body.classList.toggle("side-left", next.config.side === "left");
    body.classList.toggle("side-right", next.config.side !== "left");
    rack.invalidate();
    console.info(`overlay: skin applied side=${next.config.side} theme=${next.config.theme} rack=${next.config.rackWidth}px floor=${next.config.floorPercent}%`);
  };

  const handle = (effects: Effect[], tMs: number): void => {
    for (const e of effects) {
      switch (e.kind) {
        case "skin":
          applySkin(e.skin);
          break;
        case "resync":
          body.classList.add("ready");
          rack.invalidate();
          break;
        case "thank":
          alerts.thank({ html: e.html, dwellMs: e.dwellMs, intensity: e.intensity });
          scene.thank(tMs); // the Theme Sheet's glow behind the line
          rack.invalidate(); // the fader moved with the contribution: it reads the new amount on this frame, with the thank line (MUST 4)
          break;
        case "celebrate": {
          rack.celebrate(e.intensity, tMs);
          scene.celebrate(e.intensity, avatarFor(e.name, skin.theme), tMs);
          if (softPulse(e.intensity)) alerts.pulse(tMs);
          if (bigText(e.intensity, skin.config)) {
            const { big, sub } = bigMoment(e.name, e.face, e.source);
            alerts.stinger(big, sub, "contrib", tMs);
          }
          break;
        }
        case "full":
          rack.invalidate();
          break;
        case "unlock_stinger": {
          const { big, sub } = unlockStinger(e.count);
          alerts.stinger(big, sub, "gold", tMs);
          rack.invalidate();
          break;
        }
        case "tier_open": {
          const revealed = model.view.outcomes.filter((o) => o.tier === e.tier).length;
          const { big, sub } = tierOpenStinger(e.tier, revealed, skin.theme);
          alerts.stinger(big, sub, "accent", tMs);
          scene.tierOpen(tMs, e.tier);
          rack.invalidate();
          break;
        }
        case "drop":
          // the jumper leaves now; the banner, NOW line, row hit and reel play at its reveal (a `reveal` event from the scene)
          scene.fire(e, tMs);
          rack.invalidate();
          break;
        case "drained":
          scene.drained(); // the stinger plays on the scene's `drained` event, once the reveals are done
          rack.invalidate();
          break;
        case "cue":
          scene.cue(e.name, e.value, tMs);
          break;
        case "chat-hop":
          scene.chatHop(e.key, tMs);
          break;
      }
    }
  };

  const unknownOutcomes = new Set<string>();

  /**
   * A moment the scene reached on its own clock: a jumper's reveal, or the drained pool after the last one. The reveal
   * releases the model's pre-fire hold on the outcome first, so the pad and the rack row flip on the same frame as the
   * banner; an outcome the view does not know is logged once and gets no banner (an id is never painted) — its slot
   * still runs in the scene, so the sequencing is unchanged.
   */
  const play = (event: DropEvent, tMs: number): void => {
    if (event.kind === "drained") {
      alerts.stinger(DRAINED_STINGER.big, DRAINED_STINGER.sub, "gold", tMs);
      return;
    }
    const { fire, n, total } = event;
    model.revealed(fire.fireSeq);
    rack.invalidate(); // the row's pips flip with the banner, not before (`hit` alone does not re-render)
    const outcome = model.view.outcomes.find((o) => o.id === fire.outcomeId);
    if (outcome === undefined) {
      if (!unknownOutcomes.has(fire.outcomeId)) {
        unknownOutcomes.add(fire.outcomeId);
        console.warn(`overlay: reveal for an outcome the view does not know: ${fire.outcomeId}`);
      }
      return;
    }
    const { big, sub } = landingBanner(outcome, fire.stockAfter);
    const who = landingWho(fire.solo, sub); // the crowd's Unlock names nobody; `solo` is the one exception
    // the banner, or — for a mini-draw Outcome — the reel alone (MUST 2); the NOW box and the row hit either way
    const reel = fire.miniDraw === undefined ? null : { title: miniDrawTitle(outcome.glyph, fire.miniDraw.title), list: fire.miniDraw.list, pick: fire.miniDraw.pick };
    alerts.landing(total > 1 ? revealCounter(n, total) : "", big, who, fire.stockAfter === 0 ? "done" : "", reel, tMs, skin.config.revealMiniDrawMs);
    rack.now({ cls: "hit", what: big, who }, tMs);
    rack.hit(fire.outcomeId, tMs);
  };

  /** A Quiet Scene: nothing in motion a viewer would notice being interrupted. */
  const quiet = (tMs: number): boolean => !scene.frozen() && !scene.shuffling(tMs) && model.view.fullCount === 0 && model.view.justRevealed.length === 0 && !alerts.busy();

  let lastFrameMs: number | null = null;
  const frame = (tMs: number, dtMs: number): void => {
    const wasQuiet = quiet(tMs);
    const began = performance.now();
    handle(model.tick(tMs), tMs);
    for (const event of scene.step(tMs, dtMs)) play(event, tMs);
    rack.step(tMs);
    alerts.step(tMs);
    scene.draw(model.view, tMs);
    drawLight(tMs);
    // Auto reads the raw interval between drawn frames (the loop's `dtMs` is clamped for animation, and would hide a
    // miss) and the work this frame took — the headroom a step up needs, which the capped cadence cannot show
    if (lastFrameMs !== null) quality.feed(tMs, tMs - lastFrameMs, performance.now() - began, wasQuiet);
    lastFrameMs = tMs;
    reporter.frame();
  };
  const loop = createLoop(frame, () => quality.spec.fps);

  const inject = (msg: OverlayMessage): Effect[] => {
    const effects = tryApply(model, msg, loop.nowMs);
    if (effects === null) return []; // logged and dropped: a malformed frame must not wedge `ws.onmessage`
    if ("state" in msg) state = msg.state; // remembered for the debug bar only once the model took it
    handle(effects, loop.nowMs);
    return effects;
  };

  window.__overlay = { model, scene, quality, step: loop.step, inject, sprites: () => sprites, skin: () => skin };

  if (debug) {
    body.classList.add("debug");
    mountDebug({ inject, step: (dtMs) => void loop.step(loop.nowMs + dtMs), state: () => state, skin: () => skin, nowMs: () => loop.nowMs, quality: () => ({ ...quality.status, mode: quality.mode, webgl: light !== null }) });
  }

  // The report goes up on a real change (level / mode / WebGL / stable — not the miss ratio), on every (re)open, and
  // every REPORT_EVERY_MS regardless; the reporter owns the tick.
  const reporter = createReporter(() => quality.report(light !== null), (report) => client.send(report));
  const client = connectOverlay({ url: wsUrl(location), onMessage: inject, onStatus: (up) => void (up && reporter.force()) });
  loop.start();
}

main();
