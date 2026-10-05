/**
 * The Active Chatter roster (Chatter Dancers): everyone who has chatted within the Chat Window, in memory only
 * (rebuilt after a restart), keyed by Twitch user id. Presence, never Progress: nothing here reads or writes the Ledger,
 * and the message text never arrives — the EventSub adapter hands over the chatter's identity and nothing else.
 *
 * Rules: the broadcaster's own id and any login on `config.chatters.bots` (case-insensitive, read live on
 * every message, so a Config edit applies to the next one) never get a dancer; mods and shared-chat guests count. A first
 * sight waits `FIRST_SIGHT_BATCH_MS` for others arriving in the same burst, then ONE `usersByIds` call fetches every new
 * picture through the server AvatarCache; the batch goes out (`onChange`) when the pictures land, or after
 * `FIRST_SIGHT_WAIT_MS` with `avatarUrl` null for the slow ones (a later `onChange` fills them in). Every message from
 * someone present refreshes `lastSeen`, hops them (`onHop`) and re-sorts (`onChange`: one broadcast per message is the
 * simplest honest rule). `sweep()` drops anyone whose last message is the window or older; boot calls it every 5 s.
 */
import type { Config } from "../config/schema.ts";
import { defaultWait, FIRST_SIGHT_WAIT_MS, type AvatarCache } from "./avatars.ts";
import { chatterKey, type Chatter, type ChatterSource } from "./overlay.ts";

/** Ids first seen within this many ms of each other share one Helix call. */
export const FIRST_SIGHT_BATCH_MS = 500;
/** Twitch's stock default picture (one of several; every account has one), the 150x150 variant — what a Debug fake wears. */
export const FAKE_PICTURE_URL = "https://static-cdn.jtvnw.net/user-default-pictures-uv/ce57700a-def9-11e9-842d-784f43822e80-profile_image-150x150.png";
export const FAKE_NAMES: readonly string[] = ["Pixel_Pat", "DiscoDory", "LaserLou", "BassBridget", "GlowstickGus", "NeonNadia", "SubwooferSam", "StrobeSteph", "VinylVic", "MirrorballMo"];

/** The identity fields of a `channel.chat.message` event (EventSub reference); `source_*` is set when the message came from a partner channel in shared chat. */
export interface ChatMessageEvent {
  chatter_user_id: string;
  chatter_user_login: string;
  chatter_user_name: string;
  broadcaster_user_id: string;
  source_broadcaster_user_id?: string | null;
}

/** What the roster asks of the server AvatarCache: the synchronous read and the batch lookup. */
export type ChatterPictures = Pick<AvatarCache, "cached" | "urlsFor">;

export interface ChatterRosterOptions {
  config: () => Config;
  avatars: ChatterPictures;
  /** Epoch ms. */
  now: () => number;
  /** The roster changed (arrival, hop, lapse): the hub broadcasts the list. */
  onChange: () => void;
  /** A message from someone on the floor: the hub broadcasts the hop. */
  onHop: (key: string) => void;
  log?: (line: string) => void;
  /** The batch timer. Default: a real, unref'd setTimeout. */
  wait?: (ms: number) => Promise<void>;
  /** `hopRandom`'s dice. Default Math.random. */
  rng?: () => number;
}

interface Entry {
  id: string;
  key: string;
  name: string;
  avatarUrl: string | null;
  firstSeenMs: number;
  lastSeenMs: number;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ChatterRoster implements ChatterSource {
  readonly #config: () => Config;
  readonly #avatars: ChatterPictures;
  readonly #now: () => number;
  readonly #onChange: () => void;
  readonly #onHop: (key: string) => void;
  readonly #log: (line: string) => void;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #rng: () => number;
  readonly #entries = new Map<string, Entry>(); // insertion order = arrival order; list() sorts by lastSeen
  #pending: string[] = []; // first sights waiting for the batch
  #batching = false;
  #fakeSeq = 0;

  constructor(opts: ChatterRosterOptions) {
    this.#config = opts.config;
    this.#avatars = opts.avatars;
    this.#now = opts.now;
    this.#onChange = opts.onChange;
    this.#onHop = opts.onHop;
    this.#log = opts.log ?? (() => {});
    this.#wait = opts.wait ?? defaultWait;
    this.#rng = opts.rng ?? Math.random;
  }

  /** One chat message: a first sight joins the picture batch; someone present is refreshed, hopped and re-sorted. */
  message(event: ChatMessageEvent): void {
    const id = event.chatter_user_id;
    const config = this.#config();
    if (id === "" || id === event.broadcaster_user_id || id === config.channel.broadcasterId) return;
    const login = event.chatter_user_login.toLowerCase();
    if (config.chatters.bots.some((b) => b.toLowerCase() === login)) return;
    const now = this.#now();
    const present = this.#entries.get(id);
    if (present !== undefined) {
      present.lastSeenMs = now;
      present.name = event.chatter_user_name;
      this.#hopped(present.key);
      this.#changed();
      return;
    }
    const entry: Entry = { id, key: chatterKey(id), name: event.chatter_user_name, avatarUrl: null, firstSeenMs: now, lastSeenMs: now };
    this.#entries.set(id, entry);
    const cached = this.#avatars.cached({ twitchUserId: id });
    if (cached !== undefined) {
      entry.avatarUrl = cached;
      this.#changed();
      return;
    }
    this.#pending.push(id);
    if (!this.#batching) {
      this.#batching = true;
      void this.#collect();
    }
  }

  /** Drop everyone whose last message is the Chat Window or older; one onChange when anyone went. */
  sweep(): void {
    const windowMs = this.#config().chatters.windowMinutes * 60_000;
    const now = this.#now();
    let dropped = 0;
    for (const [id, e] of this.#entries) {
      if (now - e.lastSeenMs < windowMs) continue;
      this.#entries.delete(id);
      dropped++;
    }
    if (dropped > 0) this.#changed();
  }

  /** Most recent message first; the same ms → the later arrival first (a stable sort over reversed insertion order). */
  list(): Chatter[] {
    return [...this.#entries.values()]
      .reverse()
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
      .map(chatterOf);
  }

  count(): number {
    return this.#entries.size;
  }

  fake(): Chatter {
    const n = ++this.#fakeSeq;
    const base = FAKE_NAMES[(n - 1) % FAKE_NAMES.length]!;
    const id = `fake:${n}`; // a real Twitch id is digits only: no collision
    const now = this.#now();
    const entry: Entry = { id, key: chatterKey(id), name: n <= FAKE_NAMES.length ? base : `${base}${n}`, avatarUrl: FAKE_PICTURE_URL, firstSeenMs: now, lastSeenMs: now };
    this.#entries.set(id, entry);
    this.#changed();
    return chatterOf(entry);
  }

  hopRandom(): Chatter | null {
    const all = [...this.#entries.values()];
    if (all.length === 0) return null;
    const e = all[Math.min(all.length - 1, Math.max(0, Math.floor(this.#rng() * all.length)))]!;
    e.lastSeenMs = this.#now(); // it is a message from someone here
    this.#hopped(e.key);
    this.#changed();
    return chatterOf(e);
  }

  /** The batch: wait for the burst, one call for every pending id, out with the pictures — or without, after the wait, then again when they land. */
  async #collect(): Promise<void> {
    await this.#wait(FIRST_SIGHT_BATCH_MS);
    this.#batching = false;
    const ids = this.#pending.splice(0);
    if (ids.length === 0) return;
    let landed = false;
    const lookup = this.#avatars
      .urlsFor(ids)
      .then((urls) => {
        let pictured = 0;
        for (const [id, url] of urls) {
          const e = this.#entries.get(id); // may have lapsed meanwhile
          if (e === undefined || url === null) continue;
          e.avatarUrl = url;
          pictured++;
        }
        this.#log(`chatters: ${ids.length} new, ${pictured} with a picture`);
      })
      .catch((e: unknown) => this.#log(`chatters: picture lookup failed: ${errorText(e)}`))
      .finally(() => {
        landed = true;
      });
    await Promise.race([lookup, this.#wait(FIRST_SIGHT_WAIT_MS)]);
    this.#changed();
    if (landed) return;
    await lookup;
    this.#changed();
  }

  #changed(): void {
    try {
      this.#onChange();
    } catch (e) {
      this.#log(`chatters: onChange threw: ${errorText(e)}`);
    }
  }

  #hopped(key: string): void {
    try {
      this.#onHop(key);
    } catch (e) {
      this.#log(`chatters: onHop threw: ${errorText(e)}`);
    }
  }
}

/** The wire shape: no id, no login. */
function chatterOf({ key, name, avatarUrl, firstSeenMs, lastSeenMs }: Entry): Chatter {
  return { key, name, avatarUrl, firstSeenMs, lastSeenMs };
}
