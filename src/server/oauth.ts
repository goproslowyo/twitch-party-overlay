/**
 * Twitch OAuth: mod login over the funnel (`/login`) and the one-time broadcaster link on the streamer
 * listener (`/auth/twitch/broadcaster`), both returning to `/auth/twitch/callback` on the listener that started them.
 *
 * `start` sends the browser to id.twitch.tv with a fresh `state` and keeps state + mode + redirect URI in a signed,
 * 10-minute `tpo_oauth` cookie. `callback` exact-matches the state, exchanges the code, validates the token to learn
 * who it belongs to, then either stores the broadcaster tokens (broadcaster mode) or decides the role (login mode):
 * broadcaster id → Streamer; a live Helix moderator check → Mod; Helix down → the last-known-good `mods.json`;
 * otherwise 403 plus an `auth_failure` entry. A login-mode token is used for `validate` only and never stored.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config/schema.ts";
import type { Secrets } from "../config/secrets.ts";
import { TOKEN_KEYS, credential, type Credential, type FetchLike, type Helix } from "../ingest/twitch/helix.ts";
import type { Ledger } from "../ledger/ledger.ts";
import { AUTH_FAILURE_ACTOR, SESSION_TTL_MS, sessionCookie, sessionSecret, sign, signSession, twitchActor, verify, type AppListener, type Role } from "./auth.ts";
import { clientIp, escapeHtml, html, notFound, parseCookies, redirect, serializeCookie } from "./http-util.ts";

export type OAuthMode = "login" | "broadcaster";

export const OAUTH_COOKIE = "tpo_oauth";
export const OAUTH_TTL_MS = 10 * 60 * 1000;
export const CHAT_SCOPE = "user:read:chat"; // read chat as the broadcaster; a refresh never adds it, the link must be clicked once more
export const BROADCASTER_SCOPES = "bits:read channel:read:subscriptions moderation:read user:read:chat";
export const CALLBACK_PATH = "/auth/twitch/callback";
export const MODS_FILE = "mods.json";

const DEFAULT_EXPIRES_IN_S = 3_600;
/** Each mode belongs to exactly one listener; the other listener answers 404. */
const LISTENER_FOR_MODE: Record<OAuthMode, AppListener> = { login: "funnel", broadcaster: "streamer" };

export interface OAuthOptions {
  /** A value, or a getter read on every use (boot.ts: Secrets, so the Setup page's save applies without a restart). */
  clientId: Credential;
  clientSecret: Credential;
  secrets: Secrets;
  helix: Helix;
  config: () => Config;
  /** Broadcaster link succeeded: the caller persists `channel.broadcasterId` / `channel.login` in config. */
  onBroadcasterLinked: (userId: string, login: string) => void;
  ledger: Ledger;
  /** Holds `mods.json`, the last-known-good moderator list. */
  dataDir: string;
  fetchImpl?: FetchLike;
  /** The OAuth `state`; default 32 random bytes, hex. */
  random?: () => string;
  now?: () => Date;
  idUrl?: string; // default https://id.twitch.tv/oauth2
  /** Console: login attempts and successes, the broadcaster link (never a code, token or cookie). Default console.log. */
  log?: (line: string) => void;
}

/** What the signed `tpo_oauth` cookie carries between `start` and `callback` (signed with kind "oauth" — see auth.ts). */
interface Ticket {
  state: string;
  mode: OAuthMode;
  redirectUri: string;
  exp: number;
}

interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

interface Moderator {
  user_id: string;
  user_login: string;
}

const page = (title: string, detail: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem">` +
  `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class OAuth {
  readonly #clientId: () => string;
  readonly #clientSecret: () => string;
  readonly #secrets: Secrets;
  readonly #helix: Helix;
  readonly #config: () => Config;
  readonly #onBroadcasterLinked: (userId: string, login: string) => void;
  readonly #ledger: Ledger;
  readonly #modsPath: string;
  readonly #fetch: FetchLike;
  readonly #random: () => string;
  readonly #now: () => Date;
  readonly #idUrl: string;
  readonly #log: (line: string) => void;

  constructor(opts: OAuthOptions) {
    this.#clientId = credential(opts.clientId);
    this.#clientSecret = credential(opts.clientSecret);
    this.#secrets = opts.secrets;
    this.#helix = opts.helix;
    this.#config = opts.config;
    this.#onBroadcasterLinked = opts.onBroadcasterLinked;
    this.#ledger = opts.ledger;
    this.#modsPath = path.join(opts.dataDir, MODS_FILE);
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#random = opts.random ?? (() => randomBytes(32).toString("hex"));
    this.#now = opts.now ?? (() => new Date());
    this.#idUrl = (opts.idUrl ?? "https://id.twitch.tv/oauth2").replace(/\/$/, "");
    this.#log = opts.log ?? ((line) => console.log(line));
  }

  /** `streamer` → `http://localhost:<streamerPort>/auth/twitch/callback`; funnel → `<funnel.publicUrl>/auth/twitch/callback`. */
  redirectUri(listener: AppListener): string {
    const config = this.#config();
    if (listener === "streamer") return `http://localhost:${config.listeners.streamerPort}${CALLBACK_PATH}`;
    return `${config.funnel.publicUrl.replace(/\/+$/, "")}${CALLBACK_PATH}`;
  }

  /** 302 to Twitch's authorize page plus the signed `tpo_oauth` cookie. */
  start(mode: OAuthMode, listener: AppListener, req: Request): Response {
    if (LISTENER_FOR_MODE[mode] !== listener) return notFound();
    if (listener === "funnel" && this.#config().funnel.publicUrl === "") {
      return html(page("Login is not set up yet", "The funnel URL (funnel.publicUrl) is not configured, so there is no redirect URI to send Twitch back to."), 503);
    }
    this.#log(`login attempt: ${listener} from ${clientIp(req)}${mode === "broadcaster" ? " (broadcaster link)" : ""}`);
    const redirectUri = this.redirectUri(listener);
    const ticket: Ticket = { state: this.#random(), mode, redirectUri, exp: this.#now().getTime() + OAUTH_TTL_MS };
    const url = new URL(`${this.#idUrl}/authorize`);
    url.searchParams.set("client_id", this.#clientId());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", mode === "broadcaster" ? BROADCASTER_SCOPES : "");
    url.searchParams.set("state", ticket.state);
    return redirect(url.toString(), { "set-cookie": this.#oauthCookie(sign(this.#secret(), "oauth", ticket), listener, OAUTH_TTL_MS / 1000) });
  }

  async callback(listener: AppListener, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const clearTicket = this.#oauthCookie("", listener, 0);
    // Failed auth on the funnel is a passive tripwire: recorded, never blocked. `reason: null` = not an auth failure.
    const fail = (status: number, title: string, detail: string, reason: string | null): Response => {
      if (reason !== null && listener === "funnel") {
        this.#ledger.append("auth_failure", AUTH_FAILURE_ACTOR, { ip: clientIp(req), path: url.pathname, reason });
      }
      return html(page(title, detail), status, { "set-cookie": clearTicket });
    };

    const raw = parseCookies(req).get(OAUTH_COOKIE);
    const ticket = raw === undefined ? null : this.#readTicket(raw);
    if (ticket === null) return fail(400, "Login expired", "This login attempt is missing or has expired. Start again.", "oauth: missing or expired state cookie");
    const state = url.searchParams.get("state");
    if (state === null || !safeEqual(state, ticket.state)) return fail(400, "Login rejected", "This login attempt did not come from this browser. Start again.", "oauth: state mismatch");
    if (LISTENER_FOR_MODE[ticket.mode] !== listener) return notFound();

    const twitchError = url.searchParams.get("error");
    if (twitchError !== null) return fail(400, "Login cancelled", `Twitch reported: ${twitchError}.`, null);
    const code = url.searchParams.get("code");
    if (!code) return fail(400, "Login rejected", "Twitch did not return an authorization code.", "oauth: missing code");

    let tokens: Tokens;
    try {
      tokens = await this.#exchange(code, ticket.redirectUri);
    } catch (e) {
      return fail(502, "Twitch did not accept the login", "The authorization code was refused. Start again.", `oauth: code exchange failed: ${errorText(e)}`);
    }
    let identity: { user_id: string; login: string };
    try {
      identity = await this.#helix.validate(tokens.accessToken);
    } catch (e) {
      return fail(502, "Twitch did not confirm the login", "The token could not be validated. Start again.", `oauth: token validation failed: ${errorText(e)}`);
    }

    if (ticket.mode === "broadcaster") {
      if (tokens.refreshToken === null) return fail(502, "Twitch did not issue a refresh token", "The broadcaster link needs a refresh token. Start again.", null);
      this.#secrets.set(TOKEN_KEYS.access, tokens.accessToken);
      this.#secrets.set(TOKEN_KEYS.refresh, tokens.refreshToken);
      this.#secrets.set(TOKEN_KEYS.expiresAt, new Date(this.#now().getTime() + tokens.expiresIn * 1000).toISOString());
      this.#log(`broadcaster linked: ${twitchActor(identity.login)} (${identity.user_id})`);
      this.#onBroadcasterLinked(identity.user_id, identity.login);
      return redirect("/", { "set-cookie": clearTicket });
    }

    // Login mode: the user's token has done its only job (validate) and is dropped here.
    const role = await this.#roleFor(identity.user_id);
    if (role === null) {
      const channel = this.#config().channel.login || "this channel";
      return fail(403, "Not a moderator of this channel", `${identity.login} is not a moderator of ${channel}, so there is nothing to show.`, `not a moderator: ${identity.login}`);
    }
    const session = signSession(this.#secret(), { uid: identity.user_id, login: identity.login, role, exp: this.#now().getTime() + SESSION_TTL_MS });
    this.#log(`login ok: ${twitchActor(identity.login)} as ${role} on ${listener} from ${clientIp(req)}`);
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", sessionCookie(session));
    headers.append("set-cookie", clearTicket);
    return new Response(null, { status: 302, headers });
  }

  /** Fetch the full moderator list and write it to `<dataDir>/mods.json` (atomic replace). Throws when Helix fails. */
  async refreshMods(): Promise<void> {
    const broadcasterId = this.#config().channel.broadcasterId;
    if (broadcasterId === "") return;
    const mods = await this.#helix.listModerators(broadcasterId);
    fs.mkdirSync(path.dirname(this.#modsPath), { recursive: true });
    const tmp = `${this.#modsPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(mods, null, 2)}\n`);
    fs.renameSync(tmp, this.#modsPath);
  }

  #secret(): string {
    return sessionSecret(this.#secrets);
  }

  /** `tpo_oauth` is `Secure` on the funnel (HTTPS); the streamer listener is plain http://localhost, where Safari would drop it. */
  #oauthCookie(value: string, listener: AppListener, maxAge: number): string {
    return serializeCookie(OAUTH_COOKIE, value, { maxAge, path: "/", httpOnly: true, secure: listener === "funnel", sameSite: "Lax" });
  }

  /** Only a token of kind "oauth" is a ticket — a `tpo_session` value pasted here verifies but is the wrong kind. */
  #readTicket(raw: string): Ticket | null {
    const payload = verify(this.#secret(), "oauth", raw, this.#now().getTime());
    if (payload === null) return null;
    const { state, mode, redirectUri, exp } = payload;
    if (typeof state !== "string" || (mode !== "login" && mode !== "broadcaster") || typeof redirectUri !== "string" || typeof exp !== "number") return null;
    return { state, mode, redirectUri, exp };
  }

  /** Form POST to `<idUrl>/token` with the same redirect_uri the flow started with. */
  async #exchange(code: string, redirectUri: string): Promise<Tokens> {
    const res = await this.#fetch(`${this.#idUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.#clientId(),
        client_secret: this.#clientSecret(),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!res.ok) throw new Error(`Twitch token endpoint → ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") throw new Error("Twitch token endpoint: malformed response");
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      expiresIn: typeof body.expires_in === "number" ? body.expires_in : DEFAULT_EXPIRES_IN_S,
    };
  }

  /** Streamer by broadcaster id; Mod by a live Helix check, or by the last-known-good list when Helix fails; else null. */
  async #roleFor(userId: string): Promise<Role | null> {
    const broadcasterId = this.#config().channel.broadcasterId;
    if (broadcasterId === "") return null; // no channel linked yet: nobody is its moderator
    if (userId === broadcasterId) return "streamer";
    let isMod: boolean;
    try {
      isMod = await this.#helix.isModerator(broadcasterId, userId);
    } catch {
      isMod = this.#lastKnownMods().some((m) => m.user_id === userId);
    }
    return isMod ? "mod" : null;
  }

  #lastKnownMods(): Moderator[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.#modsPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((m): m is Moderator => typeof m === "object" && m !== null && typeof (m as Moderator).user_id === "string");
    } catch {
      return [];
    }
  }
}
