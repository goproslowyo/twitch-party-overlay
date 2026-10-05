import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Secrets } from "../../config/secrets.ts";
import { Helix, HelixError } from "./helix.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>; // lower-cased names
  body: string | undefined;
}

const HELIX = "http://helix.test/helix";
const ID = "http://id.test/oauth2";
const T0 = new Date("2026-09-12T20:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs).toISOString();

function tmpSecrets(values: Record<string, string>): { secrets: Secrets; path: string } {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tpo-helix-")), "secrets.env");
  const secrets = new Secrets(p);
  for (const [k, v] of Object.entries(values)) secrets.set(k, v);
  return { secrets, path: p };
}

const broadcasterTokens = (expiresAt: string | null = at(3_600_000)) => ({
  TWITCH_BROADCASTER_ACCESS_TOKEN: "old-access",
  TWITCH_BROADCASTER_REFRESH_TOKEN: "old-refresh",
  ...(expiresAt === null ? {} : { TWITCH_BROADCASTER_EXPIRES_AT: expiresAt }),
});

/** Records every call; `route` answers it (undefined → 404). */
function fakeTwitch(route: (call: Call, index: number) => Response | undefined) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    return route(call, calls.length - 1) ?? new Response("not found", { status: 404 });
  };
  return { calls, fetchImpl };
}

const tokenEndpoint = (call: Call) =>
  call.method === "POST" && call.url === `${ID}/token`
    ? Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 14400, scope: ["bits:read"], token_type: "bearer" })
    : undefined;

function helix(secrets: Secrets, fetchImpl: ReturnType<typeof fakeTwitch>["fetchImpl"], now: () => Date = () => T0): Helix {
  return new Helix({ clientId: "cid", clientSecret: "csecret", secrets, fetchImpl, now, helixUrl: HELIX, idUrl: ID });
}

test("token(): returns the stored access token without any request while the expiry is more than 60 s away", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens(at(61_000)));
  const tw = fakeTwitch(tokenEndpoint);
  expect(await helix(secrets, tw.fetchImpl).token()).toBe("old-access");
  expect(tw.calls).toHaveLength(0);
});

test("token(): refreshes when TWITCH_BROADCASTER_EXPIRES_AT is within 60 s, persisting all three keys", async () => {
  const { secrets, path: p } = tmpSecrets(broadcasterTokens(at(60_000)));
  const tw = fakeTwitch(tokenEndpoint);

  expect(await helix(secrets, tw.fetchImpl).token()).toBe("new-access");

  expect(tw.calls).toHaveLength(1);
  const call = tw.calls[0]!;
  expect(call.method).toBe("POST");
  expect(call.url).toBe(`${ID}/token`);
  expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  expect(Object.fromEntries(new URLSearchParams(call.body).entries())).toEqual({
    grant_type: "refresh_token",
    refresh_token: "old-refresh",
    client_id: "cid",
    client_secret: "csecret",
  });

  const persisted = new Secrets(p); // re-read from disk: the refresh survives a restart
  expect(persisted.get("TWITCH_BROADCASTER_ACCESS_TOKEN")).toBe("new-access");
  expect(persisted.get("TWITCH_BROADCASTER_REFRESH_TOKEN")).toBe("new-refresh");
  expect(persisted.get("TWITCH_BROADCASTER_EXPIRES_AT")).toBe(at(14400 * 1000));
});

test("token(): a missing expiry refreshes; a missing refresh token throws instead of calling Twitch", async () => {
  const noExpiry = tmpSecrets(broadcasterTokens(null));
  const tw = fakeTwitch(tokenEndpoint);
  expect(await helix(noExpiry.secrets, tw.fetchImpl).token()).toBe("new-access");
  expect(tw.calls).toHaveLength(1);

  const noRefresh = tmpSecrets({ TWITCH_BROADCASTER_ACCESS_TOKEN: "old-access" });
  const tw2 = fakeTwitch(tokenEndpoint);
  await expect(helix(noRefresh.secrets, tw2.fetchImpl).token()).rejects.toThrow(/refresh token/i);
  expect(tw2.calls).toHaveLength(0);
});

test("token(): concurrent callers share one in-flight refresh (two sessions subscribing at once)", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens(at(1_000)));
  const tw = fakeTwitch(tokenEndpoint);
  const h = helix(secrets, tw.fetchImpl);
  expect(await Promise.all([h.token(), h.token(), h.token()])).toEqual(["new-access", "new-access", "new-access"]);
  expect(tw.calls).toHaveLength(1);
});

test("token(): a refresh response without expires_in is accepted with a 3600 s default expiry", async () => {
  const { secrets, path: p } = tmpSecrets(broadcasterTokens(at(1_000)));
  const tw = fakeTwitch((call) =>
    call.method === "POST" && call.url === `${ID}/token` ? Response.json({ access_token: "new-access", refresh_token: "new-refresh", scope: ["bits:read"], token_type: "bearer" }) : undefined,
  );

  expect(await helix(secrets, tw.fetchImpl).token()).toBe("new-access");

  const persisted = new Secrets(p);
  expect(persisted.get("TWITCH_BROADCASTER_ACCESS_TOKEN")).toBe("new-access");
  expect(persisted.get("TWITCH_BROADCASTER_EXPIRES_AT")).toBe(at(3600 * 1000));
});

test("get(): Bearer + Client-Id headers and query params; a 401 refreshes once and retries", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch((call, i) => {
    if (call.url.startsWith(`${HELIX}/users`)) {
      return call.headers.authorization === "Bearer new-access" ? Response.json({ data: [{ id: "1337" }] }) : new Response("Unauthorized", { status: 401 });
    }
    return tokenEndpoint(call);
  });

  const got = await helix(secrets, tw.fetchImpl).get("users", { id: "1337" });

  expect(got).toEqual({ data: [{ id: "1337" }] });
  expect(tw.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${HELIX}/users?id=1337`, `POST ${ID}/token`, `GET ${HELIX}/users?id=1337`]);
  expect(tw.calls[0]!.headers.authorization).toBe("Bearer old-access");
  expect(tw.calls[0]!.headers["client-id"]).toBe("cid");
  expect(tw.calls[2]!.headers.authorization).toBe("Bearer new-access");
});

test("get(): a second 401 after the refresh throws rather than looping; other non-2xx statuses throw with the status", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch((call) => (call.url.startsWith(HELIX) ? new Response("Unauthorized", { status: 401 }) : tokenEndpoint(call)));
  await expect(helix(secrets, tw.fetchImpl).get("users", {})).rejects.toThrow(/401/);
  expect(tw.calls).toHaveLength(3); // GET 401 → refresh → GET 401 → give up

  const boom = fakeTwitch(() => new Response("nope", { status: 500 }));
  await expect(helix(tmpSecrets(broadcasterTokens()).secrets, boom.fetchImpl).get("users", {})).rejects.toThrow(/500/);
  expect(boom.calls).toHaveLength(1);
});

test("post(): JSON body with the auth headers; returns the parsed response", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch((call) =>
    call.method === "POST" && call.url === `${HELIX}/eventsub/subscriptions` ? Response.json({ data: [{ id: "sub-1", status: "enabled" }], total: 1, total_cost: 0, max_total_cost: 10 }, { status: 202 }) : undefined,
  );
  const body = { type: "channel.cheer", version: "1", condition: { broadcaster_user_id: "1337" }, transport: { method: "websocket", session_id: "s1" } };

  const got = await helix(secrets, tw.fetchImpl).post("eventsub/subscriptions", body);

  expect(got).toEqual({ data: [{ id: "sub-1", status: "enabled" }], total: 1, total_cost: 0, max_total_cost: 10 });
  const call = tw.calls[0]!;
  expect(call.headers.authorization).toBe("Bearer old-access");
  expect(call.headers["client-id"]).toBe("cid");
  expect(call.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(call.body!)).toEqual(body);
});

test("post(): a non-2xx throws a HelixError whose message is the status line and whose status and body are Twitch's, the body trimmed to 300 characters", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const body = `{"error":"Too Many Requests","status":429,"message":"subscription limit exceeded ${"x".repeat(400)}"}`;
  const tw = fakeTwitch(() => new Response(body, { status: 429 }));
  const err = await helix(secrets, tw.fetchImpl)
    .post("eventsub/subscriptions", { type: "channel.chat.message" })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(HelixError);
  expect((err as HelixError).message).toBe("Helix POST eventsub/subscriptions → 429");
  expect((err as HelixError).status).toBe(429);
  expect((err as HelixError).body).toBe(body.slice(0, 300));
});

test("post(): `{ url }` sends the same request (headers, body) to an absolute url instead of <helixUrl>/<path> — the Twitch CLI mock's subscriptions endpoint", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch((call) => (call.method === "POST" && call.url === "http://127.0.0.1:8098/eventsub/subscriptions" ? Response.json({ data: [] }, { status: 202 }) : undefined));
  const body = { type: "channel.cheer", version: "1", condition: { broadcaster_user_id: "1337" }, transport: { method: "websocket", session_id: "s1" } };

  expect(await helix(secrets, tw.fetchImpl).post("eventsub/subscriptions", body, { url: "http://127.0.0.1:8098/eventsub/subscriptions" })).toEqual({ data: [] });

  expect(tw.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST http://127.0.0.1:8098/eventsub/subscriptions"]);
  const call = tw.calls[0]!;
  expect(call.headers.authorization).toBe("Bearer old-access");
  expect(call.headers["client-id"]).toBe("cid");
  expect(call.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(call.body!)).toEqual(body);
});

test("isModerator: exactly one row → true; no rows → false", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch((call) => {
    const u = new URL(call.url);
    if (u.pathname !== "/helix/moderation/moderators") return undefined;
    return Response.json({ data: u.searchParams.get("user_id") === "42" ? [{ user_id: "42", user_login: "mod42", user_name: "Mod42" }] : [], pagination: {} });
  });
  const h = helix(secrets, tw.fetchImpl);

  expect(await h.isModerator("1337", "42")).toBe(true);
  expect(await h.isModerator("1337", "99")).toBe(false);
  expect(tw.calls[0]!.url).toBe(`${HELIX}/moderation/moderators?broadcaster_id=1337&user_id=42`);
});

test("listModerators: follows pagination.cursor with first=100 until the cursor runs out", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch((call) => {
    const u = new URL(call.url);
    if (u.pathname !== "/helix/moderation/moderators") return undefined;
    switch (u.searchParams.get("after")) {
      case null:
        return Response.json({ data: [{ user_id: "1", user_login: "a", user_name: "A" }, { user_id: "2", user_login: "b", user_name: "B" }], pagination: { cursor: "c1" } });
      case "c1":
        return Response.json({ data: [{ user_id: "3", user_login: "c", user_name: "C" }], pagination: { cursor: "c2" } });
      case "c2":
        return Response.json({ data: [], pagination: {} });
      default:
        return undefined;
    }
  });

  const mods = await helix(secrets, tw.fetchImpl).listModerators("1337");

  expect(mods).toEqual([{ user_id: "1", user_login: "a" }, { user_id: "2", user_login: "b" }, { user_id: "3", user_login: "c" }]);
  expect(tw.calls.map((c) => c.url)).toEqual([
    `${HELIX}/moderation/moderators?broadcaster_id=1337&first=100`,
    `${HELIX}/moderation/moderators?broadcaster_id=1337&first=100&after=c1`,
    `${HELIX}/moderation/moderators?broadcaster_id=1337&first=100&after=c2`,
  ]);
});

test("validate(token): GET <idUrl>/validate with `Authorization: OAuth <token>` → { user_id, login }; non-2xx throws", async () => {
  const { secrets } = tmpSecrets({});
  const tw = fakeTwitch((call) =>
    call.method === "GET" && call.url === `${ID}/validate` && call.headers.authorization === "OAuth user-token"
      ? Response.json({ client_id: "cid", login: "examplestreamer", scopes: [], user_id: "1337", expires_in: 5000 })
      : new Response("Unauthorized", { status: 401 }),
  );
  const h = helix(secrets, tw.fetchImpl);

  expect(await h.validate("user-token")).toEqual({ user_id: "1337", login: "examplestreamer", scopes: [] });
  expect(tw.calls[0]!.headers["client-id"]).toBeUndefined(); // the validate endpoint takes only the OAuth header
  await expect(h.validate("bogus")).rejects.toThrow(/401/);
});

test("validate(token): a 2xx body without a non-empty string user_id / login is malformed and throws — never { user_id: \"undefined\" }", async () => {
  const { secrets } = tmpSecrets({});
  const bodies: unknown[] = [{}, { user_id: "", login: "examplestreamer" }, { user_id: 1337, login: "examplestreamer" }, { user_id: "1337" }, { user_id: "1337", login: null }];
  let i = 0;
  const tw = fakeTwitch(() => Response.json(bodies[i++]));
  const h = helix(secrets, tw.fetchImpl);
  for (const body of bodies) await expect(h.validate("user-token")).rejects.toThrow(`Twitch validate → malformed body ${JSON.stringify(body)}`);
});

test("token(): a refresh reports `token refreshed, expires <iso>` through the verbose hook — the new expiry only, never a token or the client secret", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens(at(1_000)));
  const tw = fakeTwitch(tokenEndpoint);
  const lines: string[] = [];
  const h = new Helix({ clientId: "cid", clientSecret: "csecret", secrets, fetchImpl: tw.fetchImpl, now: () => T0, helixUrl: HELIX, idUrl: ID, verbose: (line) => void lines.push(line) });

  expect(await h.token()).toBe("new-access");
  expect(lines).toEqual([`token refreshed, expires ${at(14400 * 1000)}`]);
  for (const line of lines) for (const secret of ["new-access", "new-refresh", "old-access", "old-refresh", "csecret"]) expect(line).not.toContain(secret);

  // a cached token is not a refresh: nothing more is said
  expect(await h.token()).toBe("new-access");
  expect(lines).toHaveLength(1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Get Users (the Avatar Picture): id → profile picture, no scope needed, ≤ 100 per call
// ---------------------------------------------------------------------------------------------------------------------

const PIC = (n: string) => `https://static-cdn.jtvnw.net/jtv_user_pictures/${n}-profile_image-300x300.png`;
const usersEndpoint = (call: Call) => {
  const u = new URL(call.url);
  if (u.pathname !== "/helix/users") return undefined;
  const rows = [...u.searchParams.getAll("id").map((id) => ({ id, login: `login${id}`, display_name: `User${id}`, profile_image_url: PIC(id) })), ...u.searchParams.getAll("login").map((login) => ({ id: `id-of-${login}`, login, display_name: login.toUpperCase(), profile_image_url: PIC(login) }))];
  return Response.json({ data: rows.map((r) => ({ ...r, type: "", broadcaster_type: "", description: "", offline_image_url: "", view_count: 0, created_at: "2020-01-01T00:00:00Z" })) });
};

test("usersByIds: GET /helix/users?id=1&id=2 with the client's token and Client-Id → { id, login, profileImageUrl } per row (the raw 300x300 URL; the cache resizes)", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch(usersEndpoint);
  const got = await helix(secrets, tw.fetchImpl).usersByIds(["1", "2"]);
  expect(got).toEqual([
    { id: "1", login: "login1", profileImageUrl: PIC("1") },
    { id: "2", login: "login2", profileImageUrl: PIC("2") },
  ]);
  expect(tw.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${HELIX}/users?id=1&id=2`]);
  expect(tw.calls[0]!.headers.authorization).toBe("Bearer old-access");
  expect(tw.calls[0]!.headers["client-id"]).toBe("cid");
});

test("usersByLogins: GET /helix/users?login=a&login=b; an empty list makes no request at all", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch(usersEndpoint);
  const h = helix(secrets, tw.fetchImpl);
  expect(await h.usersByLogins(["styler", "cool_user"])).toEqual([
    { id: "id-of-styler", login: "styler", profileImageUrl: PIC("styler") },
    { id: "id-of-cool_user", login: "cool_user", profileImageUrl: PIC("cool_user") },
  ]);
  expect(tw.calls.map((c) => c.url)).toEqual([`${HELIX}/users?login=styler&login=cool_user`]);
  expect(await h.usersByIds([])).toEqual([]);
  expect(await h.usersByLogins([])).toEqual([]);
  expect(tw.calls).toHaveLength(1);
});

test("usersByIds: more than 100 ids go out in chunks of 100 (the endpoint's cap); the rows come back in one list; malformed rows are skipped, unknown ids are simply absent", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch((call) => {
    const u = new URL(call.url);
    if (u.pathname !== "/helix/users") return undefined;
    const ids = u.searchParams.getAll("id");
    if (ids.length > 100) return new Response("too many", { status: 400 });
    const data: unknown[] = ids.filter((id) => id !== "404").map((id) => ({ id, login: `l${id}`, profile_image_url: PIC(id) }));
    data.push({ id: 7 }, { login: "no-id", profile_image_url: PIC("x") }, null, { id: "junk", login: "ljunk" }); // junk shapes: never a row
    return Response.json({ data });
  });
  const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
  ids[3] = "404";
  const got = await helix(secrets, tw.fetchImpl).usersByIds(ids);
  expect(tw.calls).toHaveLength(2);
  expect(new URL(tw.calls[0]!.url).searchParams.getAll("id")).toHaveLength(100);
  expect(new URL(tw.calls[1]!.url).searchParams.getAll("id")).toHaveLength(50);
  expect(got).toHaveLength(149);
  expect(got.find((u) => u.id === "404")).toBeUndefined();
  expect(got.find((u) => u.id === "junk")).toBeUndefined(); // from the junk row: no picture url
  expect(got[0]).toEqual({ id: "1", login: "l1", profileImageUrl: PIC("1") });
});

test("usersByIds: a non-2xx answer throws (the Avatar cache turns that into a glyph and a throttled warning; the Helix client itself stays honest)", async () => {
  const { secrets } = tmpSecrets(broadcasterTokens());
  const tw = fakeTwitch(() => new Response("nope", { status: 500 }));
  await expect(helix(secrets, tw.fetchImpl).usersByIds(["1"])).rejects.toThrow(/500/);
});

test("validate(token): the token's scopes ride along in Twitch's order; a body with no scopes (or a non-array) gives []", async () => {
  const { secrets } = tmpSecrets({});
  const bodies: unknown[] = [
    { client_id: "cid", login: "examplestreamer", user_id: "1337", scopes: ["bits:read", "user:read:chat"], expires_in: 5000 },
    { client_id: "cid", login: "examplestreamer", user_id: "1337", expires_in: 5000 },
    { client_id: "cid", login: "examplestreamer", user_id: "1337", scopes: "bits:read", expires_in: 5000 },
    { client_id: "cid", login: "examplestreamer", user_id: "1337", scopes: ["bits:read", 7, null], expires_in: 5000 },
  ];
  let i = 0;
  const tw = fakeTwitch(() => Response.json(bodies[i++]));
  const h = helix(secrets, tw.fetchImpl);
  expect((await h.validate("t")).scopes).toEqual(["bits:read", "user:read:chat"]);
  expect((await h.validate("t")).scopes).toEqual([]);
  expect((await h.validate("t")).scopes).toEqual([]);
  expect((await h.validate("t")).scopes).toEqual(["bits:read"]); // non-strings dropped, never thrown on
});
