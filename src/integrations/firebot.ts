/**
 * Firebot giveaway raffle client.
 *
 * Drives the `!giveaway` custom command the streamer imported from CaveMobster's giveaway.firebotsetup over Firebot's
 * local HTTP API. What each subcommand does (read from the setup file, not guessed): `start` empties the entrant role
 * and opens ("The giveaway has been opened, type !giveaway enter to join!"); `close` stops entries ("The giveaway is
 * now closed."); `open` reopens without emptying ("The giveaway has been reopened."); `draw` picks one entrant,
 * congratulates them and drops them from the role (so a second draw picks someone else); `clear` empties the role
 * ("The giveaway list has been cleared."). Firebot posts every one of those lines itself, so this client adds only
 * what Firebot cannot know: the prize (after `start`) and the auto-close countdown (a minute, 15, 10, 5 seconds).
 *
 * A raffle Fire only `queue`s the giveaway (nothing reaches chat — the streamer may not be ready); Start on the
 * Giveaways page calls `open`, which discovers the command id, runs `start`, names the prize; entries stay open until someone acts on the
 * Giveaways page — `close` / `closeAndDraw` / `draw` / `reopen` / `clear` — unless `config.firebot.autoCloseSeconds`
 * is set, in which case the client closes and draws on its own after that long. `clear` is the end of a giveaway.
 * Nothing here throws — every failure is a result or a warning.
 */
import type { Config } from "../config/schema.ts";

/** The callable part of `fetch` — `globalThis.fetch` satisfies it; tests inject a recorder. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FirebotOptions {
  config: () => Config;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Called with the Health banner text when the deferred auto-close fails (the open already resolved ok). */
  onWarn?: (text: string) => void;
}

export type RaffleResult = { ok: true } | { ok: false; error: string };

/** A raffle Outcome that came up and is waiting for someone to press Start — nothing has reached chat yet. In memory: a restart forgets it (the Fire is still in the Ledger). */
export interface PendingGiveaway {
  prize: string;
  fireSeq: number;
}

/** The giveaway whose entries are open now — what the Giveaways page shows above Close & draw. */
export interface OpenGiveaway {
  prize: string;
  fireSeq: number;
  openedAt: string; // ISO
  /** `open`: viewers can enter. `closed`: entries stopped (a winner may have been drawn); Draw again / Reopen / Done still apply. */
  phase: "open" | "closed";
  /** How many times `draw` ran for this giveaway — 0 until the first winner. */
  draws: number;
  /** When the client will close and draw on its own; absent = by hand. */
  autoCloseAt?: string;
  /** A Debug-page dry run: nothing reaches Firebot or chat — every line and command lands in `transcript` instead. `fireSeq` is 0. */
  dry?: true;
  transcript?: string[];
}

type FirebotConfig = Config["firebot"];

const TIMEOUT_MS = 5000;

/** Where the auto-close countdown speaks, in seconds left — a minute out, then 15, 10, 5; nothing between (chat is not a stopwatch). */
export const COUNTDOWN_MARKS = [60, 15, 10, 5] as const;

/** "1 minute" / "15 seconds" for a countdown mark. */
export const countdownText = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What each subcommand makes Firebot say in chat (the imported setup's own Chat effects) — the dry-run transcript and the Dashboard quote these. */
export const FIREBOT_SAYS = {
  start: 'empties the entrant list and says "The giveaway has been opened, type \"!giveaway enter\" to join!"',
  close: 'says "The giveaway is now closed." Entries stop and the list is kept',
  open: 'says "The giveaway has been reopened." Entries start again and the list is kept',
  draw: 'picks one entrant, says "Congratulations @name! You win the giveaway!" and drops them from the list',
  clear: 'empties the entrant list and says "The giveaway list has been cleared."',
} as const;

export class Firebot {
  readonly #config: () => Config;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #onWarn: (text: string) => void;
  readonly #now: () => Date;
  #commandId: string | null = null; // step 1's discovery, cached; dropped when a run 404s
  #open: OpenGiveaway | null = null;
  #pending: PendingGiveaway[] = []; // Fires of raffle Outcomes nobody has started yet, oldest first
  #transcript: string[] = []; // a dry run's would-have-been chat lines and commands

  constructor(opts: FirebotOptions) {
    this.#config = opts.config;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.#onWarn = opts.onWarn ?? (() => {});
    this.#now = opts.now ?? (() => new Date());
  }

  /** A raffle Fire arrives here, not in chat: the streamer may not be ready. Start (the Giveaways page) opens it when they are. */
  queue(prize: string, fireSeq: number): void {
    if (!this.#pending.some((p) => p.fireSeq === fireSeq)) this.#pending.push({ prize, fireSeq });
  }

  /** What is waiting to start, oldest first. */
  pending(): PendingGiveaway[] {
    return this.#pending.map((p) => ({ ...p }));
  }

  /** The giveaway open right now, or null. In memory only: a restart forgets it (Close & draw still works — Firebot is the one holding the entries). */
  current(): OpenGiveaway | null {
    return this.#open === null ? null : { ...this.#open, ...(this.#open.dry === true ? { transcript: [...this.#transcript] } : {}) };
  }

  /**
   * Open a giveaway that never leaves this computer (the Debug page): the same flow — start, the prize line, the auto-close
   * countdown if configured, every button on the Giveaways page — with every chat line and Firebot
   * command written to the transcript instead of sent. Firebot need not be on or even installed.
   */
  async openDry(prize: string): Promise<RaffleResult> {
    const { firebot, channel } = this.#config();
    const openedAt = this.#now();
    const auto = firebot.autoCloseSeconds > 0;
    this.#transcript = [];
    this.#open = { prize, fireSeq: 0, openedAt: openedAt.toISOString(), phase: "open", draws: 0, dry: true, ...(auto ? { autoCloseAt: new Date(openedAt.getTime() + firebot.autoCloseSeconds * 1000).toISOString() } : {}) };
    await this.#run(firebot, channel.login, "start");
    await this.#announce(firebot, channel.login, prize);
    if (auto) void this.#autoClose(firebot, channel.login, prize, 0);
    return { ok: true };
  }

  /** What the latest dry run put in its transcript, in order — kept after it closes until the next giveaway (real or dry) opens. */
  transcript(): string[] {
    return [...this.#transcript];
  }

  #dry(): boolean {
    return this.#open?.dry === true;
  }

  /**
   * Open a chat raffle for `prize` (the Fire `fireSeq`). Resolves `{ ok: true }` once `start` ran. Entries stay open
   * until `close()`; with `autoCloseSeconds` > 0 the client closes and draws on its own after that long.
   */
  async open(prize: string, fireSeq: number): Promise<RaffleResult> {
    const { firebot, channel } = this.#config();
    if (!firebot.enabled) return { ok: false, error: "disabled" };
    try {
      await this.#commandIdFor(firebot); // step 1
      await this.#run(firebot, channel.login, "start"); // step 2: Firebot empties the list, opens, and says how to enter
      await this.#announce(firebot, channel.login, prize); // step 3: the prize (and the window, if any)
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
    const openedAt = this.#now();
    const auto = firebot.autoCloseSeconds > 0;
    this.#transcript = []; // a real giveaway: the last dry run's transcript has had its day
    this.#pending = this.#pending.filter((p) => p.fireSeq !== fireSeq); // started: no longer waiting
    this.#open = { prize, fireSeq, openedAt: openedAt.toISOString(), phase: "open", draws: 0, ...(auto ? { autoCloseAt: new Date(openedAt.getTime() + firebot.autoCloseSeconds * 1000).toISOString() } : {}) };
    if (auto) void this.#autoClose(firebot, channel.login, prize, fireSeq); // step 4, deferred — only when asked for
    return { ok: true };
  }

  /** `close`: entries stop; Firebot says "The giveaway is now closed." Nothing is drawn yet. */
  close(): Promise<RaffleResult> {
    return this.#act(["close"], (g) => (g.phase = "closed"));
  }

  /** `close` then `draw`: entries stop and Firebot names the winner in chat. The one-button night. */
  closeAndDraw(): Promise<RaffleResult> {
    return this.#act(["close", "draw"], (g) => {
      g.phase = "closed";
      g.draws += 1;
    });
  }

  /** `draw`: Firebot picks one entrant, congratulates them and drops them from the list — so a second draw is someone else. */
  draw(): Promise<RaffleResult> {
    return this.#act(["draw"], (g) => (g.draws += 1));
  }

  /** `open`: entries start again WITHOUT emptying the list ("The giveaway has been reopened."). For a close that came too soon. */
  reopen(): Promise<RaffleResult> {
    return this.#act(["open"], (g) => (g.phase = "open"));
  }

  /** `clear`: the list is emptied ("The giveaway list has been cleared.") and the giveaway is over — nothing tracked after this. */
  clear(): Promise<RaffleResult> {
    return this.#act(["clear"], () => {}, true);
  }

  /**
   * Run Firebot subcommands in order, then apply `after` to what is tracked (if anything — Firebot holds the truth, so
   * every act works with nothing tracked too, after a restart say). `ends` forgets the giveaway once the acts succeed.
   */
  async #act(args: Array<"close" | "draw" | "open" | "clear">, after: (g: OpenGiveaway) => void, ends = false): Promise<RaffleResult> {
    const { firebot, channel } = this.#config();
    if (!firebot.enabled && !this.#dry()) return { ok: false, error: "disabled" };
    try {
      for (const a of args) await this.#run(firebot, channel.login, a);
    } catch (e) {
      return { ok: false, error: errorText(e) };
    }
    if (this.#open !== null) after(this.#open);
    if (ends) this.#open = null;
    return { ok: true };
  }

  /** Step 1: the id of the custom command whose trigger is `config.firebot.commandTrigger` (cached). */
  async #commandIdFor(fb: FirebotConfig, refresh = false): Promise<string> {
    if (this.#commandId !== null && !refresh) return this.#commandId;
    const res = await this.#request(fb, "GET", "/api/v1/commands/custom");
    const commands = (await res.json()) as unknown;
    const found = Array.isArray(commands)
      ? (commands as Array<{ id?: unknown; trigger?: unknown }>).find((c) => c.trigger === fb.commandTrigger)
      : undefined;
    if (found === undefined || typeof found.id !== "string") {
      throw new Error(`Firebot has no custom command with trigger ${fb.commandTrigger} — import giveaway.firebotsetup`);
    }
    this.#commandId = found.id;
    return found.id;
  }

  /** The prize line, right after Firebot's own "opened, type !giveaway enter" — with the window only when the client will enforce one. */
  async #announce(fb: FirebotConfig, login: string, prize: string): Promise<void> {
    const minutes = Math.round(fb.autoCloseSeconds / 60);
    const when = fb.autoCloseSeconds > 0 ? `entries close in ${Math.max(1, minutes)} min!` : "entries stay open until we draw!";
    await this.#say(fb, login, `🎁 Tonight's prize: ${prize} — ${when}`);
  }

  /** One chat line via a one-off `firebot:chat` effect, as the configured chatter. */
  async #say(fb: FirebotConfig, login: string, message: string): Promise<void> {
    if (this.#dry()) {
      this.#transcript.push(`chat (${fb.chatter}): ${message}`);
      return;
    }
    await this.#request(fb, "POST", "/api/v1/effects", {
      effects: { id: "tpo-raffle-announce", list: [{ id: "tpo-raffle-announce-msg", type: "firebot:chat", chatter: fb.chatter, message }] },
      triggerData: { username: login },
    });
  }

  /** Step 3: run a sub-command. A 404 means the cached id is stale → re-discover once and retry. */
  async #run(fb: FirebotConfig, login: string, args: "start" | "close" | "draw" | "open" | "clear"): Promise<void> {
    if (this.#dry()) {
      this.#transcript.push(`firebot: ${fb.commandTrigger} ${args} → ${FIREBOT_SAYS[args]}`);
      return;
    }
    const body = { args, username: login };
    const id = await this.#commandIdFor(fb);
    const res = await this.#request(fb, "POST", `/api/v1/commands/custom/${id}/run`, body, { allow404: true });
    if (res.status !== 404) return;
    const fresh = await this.#commandIdFor(fb, true);
    await this.#request(fb, "POST", `/api/v1/commands/custom/${fresh}/run`, body);
  }

  /**
   * Step 4 (opt-in): count `autoCloseSeconds` down in chat, then close and draw — unless someone already did by hand
   * (each step checks). Sparse on purpose: one line at a minute out (only when the window is longer than that), then
   * 15, 10 and 5 seconds; Firebot's own "closed" and "Congratulations" lines follow. The giveaway stays tracked as
   * closed until someone presses Done (clear). A failure becomes a Health warning.
   */
  async #autoClose(fb: FirebotConfig, login: string, prize: string, fireSeq: number): Promise<void> {
    const tracked = () => this.#open !== null && this.#open.fireSeq === fireSeq;
    const stillOpen = () => tracked() && this.#open!.phase === "open";
    try {
      let left = fb.autoCloseSeconds;
      for (const mark of COUNTDOWN_MARKS.filter((m) => m < fb.autoCloseSeconds)) {
        await this.#sleep((left - mark) * 1000);
        left = mark;
        if (!stillOpen()) return; // closed by hand, or a later giveaway took over
        await this.#say(fb, login, `⏳ ${countdownText(mark)} left to type ${fb.commandTrigger} enter for ${prize}!`);
      }
      await this.#sleep(left * 1000);
      if (!stillOpen()) return; // closed by hand meanwhile
      await this.#run(fb, login, "close"); // Firebot says closed
      await this.#run(fb, login, "draw"); // Firebot names the winner
      if (tracked()) {
        this.#open!.phase = "closed";
        this.#open!.draws += 1;
      }
    } catch {
      try {
        this.#onWarn(`Firebot didn't respond for ${prize} — type !raffle 1 120 in chat`);
      } catch {
        // a throwing warn sink must not turn this fire-and-forget promise into an unhandled rejection
      }
    }
  }

  /** One Firebot API call with the 5 s timeout; throws on non-2xx (except an allowed 404). */
  async #request(fb: FirebotConfig, method: "GET" | "POST", path: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<Response> {
    const init: RequestInit = { method, signal: AbortSignal.timeout(TIMEOUT_MS) };
    if (body !== undefined) {
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.#fetch(`${fb.baseUrl.replace(/\/+$/, "")}${path}`, init);
    if (!res.ok && !(opts.allow404 === true && res.status === 404)) throw new Error(`${method} ${path} → ${res.status}`);
    return res;
  }
}
