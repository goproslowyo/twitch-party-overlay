/**
 * Alerts over the scene: the thank-you line at 70 %, the landing banner at 58 % (its
 * small line carries `REVEAL n OF m` on a multi-fire), the shared stinger at 45 %, and the mini-draw reel at 50 %
 * inside a reveal — all transform/opacity animations in styles.css, all timed from the loop's `tMs` (no setTimeout,
 * so the preview pane's synthetic clock drives them too). Thank-you lines queue and never overlap; the stinger and
 * banner are last-writer-wins holds like the prototype's; the reel (its `miniDraw`) spins through the list slowing
 * down, settles on the server's pick and folds away, all inside `revealMiniDrawMs` — its delay, ticks and settled hold
 * are the prototype's at the default slot and shrink in proportion for a shorter one (`miniDrawScale`). Text arrives
 * ready-made from copy.ts / the model's effects; nothing here composes words. The one DOM detail of its own: a thank
 * line's Avatar Picture (`<img class="pic" data-glyph>`) that fails to load is swapped for its Avatar Glyph.
 */

export const THANK_GAP_MS = 350;
export const STINGER_MS = 3400;
export const BANNER_MS = 3200;
export const PULSE_MS = 250;
/** The reel starts this long into its reveal slot (the banner lands first). */
export const MINI_DRAW_DELAY_MS = 1200;
export const MINI_DRAW_TICK0_MS = 70;
export const MINI_DRAW_TICK_GROWTH = 1.12;
export const MINI_DRAW_TICK_MAX_MS = 420;
/** How long the settled pick stays up before the reel folds away. */
export const MINI_DRAW_SETTLED_MS = 3200;
/** The slot the reel's timings are written for (the default `revealMiniDrawMs`): the whole reel ends ~7.8 s in. */
export const MINI_DRAW_SLOT_REF_MS = 8500;
/** The shortest slot the reel scales down to (ticks of ~20 ms); below it the reel keeps this pace and may outlast the slot. */
export const MINI_DRAW_MIN_SLOT_MS = 2500;
const THANK_FONT_BASE_PX = 22;
const THANK_FONT_SPAN_PX = 12;

export interface ThankItem {
  html: string;
  dwellMs: number;
  intensity: number;
}

export type ThankChange = { kind: "show"; item: ThankItem } | { kind: "hide" };

/** Acknowledgement lines, one at a time: each dwells its own `dwellMs`, then a short gap, then the next. */
export class ThankQueue {
  #queue: ThankItem[] = [];
  #current: { item: ThankItem; untilMs: number } | null = null;
  #readyAtMs = 0;

  get current(): ThankItem | null {
    return this.#current?.item ?? null;
  }

  get pending(): number {
    return this.#queue.length;
  }

  push(item: ThankItem): void {
    this.#queue.push(item);
  }

  step(nowMs: number): ThankChange[] {
    const changes: ThankChange[] = [];
    if (this.#current !== null && nowMs >= this.#current.untilMs) {
      this.#readyAtMs = this.#current.untilMs + THANK_GAP_MS; // the gap runs from when the line was due to go, so a late frame catches up
      this.#current = null;
      changes.push({ kind: "hide" });
    }
    if (this.#current === null && this.#queue.length > 0 && nowMs >= this.#readyAtMs) {
      const item = this.#queue.shift()!;
      this.#current = { item, untilMs: nowMs + item.dwellMs };
      changes.push({ kind: "show", item });
    }
    return changes;
  }
}

/** Something shown for a beat: `show(now, ms)` restarts it; `step(now)` is true on the frame it expires. */
export class Hold {
  #untilMs: number | null = null;

  get visible(): boolean {
    return this.#untilMs !== null;
  }

  show(nowMs: number, ms: number): void {
    this.#untilMs = nowMs + ms;
  }

  step(nowMs: number): boolean {
    if (this.#untilMs === null || nowMs < this.#untilMs) return false;
    this.#untilMs = null;
    return true;
  }
}

export type ReelChange = { kind: "show"; title: string; text: string } | { kind: "tick"; text: string } | { kind: "settle"; text: string } | { kind: "hide" };

interface ReelRun {
  title: string;
  list: readonly string[];
  pick: string;
  /** When the next tick (or the show) is due. */
  nextMs: number;
  delay: number;
  i: number;
  shown: boolean;
  settledMs: number | null;
  /** Every interval × this: 1 is the prototype's pace, less for a shorter slot. */
  scale: number;
}

/** How much the reel's intervals shrink for a slot of `slotMs`: 1 at the reference slot and above, proportional below it, floored at the minimum slot. */
export function miniDrawScale(slotMs: number): number {
  return Math.min(1, Math.max(slotMs, MINI_DRAW_MIN_SLOT_MS) / MINI_DRAW_SLOT_REF_MS);
}

/** The mini-draw reel's schedule: show at `atMs`, tick through the list with a growing delay, settle on the pick, hide — every interval × `scale`. */
export class MiniDrawReel {
  #run: ReelRun | null = null;

  /** From `start` until the reel has hidden — scheduled counts: the reel is inside a reveal's slot. */
  get running(): boolean {
    return this.#run !== null;
  }

  start(title: string, list: readonly string[], pick: string, atMs: number, scale = 1): void {
    this.#run = { title, list, pick, nextMs: atMs, delay: MINI_DRAW_TICK0_MS * scale, i: 0, shown: false, settledMs: null, scale };
  }

  step(nowMs: number): ReelChange[] {
    const run = this.#run;
    const changes: ReelChange[] = [];
    if (run === null) return changes;
    if (!run.shown) {
      if (nowMs < run.nextMs) return changes;
      run.shown = true;
      changes.push({ kind: "show", title: run.title, text: run.list[0] ?? run.pick });
      run.i = 1;
      run.nextMs += run.delay;
      if (run.list.length === 0) this.#settle(run, nowMs, changes);
    }
    while (run.settledMs === null && nowMs >= run.nextMs) {
      if (run.delay < MINI_DRAW_TICK_MAX_MS * run.scale) {
        changes.push({ kind: "tick", text: run.list[run.i % run.list.length]! });
        run.i++;
        run.delay *= MINI_DRAW_TICK_GROWTH;
        run.nextMs += run.delay;
      } else this.#settle(run, run.nextMs, changes);
    }
    if (run.settledMs !== null && nowMs >= run.settledMs + MINI_DRAW_SETTLED_MS * run.scale) {
      this.#run = null;
      changes.push({ kind: "hide" });
    }
    return changes;
  }

  #settle(run: ReelRun, atMs: number, changes: ReelChange[]): void {
    run.settledMs = atMs;
    changes.push({ kind: "settle", text: run.pick });
  }
}

/** The thank-you line grows with intensity: 22 px at 0, 34 px at 1. */
export function thankFontPx(intensity: number): number {
  return THANK_FONT_BASE_PX + THANK_FONT_SPAN_PX * intensity;
}

// ---- DOM ------------------------------------------------------------------------------------------------------------

export interface AlertElements {
  thanks: HTMLElement;
  stinger: HTMLElement;
  banner: HTMLElement;
  flash: HTMLElement;
  minidraw: HTMLElement;
}

export type StingerStyle = "gold" | "accent" | "danger" | "contrib";

export interface Alerts {
  thank(item: ThankItem): void;
  /** The shared stinger: `top` over `sub`; `gold` is the default look, `accent` for tier reveals, `contrib` for big moments. */
  stinger(top: string, sub: string, style: StingerStyle, nowMs: number): void;
  /** The landing banner: `who` (small — the reveal counter on a multi-fire) over `what` (the outcome) over `sub`; `done` colours it gold, `dry` red. */
  banner(who: string, what: string, sub: string, style: "" | "done" | "dry", nowMs: number): void;
  /** The 8 % soft full-screen pulse (≥ 0.7 intensity). */
  pulse(nowMs: number): void;
  /** The mini-draw reel inside a reveal's slot of `slotMs` (`revealMiniDrawMs`): shows `MINI_DRAW_DELAY_MS` (× the slot's scale) after `nowMs`, spins through `list`, settles on `pick`, hides before the slot ends. */
  miniDraw(title: string, list: readonly string[], pick: string, nowMs: number, slotMs?: number): void;
  /**
   * A reveal: the banner for a plain Outcome; for a mini-draw Outcome the reel ALONE (its title carries the Outcome)
   * — the reel at 50 % would otherwise be drawn through the banner at 58 % for two seconds (task-99 MUST 2; the
   * Minidraw board shows the reel by itself).
   */
  landing(who: string, what: string, sub: string, style: "" | "done" | "dry", miniDraw: { title: string; list: readonly string[]; pick: string } | null, nowMs: number, slotMs?: number): void;
  /** A stinger or banner up, or the mini-draw reel running — not a Quiet Scene. Thank-you lines do not count. */
  busy(): boolean;
  step(nowMs: number): void;
}

/** The shape of a failed picture, as far as the swap needs it — typed loosely so the handler is testable without a DOM. */
interface PictureLike {
  classList?: { contains(token: string): boolean };
  dataset?: { glyph?: string };
  replaceWith?(...nodes: Array<Node | string>): void;
}

/**
 * The thank line's `error` handler (attached in the capture phase — `error` does not bubble): a failed
 * `<img class="pic">` is replaced by the text of its `data-glyph`, so the line reads as it would have without a picture.
 */
export function onPictureError(ev: { target: unknown }): void {
  const img = ev.target as PictureLike | null;
  if (img === null || typeof img !== "object" || img.classList?.contains("pic") !== true || typeof img.replaceWith !== "function") return;
  img.replaceWith(img.dataset?.glyph ?? "");
}

/** A required child of an alert element, resolved once at mount — like main.ts's `#id` lookup, a missing node fails here, not on the first alert. */
function child(el: HTMLElement, selector: string): HTMLElement {
  const node = el.querySelector<HTMLElement>(selector);
  if (node === null) throw new Error(`overlay: missing ${selector} in #${el.id}`);
  return node;
}

export function createAlerts(els: AlertElements): Alerts {
  els.thanks.addEventListener("error", onPictureError, true);
  const thanks = new ThankQueue();
  const stingerHold = new Hold();
  const bannerHold = new Hold();
  const pulseHold = new Hold();
  const stingerTop = child(els.stinger, ".top");
  const stingerSub = child(els.stinger, ".sub");
  const bannerWho = child(els.banner, ".who");
  const bannerWhat = child(els.banner, ".what");
  const bannerSub = child(els.banner, ".sub");
  const reelTitle = child(els.minidraw, ".t");
  const reelText = child(els.minidraw, ".reel");
  const reelHint = child(els.minidraw, ".hint");
  const reel = new MiniDrawReel();

  return {
    thank(item) {
      thanks.push(item);
    },
    stinger(top, sub, style, nowMs) {
      els.stinger.className = `show ${style}`;
      stingerTop.textContent = top;
      stingerSub.textContent = sub;
      stingerHold.show(nowMs, STINGER_MS);
    },
    banner(who, what, sub, style, nowMs) {
      bannerWho.textContent = who;
      bannerWhat.textContent = what;
      bannerWhat.className = `what ${style}`;
      bannerSub.textContent = sub;
      els.banner.classList.add("show");
      bannerHold.show(nowMs, BANNER_MS);
    },
    pulse(nowMs) {
      els.flash.classList.add("on");
      pulseHold.show(nowMs, PULSE_MS);
    },
    miniDraw(title, list, pick, nowMs, slotMs = MINI_DRAW_SLOT_REF_MS) {
      const scale = miniDrawScale(slotMs);
      reel.start(title, list, pick, nowMs + MINI_DRAW_DELAY_MS * scale, scale);
    },
    landing(who, what, sub, style, miniDraw, nowMs, slotMs = MINI_DRAW_SLOT_REF_MS) {
      if (miniDraw === null) this.banner(who, what, sub, style, nowMs);
      else this.miniDraw(miniDraw.title, miniDraw.list, miniDraw.pick, nowMs, slotMs);
    },
    busy() {
      return stingerHold.visible || bannerHold.visible || reel.running;
    },
    step(nowMs) {
      for (const change of thanks.step(nowMs)) {
        if (change.kind === "hide") {
          els.thanks.classList.remove("show");
        } else {
          els.thanks.innerHTML = change.item.html;
          els.thanks.style.fontSize = `${thankFontPx(change.item.intensity)}px`;
          els.thanks.classList.add("show");
        }
      }
      if (stingerHold.step(nowMs)) els.stinger.classList.remove("show");
      if (bannerHold.step(nowMs)) els.banner.classList.remove("show");
      if (pulseHold.step(nowMs)) els.flash.classList.remove("on");
      for (const change of reel.step(nowMs)) {
        switch (change.kind) {
          case "show":
            reelTitle.textContent = change.title;
            reelText.textContent = change.text;
            reelHint.textContent = "";
            els.minidraw.className = "show";
            break;
          case "tick":
            reelText.textContent = change.text;
            break;
          case "settle":
            reelText.textContent = change.text;
            els.minidraw.className = "show settled";
            break;
          case "hide":
            els.minidraw.className = "";
            break;
        }
      }
    },
  };
}
