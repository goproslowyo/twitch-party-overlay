import { describe, expect, test } from "bun:test";
import { MAX_DT_MS, createLoop } from "./loop.ts";

function fakeRaf() {
  const pending: Array<{ id: number; cb: (t: number) => void }> = [];
  const cancelled: number[] = [];
  let next = 1;
  return {
    pending,
    cancelled,
    hooks: {
      raf: (cb: (t: number) => void) => {
        const id = next++;
        pending.push({ id, cb });
        return id;
      },
      caf: (id: number) => void cancelled.push(id),
    },
    /** Fire the oldest pending callback at `t`, as the browser would. */
    fire(t: number) {
      const p = pending.shift();
      if (!p) throw new Error("nothing scheduled");
      p.cb(t);
    },
  };
}

describe("loop.ts", () => {
  test("step(t) runs one frame at synthetic time: dt from the previous step, 0 on the first, clamped to MAX_DT_MS", () => {
    const frames: Array<[number, number]> = [];
    const loop = createLoop((t, dt) => void frames.push([t, dt]), () => 0);
    expect(loop.step(1000)).toBe(true);
    expect(loop.step(1016)).toBe(true);
    expect(loop.step(5000)).toBe(true);
    expect(frames).toEqual([
      [1000, 0],
      [1016, 16],
      [5000, MAX_DT_MS],
    ]);
    expect(loop.nowMs).toBe(5000);
  });

  test("an fps cap skips frames that arrive early, without counting them as the previous frame", () => {
    const frames: number[] = [];
    const loop = createLoop((t) => void frames.push(t), () => 30);
    expect(loop.step(0)).toBe(true);
    expect(loop.step(10)).toBe(false); // < 1000/30 − 1 ms since the last frame
    expect(loop.step(20)).toBe(false);
    expect(loop.step(33)).toBe(true);
    expect(frames).toEqual([0, 33]);
    expect(loop.nowMs).toBe(33);
  });

  test("the cap is read every frame (it comes from the skin, which can change)", () => {
    let fps = 0;
    const frames: number[] = [];
    const loop = createLoop((t) => void frames.push(t), () => fps);
    loop.step(0);
    loop.step(5);
    fps = 30;
    loop.step(10);
    expect(frames).toEqual([0, 5]);
  });

  test("the cap thunk switching 30 → 20 changes which frames are skipped (the Quality Level's fps)", () => {
    let fps = 30;
    const frames: number[] = [];
    const loop = createLoop((t) => void frames.push(t), () => fps);
    loop.step(0);
    expect(loop.step(16)).toBe(false);
    expect(loop.step(33)).toBe(true); // 2 ticks of a 60 Hz rAF at 30 fps
    fps = 20;
    expect(loop.step(50)).toBe(false);
    expect(loop.step(66)).toBe(false); // < 1000/20 − 1
    expect(loop.step(83)).toBe(true); // 3 ticks at 20 fps
    fps = 30;
    expect(loop.step(100)).toBe(false);
    expect(loop.step(116)).toBe(true);
    expect(frames).toEqual([0, 33, 83, 116]);
  });

  test("start() schedules through rAF, each callback steps then re-schedules; stop() cancels and stops re-scheduling", () => {
    const raf = fakeRaf();
    const frames: number[] = [];
    const loop = createLoop((t) => void frames.push(t), () => 0, raf.hooks);
    expect(raf.pending).toHaveLength(0);
    loop.start();
    loop.start(); // idempotent
    expect(raf.pending).toHaveLength(1);
    raf.fire(100);
    expect(frames).toEqual([100]);
    expect(raf.pending).toHaveLength(1); // re-scheduled
    raf.fire(116);
    expect(frames).toEqual([100, 116]);
    loop.stop();
    expect(raf.cancelled).toEqual([raf.pending[0]!.id]);
    raf.fire(132); // a callback the browser already had queued: must not re-schedule
    expect(raf.pending).toHaveLength(0);
    expect(loop.running).toBe(false);
  });
});
