import { test, expect } from "bun:test";
import { HttpError, clientIp, errorJson, escapeHtml, html, json, notFound, parseCookies, readForm, readJson, redirect, serializeCookie } from "./http-util.ts";

test("json / errorJson / html / redirect / notFound responses", async () => {
  const ok = json({ a: 1 });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toMatch(/^application\/json/);
  expect(await ok.json()).toEqual({ a: 1 });
  expect(json({ b: 2 }, 201, { "set-cookie": "x=1" }).headers.get("set-cookie")).toBe("x=1");

  const err = errorJson(409, "NO_UNLOCKS", "nothing to fire");
  expect(err.status).toBe(409);
  expect(await err.json()).toEqual({ error: { code: "NO_UNLOCKS", message: "nothing to fire" } });

  const page = html("<h1>hi</h1>", 403);
  expect(page.status).toBe(403);
  expect(page.headers.get("content-type")).toMatch(/^text\/html/);
  expect(await page.text()).toBe("<h1>hi</h1>");

  const r = redirect("/", { "set-cookie": "a=b" });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("/");
  expect(r.headers.get("set-cookie")).toBe("a=b");

  const nf = notFound();
  expect(nf.status).toBe(404);
  expect(await nf.json()).toEqual({ error: { code: "NOT_FOUND", message: "not found" } });
});

test("HttpError carries status + code and renders the API's error shape", async () => {
  const e = new HttpError(400, "VALIDATION", "cents must be an integer");
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(400);
  expect(e.code).toBe("VALIDATION");
  const res = e.toResponse();
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: { code: "VALIDATION", message: "cents must be an integer" } });
});

test("parseCookies: name=value pairs split on ';', first '=' wins, whitespace trimmed, no cookie header → empty", () => {
  const req = (cookie?: string) => new Request("http://x/", { headers: cookie === undefined ? {} : { cookie } });
  expect(parseCookies(req())).toEqual(new Map());
  expect(parseCookies(req("a=1; tpo_session=p.s==; b = c=d ;;junk"))).toEqual(
    new Map([
      ["a", "1"],
      ["tpo_session", "p.s=="],
      ["b", "c=d"],
    ]),
  );
});

test("serializeCookie: attributes only when asked; Max-Age=0 clears", () => {
  expect(serializeCookie("n", "v")).toBe("n=v");
  expect(serializeCookie("n", "v", { maxAge: 600, path: "/", httpOnly: true, secure: true, sameSite: "Lax" })).toBe("n=v; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax");
  expect(serializeCookie("n", "", { maxAge: 0, path: "/", httpOnly: true, sameSite: "Lax" })).toBe("n=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax");
  expect(() => serializeCookie("n", "bad;value")).toThrow(/cookie/i);
});

test("readJson: parses the body; invalid JSON → HttpError 400; oversized → HttpError 413", async () => {
  const post = (body: string) => new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json" } });
  expect(await readJson(post('{"cents":5000}'))).toEqual({ cents: 5000 });
  await expect(readJson(post("{nope"))).rejects.toMatchObject({ status: 400, code: "VALIDATION" });
  await expect(readJson(post(""))).rejects.toMatchObject({ status: 400, code: "VALIDATION" });
  await expect(readJson(post(`{"pad":"${"x".repeat(2048)}"}`), 1024)).rejects.toMatchObject({ status: 413 });
});

test("readForm: application/x-www-form-urlencoded → URLSearchParams", async () => {
  const req = new Request("http://x/hooks/kofi/abc", { method: "POST", body: "data=%7B%22a%22%3A1%7D&x=y", headers: { "content-type": "application/x-www-form-urlencoded" } });
  const form = await readForm(req);
  expect(form.get("data")).toBe('{"a":1}');
  expect(form.get("x")).toBe("y");
});

test("clientIp: the LAST X-Forwarded-For hop (the one the trusted proxy appended — earlier hops are whatever the client sent), else X-Real-IP, else unknown", () => {
  const req = (headers: Record<string, string>) => new Request("http://x/", { headers });
  expect(clientIp(req({ "x-forwarded-for": " 203.0.113.9 , 100.64.0.1" }))).toBe("100.64.0.1");
  expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 198.51.100.7" }))).toBe("198.51.100.7");
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
  expect(clientIp(req({ "x-forwarded-for": "203.0.113.9, " }))).toBe("203.0.113.9"); // an empty trailing hop is not an address
  expect(clientIp(req({ "x-forwarded-for": " , " }))).toBe("unknown");
  expect(clientIp(req({ "x-forwarded-for": "", "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
  expect(clientIp(req({ "x-real-ip": "198.51.100.7" }))).toBe("198.51.100.7");
  expect(clientIp(req({}))).toBe("unknown");
});

test("escapeHtml escapes & < > \" '", () => {
  expect(escapeHtml(`<b>"a" & 'b'</b>`)).toBe("&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;");
});
