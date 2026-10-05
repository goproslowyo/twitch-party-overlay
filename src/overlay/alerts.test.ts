import { describe, expect, test } from "bun:test";
import { type AlertElements, BANNER_MS, Hold, STINGER_MS, THANK_GAP_MS, ThankQueue, createAlerts, onPictureError, thankFontPx, MINI_DRAW_DELAY_MS, MINI_DRAW_MIN_SLOT_MS, MINI_DRAW_SETTLED_MS, MINI_DRAW_SLOT_REF_MS, MiniDrawReel, miniDrawScale } from "./alerts.ts";

const item = (html: string, dwellMs = 4000) => ({ html, dwellMs, intensity: 0 });

describe("ThankQueue — one line at a time, never overlapping", () => {
  test("shows the first line on the next step, hides it after its dwell, waits the gap, then shows the next", () => {
    const q = new ThankQueue();
    expect(q.step(0)).toEqual([]);
    q.push(item("a", 4000));
    q.push(item("b", 7000));
    expect(q.step(1000)).toEqual([{ kind: "show", item: item("a", 4000) }]);
    expect(q.current?.html).toBe("a");
    expect(q.step(4999)).toEqual([]);
    expect(q.step(5000)).toEqual([{ kind: "hide" }]);
    expect(q.current).toBeNull();
    expect(q.step(5000 + THANK_GAP_MS - 1)).toEqual([]);
    expect(q.step(5000 + THANK_GAP_MS)).toEqual([{ kind: "show", item: item("b", 7000) }]);
    expect(q.step(12_000 + THANK_GAP_MS)).toEqual([{ kind: "hide" }]);
    expect(q.step(20_000)).toEqual([]);
    expect(q.pending).toBe(0);
  });

  test("a late step both hides the current line and shows the next one, in that order", () => {
    const q = new ThankQueue();
    q.push(item("a", 1000));
    q.push(item("b", 1000));
    q.step(0);
    expect(q.step(10_000)).toEqual([{ kind: "hide" }, { kind: "show", item: item("b", 1000) }]);
  });

  test("a line pushed while another shows waits its turn", () => {
    const q = new ThankQueue();
    q.push(item("a", 4000));
    q.step(0);
    q.push(item("b", 4000));
    expect(q.step(100)).toEqual([]);
    expect(q.pending).toBe(1);
  });
});

describe("Hold — a stinger / banner that shows for a fixed beat", () => {
  test("show() makes it visible until nowMs + ms; step() reports the moment it expires, once", () => {
    const h = new Hold();
    expect(h.visible).toBe(false);
    expect(h.step(0)).toBe(false);
    h.show(1000, STINGER_MS);
    expect(h.visible).toBe(true);
    expect(h.step(1000 + STINGER_MS - 1)).toBe(false);
    expect(h.step(1000 + STINGER_MS)).toBe(true);
    expect(h.visible).toBe(false);
    expect(h.step(1000 + STINGER_MS)).toBe(false);
  });

  test("a show() while visible restarts the beat (last writer wins, like the prototype's shared stinger)", () => {
    const h = new Hold();
    h.show(0, BANNER_MS);
    h.show(1000, BANNER_MS);
    expect(h.step(BANNER_MS)).toBe(false);
    expect(h.step(1000 + BANNER_MS)).toBe(true);
  });
});

test("thankFontPx grows with intensity: 22 px at 0, 34 px at 1", () => {
  expect(thankFontPx(0)).toBe(22);
  expect(thankFontPx(0.5)).toBe(28);
  expect(thankFontPx(1)).toBe(34);
});

interface FakeNode {
  className: string;
  textContent: string;
}

/** The least element `createAlerts` needs: a class, text, and children found by class — counting the lookups. */
function fakeEl(id: string, children: string[]) {
  const kids = new Map<string, FakeNode>(children.map((c) => [`.${c}`, { className: c, textContent: "" }]));
  const classes = new Set<string>();
  const el = {
    id,
    className: "",
    innerHTML: "",
    style: { fontSize: "" },
    classes,
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
    listeners: [] as Array<{ type: string; fn: (ev: { target: unknown }) => void; capture: boolean }>,
    addEventListener(type: string, fn: (ev: { target: unknown }) => void, capture = false) {
      el.listeners.push({ type, fn, capture });
    },
    lookups: 0,
    querySelector(selector: string): FakeNode | null {
      el.lookups++;
      return kids.get(selector) ?? null;
    },
    kid: (c: string): FakeNode => kids.get(`.${c}`)!,
  };
  return el;
}

const elements = () => ({ thanks: fakeEl("thanks", []), stinger: fakeEl("stinger", ["top", "sub"]), banner: fakeEl("banner", ["who", "what", "sub"]), flash: fakeEl("flash", []), minidraw: fakeEl("minidraw", ["t", "reel", "hint"]) });
const asElements = (els: ReturnType<typeof elements>): AlertElements => els as unknown as AlertElements;

describe("createAlerts — the DOM side", () => {
  test("a stinger or banner missing one of its children fails at mount, like main.ts's missing-#id check, not on the first alert", () => {
    expect(() => createAlerts(asElements({ ...elements(), stinger: fakeEl("stinger", ["sub"]) }))).toThrow("overlay: missing .top in #stinger");
    expect(() => createAlerts(asElements({ ...elements(), banner: fakeEl("banner", ["who", "sub"]) }))).toThrow("overlay: missing .what in #banner");
    expect(() => createAlerts(asElements({ ...elements(), minidraw: fakeEl("minidraw", ["t", "hint"]) }))).toThrow("overlay: missing .reel in #minidraw");
    expect(() => createAlerts(asElements(elements()))).not.toThrow();
  });

  test("the children are resolved once at mount; every later alert writes into those nodes without another lookup", () => {
    const els = elements();
    const alerts = createAlerts(asElements(els));
    const atMount = els.stinger.lookups + els.banner.lookups + els.minidraw.lookups;
    expect(atMount).toBe(8);
    alerts.stinger("TIER 1 OPEN", "8 OUTCOMES JUST REVEALED", "accent", 0);
    alerts.banner("", "🎟️ STICKERS", "@alice · 4 LEFT", "done", 0);
    alerts.stinger("+2 UNLOCKS · READY TO DROP", "", "gold", 10);
    expect(els.stinger.kid("top").textContent).toBe("+2 UNLOCKS · READY TO DROP");
    expect(els.stinger.kid("sub").textContent).toBe("");
    expect(els.stinger.className).toBe("show gold");
    expect(els.banner.kid("what")).toEqual({ className: "what done", textContent: "🎟️ STICKERS" });
    expect(els.banner.kid("sub").textContent).toBe("@alice · 4 LEFT");
    expect(els.stinger.lookups + els.banner.lookups + els.minidraw.lookups).toBe(atMount);
  });

  test("a reveal's banner carries the counter on its small line; the mini-draw reel spins on the loop's clock, settles on the pick, then hides", () => {
    const els = elements();
    const alerts = createAlerts(asElements(els));
    alerts.banner("REVEAL 2 OF 3", "🎲 GENRE ROULETTE", "@bea · DONE", "done", 1000);
    expect(els.banner.kid("who").textContent).toBe("REVEAL 2 OF 3");
    const list = ["DISCO", "UK GARAGE", "TRANCE", "JUNGLE"];
    alerts.miniDraw("🎲 GENRE ROULETTE · 10–15 MIN — DRAWING FROM THE LIST", list, "TRANCE", 1000);
    alerts.step(1000 + MINI_DRAW_DELAY_MS - 1);
    expect(els.minidraw.className).toBe("");
    alerts.step(1000 + MINI_DRAW_DELAY_MS);
    expect(els.minidraw.className).toBe("show");
    expect(els.minidraw.kid("t").textContent).toBe("🎲 GENRE ROULETTE · 10–15 MIN — DRAWING FROM THE LIST");
    expect(els.minidraw.kid("reel").textContent).toBe("DISCO");
    expect(els.minidraw.kid("hint").textContent).toBe("");
    const seen: string[] = [];
    let settledAt = -1;
    let hiddenAt = -1;
    for (let t = 1000 + MINI_DRAW_DELAY_MS; t < 1000 + MINI_DRAW_DELAY_MS + 9000; t += 16) {
      alerts.step(t);
      const text = els.minidraw.kid("reel").textContent;
      if (seen[seen.length - 1] !== text) seen.push(text);
      if (settledAt < 0 && els.minidraw.className === "show settled") settledAt = t;
      if (settledAt >= 0 && hiddenAt < 0 && els.minidraw.className === "") hiddenAt = t;
    }
    expect(seen.length).toBeGreaterThan(12); // it spun through the list, slowing down
    expect(seen.slice(0, 4)).toEqual(list);
    expect(seen[seen.length - 1]).toBe("TRANCE");
    expect(settledAt - (1000 + MINI_DRAW_DELAY_MS)).toBeGreaterThan(3300); // 70 ms × 1.12ⁿ summed to the 420 ms tick: ~3.4 s of spin
    expect(settledAt - (1000 + MINI_DRAW_DELAY_MS)).toBeLessThan(3600);
    expect(hiddenAt - settledAt).toBeGreaterThanOrEqual(MINI_DRAW_SETTLED_MS);
    expect(hiddenAt - settledAt).toBeLessThan(MINI_DRAW_SETTLED_MS + 32);
    expect(hiddenAt).toBeLessThan(1000 + 8500); // inside the reveal's revealMiniDrawMs slot
  });

  test("the reel's timings come from the slot: a short revealMiniDrawMs squeezes delay, ticks and the settled hold so it hides before the slot ends", () => {
    const els = elements();
    const alerts = createAlerts(asElements(els));
    const list = ["DISCO", "UK GARAGE", "TRANCE", "JUNGLE"];
    const slot = 4000;
    alerts.miniDraw("T", list, "TRANCE", 1000, slot);
    const scale = miniDrawScale(slot);
    alerts.step(1000 + MINI_DRAW_DELAY_MS * scale - 1);
    expect(els.minidraw.className).toBe("");
    alerts.step(1000 + MINI_DRAW_DELAY_MS * scale);
    expect(els.minidraw.className).toBe("show");
    const seen: string[] = [];
    let settledAt = -1;
    let hiddenAt = -1;
    for (let t = 1000; t < 1000 + slot + 2000; t += 4) {
      alerts.step(t);
      const text = els.minidraw.kid("reel").textContent;
      if (seen[seen.length - 1] !== text) seen.push(text);
      if (settledAt < 0 && els.minidraw.className === "show settled") settledAt = t;
      if (settledAt >= 0 && hiddenAt < 0 && els.minidraw.className === "") hiddenAt = t;
    }
    expect(seen.length).toBeGreaterThan(12); // still the whole spin, 16 ticks slowing down
    expect(seen[seen.length - 1]).toBe("TRANCE");
    expect(hiddenAt - settledAt).toBeGreaterThanOrEqual(MINI_DRAW_SETTLED_MS * scale);
    expect(hiddenAt).toBeLessThanOrEqual(1000 + slot); // inside the slot
    expect(hiddenAt).toBeGreaterThan(1000 + slot * 0.85); // and using most of it
  });

  test("miniDrawScale: 1 at the reference slot (and above — the reel never runs slower than designed); proportional below it down to the reel's minimum", () => {
    expect(MINI_DRAW_SLOT_REF_MS).toBe(8500); // the default revealMiniDrawMs: the prototype's pace
    expect(miniDrawScale(8500)).toBe(1);
    expect(miniDrawScale(20000)).toBe(1);
    expect(miniDrawScale(4250)).toBe(0.5);
    expect(miniDrawScale(MINI_DRAW_MIN_SLOT_MS)).toBeCloseTo(MINI_DRAW_MIN_SLOT_MS / 8500, 6);
    expect(miniDrawScale(100)).toBe(miniDrawScale(MINI_DRAW_MIN_SLOT_MS)); // below the minimum the reel keeps the minimum's pace (and may outlast the slot)
    // at any slot from the minimum up, the whole reel — delay, 16 ticks, the settled hold — fits the slot
    for (const slot of [MINI_DRAW_MIN_SLOT_MS, 3000, 5000, 8500, 12000]) {
      const reel = new MiniDrawReel();
      const sc = miniDrawScale(slot);
      reel.start("T", ["A", "B", "C"], "B", MINI_DRAW_DELAY_MS * sc, sc);
      let hidden = -1;
      for (let t = 0; hidden < 0 && t < slot + 5000; t++) if (reel.step(t).some((c) => c.kind === "hide")) hidden = t;
      expect(hidden).toBeGreaterThan(0);
      expect(hidden).toBeLessThanOrEqual(slot);
    }
  });
});

describe("Alerts.landing — a reveal shows the banner OR the reel, never both (task-99 MUST 2)", () => {
  const reel = { title: "🎲 GENRE ROULETTE · 10–15 MIN — DRAWING FROM THE LIST", list: ["DISCO", "TRANCE"], pick: "TRANCE" };

  test("a plain Outcome: the banner, no reel", () => {
    const els = elements();
    const alerts = createAlerts(asElements(els));
    alerts.landing("", "🎟️ STICKERS", "4 LEFT", "", null, 1000, 8500);
    expect(els.banner.classes.has("show")).toBe(true);
    expect(els.banner.kid("what").textContent).toBe("🎟️ STICKERS");
    expect(els.banner.kid("sub").textContent).toBe("4 LEFT");
    alerts.step(1000 + MINI_DRAW_DELAY_MS + 100);
    expect(els.minidraw.className).toBe("");
    expect(alerts.busy()).toBe(true);
  });

  test("a mini-draw Outcome: the reel alone at its usual delay — the banner never shows, so the reel's box is not drawn through its frame; busy from the call", () => {
    const els = elements();
    const alerts = createAlerts(asElements(els));
    alerts.landing("REVEAL 2 OF 3", "🎲 GENRE ROULETTE", "DONE", "done", reel, 1000, 8500);
    expect(els.banner.classes.has("show")).toBe(false);
    expect(els.banner.kid("what").textContent).toBe("");
    expect(alerts.busy()).toBe(true);
    for (let t = 1000; t < 1000 + MINI_DRAW_DELAY_MS + 200; t += 16) alerts.step(t);
    expect(els.banner.classes.has("show")).toBe(false);
    expect(els.minidraw.className).toBe("show");
    expect(els.minidraw.kid("t").textContent).toBe(reel.title);
  });
});

describe("MiniDrawReel — the pure schedule", () => {
  test("the tick delay grows 12 % a tick from 70 ms until it passes 420 ms, then the pick settles; an empty list settles at once", () => {
    const reel = new MiniDrawReel();
    expect(reel.step(0)).toEqual([]);
    reel.start("T", ["A", "B", "C"], "B", 100);
    expect(reel.step(99)).toEqual([]);
    expect(reel.step(100)).toEqual([{ kind: "show", title: "T", text: "A" }]);
    expect(reel.step(169)).toEqual([]);
    expect(reel.step(170)).toEqual([{ kind: "tick", text: "B" }]);
    let ticks = 1;
    let t = 170;
    let settled = -1;
    while (settled < 0 && t < 10000) {
      t += 1;
      for (const c of reel.step(t)) {
        if (c.kind === "tick") ticks++;
        if (c.kind === "settle") {
          settled = t;
          expect(c.text).toBe("B");
        }
      }
    }
    expect(ticks).toBe(16); // 70 × 1.12^n reaches 420 after 16 growths
    expect(settled).toBeGreaterThan(100 + 3300);
    expect(settled).toBeLessThan(100 + 3600);
    expect(reel.step(settled + MINI_DRAW_SETTLED_MS - 1)).toEqual([]);
    expect(reel.step(settled + MINI_DRAW_SETTLED_MS)).toEqual([{ kind: "hide" }]);
    expect(reel.step(settled + MINI_DRAW_SETTLED_MS + 5000)).toEqual([]);
    const empty = new MiniDrawReel();
    empty.start("T", [], "X", 0);
    expect(empty.step(0)).toEqual([{ kind: "show", title: "T", text: "X" }, { kind: "settle", text: "X" }]);
  });

  test("a scale squeezes every interval alike: at 0.5 the first tick lands at +35 ms, the spin takes half as long, the settled hold too", () => {
    const reel = new MiniDrawReel();
    reel.start("T", ["A", "B", "C"], "B", 100, 0.5);
    expect(reel.step(100)).toEqual([{ kind: "show", title: "T", text: "A" }]);
    expect(reel.step(134)).toEqual([]);
    expect(reel.step(135)).toEqual([{ kind: "tick", text: "B" }]);
    let ticks = 1;
    let settled = -1;
    let hidden = -1;
    for (let t = 136; hidden < 0 && t < 10000; t++) {
      for (const c of reel.step(t)) {
        if (c.kind === "tick") ticks++;
        if (c.kind === "settle") settled = t;
        if (c.kind === "hide") hidden = t;
      }
    }
    expect(ticks).toBe(16);
    expect(settled - 100).toBeGreaterThan(1650);
    expect(settled - 100).toBeLessThan(1800);
    expect(hidden - settled).toBe(MINI_DRAW_SETTLED_MS / 2);
  });
});

describe("Alerts.busy — the alerts' side of the Quiet Scene", () => {
  test("a stinger or a banner up, or the reel running (from the call, not from its first tick) is busy; a thank-you line is not", () => {
    const alerts = createAlerts(asElements(elements()));
    expect(alerts.busy()).toBe(false);
    alerts.thank({ html: "x", dwellMs: 5000, intensity: 0.5 });
    alerts.step(0);
    expect(alerts.busy()).toBe(false);
    alerts.stinger("READY", "", "gold", 1000);
    expect(alerts.busy()).toBe(true);
    alerts.step(1000 + STINGER_MS - 1);
    expect(alerts.busy()).toBe(true);
    alerts.step(1000 + STINGER_MS);
    expect(alerts.busy()).toBe(false);
    alerts.banner("", "🎲 GENRE ROULETTE", "", "", 2000);
    expect(alerts.busy()).toBe(true);
    alerts.step(2000 + BANNER_MS);
    expect(alerts.busy()).toBe(false);
    alerts.miniDraw("t", ["A", "B"], "B", 3000);
    expect(alerts.busy()).toBe(true); // scheduled: the reveal's slot is under way
    for (let t = 3000; t < 3000 + MINI_DRAW_SLOT_REF_MS; t += 16) alerts.step(t);
    expect(alerts.busy()).toBe(false);
  });
});

describe("Avatar Picture fallback — a failed <img class=\"pic\"> becomes its Avatar Glyph", () => {
  /** The least an <img> needs to be swapped: its class, its data-glyph, and replaceWith. */
  function fakeImg(className: string, glyph: string | undefined) {
    const img = {
      replacedBy: undefined as string | undefined,
      classList: { contains: (c: string) => className.split(" ").includes(c) },
      dataset: glyph === undefined ? {} : { glyph },
      replaceWith(node: string) {
        img.replacedBy = node;
      },
    };
    return img;
  }

  test("createAlerts listens for error on #thanks in the capture phase (error events do not bubble)", () => {
    const els = elements();
    createAlerts(asElements(els));
    expect(els.thanks.listeners).toEqual([{ type: "error", fn: onPictureError, capture: true }]);
    expect(els.stinger.listeners).toEqual([]);
  });

  test("onPictureError: the failed picture is replaced by its glyph text; a picture without a glyph by nothing; other targets are left alone", () => {
    const pic = fakeImg("pic", "🎧");
    onPictureError({ target: pic });
    expect(pic.replacedBy).toBe("🎧");

    const bare = fakeImg("pic", undefined);
    onPictureError({ target: bare });
    expect(bare.replacedBy).toBe("");

    const other = fakeImg("something-else", "🎧");
    onPictureError({ target: other });
    expect(other.replacedBy).toBeUndefined();

    expect(() => onPictureError({ target: null })).not.toThrow();
    expect(() => onPictureError({ target: { classList: { contains: () => true } } })).not.toThrow(); // no replaceWith: nothing to do
  });
});
