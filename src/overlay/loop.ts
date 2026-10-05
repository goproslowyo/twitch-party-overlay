/**
 * The frame loop. One function, `step(tMs)`, runs a frame at a given time — the rAF callback calls it with the
 * browser's timestamp, and the debug chrome / a test calls it with synthetic time (the preview pane used to verify the
 * overlay pauses rAF entirely). The fps cap (a thunk — the Quality Level's; 0 = uncapped) drops early frames
 * the way the prototype did; `dt` is clamped so a tab that was hidden for a minute does not animate a minute in one frame.
 */

export const MAX_DT_MS = 50;

export interface LoopHooks {
  raf: (cb: (tMs: number) => void) => number;
  caf: (id: number) => void;
}

export interface Loop {
  /** Run one frame at `tMs`. Returns false when the fps cap skipped it. */
  step(tMs: number): boolean;
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** The last `tMs` handed to `step` — the loop's idea of "now", synthetic or real. */
  readonly nowMs: number;
}

const browserHooks = (): LoopHooks => ({ raf: (cb) => requestAnimationFrame(cb), caf: (id) => cancelAnimationFrame(id) });

export function createLoop(frame: (tMs: number, dtMs: number) => void, fps: () => number, hooks: LoopHooks = browserHooks()): Loop {
  let running = false;
  let handle = 0;
  let nowMs = 0;
  let lastFrameMs: number | null = null;

  const step = (tMs: number): boolean => {
    nowMs = tMs;
    const cap = fps();
    if (cap > 0 && lastFrameMs !== null && tMs - lastFrameMs < 1000 / cap - 1) return false;
    const dt = lastFrameMs === null ? 0 : Math.min(MAX_DT_MS, Math.max(0, tMs - lastFrameMs));
    lastFrameMs = tMs;
    frame(tMs, dt);
    return true;
  };

  const tick = (tMs: number): void => {
    if (!running) return;
    handle = hooks.raf(tick);
    step(tMs);
  };

  return {
    step,
    start() {
      if (running) return;
      running = true;
      handle = hooks.raf(tick);
    },
    stop() {
      if (!running) return;
      running = false;
      hooks.caf(handle);
    },
    get running() {
      return running;
    },
    get nowMs() {
      return nowMs;
    },
  };
}
