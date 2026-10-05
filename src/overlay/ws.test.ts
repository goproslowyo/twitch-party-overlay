import { describe, expect, test } from "bun:test";
import type { OverlayMessage, OverlayReport } from "../server/overlay.ts";
import { QualityController } from "./quality.ts";
import { MAX_BACKOFF_MS, MIN_BACKOFF_MS, REPORT_EVERY_MS, connectOverlay, createReporter, nextBackoff, reportKey, wsUrl, type WsLike } from "./ws.ts";

class FakeSocket implements WsLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  sent: string[] = [];
  constructor(readonly url: string) {}
  send(data: string): void {
    if (this.closed) throw new Error("closed");
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

const report: OverlayReport = { type: "quality", level: 4, mode: "auto", missRatio: 0.03, webgl: false, stable: true };

function harness(over: { minBackoffMs?: number; maxBackoffMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const messages: OverlayMessage[] = [];
  const status: boolean[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const client = connectOverlay({
    url: "ws://overlay.test/overlay/ws",
    onMessage: (m) => void messages.push(m),
    onStatus: (up) => void status.push(up),
    create: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    schedule: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    cancel: (handle) => void ((handle as { cancelled: boolean }).cancelled = true),
    ...over,
  });
  const sock = () => sockets[sockets.length - 1]!;
  /** Run the newest pending reconnect timer (as the clock would) and return its delay. */
  const elapse = () => {
    const t = timers[timers.length - 1]!;
    t.fn();
    return t.ms;
  };
  return { client, sockets, messages, status, timers, sock, elapse };
}

describe("ws.ts", () => {
  test("wsUrl: same host, ws under http and wss under https, the hub's WS_PATH", () => {
    expect(wsUrl({ protocol: "http:", host: "127.0.0.1:8702" })).toBe("ws://127.0.0.1:8702/overlay/ws");
    expect(wsUrl({ protocol: "https:", host: "laptop.tail1234.ts.net" })).toBe("wss://laptop.tail1234.ts.net/overlay/ws");
  });

  test("nextBackoff doubles up to the cap", () => {
    expect(nextBackoff(500, 10000)).toBe(1000);
    expect(nextBackoff(8000, 10000)).toBe(10000);
    expect(nextBackoff(10000, 10000)).toBe(10000);
    expect(MIN_BACKOFF_MS).toBe(500);
    expect(MAX_BACKOFF_MS).toBe(10000);
  });

  test("connects at once, parses each message as an OverlayMessage, ignores frames that are not JSON objects", () => {
    const h = harness();
    expect(h.sockets).toHaveLength(1);
    expect(h.sock().url).toBe("ws://overlay.test/overlay/ws");
    h.sock().onopen!();
    expect(h.status).toEqual([true]);
    h.sock().onmessage!({ data: JSON.stringify({ type: "cue", name: "energy", value: 0.5 }) });
    h.sock().onmessage!({ data: "not json" });
    h.sock().onmessage!({ data: JSON.stringify("a string") });
    h.sock().onmessage!({ data: JSON.stringify({ type: "cue", name: "beat" }) });
    expect(h.messages).toEqual([
      { type: "cue", name: "energy", value: 0.5 },
      { type: "cue", name: "beat" },
    ]);
  });

  test("a close schedules a reconnect with doubling backoff; a successful open resets it", () => {
    const h = harness();
    h.sock().onopen!();
    h.sock().onclose!();
    expect(h.status).toEqual([true, false]);
    expect(h.elapse()).toBe(500);
    expect(h.sockets).toHaveLength(2);
    h.sock().onclose!(); // never opened
    expect(h.elapse()).toBe(1000);
    h.sock().onclose!();
    expect(h.elapse()).toBe(2000);
    h.sock().onopen!(); // back: the next failure starts over
    h.sock().onclose!();
    expect(h.elapse()).toBe(500);
    expect(h.sockets).toHaveLength(5);
  });

  test("the backoff is capped", () => {
    const h = harness({ minBackoffMs: 4000, maxBackoffMs: 10000 });
    h.sock().onclose!();
    expect(h.elapse()).toBe(4000);
    h.sock().onclose!();
    expect(h.elapse()).toBe(8000);
    h.sock().onclose!();
    expect(h.elapse()).toBe(10000);
    h.sock().onclose!();
    expect(h.elapse()).toBe(10000);
  });

  test("an error only closes the socket; the close event is what reconnects (no double reconnect)", () => {
    const h = harness();
    h.sock().onerror!();
    expect(h.sock().closed).toBe(true);
    expect(h.timers).toHaveLength(0);
    h.sock().onclose!();
    expect(h.timers).toHaveLength(1);
  });

  test("send(report): nothing before the socket opens (false), the serialised OverlayReport once it has, on the current socket only after a reconnect", () => {
    const h = harness();
    expect(REPORT_EVERY_MS).toBe(15_000);
    expect(h.client.send(report)).toBe(false);
    expect(h.sock().sent).toEqual([]);
    h.sock().onopen!();
    expect(h.client.send(report)).toBe(true);
    expect(h.sock().sent).toEqual([JSON.stringify(report)]);
    expect(JSON.parse(h.sock().sent[0]!)).toEqual(report);
    const first = h.sock();
    first.onclose!();
    expect(h.client.send(report)).toBe(false); // between sockets
    h.elapse();
    expect(h.client.send(report)).toBe(false); // the new socket has not opened yet
    h.sock().onopen!();
    expect(h.client.send({ ...report, level: 3 })).toBe(true);
    expect(first.sent).toHaveLength(1);
    expect(h.sock().sent).toEqual([JSON.stringify({ ...report, level: 3 })]);
    h.client.close();
    expect(h.client.send(report)).toBe(false);
  });

  test("a send that throws (the socket closing under it) is false, not an exception", () => {
    const h = harness();
    h.sock().onopen!();
    h.sock().closed = true; // closed by the browser, the close event not yet delivered
    expect(h.client.send(report)).toBe(false);
  });

  test("a message that arrives after the snapshot re-applies cleanly on every socket (the client sends nothing but its report)", () => {
    const h = harness();
    h.sock().onclose!();
    h.elapse();
    h.sock().onopen!();
    h.sock().onmessage!({ data: JSON.stringify({ type: "cue", name: "x" }) });
    expect(h.messages).toEqual([{ type: "cue", name: "x" }]);
  });

  test("close(): closes an open socket, and its close event does not reconnect", () => {
    const h = harness();
    h.sock().onopen!();
    h.client.close();
    expect(h.sock().closed).toBe(true);
    h.sock().onclose!();
    expect(h.timers).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });

  describe("createReporter — the report goes up on a real change, on demand (open), and on the 15 s tick", () => {
    /** A reporter over a live auto controller and a counting sink; `tick()` is what the 15 s timer does. */
    function reporterHarness(sendOk = true) {
      const quality = new QualityController(() => "auto", null);
      const sent: OverlayReport[] = [];
      const ticks: Array<{ fn: () => void; ms: number }> = [];
      const reporter = createReporter(
        () => quality.report(false),
        (r) => {
          if (!sendOk) return false;
          sent.push(r);
          return true;
        },
        (fn, ms) => void ticks.push({ fn, ms }),
      );
      return { quality, sent, ticks, reporter, tick: () => ticks[0]!.fn() };
    }

    test("reportKey is level | mode | webgl | stable — the live missRatio is not part of it", () => {
      expect(reportKey(report)).toBe("4|auto|false|true");
      expect(reportKey({ ...report, missRatio: 0.9 })).toBe(reportKey(report));
      expect(reportKey({ ...report, stable: false })).not.toBe(reportKey(report));
      expect(reportKey({ ...report, level: 3 })).not.toBe(reportKey(report));
      expect(reportKey({ ...report, mode: "manual" })).not.toBe(reportKey(report));
      expect(reportKey({ ...report, webgl: true })).not.toBe(reportKey(report));
    });

    test("60 s of 30 fps with 5 % misses: one send on open, one when stable first turns false, then only the four ticks (not one per frame)", () => {
      const h = reporterHarness();
      expect(h.ticks).toEqual([{ fn: expect.any(Function), ms: REPORT_EVERY_MS }]);
      h.reporter.force(); // the socket opened
      expect(h.sent).toHaveLength(1);
      let t = 0;
      let nextTick = REPORT_EVERY_MS;
      const fromFrames: OverlayReport[] = [];
      let frames = 0;
      while (t < 60_000) {
        frames++;
        const interval = frames % 20 === 0 ? 60 : 33;
        t += interval;
        h.quality.feed(t, interval, 8, true);
        const before = h.sent.length;
        h.reporter.frame();
        if (h.sent.length > before) fromFrames.push(h.sent[h.sent.length - 1]!);
        if (t >= nextTick) {
          h.tick();
          nextTick += REPORT_EVERY_MS;
        }
      }
      expect(nextTick).toBe(5 * REPORT_EVERY_MS); // four ticks fired
      expect(fromFrames).toHaveLength(1);
      expect(fromFrames[0]).toMatchObject({ level: 5, mode: "auto", stable: false });
      expect(h.sent).toHaveLength(6); // open + the stable flip + 4 ticks
      expect(h.sent.at(-1)!.missRatio).toBeGreaterThan(0.02); // the tick carries the live ratio
      expect(h.quality.spec.level).toBe(5);
    });

    test("a clean minute sends nothing between the ticks; a step down is a change and goes up at once", () => {
      const h = reporterHarness();
      h.reporter.force();
      let t = 0;
      for (let i = 0; i < 1800; i++) {
        t += 33;
        h.quality.feed(t, 33, 8, true);
        h.reporter.frame();
      }
      expect(h.sent).toHaveLength(1);
      for (let i = 0; i < 100; i++) {
        t += 60; // 6 s of misses: one step (the cooldown holds the second)
        h.quality.feed(t, 60, 8, true);
        h.reporter.frame();
      }
      expect(h.quality.spec.level).toBe(4);
      expect(h.sent.map((r) => [r.level, r.stable])).toEqual([
        [5, true],
        [5, false],
        [4, false],
      ]);
    });

    test("a send that fails leaves the change pending: the next frame tries again", () => {
      const h = reporterHarness(false);
      h.reporter.force();
      expect(h.sent).toHaveLength(0);
      h.quality.feed(100, 100, 8, true);
      h.reporter.frame();
      h.reporter.frame();
      expect(h.sent).toHaveLength(0);
    });
  });

  test("close() while a reconnect is pending cancels it", () => {
    const h = harness();
    h.sock().onclose!();
    expect(h.timers[0]!.cancelled).toBe(false);
    h.client.close();
    expect(h.timers[0]!.cancelled).toBe(true);
    h.timers[0]!.fn(); // a timer the runtime fires anyway must not open a socket
    expect(h.sockets).toHaveLength(1);
  });
});
