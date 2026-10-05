/**
 * Twitch Helix + id.twitch.tv client.
 *
 * Every Helix call carries the broadcaster's user token from Secrets (`TWITCH_BROADCASTER_*`), refreshed through
 * `POST /oauth2/token` (grant_type=refresh_token) when the stored expiry is within 60 s or missing; the three keys are
 * persisted on every refresh so a restart picks up where the last refresh left off. A 401 triggers one refresh + retry.
 *
 * `usersByIds` / `usersByLogins` (Get Users, for the Avatar Picture) need no scope — any app or user token — and take at most
 * 100 ids or logins per call, so longer lists go out in chunks; the raw `profile_image_url` (Twitch's 300x300 variant)
 * is returned as is and `src/server/avatars.ts` picks the size.
 */
import type { Secrets } from "../../config/secrets.ts";

/** The callable part of `fetch` — `globalThis.fetch` satisfies it; tests inject a recorder. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** A credential as a value, or as a getter read on every use (boot.ts hands in Secrets getters so the Setup page's save applies at once). */
export type Credential = string | (() => string);
export const credential = (c: Credential): (() => string) => (typeof c === "function" ? c : () => c);

export interface HelixOptions {
  clientId: Credential;
  clientSecret: Credential;
  secrets: Secrets;
  fetchImpl?: FetchLike;
  now?: () => Date;
  helixUrl?: string; // default https://api.twitch.tv/helix
  idUrl?: string; // default https://id.twitch.tv/oauth2
  /** VERBOSE detail: `token refreshed, expires <iso>` after every refresh — the expiry only, never a token. Default: nothing. */
  verbose?: (line: string) => void;
}

export const TOKEN_KEYS = {
  access: "TWITCH_BROADCASTER_ACCESS_TOKEN",
  refresh: "TWITCH_BROADCASTER_REFRESH_TOKEN",
  expiresAt: "TWITCH_BROADCASTER_EXPIRES_AT",
} as const;

const REFRESH_MARGIN_MS = 60_000;
const DEFAULT_EXPIRES_IN_S = 3_600; // when a refresh response omits `expires_in`: a usable token beats a refusal

type Params = Record<string, string | string[]>; // an array repeats the key: `id=1&id=2`

/** One row of Get Users, the three fields the overlay's Avatar Picture needs. */
export interface HelixUser {
  id: string;
  login: string;
  profileImageUrl: string;
}

const USERS_PER_CALL = 100;

/** The longest response body kept on a refusal: Twitch's error JSON is one short line; a proxy's HTML page is not. */
const ERROR_BODY_MAX = 300;

/** A non-2xx Helix answer: the message is the status line as ever; `status` and `body` carry what Twitch said. */
export class HelixError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "HelixError";
    this.status = status;
    this.body = body;
  }
}

export class Helix {
  readonly #clientId: () => string;
  readonly #clientSecret: () => string;
  readonly #secrets: Secrets;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #helixUrl: string;
  readonly #idUrl: string;
  readonly #verbose: (line: string) => void;
  #refreshing: Promise<string> | null = null; // concurrent callers (two EventSub sessions) share one refresh

  constructor(opts: HelixOptions) {
    this.#clientId = credential(opts.clientId);
    this.#clientSecret = credential(opts.clientSecret);
    this.#secrets = opts.secrets;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? (() => new Date());
    this.#helixUrl = (opts.helixUrl ?? "https://api.twitch.tv/helix").replace(/\/$/, "");
    this.#idUrl = (opts.idUrl ?? "https://id.twitch.tv/oauth2").replace(/\/$/, "");
    this.#verbose = opts.verbose ?? (() => {});
  }

  /** The broadcaster access token, refreshed first when it expires within 60 s (or the expiry/token is missing). */
  async token(): Promise<string> {
    const access = this.#secrets.get(TOKEN_KEYS.access);
    const expiresAt = Date.parse(this.#secrets.get(TOKEN_KEYS.expiresAt) ?? "");
    if (access !== undefined && Number.isFinite(expiresAt) && expiresAt - this.#now().getTime() > REFRESH_MARGIN_MS) return access;
    return this.#refresh();
  }

  get(path: string, params: Params = {}): Promise<any> {
    return this.#request("GET", path, params, undefined);
  }

  /** `opts.url`: send the same request (auth headers, JSON body) to an absolute url instead of `<helixUrl>/<path>` — the Twitch CLI mock's subscriptions endpoint. */
  post(path: string, body: unknown, opts: { url?: string } = {}): Promise<any> {
    return this.#request("POST", path, {}, body, false, opts.url);
  }

  /** Mod login: exactly one moderator row for `userId` → Mod. */
  async isModerator(broadcasterId: string, userId: string): Promise<boolean> {
    const res = await this.get("moderation/moderators", { broadcaster_id: broadcasterId, user_id: userId });
    return Array.isArray(res?.data) && res.data.length === 1;
  }

  /** The full moderator list, following `pagination.cursor` (last-known-good list for the Helix-down fallback at login). */
  async listModerators(broadcasterId: string): Promise<Array<{ user_id: string; user_login: string }>> {
    const out: Array<{ user_id: string; user_login: string }> = [];
    let cursor: string | undefined;
    do {
      const params: Params = { broadcaster_id: broadcasterId, first: "100" };
      if (cursor !== undefined) params.after = cursor;
      const res = await this.get("moderation/moderators", params);
      for (const row of (res?.data ?? []) as Array<{ user_id: unknown; user_login: unknown }>) {
        out.push({ user_id: String(row.user_id), user_login: String(row.user_login) });
      }
      const next = res?.pagination?.cursor;
      cursor = typeof next === "string" && next !== "" ? next : undefined;
    } while (cursor !== undefined);
    return out;
  }

  /** Get Users by id, chunked at 100 per call; ids Twitch does not know are simply absent from the result; `[]` makes no request. */
  usersByIds(ids: readonly string[]): Promise<HelixUser[]> {
    return this.#users("id", ids);
  }

  /** Get Users by login (case-insensitive on Twitch's side), chunked at 100 per call; `[]` makes no request. */
  usersByLogins(logins: readonly string[]): Promise<HelixUser[]> {
    return this.#users("login", logins);
  }

  async #users(key: "id" | "login", values: readonly string[]): Promise<HelixUser[]> {
    const out: HelixUser[] = [];
    for (let i = 0; i < values.length; i += USERS_PER_CALL) {
      const res = await this.get("users", { [key]: values.slice(i, i + USERS_PER_CALL) });
      for (const row of (Array.isArray(res?.data) ? res.data : []) as unknown[]) {
        const user = helixUser(row);
        if (user !== null) out.push(user);
      }
    }
    return out;
  }

  /** `GET /oauth2/validate` with `Authorization: OAuth <token>` (the OAuth callback) → who the token belongs to and what it may do (`scopes`: [] when Twitch sends none). */
  async validate(token: string): Promise<{ user_id: string; login: string; scopes: string[] }> {
    const res = await this.#fetch(`${this.#idUrl}/validate`, { headers: { Authorization: `OAuth ${token}` } });
    if (!res.ok) throw new Error(`Twitch validate → ${res.status}`);
    const body = (await res.json()) as { user_id?: unknown; login?: unknown; scopes?: unknown };
    const { user_id, login } = body;
    // A 2xx with no usable identity must never become { user_id: "undefined" } (that would be a real, wrong principal).
    if (typeof user_id !== "string" || user_id === "" || typeof login !== "string" || login === "") throw new Error(`Twitch validate → malformed body ${JSON.stringify(body)}`);
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
    return { user_id, login, scopes };
  }

  async #request(method: "GET" | "POST", path: string, params: Params, body: unknown, retried = false, absoluteUrl?: string): Promise<any> {
    const url = new URL(absoluteUrl ?? `${this.#helixUrl}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === "string") url.searchParams.set(k, v);
      else for (const item of v) url.searchParams.append(k, item);
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}`, "Client-Id": this.#clientId() };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.#fetch(url.toString(), init);
    if (res.status === 401 && !retried) {
      await this.#refresh();
      return this.#request(method, path, params, body, true, absoluteUrl);
    }
    if (!res.ok) throw new HelixError(`Helix ${method} ${path} → ${res.status}`, res.status, (await res.text().catch(() => "")).slice(0, ERROR_BODY_MAX));
    return res.status === 204 ? null : res.json();
  }

  #refresh(): Promise<string> {
    this.#refreshing ??= this.#doRefresh().finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<string> {
    const refreshToken = this.#secrets.get(TOKEN_KEYS.refresh);
    if (refreshToken === undefined) throw new Error("Twitch: no broadcaster refresh token in Secrets — connect the broadcaster account again");
    const res = await this.#fetch(`${this.#idUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: this.#clientId(), client_secret: this.#clientSecret() }).toString(),
    });
    if (!res.ok) throw new Error(`Twitch token refresh → ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new Error("Twitch token refresh: malformed response");
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : DEFAULT_EXPIRES_IN_S;
    this.#secrets.set(TOKEN_KEYS.access, body.access_token);
    this.#secrets.set(TOKEN_KEYS.refresh, typeof body.refresh_token === "string" ? body.refresh_token : refreshToken);
    const expiresAt = new Date(this.#now().getTime() + expiresIn * 1000).toISOString();
    this.#secrets.set(TOKEN_KEYS.expiresAt, expiresAt);
    this.#verbose(`token refreshed, expires ${expiresAt}`);
    return body.access_token;
  }
}

/** A Get Users row with non-empty string `id`, `login` and `profile_image_url`; anything else is not a user we can picture. */
function helixUser(row: unknown): HelixUser | null {
  if (typeof row !== "object" || row === null) return null;
  const { id, login, profile_image_url: url } = row as { id?: unknown; login?: unknown; profile_image_url?: unknown };
  if (typeof id !== "string" || id === "" || typeof login !== "string" || login === "" || typeof url !== "string" || url === "") return null;
  return { id, login, profileImageUrl: url };
}
