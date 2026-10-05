import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, type Config } from "../../config/schema.ts";
import { Secrets } from "../../config/secrets.ts";
import { Engine } from "../../engine/engine.ts";
import { Ledger } from "../../ledger/ledger.ts";
import { KOFI_ACTOR, KOFI_TOKEN_KEY, createKofiHandler } from "./webhook.ts";

const TOKEN = "e58df006-d830-4114-96e9-6bbbfcb2b776";
const PATH = "hook-9f8e7d";

/** What the webhook wrote — after the Engine's threshold seed (seq 1). */
const written = (f: ReturnType<typeof mk>) => f.ledger.all().slice(1 + defaultConfig().outcomes.length); // after the Engine's boot seeds: the threshold seed + one stock seed per Outcome

function mk(opts: { token?: string | null; webhookPath?: string; enabled?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-kofi-"));
  const secrets = new Secrets(path.join(dir, "secrets.env"));
  if (opts.token !== null) secrets.set(KOFI_TOKEN_KEY, opts.token ?? TOKEN);
  const config: Config = defaultConfig();
  config.ingest.kofi.webhookPath = opts.webhookPath ?? PATH;
  config.ingest.kofi.enabled = opts.enabled ?? true;
  const ledgerPath = path.join(dir, "ledger.sqlite");
  const ledger = new Ledger(ledgerPath);
  const engine = new Engine(ledger, () => config);
  const logs: string[] = [];
  const handler = createKofiHandler({ config: () => config, secrets, engine, ledger, log: (m) => void logs.push(m) });
  return { secrets, config, ledger, engine, logs, handler, ledgerPath };
}

/** The stored raw_events payloads (JSON text), oldest first — the Ledger has no reader for them; the test probes the file. */
function rawRows(f: ReturnType<typeof mk>): string[] {
  const probe = new Database(f.ledgerPath, { readonly: true });
  try {
    return (probe.query("SELECT payload FROM raw_events ORDER BY id ASC").all() as Array<{ payload: string }>).map((r) => r.payload);
  } finally {
    probe.close();
  }
}

const payload = (overrides: Record<string, unknown> = {}) => ({
  verification_token: TOKEN,
  message_id: "2defe7b3-a0a9-4495-991c-ad08cd0dc51d",
  timestamp: "2024-01-25T15:22:49Z",
  type: "Donation",
  is_public: true,
  from_name: "Jo Example",
  message: "Good luck with the integration!",
  amount: "3.00",
  url: "https://ko-fi.com/Home/CoffeeShop?txid=00000000-1111-2222-3333-444444444444",
  email: "jo.example@example.com",
  currency: "USD",
  is_subscription_payment: false,
  is_first_subscription_payment: false,
  kofi_transaction_id: "00000000-1111-2222-3333-444444444444",
  shop_items: null,
  tier_name: null,
  shipping: null,
  ...overrides,
});

function post(body: string, hookPath = PATH, opts: { contentType?: string; ip?: string } = {}): Request {
  return new Request(`https://laptop.tail1234.ts.net/hooks/kofi/${hookPath}`, {
    method: "POST",
    headers: { "content-type": opts.contentType ?? "application/x-www-form-urlencoded", "x-forwarded-for": opts.ip ?? "203.0.113.9" },
    body,
  });
}
const form = (data: unknown) => `data=${encodeURIComponent(JSON.stringify(data))}`;
const send = (f: ReturnType<typeof mk>, body: string, hookPath = PATH, opts: Parameters<typeof post>[2] = {}) => f.handler(post(body, hookPath, opts), hookPath);

test("the path must equal config.ingest.kofi.webhookPath; an empty configured path matches nothing", async () => {
  const f = mk();
  expect((await send(f, form(payload()), "wrong")).status).toBe(404);
  expect((await send(f, form(payload()), "")).status).toBe(404);
  expect((await send(f, form(payload()), `${PATH}/`)).status).toBe(404);
  const unset = mk({ webhookPath: "" });
  expect((await send(unset, form(payload()), "")).status).toBe(404);
  expect((await send(unset, form(payload()), PATH)).status).toBe(404);
  expect(written(f)).toEqual([]);
  expect(written(unset)).toEqual([]);
});

test("ingest.kofi.enabled false → 404 even on the right path, nothing written; the flag is read per request", async () => {
  const off = mk({ enabled: false });
  expect((await send(off, form(payload()), PATH)).status).toBe(404);
  expect((await send(off, form(payload({ verification_token: "wrong" })), PATH)).status).toBe(404); // off is off: not even a token check
  expect(written(off)).toEqual([]);
  expect(off.engine.state.progressCents).toBe(0);
  off.config.ingest.kofi.enabled = true;
  expect((await send(off, form(payload()), PATH)).status).toBe(200);
  expect(off.engine.state.progressCents).toBe(300);
});

test("garbage bodies → 400 VALIDATION and nothing is written: no data field, data not JSON, data not an object, no token, no message_id", async () => {
  const f = mk();
  for (const body of ["", "foo=bar", "data=not-json", "data=%5B%5D", "data=null", form({ ...payload(), verification_token: undefined }), form({ ...payload(), message_id: 7 }), form({ ...payload(), message_id: "" })]) {
    const res = await send(f, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "VALIDATION", message: expect.any(String) } });
  }
  expect(written(f)).toEqual([]);
  expect(f.engine.state.progressCents).toBe(0);
});

test("token mismatch, wrong length, or no token configured → 401 + auth_failure; the token never appears in the response or the log", async () => {
  const f = mk();
  for (const [given, ip] of [
    [TOKEN.slice(0, -1) + "0", "198.51.100.1"],
    ["short", "198.51.100.2"],
    [`${TOKEN}x`, "198.51.100.3"],
    ["", "198.51.100.4"],
  ] as const) {
    const res = await send(f, form(payload({ verification_token: given })), PATH, { ip });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "UNAUTHORIZED", message: expect.any(String) } });
    expect(text).not.toContain(TOKEN);
    if (given !== "") expect(text).not.toContain(given);
    expect(f.ledger.all().at(-1)).toMatchObject({ type: "auth_failure", actor: KOFI_ACTOR, payload: { ip, path: "/hooks/kofi/<redacted>", reason: "bad verification token" } });
  }
  expect(written(f)).toHaveLength(4);
  expect(JSON.stringify(f.ledger.all())).not.toContain(PATH); // the path is the other half of the secret; the Ledger page must not show it
  expect(f.logs.join("\n")).not.toContain(TOKEN);

  const unconfigured = mk({ token: null });
  expect((await send(unconfigured, form(payload()))).status).toBe(401);
  expect(written(unconfigured)).toHaveLength(1);
  const blank = mk({ token: "" });
  expect((await send(blank, form(payload({ verification_token: "" })))).status).toBe(401);
});

test("Donation / Subscription credit as tips with the message id as dedupe key; replay → duplicate, no double credit; the email stays out of the entry", async () => {
  const f = mk();
  const first = await send(f, form(payload()));
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, credited: true });
  const entry = written(f)[0]!;
  expect(entry).toMatchObject({ type: "contribution", actor: KOFI_ACTOR, payload: { source: "kofi", sourceId: "kofi:2defe7b3-a0a9-4495-991c-ad08cd0dc51d", face: { kind: "tip", cents: 300 }, displayName: "Jo Example", anonymous: false, message: "Good luck with the integration!", occurredAt: "2024-01-25T15:22:49Z", currency: "USD", progressCents: 300 } });
  expect(JSON.stringify(entry)).not.toContain("jo.example@example.com");
  expect(f.engine.state.progressCents).toBe(300);
  const raw = rawRows(f); // the stored raw event keeps the event, not the credential and not the donor's email
  expect(raw).toHaveLength(1);
  expect(JSON.parse(raw[0]!)).toMatchObject({ message_id: "2defe7b3-a0a9-4495-991c-ad08cd0dc51d", type: "Donation", from_name: "Jo Example", amount: "3.00" });
  expect(raw[0]).not.toContain(TOKEN);
  expect(raw[0]).not.toContain("jo.example@example.com");
  expect(raw[0]).not.toContain("email");

  expect(await (await send(f, form(payload()))).json()).toEqual({ ok: true, duplicate: true });
  expect(await (await send(f, form(payload({ amount: "99.00" })))).json()).toEqual({ ok: true, duplicate: true }); // same message_id, whatever the body says
  expect(f.engine.state.progressCents).toBe(300);
  expect(written(f)).toHaveLength(1);

  const sub = await send(f, form(payload({ message_id: "c2c2c2c2-0000-0000-0000-000000000002", type: "Subscription", is_public: false, is_subscription_payment: true, amount: "4.35", currency: "EUR", message: null })));
  expect(await sub.json()).toEqual({ ok: true, credited: true });
  expect(written(f)[1]).toMatchObject({ payload: { displayName: null, anonymous: true, face: { kind: "tip", cents: 435 }, currency: "EUR" } });
  expect(f.engine.state.progressCents).toBe(735);
  expect(f.logs).toEqual([]);
});

test("Shop Order / Commission → 200 credited:false, stored raw so a replay is a duplicate; a malformed amount → 400 and no credit", async () => {
  const f = mk();
  const shop = form(payload({ message_id: "b1b1b1b1-0000-0000-0000-000000000001", type: "Shop Order", shop_items: [{ direct_link_code: "1a2b3c4d", variation_name: "Blue", quantity: 1 }] }));
  expect(await (await send(f, shop)).json()).toEqual({ ok: true, credited: false });
  expect(await (await send(f, shop)).json()).toEqual({ ok: true, duplicate: true });
  const commission = form(payload({ message_id: "d3d3d3d3-0000-0000-0000-000000000003", type: "Commission" }));
  expect(await (await send(f, commission)).json()).toEqual({ ok: true, credited: false });
  expect(written(f)).toEqual([]);
  expect(f.engine.state.progressCents).toBe(0);

  const bad = await send(f, form(payload({ message_id: "e4e4e4e4-0000-0000-0000-000000000004", amount: "3.499" })));
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: { code: "VALIDATION", message: expect.any(String) } });
  expect(written(f)).toEqual([]);
  expect(f.logs).toHaveLength(1);
  expect(f.logs[0]).toContain("e4e4e4e4-0000-0000-0000-000000000004");
  expect(f.logs[0]).not.toContain(TOKEN);
});
