import { test, expect } from "bun:test";
import { defaultConfig, type Config } from "../config/schema.ts";
import { HttpError, json } from "./http-util.ts";
import { startListeners, type ListenerHandlers } from "./listeners.ts";

function config(bindAll = false, overlayOnLan = false): Config {
  const c = defaultConfig();
  c.listeners = { streamerPort: 0, funnelPort: 0, overlayPort: 0, bindAll, overlayOnLan };
  return c;
}

function handlers(overrides: Partial<ListenerHandlers> = {}) {
  const calls: Array<{ listener: string; path: string }> = [];
  const h: ListenerHandlers = {
    app: async (req, listener) => {
      calls.push({ listener, path: new URL(req.url).pathname });
      return json({ listener });
    },
    overlay: (req, server) => {
      const { pathname } = new URL(req.url);
      if (pathname === "/overlay") return new Response("<html>overlay</html>", { headers: { "content-type": "text/html" } });
      if (pathname === "/overlay/ws") return server.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
      return undefined;
    },
    overlayWs: {
      open(ws) {
        ws.send("snapshot");
      },
      message() {},
    },
    ...overrides,
  };
  return { calls, h };
}

test("three listeners on port 0: app listeners route to handlers.app with their own name; the overlay listener 404s /api/state and serves /overlay", async () => {
  const { calls, h } = handlers();
  const l = startListeners({ config: config(), handlers: h });
  try {
    const ports = [l.streamer.port, l.funnel.port, l.overlay.port];
    for (const p of ports) expect(p).toBeGreaterThan(0);
    expect(new Set(ports).size).toBe(3);

    const s = await fetch(`http://127.0.0.1:${l.streamer.port}/api/state`);
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ listener: "streamer" });

    const f = await fetch(`http://127.0.0.1:${l.funnel.port}/api/state`, { method: "POST", headers: { "x-requested-with": "twitch-party-overlay" } });
    expect(await f.json()).toEqual({ listener: "funnel" });

    const o = await fetch(`http://127.0.0.1:${l.overlay.port}/api/state`);
    expect(o.status).toBe(404);
    expect(await o.json()).toEqual({ error: { code: "NOT_FOUND", message: "not found" } });

    const page = await fetch(`http://127.0.0.1:${l.overlay.port}/overlay`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<html>overlay</html>");

    expect(calls).toEqual([
      { listener: "streamer", path: "/api/state" },
      { listener: "funnel", path: "/api/state" },
    ]);
  } finally {
    l.stop();
  }
});

test("bind addresses: app listeners on 127.0.0.1 (0.0.0.0 with bindAll); the overlay listener on 127.0.0.1 by default, 0.0.0.0 when OBS runs on another computer or under Docker (bindAll)", () => {
  const bare = startListeners({ config: config(false, false), handlers: handlers().h });
  try {
    expect(bare.streamer.hostname).toBe("127.0.0.1");
    expect(bare.funnel.hostname).toBe("127.0.0.1");
    expect(bare.overlay.hostname).toBe("127.0.0.1");
  } finally {
    bare.stop();
  }
  const lan = startListeners({ config: config(false, true), handlers: handlers().h });
  try {
    expect(lan.streamer.hostname).toBe("127.0.0.1"); // the Dashboard never follows the overlay onto the LAN
    expect(lan.funnel.hostname).toBe("127.0.0.1");
    expect(lan.overlay.hostname).toBe("0.0.0.0");
  } finally {
    lan.stop();
  }
  // Docker (BIND_ALL=1): the container must bind every interface whatever the setting says; compose decides what is published
  const all = startListeners({ config: config(true, false), handlers: handlers().h });
  try {
    expect(all.streamer.hostname).toBe("0.0.0.0");
    expect(all.funnel.hostname).toBe("0.0.0.0");
    expect(all.overlay.hostname).toBe("0.0.0.0");
  } finally {
    all.stop();
  }
});

test("the overlay listener upgrades /overlay/ws through handlers.overlayWs", async () => {
  const l = startListeners({ config: config(), handlers: handlers().h });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${l.overlay.port}/overlay/ws`);
    const first = await new Promise<string>((resolve, reject) => {
      ws.onmessage = (ev) => resolve(String(ev.data));
      ws.onerror = () => reject(new Error("websocket error"));
      ws.onclose = (ev) => reject(new Error(`closed ${ev.code}`));
    });
    expect(first).toBe("snapshot");
    ws.close();
  } finally {
    l.stop();
  }
});

test("a throwing app handler → 500 JSON that does not echo the error; an HttpError → its own status and code; onError sees both", async () => {
  const errors: Array<[string, unknown]> = [];
  const { h } = handlers({
    app: async (req) => {
      if (new URL(req.url).pathname === "/boom") throw new Error("secret-ish detail");
      throw new HttpError(409, "NO_UNLOCKS", "nothing to fire");
    },
  });
  const l = startListeners({ config: config(), handlers: h, onError: (listener, err) => errors.push([listener, err]) });
  try {
    const boom = await fetch(`http://127.0.0.1:${l.streamer.port}/boom`);
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(text).not.toContain("secret-ish");
    expect(JSON.parse(text)).toEqual({ error: { code: "INTERNAL", message: expect.any(String) } });

    const conflict = await fetch(`http://127.0.0.1:${l.funnel.port}/api/fire`, { method: "POST" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: { code: "NO_UNLOCKS", message: "nothing to fire" } });

    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe("streamer");
    expect((errors[0]![1] as Error).message).toBe("secret-ish detail");
  } finally {
    l.stop();
  }
});

test("stop() closes all three listeners", async () => {
  const l = startListeners({ config: config(), handlers: handlers().h });
  const port = l.streamer.port;
  expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(200);
  l.stop();
  await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
});

/** One raw HTTP/1.0 request (HTTP/1.0 lets us leave the Host header out entirely); the status line's code. */
async function rawStatus(port: number, requestText: string): Promise<number> {
  const head = await new Promise<string>((resolve) => {
    let buf = "";
    const done = () => resolve(buf);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(sock) {
          sock.write(requestText);
        },
        data(_sock, chunk) {
          buf += chunk.toString();
        },
        close: done,
        error: done,
      },
    }).catch(done);
    setTimeout(done, 2000);
  });
  return Number(head.split(" ")[1]);
}

test("streamer listener refuses a foreign or missing Host with a generic 403; funnel and overlay listeners are untouched", async () => {
  const { calls, h } = handlers();
  const l = startListeners({ config: config(), handlers: h });
  try {
    const sp = l.streamer.port!;
    for (const host of ["localhost:" + sp, "LOCALHOST:" + sp, "127.0.0.1:" + sp, "[::1]:" + sp, "localhost", "127.0.0.1"]) {
      const ok = await fetch(`http://127.0.0.1:${sp}/api/state`, { headers: { Host: host } });
      expect([host, ok.status]).toEqual([host, 200]);
    }
    const foreign = await fetch(`http://127.0.0.1:${sp}/api/state`, { headers: { Host: "evil.example:" + sp } });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("content-type")).toStartWith("text/plain");
    const body = await foreign.text();
    expect(body).not.toContain("evil");
    expect(body.trim().split(/[.!?]\s/)).toHaveLength(1);

    expect(await rawStatus(sp, "GET /api/state HTTP/1.0\r\n\r\n")).toBe(403);
    expect(await rawStatus(sp, "GET /api/state HTTP/1.0\r\nHost: localhost:8700\r\n\r\n")).toBe(200);

    expect(calls.filter((c) => c.listener === "streamer")).toHaveLength(7);

    // the funnel listener never looks at Host (it sits behind the Tailscale funnel, whose Host is the funnel's)
    const funnel = await fetch(`http://127.0.0.1:${l.funnel.port}/api/state`, { headers: { Host: "party.tailnet.ts.net" } });
    expect(funnel.status).toBe(200);
    const overlay = await fetch(`http://127.0.0.1:${l.overlay.port}/overlay`, { headers: { Host: "192.168.1.20:" + l.overlay.port } });
    expect(overlay.status).toBe(200);
  } finally {
    l.stop();
  }
});

test("streamer listener: a mutating request with a foreign Origin → 403; Firebot's !fire (POST, X-Requested-With, no Origin) and a GET with a foreign Origin go through", async () => {
  const { calls, h } = handlers();
  const l = startListeners({ config: config(), handlers: h });
  try {
    const sp = l.streamer.port!;
    const firebot = await fetch(`http://127.0.0.1:${sp}/api/fire`, { method: "POST", headers: { "X-Requested-With": "twitch-party-overlay" } });
    expect(firebot.status).toBe(200);
    expect(await firebot.json()).toEqual({ listener: "streamer" });

    const dashboard = await fetch(`http://127.0.0.1:${sp}/api/fire`, { method: "POST", headers: { Host: "localhost:" + sp, Origin: "http://localhost:" + sp, "X-Requested-With": "twitch-party-overlay" } });
    expect(dashboard.status).toBe(200);

    const rebound = await fetch(`http://127.0.0.1:${sp}/api/fire`, { method: "POST", headers: { Origin: "http://evil.example", "X-Requested-With": "twitch-party-overlay" } });
    expect(rebound.status).toBe(403);
    expect(await rebound.text()).not.toContain("evil");

    const read = await fetch(`http://127.0.0.1:${sp}/api/state`, { headers: { Origin: "http://evil.example" } });
    expect(read.status).toBe(200);

    expect(calls.map((c) => c.path)).toEqual(["/api/fire", "/api/fire", "/api/state"]);
  } finally {
    l.stop();
  }
});
