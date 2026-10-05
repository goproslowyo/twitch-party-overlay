/**
 * The Dashboard pages — server-rendered HTML on both app listeners: Live `/`, Ledger `/ledger`, Pool `/pool`,
 * Giveaways `/giveaways`, Config `/config` and Debug `/debug` (both Streamer only), Help `/help`, plus `GET /dashboard/client.js`. Everything is read straight off the
 * Engine, Ledger, Health and ConfigStore the JSON API also serves; nothing here mutates — every button is `client.js`
 * calling an API route. The Live page is a calm pass: one number, two quiet cards, the one FIRE button, what just
 * came up, five plain Latest lines, manual credit behind a `<details>` — plain words on screen (an Outcome "came up",
 * you "put it back"); Fire / re-bank / Ledger stay the code's names. The Pool page is the Outcome editor:
 * here the server renders the table and the `#pool-data` island; `client.js` renders the form and re-renders the table
 * from `/api/state` after every change. Every string that could come from a user goes through `h` (escaped). The
 * Ledger page's row summary and the Live page's Latest lines are `describeEntry` — the console's wording, so the three
 * never drift.
 */
import os from "node:os";
import { CHAT_WINDOW_MAX, CHAT_WINDOW_MIN, DESCRIPTION_MAX, DWELL_SECONDS_MAX, DWELL_SECONDS_MIN, DWELL_SECONDS_STEP, FLOOR_PERCENT_MAX, FLOOR_PERCENT_MIN, LIST_ITEM_MAX, NAME_LENGTH_MAX, NAME_LENGTH_MIN, type Config } from "../../config/schema.ts";

import type { ConfigStore } from "../../config/store.ts";
import type { Engine } from "../../engine/engine.ts";
import { FIREBOT_SAYS, type Firebot, type OpenGiveaway, type PendingGiveaway } from "../../integrations/firebot.ts";
import type { OutcomeState, State } from "../../engine/state.ts";
import type { Ledger } from "../../ledger/ledger.ts";
import { describeEntry, describeEntryFull } from "../../ledger/describe.ts";
import type { Face } from "../../ingest/contribution.ts";
import type { Entry } from "../../ledger/types.ts";
import { money } from "../../overlay/copy.ts";
import type { AppListener, Principal } from "../auth.ts";
import type { Health } from "../health.ts";
import { html } from "../http-util.ts";
import type { ChatterSource, OverlayHub, OverlayReport } from "../overlay.ts";
import clientJs from "./client.js" with { type: "text" };
import { overlayUrls } from "../overlay-urls.ts";
import { helpHtml } from "./help.ts";
import { CLIENT_JS_PATH, h, layout, raw, type NavKey, type Raw } from "./layout.ts";

export { CLIENT_JS_PATH };

export interface DashboardDeps {
  config: ConfigStore;
  ledger: Ledger;
  engine: Engine;
  health: Health;
  /** For the connected overlays' quality reports on the Live page. */
  hub: OverlayHub;
  /** For the Giveaways page: the raffle whose entries are open now. */
  firebot: Firebot;
  /** The Active Chatter roster: "N people chatting" on Live. */
  chatters: ChatterSource;
  /** For the overlay URL list; default `os.networkInterfaces`. */
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** This computer's own LAN address, which a container cannot see for itself. Read from `$HOST_LAN_IP` at the boot seam. */
  hostLanIp?: string;
  /** The clock behind "came up 2 min ago"; default `new Date()`. */
  now?: () => Date;
}

export interface DashboardContext {
  principal: Principal;
  listener: AppListener;
}

/** A page for a GET on one of `PAGE_PATHS`; the caller has already resolved the Principal. */
export type DashboardHandler = (req: Request, ctx: DashboardContext) => Response;

export const PAGE_PATHS: ReadonlySet<string> = new Set(["/", "/ledger", "/pool", "/giveaways", "/config", "/debug", "/help"]);
export const BROADCASTER_LINK_HREF = "/auth/twitch/broadcaster";
export const LEDGER_PAGE = 50;
/** Latest lines on Live: five, plain, no buttons. */
export const LIVE_ENTRIES = 5;
/** The mini-draw lists as the editor names them (`config.lists` keys → labels). */
const LIST_NAMES: Record<NonNullable<OutcomeState["miniDraw"]>, string> = { genreRoulette: "Genre roulette", chatRules: "Chat rules" };
const MINI_DRAW_KEYS = Object.keys(LIST_NAMES) as (keyof typeof LIST_NAMES)[];

/** The editor's tooltip copy. Plain words; an Outcome "comes up" (never "Fire" to a mod). */
export const TIPS = {
  glyph: "The emoji on the pad. One character. It is what the crowd sees first.",
  name: "Shown in CAPS on the pad and in chat. Keep it short, about 20 characters.",
  shape: "Challenge: the streamer does something. Giveaway: a viewer wins something (a chat raffle runs). Moment: something happens on stream. Stunt: a big one-off bit.",
  tier: "When it joins the board. Tier 0 from the start; Tier 1 after 3 unlocks are banked; Tier 2 after 6. Tiers never close.",
  occupancy: "How long it takes the streamer, in your own words: 'instant', '1 transition', '~10 min'. A note only. Nothing is timed.",
  description: "What happens when it comes up, in a line or two. Shows as the ⓘ next to the name on the Pool page, for the ones nobody remembers at 3am.",
  restockable: "Can be topped up after it runs out. Leave off for merch and one-time bits. Those never come back.",
  raffle: "When this comes up, Firebot runs a chat raffle and announces the winner. Giveaways only.",
  miniDraw: "When this comes up, the overlay also picks one item from a list: a genre, or a chat rule. The lists are edited below the table on the Pool page, or on the Config page.",
  used: "How many times it has come up tonight. It comes from the Ledger and cannot be changed here.",
  left: "How many more times it can come up. 0 means it's done until someone restocks it. What already happened is never changed.",
  status: "Live: on the board. Suspended: skipped for now, resume any time. Retired: gone for the night, for good.",
  id: "Internal name in the config and the Ledger. Made from the name when it's added; never changes.",
  delete: "Only while Used is 0. Once it has come up, Retire it instead so the night's history still makes sense.",
  retire: "Takes it off the board for good. Anything it already did stays in the Ledger.",
  suspend: "Skip it for now. Resume any time.",
  resume: "Put it back on the board.",
  restock: "Adds one more go. Only for restockable Outcomes.",
  filter: "Type part of a name, shape, tier, status or What it is line. Esc clears it.",
} as const;
type TipKey = keyof typeof TIPS;

/** The `#pool-data` island `client.js` re-renders the editor from (never `initialLeft` — it is not shown). */
interface PoolData {
  role: Principal["role"];
  gates: readonly number[];
  openTier: number;
  lists: typeof LIST_NAMES;
  /** The What it is line's limit (schema.ts's DESCRIPTION_MAX): the editor's maxlength comes from here, not a literal. */
  descriptionMax: number;
  tips: typeof TIPS;
  queue: { ready: number; banked: number; fired: number; drained: boolean };
  outcomes: Omit<OutcomeState, "initialLeft">[];
}
/** The Quality select: Auto, then the five fixed Levels, richest first. */
const QUALITY_OPTIONS: ReadonlyArray<readonly [string, string]> = [["auto", "Auto"], ["5", "Level 5, richest"], ["4", "Level 4"], ["3", "Level 3"], ["2", "Level 2"], ["1", "Level 1, lightest"]];
const WEBGL_OPTIONS: ReadonlyArray<readonly [string, string]> = [["auto", "Auto (on with a real GPU)"], ["off", "Off"]];
const RENDER_SCALE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ["1x", "Standard, 1080p"],
  ["1.5x", "Sharper, in between"],
  ["2x", "Sharpest, full 4K"],
];
/** Local wall-clock time of an ISO stamp, `HH:MM:SS` — the Dashboard runs on the streamer's computer, in the room. */
const clock = (iso: string): string => new Date(iso).toTimeString().slice(0, 8);
/** "just now" / "2 min ago" / "3 hours ago" — the Just came up line; anything in the future (clock skew) is "just now". */
export function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Ledger index — what the entries say about each other (who is voided, re-banked, who won)
// ---------------------------------------------------------------------------------------------------------------------

interface LedgerIndex {
  voided: Set<number>; // contribution seqs with a `void`
  rebanked: Set<number>; // fire seqs with a `rebank`
  winners: Map<number, string[]>; // fire seq → recorded winners, in order
}

function indexLedger(entries: readonly Entry[]): LedgerIndex {
  const index: LedgerIndex = { voided: new Set(), rebanked: new Set(), winners: new Map() };
  for (const e of entries) {
    if (e.type === "void") index.voided.add((e as Entry<"void">).payload.contributionSeq);
    else if (e.type === "rebank") index.rebanked.add((e as Entry<"rebank">).payload.fireSeq);
    else if (e.type === "note") {
      const { fireSeq, winner } = (e as Entry<"note">).payload;
      if (typeof fireSeq === "number" && typeof winner === "string") index.winners.set(fireSeq, [...(index.winners.get(fireSeq) ?? []), winner]);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------------------------------

export function createDashboard(deps: DashboardDeps): DashboardHandler {
  const { config, ledger, engine, health, hub, firebot, chatters } = deps;
  const networkInterfaces = deps.networkInterfaces ?? (() => os.networkInterfaces());
  const now = deps.now ?? (() => new Date());

  const state = (): State => engine.state;
  const outcome = (id: string): OutcomeState | undefined => state().outcomes.find((o) => o.id === id);

  /** The same rule as `/api/state`'s `overlayUrls`; see `overlay-urls.ts`. */
  const overlayUrlsFor = () => overlayUrls({ overlayPort: config.get().listeners.overlayPort, overlayOnLan: config.get().listeners.overlayOnLan, networkInterfaces, hostLanIp: deps.hostLanIp });

  /** One line per entry — the same wording the console prints (`src/ledger/describe.ts`), with the Outcome names of the live config. */
  const summary = (e: Entry): string => describeEntry(e, { outcome: (id) => outcome(id), entry: (seq) => ledger.get(seq) });

  /** "Show all" under a summary that had to cut something (a long config change, a clipped message): every item, in full. */
  const more = (e: Entry): Raw => {
    const lines = describeEntryFull(e);
    return lines === null ? raw("") : h`<details class="more"><summary>Show all ${lines.length === 1 ? "" : `${lines.length} `}</summary><ul>${lines.map((l) => h`<li>${l}</li>`)}</ul></details>`;
  };

  /** Void / Re-bank / Winner controls for one entry; nothing for entries that have nothing to correct. */
  const actions = (e: Entry, index: LedgerIndex): Raw => {
    if (e.type === "contribution" && !index.voided.has(e.seq)) return h`<button type="button" class="danger" data-action="void" data-seq="${e.seq}">Void</button>`;
    if (e.type === "fire") {
      const rebanked = index.rebanked.has(e.seq);
      const o = outcome((e as Entry<"fire">).payload.outcomeId);
      const winners = index.winners.get(e.seq) ?? [];
      return h`${rebanked ? h`<span class="muted">re-banked</span>` : h`<button type="button" class="danger" data-action="rebank" data-seq="${e.seq}">Re-bank</button>`}${
        winners.length > 0 ? h`<span>Winner: <strong>${winners.join(", ")}</strong></span>` : ""
      }${
        o?.raffle === true && !rebanked
          ? h`<form data-action="winner" data-seq="${e.seq}"><input name="winner" placeholder="Winner" autocomplete="off" required><button type="submit">Save</button></form>`
          : ""
      }`;
    }
    return raw("");
  };

  const ledgerTable = (entries: readonly Entry[], index: LedgerIndex): Raw => {
    if (entries.length === 0) return h`<p class="muted">Nothing in the Ledger yet.</p>`;
    return h`<div class="wrap"><table>
<thead><tr><th>#</th><th>Time</th><th>Type</th><th>Actor</th><th>Summary</th></tr></thead>
<tbody>${entries.map(
      (e) => h`<tr${index.voided.has(e.seq) || index.rebanked.has(e.seq) ? raw(' class="muted"') : ""}><td class="n">#${e.seq}</td><td class="n">${clock(e.ts)}</td><td class="n">${e.type}</td><td class="a">${e.actor}</td><td>${summary(e)}${more(e)}<div class="actions">${actions(e, index)}</div></td></tr>`,
    )}</tbody>
</table></div>`;
  };

  /** One line per connected overlay: the Quality Level it is drawing at, who chose it, its misses, the light layer. */
  const overlayLine = (r: OverlayReport): Raw => h`<p class="overlay-line">Overlay · Level ${r.level} (${r.mode}) · ${Math.round(r.missRatio * 100)} % misses · WebGL ${r.webgl ? "on" : "off"}</p>`;
  const overlayLines = (): Raw => {
    const reports = hub.reports();
    return reports.length === 0 ? h`<p class="muted overlay-line">No overlay connected</p>` : h`${reports.map(overlayLine)}`;
  };

  /** The Active Chatter count: the people on the dance floor right now because they talked. */
  const chattersLine = (): Raw => {
    const n = chatters.count();
    return h`<p class="chatters-line">${n === 0 ? "Nobody chatting yet" : n === 1 ? "1 person chatting" : `${n} people chatting`}</p>`;
  };

  const banners = (): Raw =>
    h`${health.list().map((b) => h`<div class="banner ${b.level}"><span>${b.text}</span><button type="button" data-action="dismiss" data-id="${b.id}">Dismiss</button></div>`)}`;

  const creditForm = (): Raw => h`<form id="credit">
<label class="field"><span>Kind</span><select name="kind">
<option value="tip">Tip (StreamElements / PayPal)</option><option value="kofi">Ko-fi donation</option><option value="bits">Bits</option><option value="sub">Sub</option><option value="gift">Gift subs</option>
</select></label>
<label class="field" id="credit-amount"><span>Dollars</span><input name="amount" inputmode="decimal" placeholder="4.50" autocomplete="off"></label>
<label class="field" id="credit-tier" hidden><span>Tier</span><select name="tier"><option value="1000">Tier 1</option><option value="2000">Tier 2</option><option value="3000">Tier 3</option><option value="prime">Prime</option></select></label>
<label class="field"><span>Name (Twitch login or how they signed)</span><input name="displayName" autocomplete="off"></label>
<label class="row"><input type="checkbox" name="anonymous">Anonymous</label>
<button type="submit">Add it</button>
</form>`;

  /**
   * The Config page's "Overlay URL for OBS" section (moved off Live). OBS on the same computer is the default:
   * the localhost URL first with a Copy button and a 1920 × 1080 source recommended; a checkbox ("OBS runs on
   * another computer") that saves `listeners.overlayOnLan` through the whole-config PUT (client.js) and, once it is on,
   * the network addresses under it. The listener itself rebinds on the next start, and the copy says so.
   */
  const overlayUrlList = (): Raw => {
    const cfg = config.get();
    const [local, ...lan] = overlayUrlsFor() as [string, ...string[]];
    const lanBlock = (): Raw => {
      if (!cfg.listeners.overlayOnLan) return raw("");
      if (lan.length === 0) return h`<p class="muted">No network address found. Is this computer on a network?</p>`;
      // One address is the answer. Several means we had to guess off this machine's own NICs and cannot tell which is the LAN one.
      const note = lan.length === 1
        ? h`<p class="muted">On the other computer, use this address.</p>`
        : h`<p class="muted">On the other computer, use one of these. This computer has more than one address, so try them in order until the overlay shows up in OBS.</p>`;
      return h`<ul>${lan.map((u) => h`<li><a href="${u}">${u}</a></li>`)}</ul>${note}`;
    };
    return h`<section id="overlay-url"><h2>Overlay URL for OBS</h2>
<p class="row"><a href="${local}">${local}</a><button type="button" data-action="copy" data-text="${local}">Copy</button></p>
<p class="muted">Add it in OBS as a Browser source, 1920 wide and 1080 high, 30 fps. A 3840 × 2160 source works too and costs more; Detail under Quick settings decides how much of it is drawn.</p>
<form id="overlay-lan" autocomplete="off">
<label class="row"><input type="checkbox" name="listeners.overlayOnLan"${cfg.listeners.overlayOnLan ? raw(" checked") : ""}>OBS runs on another computer (show this computer's network address and allow it to connect)</label>
<p class="muted small">Takes effect after a restart. When this is on, Windows may ask to allow the overlay through the firewall, and anyone on your network can open the overlay page.</p>
</form>
${lanBlock()}</section>`;
  };

  /** The newest `fire` that has not been put back (re-banked) — the one that "just came up"; undefined when none. */
  const lastFire = (entries: readonly Entry[], index: LedgerIndex): Entry<"fire"> | undefined => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.type === "fire" && !index.rebanked.has(e.seq)) return e as Entry<"fire">;
    }
    return undefined;
  };

  // --- Live = a calm pass. Order: Health banners (the prep-power-ups reminder lives there), the one number with
  // its bar, two quiet cards, the one FIRE button (the page's only magenta), what just came up, five Latest lines, the
  // credit form behind a <details>. Plain words only in this page's own copy.
  const live = (): Raw => {
    const s = state();
    const { gates } = config.get().tiers;
    const nextTier = s.tier + 1;
    const gate = nextTier < gates.length ? `${gates[nextTier]! - s.bankedTotal} to Tier ${nextTier}` : "all tiers open";
    const pct = s.thresholdCents > 0 ? Math.min(100, Math.max(0, Math.floor((s.progressCents / s.thresholdCents) * 100))) : 0;
    const all = ledger.all();
    const index = indexLedger(all);
    const last = lastFire(all, index);
    const lastOutcome = last === undefined ? undefined : outcome(last.payload.outcomeId);
    // The connected-overlay status line: one line under the cards and above FIRE.
    const overlayStatus: Raw = overlayLines();
    return h`${banners()}
<section class="now">
<h2>Next unlock</h2>
<div class="big-number">${money(s.progressCents)}<small> of ${money(s.thresholdCents)}</small></div>
<div class="bar"><i style="width:${pct}%"></i></div>
<div class="cards">
<div class="card"><h2>Ready</h2><div class="n">${s.queue.length}</div>${s.drained ? h`<p class="sub status-retired">pool drained, nothing left to draw</p>` : h`<p class="sub">${s.firedTotal} came up so far</p>`}</div>
<div class="card"><h2>Tier</h2><div class="n">${s.tier}</div><p class="sub">${gate}</p></div>
</div>
${overlayStatus}${chattersLine()}<button type="button" id="fire">FIRE</button>
</section>
${
  last === undefined
    ? ""
    : h`<section class="came-up"><h2>Just came up</h2>
<div class="what">${lastOutcome === undefined ? h`<strong>${last.payload.outcomeId}</strong>` : h`<span class="glyph">${lastOutcome.glyph}</span><strong>${lastOutcome.name}</strong>`}</div>
<p class="muted">came up ${ago(last.ts, now())}${last.payload.miniDraw === undefined ? "" : ` · ${last.payload.miniDraw.title}: ${last.payload.miniDraw.pick}`}</p>
<div class="actions"><button type="button" data-action="rebank" data-seq="${last.seq}">Put it back</button><button type="button" data-action="fire">Draw again</button></div>
</section>`
}
<section><h2>Latest</h2>${latest(shown(ledger.page({ limit: LIVE_ENTRIES })), index)}<p><a href="/ledger">Everything tonight →</a></p></section>
<section><details class="byhand"><summary>Add a tip by hand</summary>${creditForm()}</details></section>`;
  };

  /**
   * The Engine seeds every Outcome's `initialLeft` as a `stock` entry (reason "initial") the first time it sees the id.
   * Those stay in the Ledger — Left is their sum — but on the Dashboard a fresh boot listing 32 "left +1
   * (initial)" rows read as 32 things that had happened, so the pages leave them out. Every other stock entry (a Left
   * edit, a delete, a removed id) still shows: those are someone's act. The same goes for the Threshold line a fresh
   * Ledger opens with (`system:boot`): config's number, nobody's act.
   */
  const isSeed = (e: Entry): boolean => (e.type === "stock" && (e as Entry<"stock">).payload.reason === "initial") || (e.type === "threshold" && e.actor === "system:boot");
  const shown = (entries: readonly Entry[]): Entry[] => entries.filter((e) => !isSeed(e));

  /** Five plain lines — time + `describeEntry`'s sentence, nothing to press; a voided or put-back entry is muted. */
  const latest = (entries: readonly Entry[], index: LedgerIndex): Raw => {
    if (entries.length === 0) return h`<p class="muted">Nothing yet tonight.</p>`;
    return h`<ul class="latest">${entries.map((e) => h`<li class="entry${index.voided.has(e.seq) || index.rebanked.has(e.seq) ? " muted" : ""}"><time>${clock(e.ts)}</time><span>${summary(e)}</span></li>`)}</ul>`;
  };

  const ledgerPage = (url: URL): Raw => {
    const all = ledger.all();
    const index = indexLedger(all);
    const beforeRaw = url.searchParams.get("before");
    const before = beforeRaw !== null && /^\d+$/.test(beforeRaw) && Number.isSafeInteger(Number(beforeRaw)) ? Number(beforeRaw) : undefined;
    // one more than the page: its presence is what says "there is an older page" (never shown itself)
    const fetched = ledger.page(before === undefined ? { limit: LEDGER_PAGE + 1 } : { before, limit: LEDGER_PAGE + 1 });
    const pageEntries = fetched.slice(0, LEDGER_PAGE);
    const oldest = pageEntries[pageEntries.length - 1]; // paging keys on the real page, seeds included, so no entry is ever skipped
    const entries = shown(pageEntries);
    return h`<section><h2>Ledger</h2>
<p class="muted">Newest first. <a href="/giveaways">Giveaway winners</a></p>
${ledgerTable(entries, index)}
${fetched.length > LEDGER_PAGE && oldest !== undefined ? h`<p><a class="btn" href="/ledger?before=${oldest.seq}">Older</a></p>` : ""}
</section>`;
  };

  // --- Pool page = the Outcome editor: one table grouped by Tier, one tab stop per row, the streamer's
  // rows expand into the form (rendered by client.js from the `#pool-data` island); a mod's rows carry the buttons only.
  const tip = (key: TipKey): Raw => h`<i class="tip" data-tip="${key}" aria-hidden="true">?<span class="bubble">${TIPS[key]}</span></i>`;
  /** Key hint: the letter underlined when it is in the word, else a faint suffix; visible only while `body.kbd`. */
  const hint = (label: string, key: string): Raw => {
    const i = label.toLowerCase().indexOf(key);
    return i < 0 ? h`<span>${label}<span class="k">${key}</span></span>` : h`<span>${label.slice(0, i)}<u class="k">${label[i]}</u>${label.slice(i + 1)}</span>`;
  };
  const flags = (o: OutcomeState): string =>
    [o.restockable ? "restockable" : "one-off", o.raffle === true ? "raffle" : "", o.miniDraw !== undefined ? `draws ${LIST_NAMES[o.miniDraw].toLowerCase()}` : ""].filter((f) => f !== "").join(" · ");
  /**
   * Row buttons — never tab stops: the row is the stop and the shortcuts (`s` `r` `x`) or the mouse do the rest. Each
   * carries its TIP as the native title (every action has a tooltip, and these are all a mod ever sees; a `?` would
   * crowd the row) and `data-help` for the help bar. client.js's rowButtons must render these byte-identically.
   */
  const rowButtons = (o: OutcomeState): Raw[] => {
    const b: Raw[] = [];
    const button = (act: "suspend" | "resume" | "restock" | "retire", label: string, key: string, danger = false): Raw =>
      h`<button type="button" class="sm${danger ? " danger" : ""}" data-act="${act}" data-id="${o.id}" tabindex="-1" title="${TIPS[act]}" data-help="${act}">${hint(label, key)}</button>`;
    if (o.status === "live") b.push(button("suspend", "Suspend", "s"));
    if (o.status === "suspended") b.push(button("resume", "Resume", "s"));
    if (o.status !== "retired") {
      if (o.restockable) b.push(button("restock", "Restock +1", "r"));
      b.push(button("retire", "Retire", "x", true));
    }
    return b;
  };
  /** The What it is line: an ⓘ after the name whose bubble is the description — nothing at all when there is nothing to say. The row itself carries no title (the bubble shows on hover and on row focus). */
  const info = (o: OutcomeState): Raw | "" => (o.description === "" ? "" : h`<i class="tip info" data-tip="description" title="" aria-hidden="true">i<span class="bubble">${o.description}</span></i>`);
  const outcomeRow = (o: OutcomeState, streamer: boolean): Raw =>
    h`<tr class="orow${o.status === "retired" ? " retired" : ""}" tabindex="0"${streamer ? raw(' role="button" aria-expanded="false"') : ""} data-act="${streamer ? "edit" : "noop"}" data-id="${o.id}"><td class="glyph">${streamer ? raw('<span class="caret dsk">▸</span>') : ""}${o.glyph}</td><td class="name"><strong>${o.name}</strong>${info(o)}<span class="sub">${o.shape} · ${o.occupancy} · ${flags(o)}</span></td><td class="meta mob">${o.shape} · ${o.occupancy}</td><td class="num used muted">${o.used}</td><td class="num left"><strong>${o.left}</strong><small class="mob">${o.used} used</small></td><td class="status status-${o.status}">${o.status}</td><td class="act"><div class="actions">${rowButtons(o)}</div></td></tr>`;

  const pool = (ctx: DashboardContext): Raw => {
    const s = state();
    const cfg = config.get();
    const { lists } = cfg;
    const gates = cfg.tiers.gates;
    const streamer = ctx.principal.role === "streamer";
    const outcomes = [...s.outcomes].sort((a, b) => a.tier - b.tier); // stable: config order within a Tier
    const list = (items: string[]): Raw => (items.length === 0 ? h`<p class="muted">Empty.</p>` : h`<ul>${items.map((item) => h`<li>${item}</li>`)}</ul>`);
    // The draw lists (T4): a mod reads them; the streamer edits them in place — one input per row (the radio is the
    // selection; client.js wires + / − / Save and re-paints the rows after a save with its listRow, which must render
    // these bytes). The buttons are data-list-act, never data-act: the Outcome editor's document click handler owns
    // that name. Items are stored in CAPS (schema.ts normaliseList; client.js itemsOf) — the input only previews that.
    const listRow = (key: keyof typeof LIST_NAMES, item: string): Raw =>
      h`<li class="lrow"><input type="radio" name="sel-${key}" tabindex="-1" aria-label="Select this row"><input class="item" maxlength="${LIST_ITEM_MAX}" value="${item}" spellcheck="false" autocomplete="off" aria-label="${LIST_NAMES[key]} item" style="text-transform:uppercase"></li>`;
    const listSection = (key: keyof typeof LIST_NAMES): Raw =>
      streamer
        ? h`<section><h2>${LIST_NAMES[key]}</h2><form class="list-editor" data-list="${key}" data-name="${LIST_NAMES[key]}" data-max="${LIST_ITEM_MAX}" autocomplete="off"><ul class="lrows">${lists[key].map((item) => listRow(key, item))}</ul><div class="actions"><button type="button" class="sm" data-list-act="add" title="Add a row" aria-label="Add a row">+</button><button type="button" class="sm danger" data-list-act="remove" title="Remove the selected row" aria-label="Remove the selected row" disabled>−</button><button type="submit" class="sm primary" disabled>Save</button></div><p class="lstatus small" aria-live="polite"></p><p class="muted small">Pick a row and − removes it, after asking. + adds one at the bottom and ⏎ in a row adds one below it. Items show in CAPS whatever case you type. Also on the Config page.</p></form></section>`
        : h`<section><h2>${LIST_NAMES[key]}</h2>${list(lists[key])}</section>`;
    const tierHeader = (tier: number): Raw =>
      h`<tr class="tier"><th colspan="7">Tier ${tier}${tier > s.tier ? " (locked)" : ""}<span>${tier === 0 ? "live from the start" : `opens at ${gates[tier] ?? "?"} banked`}</span></th></tr>`;
    const rows: Raw[] = [];
    let lastTier = -1;
    for (const o of outcomes) {
      if (o.tier !== lastTier) {
        lastTier = o.tier;
        rows.push(tierHeader(o.tier));
      }
      rows.push(outcomeRow(o, streamer));
    }
    const island: PoolData = {
      role: ctx.principal.role,
      gates,
      openTier: s.tier,
      lists: LIST_NAMES,
      descriptionMax: DESCRIPTION_MAX,
      tips: TIPS,
      queue: { ready: s.queue.length, banked: s.bankedTotal, fired: s.firedTotal, drained: s.drained },
      outcomes: s.outcomes.map(({ initialLeft: _never_shown, ...o }) => o),
    };
    return h`<section class="queuebar"><h2>Queue</h2><span class="fader">READY ${s.queue.length}</span><span class="row"><button type="button" data-action="queue" data-delta="-1">−1</button><button type="button" data-action="queue" data-delta="1">+1</button></span><p class="muted" id="queue-meta">Banked ${s.bankedTotal} · fired ${s.firedTotal} · Tier ${s.tier} open${s.drained ? " · POOL DRAINED" : ""}</p></section>
<section id="pool"><h2><span>Outcome pool <span class="count">· ${outcomes.length} Outcomes</span></span><span class="toolbar"><input id="filter" placeholder="Filter…  /" aria-label="Filter Outcomes" data-help="filter" title="${TIPS.filter}" autocomplete="off">${
      streamer ? h`<button type="button" class="primary" data-act="add" data-tier="0"><span>+ Add Outcome<span class="k">n</span></span></button>` : ""
    }</span></h2>
<div class="wrap"><table><thead><tr><th></th><th>Outcome ${tip("name")}</th><th class="num">Used ${tip("used")}</th><th class="num">Left ${tip("left")}</th><th>Status ${tip("status")}</th><th></th></tr></thead>
<tbody>${rows}</tbody></table></div>
<p class="keys dsk">${streamer ? raw("Hover or arrow to a row for its buttons · <kbd>⏎</kbd> edit") : raw("Arrow to a row, then <kbd>s</kbd> suspend / resume · <kbd>r</kbd> restock · <kbd>x</kbd> retire")} · <kbd>?</kbd> keyboard shortcuts</p>
${streamer ? h`<p class="muted small mob">Tap a row to edit it.</p>` : ""}</section>
<div class="two">
${MINI_DRAW_KEYS.map(listSection)}
</div>
<script id="pool-data" type="application/json">${raw(JSON.stringify(island).replace(/</g, "\\u003c"))}</script>`;
  };

  const configPage = (ctx: DashboardContext): Raw => {
    const cfg = config.get();
    const s = state();
    const linked = cfg.channel.broadcasterId !== "";
    return h`<section><h2>Threshold</h2>
<div class="fader">${money(s.thresholdCents)}</div>
<div class="actions">${cfg.threshold.suggestedCents.map((cents) => h`<button type="button"${cents === s.thresholdCents ? raw(' class="primary"') : ""} data-action="threshold" data-cents="${cents}">${money(cents)}</button>`)}</div>
<form id="threshold-form" class="row"><input id="threshold-custom" inputmode="decimal" placeholder="Custom, in dollars"><button type="submit">Set</button></form>
<p class="muted">Partial progress carries across a change; extra crossings bank at once.</p>
</section>
<section><h2>Quick settings</h2>
<form id="quick" autocomplete="off">
<label class="field"><span>Rack side</span><select name="side"><option value="left"${cfg.overlay.side === "left" ? raw(" selected") : ""}>left</option><option value="right"${cfg.overlay.side === "right" ? raw(" selected") : ""}>right</option></select></label>
<label class="field"><span>Dance floor height · <output data-for="overlay.floorPercent">${cfg.overlay.floorPercent}</output>% of the frame, from the bottom</span><input name="overlay.floorPercent" type="range" min="${FLOOR_PERCENT_MIN}" max="${FLOOR_PERCENT_MAX}" step="1" value="${cfg.overlay.floorPercent}"></label>
<label class="field"><span>Dance floor opacity · <output data-for="overlay.floorOpacity">${cfg.overlay.floorOpacity}</output>%</span><input name="overlay.floorOpacity" type="range" min="0" max="100" step="5" value="${cfg.overlay.floorOpacity}"></label>
<p class="muted small">Both save as you let go of the slider and the overlay follows at once. Height: where the Chrome Lounge floor's far edge sits; the towers, lasers, haze and crowd shrink with it. Opacity: fade the room so the cam shows through when the crowd needs to watch you. The pads, the drop, the airship, the rack and every tip, sub and cheer line stay bright, so nothing is missed while the room is down.</p>
<label class="field"><span>Brand line</span><input name="brand" value="${cfg.overlay.brand}" autocomplete="off"></label>
<label class="field"><span>Theme</span><select name="theme">${Object.keys(cfg.themes).map((key) => h`<option value="${key}"${key === cfg.overlay.theme ? raw(" selected") : ""}>${key}: ${cfg.themes[key]!.name}</option>`)}</select></label>
<label class="field"><span>Quality</span><select name="overlay.quality">${QUALITY_OPTIONS.map(([value, label]) => h`<option value="${value}"${value === String(cfg.overlay.quality) ? raw(" selected") : ""}>${label}</option>`)}</select></label>
<label class="field"><span>Detail</span><select name="overlay.renderScale">${RENDER_SCALE_OPTIONS.map(([value, label]) => h`<option value="${value}"${value === cfg.overlay.renderScale ? raw(" selected") : ""}>${label}</option>`)}</select></label>
<p class="muted small">The overlay is laid out the same way at any browser source size, so this changes how sharp it looks and nothing else. Standard draws 1920 × 1080 and lets the browser scale it up to your 3840 × 2160 source, which costs the same as it always did. Sharper draws 2880 × 1620 with the same artwork, so it costs the stream PC more fill and nothing else. Sharpest draws all four times the pixels and switches to sharper artwork, which looks crisper and can be too much for the stream PC, in which case the overlay keeps its frame rate by dropping the lasers, the smoke and some of the confetti. Move up one step at a time and watch the show.</p>
<label class="field"><span>WebGL light layer</span><select name="overlay.webgl">${WEBGL_OPTIONS.map(([value, label]) => h`<option value="${value}"${value === cfg.overlay.webgl ? raw(" selected") : ""}>${label}</option>`)}</select></label>
<button type="submit" class="primary">Save quick settings</button>
</form>
</section>
${chattersSection(cfg.chatters)}
<section><h2>Draw lists</h2>
<form id="lists-form" autocomplete="off" data-lists="${JSON.stringify(LIST_NAMES)}">
${MINI_DRAW_KEYS.map((key) => h`<label class="field"><span>${LIST_NAMES[key]}</span><textarea name="${key}" class="lines" spellcheck="false">${cfg.lists[key].join("\n")}</textarea></label>`)}
<p class="muted small">One per line. The overlay picks one when GENRE ROULETTE or CHAT-RULE DRAW comes up. Items are shown in CAPS whatever case you type, and can also be edited row by row on the Pool page. Up to ${LIST_ITEM_MAX} characters each; a change applies the next time the Outcome comes up.</p>
<button type="submit" class="primary">Save draw lists</button>
<pre id="lists-status"></pre>
</form>
</section>
<section><h2>Broadcaster account</h2>
<p>${linked ? h`Linked: <strong>@${cfg.channel.login}</strong> (id ${cfg.channel.broadcasterId})` : h`<strong>Not linked.</strong> Mods cannot log in until it is.`}</p>
${ctx.listener === "streamer" ? h`<div class="actions"><a class="btn primary" href="${BROADCASTER_LINK_HREF}">Link broadcaster account</a><a class="btn" href="/setup">Setup</a></div><p class="muted small">Setup is the first-run page: your Twitch app, StreamElements, mod access and Ko-fi, Firebot. Come back to it any time.</p>` : h`<p class="muted">Link broadcaster account: link from the computer running the overlay. The button only exists on the local Dashboard (http://localhost:${cfg.listeners.streamerPort}/config).</p>`}
</section>
${overlayUrlList()}
<section><h2>Full config (config.json)</h2>
<form id="config-form" autocomplete="off">
<textarea id="config-json" spellcheck="false">${JSON.stringify(cfg, null, 2)}</textarea>
<div class="actions"><button type="button" data-action="validate">Validate</button><button type="submit" class="primary">Save</button></div>
<pre id="config-status"></pre>
</form>
</section>
${ctx.listener === "streamer" ? shutdownSection(s.queue.length) : h`<section id="shutdown"><h2>Shut down</h2><p class="muted">Shut down from the computer running the overlay. The button only exists on its own Dashboard, never over the public address.</p></section>`}
<script id="config-data" type="application/json">${raw(JSON.stringify(cfg).replace(/</g, "\\u003c"))}</script>`;
  };

  /**
   * The Shut down button (last on Config, the streamer's page): one danger button, then an inline confirm — never
   * `window.confirm` — that names what stops and how to start again, and warns while Unlocks are still READY (the Live
   * page's count). client.js posts the confirm word and replaces the page; the process exits through main.ts's signal path.
   */
  // Chatter Dancers: three sliders that save as they are let go, the Chat Bot list one login per line. Every
  // value rides the skin, so a slider moves the floor live; the bot list is read on every message (hot reload).
  const chattersSection = (c: Config["chatters"]): Raw => {
    const slider = (name: string, value: number, min: number, max: number, step: number, before: string, unit: string): Raw =>
      h`<label class="field"><span>${before} · <output data-for="${name}">${value}</output> ${unit}</span><input name="${name}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
    return h`<section id="chatter-dancers"><h2>Chatter Dancers</h2>
<form id="chatters" autocomplete="off">
${slider("chatters.windowMinutes", c.windowMinutes, CHAT_WINDOW_MIN, CHAT_WINDOW_MAX, 1, "How long someone stays on the floor after their last message", "min")}
${slider("chatters.nameLength", c.nameLength, NAME_LENGTH_MIN, NAME_LENGTH_MAX, 1, "How much of a name fits before it is cut short", "letters")}
${slider("chatters.dwellSeconds", c.dwellSeconds, DWELL_SECONDS_MIN, DWELL_SECONDS_MAX, DWELL_SECONDS_STEP, "When the floor is full, how long each person gets before the next one walks on", "s")}
<label class="field"><span>Chat bots (one name per line). Anything on this list never gets a dancer.</span><textarea name="chatters.bots" class="lines" spellcheck="false">${c.bots.join("\n")}</textarea></label>
<p class="muted small">Anyone who chats stands on the dance floor with their picture and their name, hops each time they say something, and walks off when the window runs out after their last message. Bot names are matched against the Twitch login whatever the case, and a name added here counts from the next message, no restart needed. Sliders save when you let go and the floor follows at once.</p>
<button type="submit" class="primary">Save Chatter Dancers</button>
</form>
</section>`;
  };

  const shutdownSection = (ready: number): Raw => h`<section id="shutdown"><h2>Shut down</h2>
<p class="muted">Stops the overlay server, the same as <code>just down</code>. Start it again on the computer running the overlay (double-click the program, or <code>just show</code> under Docker). The Ledger replays.</p>
<button type="button" class="danger" data-action="shutdown">Shut down the service…</button>
<div id="shutdown-confirm" class="addbox" hidden>
<p>This stops the overlay server: OBS loses the overlay and this Dashboard goes offline. Start it again with <code>just show</code>.</p>
${ready > 0 ? h`<p class="status-suspended"><strong>${ready} ${ready === 1 ? "Unlock is" : "Unlocks are"} still READY.</strong> Fire ${ready === 1 ? "it" : "them"} first?</p>` : ""}
<div class="actions"><button type="button" data-action="shutdown-cancel">Cancel</button><button type="button" class="danger" data-action="shutdown-confirm">Yes, shut down</button></div>
</div>
</section>`;

  /**
   * Every Firebot subcommand a mod can run, always on the page, each with the plain sentence of what Firebot will do
   * and say (from the imported setup, `FIREBOT_SAYS`) — so no mod has to guess — and DISABLED whenever pressing it
   * would be wrong for where the giveaway stands (the streamer's rule): nothing on → Start only (a waiting Fire's
   * prize prefilled, or typed by hand); open → Close & draw / Close only; closed → Draw, Reopen, Done. Done asks
   * first, because after clear the winner cannot be re-drawn. A checkbox lets a mod act on a giveaway Firebot still
   * holds from before a restart (nothing tracked here, but the entries are Firebot's).
   */
  const giveawayControls = (open: OpenGiveaway | null, pending: readonly PendingGiveaway[]): Raw => {
    const phase = open === null ? "none" : open.phase;
    const drawn = open !== null && open.draws > 0;
    const next = pending[0];
    const btn = (action: string, label: string, what: string, enabled: boolean, primary = false, danger = false): Raw =>
      h`<div class="gbtn${enabled ? " now" : ""}"><button type="button"${primary ? raw(' class="primary"') : danger ? raw(' class="danger"') : ""} data-action="${action}"${enabled ? "" : raw(" disabled")}>${label}</button><p class="muted small">${what}</p></div>`;
    const canStart = open === null;
    return h`${
      pending.length === 0
        ? ""
        : h`<p><strong>Waiting to start:</strong> ${pending.map((p, i) => h`${i === 0 ? "" : " · "}${p.prize} <span class="muted">(fire #${p.fireSeq})</span>`)}</p>`
    }<div class="gcontrols">
<div class="gbtn${canStart ? " now" : ""}"><form id="giveaway-start" autocomplete="off" class="row"${next === undefined ? "" : raw(` data-fire-seq="${next.fireSeq}"`)}><input name="prize" placeholder="Prize" value="${next === undefined ? "" : next.prize}" required${canStart ? "" : raw(" disabled")}><button type="submit"${canStart ? raw(' class="primary"') : raw(" disabled")}>Start${next === undefined ? " a giveaway" : ` ${next.prize}`}</button></form><p class="muted small">${next === undefined ? "By hand, no Fire needed. " : `Fire #${next.fireSeq} came up and nothing has reached chat yet. Edit the prize if you like. `}Firebot ${FIREBOT_SAYS.start} Then chat hears the prize.${canStart ? "" : " Not while one is still on. Press Done first."}</p></div>
${btn("giveaway-close-and-draw", "Close & draw", `Entries stop and the winner is named. Firebot ${FIREBOT_SAYS.close}, then ${FIREBOT_SAYS.draw}.`, phase === "open", true)}
${btn("giveaway-close", "Close only", `Entries stop and nobody is drawn yet. Firebot ${FIREBOT_SAYS.close}. Draw when you are ready.`, phase === "open")}
${btn("giveaway-draw", drawn ? "Draw again" : "Draw a winner", `${drawn ? "The winner never answered? " : ""}Firebot ${FIREBOT_SAYS.draw}. A second draw is always someone new. Only once entries are closed.`, phase === "closed", true)}
${btn("giveaway-reopen", "Reopen entries", `Closed too soon? Firebot ${FIREBOT_SAYS.open}. Everyone already in stays in.`, phase === "closed")}
<div class="gbtn${phase === "closed" ? " now" : ""}"><button type="button" class="danger" data-action="giveaway-clear"${phase === "closed" ? "" : raw(" disabled")}>Done, clear the list…</button><p class="muted small">Press once the winner has answered. Firebot ${FIREBOT_SAYS.clear} After this nobody can be re-drawn. The next giveaway starts from an empty list anyway.</p>
<div id="giveaway-clear-confirm" class="addbox" hidden><p>Empty the entrant list${open === null ? "" : ` for <strong>${open.prize}</strong>`}? Only do this once the winner has answered. A Draw again is impossible afterwards.</p><div class="actions"><button type="button" data-action="giveaway-clear-cancel">Keep it</button><button type="button" class="danger" data-action="giveaway-clear-confirm">Yes, clear the list</button></div></div></div>
</div>
${open === null ? h`<label class="row small"><input type="checkbox" id="giveaway-takeover">Firebot still holds a giveaway from before a restart. Let me press the other buttons anyway</label>` : ""}
<p class="muted small">Buttons that make no sense right now are grayed out. Viewers have the other two commands. <code>!giveaway enter</code> joins, only while entries are open and once each, and <code>!giveaway leave</code> drops out. Nothing for a mod to press. A bare <code>!giveaway</code> repeats the description Firebot was given at import.</p>`;
  };

  /** A dry run's would-have-been chat lines and Firebot commands, in order (Giveaways and Debug pages). */
  const transcriptList = (lines: readonly string[]): Raw => h`<div class="addbox"><p class="muted small">What chat would have seen (refresh to follow the countdown):</p>${
    lines.length === 0 ? h`<p class="muted small">Nothing yet.</p>` : h`<ul class="latest transcript">${lines.map((l) => h`<li class="entry"><span>${l}</span></li>`)}</ul>`
  }</div>`;

  /** `autoCloseSeconds` as the settings box shows it: "off", "5m", "2m30s", "45s" — what client.js's parser reads back. */
  const durationText = (seconds: number): string => {
    if (seconds <= 0) return "off";
    const m = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${m > 0 ? `${m}m` : ""}${sec > 0 || m === 0 ? `${sec}s` : ""}`;
  };

  /**
   * The Giveaways page: everything giveaway-shaped in one place. The raffle whose entries are open now with
   * Close & draw and Draw again (both stay on the page when nothing is tracked — Firebot holds the entries, so a close
   * after a restart still works), the "who I owe" table that used to hang off the Ledger page (Winner forms on the
   * raffle Fires), and — for the streamer — the Firebot settings that used to sit on Config: on/off and the optional
   * auto-close, typed as a duration ("5m", "120s", "off").
   */
  const giveawaysPage = (ctx: DashboardContext): Raw => {
    const cfg = config.get();
    const open = firebot.current();
    const all = ledger.all();
    const index = indexLedger(all);
    const fires = all.filter((e): e is Entry<"fire"> => e.type === "fire" && outcome((e as Entry<"fire">).payload.outcomeId)?.raffle === true).reverse();
    const firebotOff = !cfg.firebot.enabled && open?.dry !== true; // a dry run runs regardless: no nag while one is open
    return h`<section class="now">
<h1>Giveaways</h1>
${
  open === null
    ? h`<p class="muted">Nothing open. When a giveaway pad comes up it waits here, and nothing reaches chat until someone presses Start. Then chat is told to type <code>${cfg.firebot.commandTrigger} enter</code> and entries stay open until Close &amp; draw${cfg.firebot.autoCloseSeconds > 0 ? h` (or ${durationText(cfg.firebot.autoCloseSeconds)} pass)` : ""}.</p>`
    : h`<h2>${open.phase === "open" ? "Entries open" : open.draws > 0 ? `Closed · winner drawn${open.draws > 1 ? ` (${open.draws} draws)` : ""}` : "Closed · nothing drawn yet"}${open.dry === true ? h` · <span class="status-suspended">dry run, nothing reaches chat</span>` : ""}</h2>
<div class="what"><strong>${open.prize}</strong></div>
<p class="muted">${open.dry === true ? "from the Debug page, no Fire" : `fire #${open.fireSeq}`} · opened ${clock(open.openedAt)} (${ago(open.openedAt, now())})${open.autoCloseAt === undefined || open.phase !== "open" ? "" : ` · closes on its own at ${clock(open.autoCloseAt)}`}</p>
${open.dry === true ? transcriptList(open.transcript ?? []) : ""}`
}
${firebotOff ? h`<p class="status-suspended"><strong>Firebot is off.</strong> Run <code>!raffle 1 120</code> in chat for giveaways${ctx.principal.role === "streamer" ? ", or turn it on below" : ""}.</p>` : ""}
${giveawayControls(open, firebot.pending())}
</section>
<section><h2>Who I owe</h2>
<p class="muted">Every Fire of a raffle Outcome, newest first. Type the winner's name on its row. Fulfilment happens after the event. <a href="/ledger">All entries</a></p>
${fires.length === 0 ? h`<p class="muted">No giveaway has fired yet.</p>` : ledgerTable(fires, index)}
</section>
${
  ctx.principal.role === "streamer"
    ? h`<section><h2>Firebot</h2>
<form id="giveaway-settings" autocomplete="off">
<label class="row"><input type="checkbox" name="firebotEnabled"${cfg.firebot.enabled ? raw(" checked") : ""}>Firebot raffles on giveaway Fires</label>
<label class="field"><span>Auto-close after</span><input name="autoClose" value="${durationText(cfg.firebot.autoCloseSeconds)}" placeholder="off" autocomplete="off"></label>
<p class="muted small">Leave it <code>off</code> and entries stay open until Close &amp; draw. Or type a time such as <code>5m</code>, <code>120s</code> or <code>2m30s</code>, and the service closes and draws on its own that long after Start. Chat is told the window. Firebot's address and the command are in the full config on the Config page.</p>
<button type="submit" class="primary">Save</button>
</form>
</section>`
    : ""
}`;
  };

  /**
   * The Debug panel (streamer only): a board of buttons over the routes Twitch / StreamElements / Ko-fi / a mod would
   * hit, so every overlay moment can be tried without sending bits, EventSub fixtures or a Ko-fi test hook. Nothing
   * here is a fake: each button writes real Ledger entries (a Manual Credit, a queue_adjust, a fire) that the Ledger
   * page can void or re-bank like any other. client.js owns the handlers (`data-action="debug-*"`).
   */
  const debugPage = (): Raw => {
    const s = state();
    const { gates } = config.get().tiers;
    const creditButton = (label: string, f: Face): Raw => h`<button type="button" data-action="debug-credit" data-face="${JSON.stringify(f)}">${label}</button>`;
    const openableGates = gates.map((gate, i) => ({ gate, i })).filter(({ gate }) => gate > s.bankedTotal); // gates[0] is 0: never listed
    const current = firebot.current();
    const dry = current !== null && current.dry === true ? current : null;
    const realOpen = current !== null && current.dry !== true;
    const lastDry = firebot.transcript();
    return h`<section>
<h1>Debug</h1>
<p class="muted">Try the overlay without Twitch, StreamElements or Ko-fi. Every button here goes through the same routes they would, so these are <strong>real Ledger entries</strong>. Void or re-bank them on the Ledger page afterwards. A drop from here <strong>never posts to Twitch chat</strong>. The Firebot raffle is skipped, so no Outcome is announced before the night. Progress ${money(s.progressCents)} of ${money(s.thresholdCents)} · ${s.queue.length} READY · Tier ${s.tier} (${s.bankedTotal} banked).</p>
</section>
<section><h2>Drop a jumper</h2>
<p class="muted">Fires the next READY Unlock. If nothing is READY it banks one first with a +1 queue adjust. If the pool is drained it restocks one charge on a random live restockable Outcome first. It always drops something, and never opens the Firebot raffle.</p>
<div class="actions"><button type="button" class="primary" data-action="debug-drop">Drop a jumper</button></div>
</section>
<section><h2>Credits</h2>
<label class="field"><span>Name on the credit</span><input id="debug-name" value="test_viewer" autocomplete="off"></label>
<label class="row"><input type="checkbox" id="debug-anon">Anonymous</label>
<p class="muted small">Tips</p>
<div class="actions">${creditButton("$1", { kind: "tip", cents: 100 })}${creditButton("$5", { kind: "tip", cents: 500 })}${creditButton("$20", { kind: "tip", cents: 2000 })}${creditButton("$50", { kind: "tip", cents: 5000 })}</div>
<p class="muted small">Bits</p>
<div class="actions">${creditButton("100 bits", { kind: "bits", bits: 100 })}${creditButton("500 bits", { kind: "bits", bits: 500 })}${creditButton("1000 bits", { kind: "bits", bits: 1000 })}${creditButton("5000 bits", { kind: "bits", bits: 5000 })}</div>
<p class="muted small">Subs</p>
<div class="actions">${creditButton("Tier 1", { kind: "sub", tier: "1000" })}${creditButton("Tier 2", { kind: "sub", tier: "2000" })}${creditButton("Tier 3", { kind: "sub", tier: "3000" })}${creditButton("Prime", { kind: "sub", tier: "prime" })}${creditButton("Resub ×12", { kind: "sub", tier: "1000", months: 12 })}</div>
<p class="muted small">Gift subs</p>
<div class="actions">${creditButton("1 × Tier 1", { kind: "gift", tier: "1000", count: 1 })}${creditButton("5 × Tier 1", { kind: "gift", tier: "1000", count: 5 })}${creditButton("20 × Tier 1", { kind: "gift", tier: "1000", count: 20 })}${creditButton("5 × Tier 3", { kind: "gift", tier: "3000", count: 5 })}</div>
<p class="muted small">Threshold</p>
<div class="actions"><button type="button" data-action="debug-cross">Cross the Threshold now</button><button type="button" data-action="debug-cross" data-times="3">Cross it three times in one tip</button></div>
</section>
<section><h2>Unlocks and tiers</h2>
<div class="actions"><button type="button" data-action="debug-queue" data-delta="1">+1 Unlock</button><button type="button" data-action="debug-queue" data-delta="5">+5 Unlocks</button><button type="button" data-action="debug-queue" data-delta="-1">−1 Unlock</button></div>
${
  openableGates.length === 0
    ? h`<p class="muted small">Every tier is open.</p>`
    : h`<div class="actions">${openableGates.map(({ gate, i }) => h`<button type="button" data-action="debug-tier" data-gate="${gate}">Open Tier ${i} (bank to ${gate})</button>`)}</div>`
}
</section>
<section><h2>Giveaway (dry run)</h2>
<p class="muted small">The whole raffle flow without Firebot or chat: start, the prize line, the auto-close countdown if one is set, and every button the Giveaways page has. Each line lands in a transcript here and on the Giveaways page instead, quoting what Firebot would have said. Nothing is written and nothing reaches Twitch. Firebot can be off.</p>
${
  dry === null
    ? h`<div class="actions"><button type="button" data-action="debug-giveaway">Open a dry-run giveaway</button></div>${lastDry.length > 0 && !realOpen ? h`<p class="muted small">Last dry run:</p>${transcriptList(lastDry)}` : ""}`
    : h`<p><strong>${dry.prize}</strong> is open as a dry run${dry.autoCloseAt === undefined ? "" : ` · closes on its own at ${clock(dry.autoCloseAt)}`}.</p>
${giveawayControls(dry, [])}
<p><a class="btn" href="/giveaways">Giveaways page</a></p>
${transcriptList(dry.transcript ?? [])}`
}
${realOpen ? h`<p class="status-suspended small">A real giveaway is open right now. Finish it on the Giveaways page before a dry run.</p>` : ""}
</section>
<section><h2>Chatter Dancers</h2>
<p class="muted small">Fake a new chatter puts a made-up person with a stock picture on the dance floor. Press it again for more people. Fake a message from someone here makes one random person already on the floor hop, real or fake. Fakes walk off when the window runs out, like anyone who stops chatting. Nothing here reaches Twitch chat and nothing is written to the Ledger.</p>
<div class="actions"><button type="button" data-action="debug-chatter">Fake a new chatter</button><button type="button" data-action="debug-chat-hop">Fake a message from someone here</button></div>
</section>
<section><h2>Cues</h2>
<p class="muted small">Sent straight to the overlay; nothing is written. <code>energy</code> drives the dance floor for a while (0–1).</p>
<div class="actions"><button type="button" data-action="debug-cue" data-name="energy" data-value="0">Floor energy 0</button><button type="button" data-action="debug-cue" data-name="energy" data-value="0.5">Floor energy 0.5</button><button type="button" data-action="debug-cue" data-name="energy" data-value="1">Floor energy 1</button></div>
<form id="debug-cue" autocomplete="off">
<label class="field"><span>Cue name</span><input name="name" placeholder="energy" required></label>
<label class="field"><span>Value (optional)</span><input name="value" inputmode="decimal" placeholder="0.8"></label>
<button type="submit">Send cue</button>
</form>
</section>`;
  };

  const help = (): Raw => h`<section class="help">${raw(helpHtml())}</section>`;

  const forbidden = (ctx: DashboardContext): Response =>
    html(
      layout({
        title: "Streamer only",
        active: "config",
        principal: ctx.principal,
        listener: ctx.listener,
        body: h`<section><h1>Streamer only</h1><p>Config, including the Threshold, is the streamer's. Everything operational is on the other pages: Fire, credits, voids, re-banks, the queue, the pool.</p></section>`,
      }),
      403,
    );

  const page = (title: string, active: NavKey, ctx: DashboardContext, body: Raw, mainClass?: string): Response =>
    html(layout({ title, active, principal: ctx.principal, listener: ctx.listener, body, mainClass }));

  return (req, ctx) => {
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/":
        return page("Live", "live", ctx, live());
      case "/ledger":
        return page("Ledger", "ledger", ctx, ledgerPage(url));
      case "/pool":
        return page("Pool", "pool", ctx, pool(ctx), ctx.principal.role === "streamer" ? "xwide" : "xwide modview");
      case "/giveaways":
        return page("Giveaways", "giveaways", ctx, giveawaysPage(ctx));
      case "/config":
        return ctx.principal.role === "streamer" ? page("Config", "config", ctx, configPage(ctx)) : forbidden(ctx);
      case "/debug":
        return ctx.principal.role === "streamer" ? page("Debug", "debug", ctx, debugPage()) : forbidden(ctx);
      case "/help":
        return page("Help", "help", ctx, help());
      default:
        return html(layout({ title: "Not found", active: null, principal: ctx.principal, listener: ctx.listener, body: h`<section><h1>Not found</h1></section>` }), 404);
    }
  };
}

/** `GET /dashboard/client.js` — the one script, embedded in the binary. */
export function clientScript(): Response {
  return new Response(clientJs, { headers: { "content-type": "application/javascript; charset=utf-8" } });
}
