/**
 * Avatar Pictures: a contributor's Twitch profile picture, resolved on the server from the Twitch user id (or a
 * login hint) through Helix Get Users and remembered in memory — id → URL, 24 h TTL, 2,000 entries, least recently
 * used dropped. The URL leaves here as the 150x150 CDN variant; it is never written to the Ledger (a viewer may change
 * their picture; the id is what persists).
 *
 * The one timing rule: the first sight of a contributor waits at most `FIRST_SIGHT_WAIT_MS` for the lookup and then
 * goes out without a picture (the lookup keeps running and fills the cache for next time); cached contributors are
 * instant. Helix down or the token revoked is silent to the streamer — null everywhere (the overlay shows Avatar
 * Glyphs), one warning log line per minute at most, never a Health banner.
 */
import type { HelixUser } from "../ingest/twitch/helix.ts";

export const AVATAR_TTL_MS = 24 * 3_600_000;
export const AVATAR_MAX = 2_000;
export const FIRST_SIGHT_WAIT_MS = 500;
export const AVATAR_SIZE = "150x150";
export const AVATAR_WARN_EVERY_MS = 60_000;

/** What a Contribution knows about the contributor's Twitch identity: an id when the source had one, else maybe a login hint. */
export interface AvatarRef {
  twitchUserId?: string | null;
  loginHint?: string | null;
}

/** The two Helix calls the cache needs — `Helix` satisfies it, and so does a test double. */
export interface AvatarLookup {
  usersByIds(ids: readonly string[]): Promise<HelixUser[]>;
  usersByLogins(logins: readonly string[]): Promise<HelixUser[]>;
}

/** What the OverlayHub asks of the cache (the motes use `peek`). */
export interface AvatarSource {
  urlFor(ref: AvatarRef | null | undefined): Promise<string | null>;
  cached(ref: AvatarRef | null | undefined): string | null | undefined;
  peek(ref: AvatarRef | null | undefined): string | null;
}

export interface AvatarCacheOptions {
  /** Epoch ms (TTL and the warning throttle). Default: Date.now. */
  now?: () => number;
  /** Where the throttled Helix failure line goes. Default: console.warn. */
  warn?: (line: string) => void;
  /** The first-sight timer. Default: a real setTimeout (unref'd, so it never keeps the process alive). */
  wait?: (ms: number) => Promise<void>;
  /** Entry cap. Default AVATAR_MAX; tests shrink it. */
  max?: number;
}

/** Twitch hands out the 300x300 variant; the CDN serves 28, 50, 70, 150, 300 and 600 under the same name. */
export function toSized(url: string, size: string = AVATAR_SIZE): string {
  return url.replace(/-300x300(\.[a-z0-9]+)$/i, `-${size}$1`);
}

interface Entry {
  url: string | null; // null = looked up, no such user (remembered so a typo'd Manual Credit name costs one call, not one per credit)
  at: number;
}

export const defaultWait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    (t as { unref?: () => void }).unref?.();
  });

export class AvatarCache implements AvatarSource {
  readonly max: number;
  readonly #helix: AvatarLookup;
  readonly #now: () => number;
  readonly #warn: (line: string) => void;
  readonly #wait: (ms: number) => Promise<void>;
  /** Insertion order is recency: a read re-inserts, eviction takes the first key. */
  readonly #entries = new Map<string, Entry>();
  readonly #inFlight = new Map<string, Promise<string | null>>();
  #lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(helix: AvatarLookup, opts: AvatarCacheOptions = {}) {
    this.#helix = helix;
    this.#now = opts.now ?? Date.now;
    this.#warn = opts.warn ?? ((line) => console.warn(line));
    this.#wait = opts.wait ?? defaultWait;
    this.max = opts.max ?? AVATAR_MAX;
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Cached → the URL (or null for a known no-picture) at once; else a lookup raced against `FIRST_SIGHT_WAIT_MS` → the
   * URL or null. The lookup keeps running past the wait and fills the cache. Helix failures → null, warned at most
   * once a minute; nothing is cached for them, so the next sighting tries again.
   */
  async urlFor(ref: AvatarRef | null | undefined): Promise<string | null> {
    const key = keyOf(ref);
    if (key === null) return null;
    const hit = this.#read(key);
    if (hit !== undefined) return hit;
    return Promise.race([this.#lookup(key), this.#wait(FIRST_SIGHT_WAIT_MS).then(() => null)]);
  }

  /** Synchronous: the URL, null for a known no-picture, undefined when the contributor has never been looked up (or the entry expired). */
  cached(ref: AvatarRef | null | undefined): string | null | undefined {
    const key = keyOf(ref);
    return key === null ? null : this.#read(key);
  }

  /** Synchronous cache read for the motes: the URL or null; never triggers a lookup. */
  peek(ref: AvatarRef | null | undefined): string | null {
    return this.cached(ref) ?? null;
  }

  /**
   * The batch path (Chatter Dancers): every id's picture at once — cached ids from memory, the rest in ONE
   * `usersByIds` call (Helix chunks past 100), written under id and login exactly like a single lookup; an id Twitch
   * does not know is remembered as null. Helix failing → null for the uncached, nothing cached, the throttled warning.
   */
  async urlsFor(ids: readonly string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    const missing: string[] = [];
    for (const id of new Set(ids)) {
      if (id === "") continue;
      const hit = this.#read(`id:${id}`);
      if (hit !== undefined) out.set(id, hit);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    let users: HelixUser[];
    try {
      users = await this.#helix.usersByIds(missing);
    } catch (e) {
      this.#warnThrottled(e);
      for (const id of missing) out.set(id, null);
      return out;
    }
    const at = this.#now();
    for (const u of users) {
      const url = toSized(u.profileImageUrl);
      this.#write(`id:${u.id}`, url, at);
      this.#write(`login:${u.login.toLowerCase()}`, url, at);
    }
    for (const id of missing) {
      const found = this.#read(`id:${id}`);
      if (found === undefined) this.#write(`id:${id}`, null, at); // Twitch knows no such user: remember that too
      out.set(id, found ?? null);
    }
    return out;
  }

  #lookup(key: string): Promise<string | null> {
    let p = this.#inFlight.get(key);
    if (p === undefined) {
      p = this.#fetch(key).finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, p);
    }
    return p;
  }

  async #fetch(key: string): Promise<string | null> {
    const colon = key.indexOf(":");
    const kind = key.slice(0, colon) as "id" | "login";
    const value = key.slice(colon + 1); // a value may itself carry a colon; Helix gets it whole
    let users: HelixUser[];
    try {
      users = kind === "id" ? await this.#helix.usersByIds([value]) : await this.#helix.usersByLogins([value]);
    } catch (e) {
      this.#warnThrottled(e);
      return null;
    }
    const at = this.#now();
    for (const u of users) {
      const url = toSized(u.profileImageUrl);
      this.#write(`id:${u.id}`, url, at);
      this.#write(`login:${u.login.toLowerCase()}`, url, at);
    }
    const found = this.#read(key);
    if (found !== undefined) return found;
    this.#write(key, null, at); // Twitch knows no such user: remember that too
    return null;
  }

  #read(key: string): string | null | undefined {
    const e = this.#entries.get(key);
    if (e === undefined) return undefined;
    if (this.#now() - e.at >= AVATAR_TTL_MS) {
      this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key); // re-insert: most recently used
    this.#entries.set(key, e);
    return e.url;
  }

  #write(key: string, url: string | null, at: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { url, at });
    while (this.#entries.size > this.max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  #warnThrottled(e: unknown): void {
    const now = this.#now();
    if (now - this.#lastWarnAt < AVATAR_WARN_EVERY_MS) return;
    this.#lastWarnAt = now;
    this.#warn(`avatars: Twitch user lookup failed (${e instanceof Error ? e.message : String(e)}) — Avatar Glyphs until it recovers`);
  }
}

/** `id:<id>` when the ref has an id, else `login:<login>` (lower-case), else null — nothing to look up. */
function keyOf(ref: AvatarRef | null | undefined): string | null {
  if (ref === null || ref === undefined) return null;
  const { twitchUserId, loginHint } = ref;
  if (typeof twitchUserId === "string" && twitchUserId !== "") return `id:${twitchUserId}`;
  if (typeof loginHint === "string" && loginHint !== "") return `login:${loginHint.toLowerCase()}`;
  return null;
}
