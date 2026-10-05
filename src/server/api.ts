/**
 * The JSON API — the same routes on both app listeners; the caller (app.ts) has already resolved the
 * Principal. Every mutation goes CSRF → role → body validation (400 VALIDATION) → Engine, and an Engine rejection maps
 * to its HTTP status: 404 for an unknown outcome / entry, 409 for NO_UNLOCKS, POOL_DRAINED, NOT_RESTOCKABLE, INVALID.
 * Nothing here writes the Ledger except through the Engine, the two direct appends the API makes itself (`note` for a giveaway
 * winner, `config_change` for a config PUT), the Outcome editor's `outcome_change` (one per add / edit / delete,
 * keyed by id — never a `config_change`), `/api/cue`, which touches nothing but the overlay, and `/api/shutdown`'s `note`
 * (the Dashboard's Shut down button: who stopped the service, before the process goes down through main.ts's signal path).
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import { ConfigError, validateConfig, type Config, type OutcomeDef } from "../config/schema.ts";
import type { ConfigStore } from "../config/store.ts";
import { EngineError, OUTCOME_STATUSES, type Engine, type EngineErrorCode } from "../engine/engine.ts";
import { EDITABLE_FIELDS, outcomeChanges, slugId, type OutcomeChanges } from "../engine/outcome-diff.ts";
import type { OutcomeState } from "../engine/state.ts";
import { loginHintFor, type Contribution, type Face, type SubTier } from "../ingest/contribution.ts";
import type { Firebot } from "../integrations/firebot.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { Entry } from "../ledger/types.ts";
import { requireCsrf, type AppListener, type Principal, type Role } from "./auth.ts";
import type { Health } from "./health.ts";
import { HttpError, errorJson, json, notFound, readJson } from "./http-util.ts";
import { overlayUrls } from "./overlay-urls.ts";
import type { ChatterSource, OverlayHub } from "./overlay.ts";

export interface ApiDeps {
  config: ConfigStore;
  ledger: Ledger;
  engine: Engine;
  health: Health;
  firebot: Firebot;
  hub: OverlayHub;
  /** The Active Chatter roster: `/api/state`'s count and the two Debug routes. Never written by a route. */
  chatters: ChatterSource;
  now?: () => Date;
  /** For `overlayUrls`; default `os.networkInterfaces`. */
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** This computer's own LAN address, which a container cannot see for itself. Read from `$HOST_LAN_IP` at the boot seam. */
  hostLanIp?: string;
  /** The console (`shutdown requested from the Dashboard by …`); default console.log. */
  log?: (line: string) => void;
  /**
   * `POST /api/shutdown`: called SHUTDOWN_DELAY_MS after the 200 has been returned, with `"dashboard"` — main.ts's
   * signal path, so the button stops the process exactly the way SIGTERM does. Absent (a bare boot, tests): 503.
   */
  onShutdownRequest?: (source: string) => void;
}

export interface ApiContext {
  principal: Principal;
  listener: AppListener;
}

export type ApiHandler = (req: Request, ctx: ApiContext) => Promise<Response>;

export const MANUAL_SOURCE_PREFIX = "manual:";
export const ACTOR_OVERRIDE_MAX = 40;
export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 200;
export const FIREBOT_HEALTH_ID = "firebot";
/** Firebot is switched off in config: at a giveaway Fire the streamer gets a reminder (info, dismissable), not an outage warning. */
export const FIREBOT_OFF_TEXT = "Firebot is off — run !raffle 1 120 in chat for giveaways";
/** The editor's one cross-field rule: a Firebot raffle only makes sense where a viewer wins something. */
export const RAFFLE_GIVEAWAYS_ONLY = "Firebot raffle is for giveaways only";
/** The word the Shut down confirm must carry — a stray POST never stops the show. */
export const SHUTDOWN_CONFIRM = "SHUTDOWN";

/** Between the 200 and the hook: long enough for the response to reach the page, short enough to feel like a button. */
export const SHUTDOWN_DELAY_MS = 500;
/** `POST /api/chatters/hop` with an empty dance floor: a 409 the Debug button shows as a toast. */
export const NOBODY_ON_THE_FLOOR = "Nobody is on the floor yet";

const STATUS_FOR_CODE: Record<EngineErrorCode, number> = { UNKNOWN_OUTCOME: 404, UNKNOWN_ENTRY: 404, NO_UNLOCKS: 409, POOL_DRAINED: 409, NOT_RESTOCKABLE: 409, INVALID: 409 };
const SUB_TIERS: ReadonlySet<string> = new Set<SubTier>(["1000", "2000", "3000", "prime"]);

// ---------------------------------------------------------------------------------------------------------------------
// Body validation — every failure is a 400 VALIDATION naming the field
// ---------------------------------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const bad = (message: string) => new HttpError(400, "VALIDATION", message);
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function body(v: unknown): Rec {
  if (!isRecord(v)) throw bad("body must be a JSON object");
  return v;
}

function str(v: unknown, name: string): string {
  if (typeof v !== "string") throw bad(`${name} must be a string`);
  return v;
}

function nonEmpty(v: unknown, name: string): string {
  const s = str(v, name).trim();
  if (s === "") throw bad(`${name} must not be empty`);
  return s;
}

function int(v: unknown, name: string, min: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw bad(`${name} must be an integer >= ${min}`);
  return v;
}

function subTier(v: unknown): SubTier {
  if (typeof v !== "string" || !SUB_TIERS.has(v)) throw bad("face.tier must be one of 1000 | 2000 | 3000 | prime");
  return v as SubTier;
}

function face(v: unknown): Face {
  if (!isRecord(v)) throw bad("face must be an object");
  switch (v.kind) {
    case "tip":
      return { kind: "tip", cents: int(v.cents, "face.cents", 1) };
    case "bits":
      return { kind: "bits", bits: int(v.bits, "face.bits", 1) };
    case "sub": {
      const tier = subTier(v.tier);
      return v.months === undefined ? { kind: "sub", tier } : { kind: "sub", tier, months: int(v.months, "face.months", 1) };
    }
    case "gift":
      return { kind: "gift", tier: subTier(v.tier), count: int(v.count, "face.count", 1) };
    default:
      throw bad("face.kind must be one of tip | bits | sub | gift");
  }
}

/**
 * The editor's definition fields from a body onto a def: only EDITABLE_FIELDS (never `id`, never `initialLeft`), a key
 * absent from the body is left alone, `null` clears an optional (`miniDraw`, `raffle`), the name is trimmed and must not
 * be blank. Field types are validateConfig's job — the candidate config goes through it before anything is written.
 */
function editorFields(b: Rec, into: Rec): void {
  for (const field of EDITABLE_FIELDS) {
    const v = b[field];
    if (v === undefined) continue;
    if (v === null && (field === "miniDraw" || field === "raffle")) delete into[field];
    else if (field === "name") into.name = nonEmpty(v, "name");
    else if (field === "description") into.description = str(v, "description").trim(); // "" allowed: nothing to say; validateConfig holds the length
    else into[field] = v;
  }
}

/** The candidate config through validateConfig; every problem it lists is the client's 400, in one message. */
function validated(next: unknown): Config {
  try {
    return validateConfig(next);
  } catch (e) {
    if (e instanceof ConfigError) throw bad(e.message);
    throw e;
  }
}

function raffleAllowed(def: OutcomeDef): void {
  if (def.raffle === true && def.shape !== "giveaway") throw bad(RAFFLE_GIVEAWAYS_ONLY);
}

/** `outcome_change.changes` for an add (every field as `{from: undefined, to}`) or a delete (the reverse): the editable fields that are set, plus the Left at that moment. */
function wholeDef(def: OutcomeDef, left: number, action: "add" | "delete"): OutcomeChanges {
  const out: OutcomeChanges = {};
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) out[key] = action === "add" ? { from: undefined, to: value } : { from: value, to: undefined };
  };
  for (const field of EDITABLE_FIELDS) put(field, def[field]);
  put("left", left);
  return out;
}

/** A path segment as text; a malformed percent-encoding is the client's problem (400), not a 500. */
function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw bad("malformed path segment");
  }
}

function seqParam(raw: string, name: string): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1) throw bad(`${name} must be a positive integer`);
  return n;
}

function queryInt(url: URL, name: string, min: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const n = Number(raw);
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min) throw bad(`${name} must be an integer >= ${min}`);
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------------------------------------------------

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface RouteInput {
  req: Request;
  url: URL;
  ctx: ApiContext;
  params: Record<string, string>;
}

interface Route {
  method: Method;
  pattern: RegExp;
  names: string[];
  role: Role;
  run: (input: RouteInput) => Promise<Response> | Response;
}

/** `/api/fires/:seq/winner` → a regexp with one capture per `:name` (a segment may not contain `/`). */
function route(method: Method, path: string, role: Role, run: Route["run"]): Route {
  const names: string[] = [];
  const source = path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(seg.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { method, pattern: new RegExp(`^${source}$`), names, role, run };
}

const RANK: Record<Role, number> = { mod: 1, streamer: 2 };
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** An actor override as it may enter the Ledger: control characters out (no newline in the actor column), trimmed, at most ACTOR_OVERRIDE_MAX code points (never a split surrogate pair). */
const sanitizeActor = (raw: string): string => Array.from(raw.replace(CONTROL_CHARS, "").trim()).slice(0, ACTOR_OVERRIDE_MAX).join("");

const engineErrorResponse = (e: EngineError): Response => errorJson(STATUS_FOR_CODE[e.code], e.code, e.message.replace(new RegExp(`^${e.code}:\\s*`), ""));

export function createApi(deps: ApiDeps): ApiHandler {
  const { config, ledger, engine, health, firebot, hub, chatters } = deps;
  const now = deps.now ?? (() => new Date());
  const networkInterfaces = deps.networkInterfaces ?? (() => os.networkInterfaces());
  const log = deps.log ?? ((line: string) => console.log(line));

  const state = () => engine.state;
  const outcomeName = (id: string): string => state().outcomes.find((o) => o.id === id)?.name ?? id;
  /** An Outcome that is in config right now (the editor routes check first); the Engine's list follows config synchronously. */
  const outcomeOf = (id: string): OutcomeState => {
    const outcome = state().outcomes.find((o) => o.id === id);
    if (outcome === undefined) throw new EngineError("UNKNOWN_OUTCOME", `no outcome with id ${JSON.stringify(id)}`);
    return outcome;
  };

  /** What to paste into OBS; see `overlay-urls.ts` for why Docker needs the host's address handed to it. */
  const overlayUrlList = (): string[] => overlayUrls({ overlayPort: config.get().listeners.overlayPort, overlayOnLan: config.get().listeners.overlayOnLan, networkInterfaces, hostLanIp: deps.hostLanIp });

  /** `actor` in the body is honoured on the streamer listener only (`twitch:<login> via <name>` — or `streamer@local via <name>` before the link — e.g. Firebot's `!fire`). */
  const fireActor = (ctx: ApiContext, b: Rec): string => {
    if (b.actor === undefined) return ctx.principal.actor;
    const override = sanitizeActor(str(b.actor, "actor"));
    if (ctx.listener !== "streamer" || override === "") return ctx.principal.actor;
    return `${ctx.principal.actor} via ${override}`;
  };

  /** A giveaway Fire waits for Start on the Giveaways page — nothing reaches chat until then (the streamer may not be ready). */
  const raffle = (outcome: OutcomeState, fireSeq: number): void => {
    if (outcome.raffle !== true) return;
    firebot.queue(outcome.name, fireSeq);
    if (!config.get().firebot.enabled) health.set(FIREBOT_HEALTH_ID, "info", FIREBOT_OFF_TEXT); // a reminder, dismissable: the raffle will be by hand
  };

  /** `POST /api/fire` may come without a body at all (Firebot's `!fire` HTTP effect); anything present must be a JSON object. */
  const optionalBody = async (req: Request): Promise<Rec> => (req.body === null || req.headers.get("content-length") === "0" ? {} : body(await readJson(req)));

  const routes: Route[] = [
    route("GET", "/api/state", "mod", ({ ctx }) => json({ role: ctx.principal.role, actor: ctx.principal.actor, state: state(), health: health.list(), overlayUrls: overlayUrlList(), overlays: hub.reports(), giveaway: firebot.current(), giveawaysPending: firebot.pending(), chatters: chatters.count() })),

    route("GET", "/api/ledger", "mod", ({ url }) => {
      const limit = Math.min(queryInt(url, "limit", 1) ?? LEDGER_PAGE_DEFAULT, LEDGER_PAGE_MAX);
      const before = queryInt(url, "before", 0);
      return json({ entries: ledger.page(before === undefined ? { limit } : { before, limit }) });
    }),

    route("POST", "/api/contributions", "mod", async ({ req, ctx }) => {
      const b = body(await readJson(req));
      const displayName = b.displayName === undefined ? "" : str(b.displayName, "displayName").trim();
      const message = b.message === undefined ? "" : str(b.message, "message").trim();
      const loginHint = loginHintFor(displayName); // a login-shaped typed name may find a picture; never an id from a name
      const contribution: Contribution = {
        source: "manual",
        sourceId: `${MANUAL_SOURCE_PREFIX}${randomUUID()}`,
        face: face(b.face),
        displayName: displayName === "" ? null : displayName,
        anonymous: displayName === "",
        ...(message === "" ? {} : { message }),
        ...(loginHint === undefined ? {} : { loginHint }),
        occurredAt: now().toISOString(),
      };
      const result = engine.contribute(contribution, ctx.principal.actor);
      if (result.duplicate) throw new HttpError(409, "INVALID", "duplicate manual credit"); // unreachable with a fresh uuid
      return json({ seq: result.entry.seq, unlocksBanked: result.unlocksBanked, tiersOpened: result.tiersOpened, state: state() });
    }),

    route("POST", "/api/contributions/:seq/void", "mod", async ({ req, ctx, params }) => {
      const seq = seqParam(params.seq!, "seq");
      const reason = nonEmpty(body(await readJson(req)).reason, "reason");
      engine.voidContribution(seq, ctx.principal.actor, reason);
      return json({ state: state() });
    }),

    route("POST", "/api/fire", "mod", async ({ req, ctx }) => {
      const b = await optionalBody(req);
      // `raffle: false` fires without the Firebot raffle — the Debug page's drops, so a test never announces a prize in chat
      if (b.raffle !== undefined && typeof b.raffle !== "boolean") throw bad("raffle must be a boolean");
      const result = engine.fire(fireActor(ctx, b));
      if (b.raffle !== false) raffle(result.outcome, result.seq);
      return json(result);
    }),

    route("POST", "/api/fires/:seq/rebank", "mod", async ({ req, ctx, params }) => {
      const seq = seqParam(params.seq!, "seq");
      const reason = nonEmpty(body(await readJson(req)).reason, "reason");
      engine.rebank(seq, ctx.principal.actor, reason);
      return json({ state: state() });
    }),

    route("POST", "/api/fires/:seq/winner", "mod", async ({ req, ctx, params }) => {
      const seq = seqParam(params.seq!, "seq");
      const winner = nonEmpty(body(await readJson(req)).winner, "winner");
      const fired = ledger.get(seq);
      if (fired === undefined || fired.type !== "fire") return errorJson(404, "NOT_FOUND", `no fire with seq ${seq}`);
      const name = outcomeName((fired as Entry<"fire">).payload.outcomeId);
      return json({ entry: ledger.append("note", ctx.principal.actor, { text: `winner of fire #${seq} (${name}): ${winner}`, fireSeq: seq, winner }) });
    }),

    // --- Giveaways: entries stay open until a person closes them (the Giveaways page). Firebot holds the entries, so
    // close works after a restart too; each act leaves a note against the Fire so the Ledger tells the whole story.
    // Giveaways: every act is one Firebot subcommand (or two), works with nothing tracked too (Firebot holds the
    // entries, so a close after a restart still lands), and leaves a note against the Fire — except for a dry run,
    // which writes nothing. 502 FIREBOT with the !raffle fallback when Firebot is off or does not answer.
    ...(
      [
        ["close", "closed (entries stopped, nothing drawn)", () => firebot.close()],
        ["close-and-draw", "closed and drawn", () => firebot.closeAndDraw()],
        ["draw", "drawn again", () => firebot.draw()],
        ["reopen", "reopened (entries on again, list kept)", () => firebot.reopen()],
        ["clear", "done — entrant list cleared", () => firebot.clear()],
      ] as const
    ).map(([name, said, act]) =>
      route("POST", `/api/giveaway/${name}`, "mod", async ({ ctx }) => {
        const open = firebot.current();
        const result = await act();
        if (!result.ok) return errorJson(502, "FIREBOT", result.error === "disabled" ? FIREBOT_OFF_TEXT : `Firebot didn't respond (${result.error}) — type !raffle 1 120 in chat`);
        if (open?.dry === true) return json({ entry: null, giveaway: firebot.current(), transcript: firebot.transcript() }); // a dry run: nothing real happened, nothing written
        health.clear(FIREBOT_HEALTH_ID);
        const entry = ledger.append("note", ctx.principal.actor, { text: open === null ? `giveaway ${said}` : `giveaway ${said} for fire #${open.fireSeq} (${open.prize})`, ...(open === null ? {} : { fireSeq: open.fireSeq }) });
        return json({ entry, giveaway: firebot.current() });
      }),
    ),

    // Start (mod): `fireSeq` names a waiting Fire (its prize unless `prize` overrides); no fireSeq = by hand, no Fire
    // behind it. Firebot empties the list and opens, our prize line follows. Refused while one is tracked as open or
    // closed-but-not-done: press Done first, or it is two giveaways in one list.
    route("POST", "/api/giveaway/start", "mod", async ({ req, ctx }) => {
      const b = body(await readJson(req));
      const waiting = b.fireSeq === undefined ? undefined : firebot.pending().find((p) => p.fireSeq === seqParam(String(b.fireSeq), "fireSeq"));
      if (b.fireSeq !== undefined && waiting === undefined) return errorJson(404, "NOT_FOUND", `no giveaway is waiting on fire #${String(b.fireSeq)}`);
      const prize = b.prize === undefined ? waiting?.prize : nonEmpty(b.prize, "prize");
      if (prize === undefined) throw bad("prize is required");
      const open = firebot.current();
      if (open !== null) return errorJson(409, "GIVEAWAY_OPEN", `${open.dry === true ? "a dry run" : `a giveaway (${open.prize})`} is still on — press Done on the Giveaways page first`);
      const result = await firebot.open(prize, waiting?.fireSeq ?? 0);
      if (!result.ok) return errorJson(502, "FIREBOT", result.error === "disabled" ? FIREBOT_OFF_TEXT : `Firebot didn't respond (${result.error}) — type !raffle 1 120 in chat`);
      health.clear(FIREBOT_HEALTH_ID);
      const entry = ledger.append("note", ctx.principal.actor, waiting === undefined ? { text: `giveaway started by hand (${prize})` } : { text: `giveaway started for fire #${waiting.fireSeq} (${prize})`, fireSeq: waiting.fireSeq });
      return json({ entry, giveaway: firebot.current(), giveawaysPending: firebot.pending() });
    }),

    // The Debug page's giveaway: the full flow — announcement, countdown, Close & draw — with nothing sent to Firebot
    // or chat and nothing written; `prize` optional (a random raffle Outcome's name otherwise). Refused while a real
    // giveaway is open: a dry run must never take over a live one.
    route("POST", "/api/giveaway/dry-run", "streamer", async ({ req }) => {
      const b = await optionalBody(req);
      const open = firebot.current();
      if (open !== null && open.dry !== true) return errorJson(409, "GIVEAWAY_OPEN", `a real giveaway is open (${open.prize}) — finish it on the Giveaways page first`);
      const raffles = state().outcomes.filter((o) => o.raffle === true);
      const pick = raffles.length === 0 ? "TEST PRIZE" : raffles[Math.floor(Math.random() * raffles.length)]!.name;
      const prize = b.prize === undefined ? pick : nonEmpty(b.prize, "prize");
      await firebot.openDry(prize);
      return json({ giveaway: firebot.current() });
    }),

    route("POST", "/api/queue/adjust", "mod", async ({ req, ctx }) => {
      const b = body(await readJson(req));
      if (typeof b.delta !== "number" || !Number.isInteger(b.delta) || b.delta === 0) throw bad("delta must be a non-zero integer");
      engine.adjustQueue(b.delta, ctx.principal.actor, nonEmpty(b.reason, "reason"));
      return json({ state: state() });
    }),

    route("POST", "/api/outcomes/:id/status", "mod", async ({ req, ctx, params }) => {
      const status = str(body(await readJson(req)).status, "status");
      if (!OUTCOME_STATUSES.has(status)) throw bad("status must be one of live | suspended | retired");
      engine.setOutcomeStatus(params.id!, status as OutcomeState["status"], ctx.principal.actor);
      return json({ state: state() });
    }),

    route("POST", "/api/outcomes/:id/restock", "mod", async ({ req, ctx, params }) => {
      const charges = int(body(await readJson(req)).charges, "charges", 1);
      engine.restock(params.id!, charges, ctx.principal.actor);
      return json({ state: state() });
    }),

    // --- the Outcome editor: definitions live in config.json, Left in the Ledger; each act is one outcome_change.
    // Order on every route: config.update → engine.reproject (the list follows config; the overlay hears) → outcome_change →
    // setLeft when a Left was asked for. Nothing is written until the candidate config has passed validateConfig.

    route("POST", "/api/outcomes", "streamer", async ({ req, ctx }) => {
      const b = body(await readJson(req));
      const name = nonEmpty(b.name, "name");
      const left = int(b.left, "left", 0);
      const current = config.get();
      const def: Rec = { id: slugId(name, new Set(current.outcomes.map((o) => o.id))), initialLeft: left };
      editorFields(b, def);
      const next = structuredClone(current);
      next.outcomes.push(def as unknown as OutcomeDef);
      validated(next);
      const added = def as unknown as OutcomeDef;
      raffleAllowed(added);
      const actor = ctx.principal.actor;
      config.update(next);
      engine.reproject(actor); // an id the Ledger has never met gets its `stock` seed (reason "initial") here
      ledger.append("outcome_change", actor, { outcomeId: added.id, action: "add", changes: wholeDef(added, left, "add") });
      // A re-used id (deleted earlier) is already seeded, so reproject left its Left where the delete put it — 0; the
      // route sets the asked-for Left itself. For a fresh id the seed already equals it and this writes nothing.
      engine.setLeft(added.id, left, actor, "initial");
      return json({ outcome: outcomeOf(added.id), state: state() }, 201);
    }),

    route("PUT", "/api/outcomes/:id", "streamer", async ({ req, ctx, params }) => {
      const b = body(await readJson(req));
      const id = params.id!;
      const current = config.get();
      const index = current.outcomes.findIndex((o) => o.id === id);
      if (index === -1) throw new EngineError("UNKNOWN_OUTCOME", `no outcome with id ${JSON.stringify(id)}`);
      const left = b.left === undefined ? undefined : int(b.left, "left", 0);
      const next = structuredClone(current);
      const after = next.outcomes[index]!;
      editorFields(b, after as unknown as Rec);
      validated(next);
      raffleAllowed(after);
      const changes = outcomeChanges(current.outcomes[index]!, after);
      const actor = ctx.principal.actor;
      if (Object.keys(changes).length > 0) {
        config.update(next);
        engine.reproject(actor); // a definition edit writes no stock; the list is rebuilt and the overlay hears
        ledger.append("outcome_change", actor, { outcomeId: id, action: "edit", changes });
      }
      if (left !== undefined) engine.setLeft(id, left, actor, "left edit"); // one signed `stock` entry; none when Left already reads that
      return json({ outcome: outcomeOf(id), state: state() });
    }),

    route("DELETE", "/api/outcomes/:id", "streamer", ({ ctx, params }) => {
      const id = params.id!;
      const current = config.get();
      if (!current.outcomes.some((o) => o.id === id)) throw new EngineError("UNKNOWN_OUTCOME", `no outcome with id ${JSON.stringify(id)}`);
      const outcome = outcomeOf(id);
      if (outcome.used > 0) return errorJson(409, "OUTCOME_USED", `Used ${outcome.used} — retire it instead`); // delete only while Used = 0
      const actor = ctx.principal.actor;
      engine.setLeft(id, 0, actor, "deleted"); // the Ledger, not a missing definition, says where the Left went (nothing when it was 0)
      const next = structuredClone(current);
      next.outcomes = next.outcomes.filter((o) => o.id !== id);
      config.update(next);
      engine.reproject(actor); // the pad leaves the pool now; the overlay hears
      ledger.append("outcome_change", actor, { outcomeId: id, action: "delete", changes: wholeDef(outcome, outcome.left, "delete") });
      return json({ state: state() });
    }),

    route("POST", "/api/threshold", "streamer", async ({ req, ctx }) => {
      const cents = int(body(await readJson(req)).cents, "cents", 1);
      const { unlocksBanked } = engine.setThreshold(cents, ctx.principal.actor);
      // The `threshold` entry is the record; config.json just has to agree with it after a restart.
      const current = config.get();
      config.update({ ...current, threshold: { ...current.threshold, cents } });
      return json({ unlocksBanked, state: state() });
    }),

    route("GET", "/api/config", "streamer", () => json({ config: config.get() })),

    route("PUT", "/api/config", "streamer", async ({ req, ctx }) => {
      const next = validated(await readJson(req));
      // A Threshold edit through the config editor is still a Threshold edit: the Engine applies it first (the `threshold`
      // entry is the record and any crossing banks now), then the file agrees — the same order as /api/threshold. The
      // comparison is against the Engine's Threshold, not the file's: after a hand edit the file may already differ.
      if (next.threshold.cents !== engine.state.thresholdCents) engine.setThreshold(next.threshold.cents, ctx.principal.actor);
      const diff = config.update(next);
      if (diff.length > 0) {
        ledger.append("config_change", ctx.principal.actor, { diff });
        engine.reproject(ctx.principal.actor); // an `outcomes` edit lands in the Engine the same way a hand edit does
        hub.skinChanged();
      }
      return json({ config: config.get(), diff });
    }),

    route("POST", "/api/cue", "streamer", async ({ req }) => {
      const b = body(await readJson(req));
      const name = nonEmpty(b.name, "name");
      if (b.value === undefined) {
        hub.broadcast({ type: "cue", name });
      } else {
        if (typeof b.value !== "number" || !Number.isFinite(b.value)) throw bad("value must be a finite number");
        hub.broadcast({ type: "cue", name, value: b.value });
      }
      return json({ ok: true });
    }),

    // Debug page: a made-up person walks onto the dance floor / one person already there hops. The roster is in
    // memory and the overlay is its only listener: nothing is written and nothing reaches Twitch chat.
    route("POST", "/api/chatters/fake", "streamer", () => json({ chatter: chatters.fake() })),

    route("POST", "/api/chatters/hop", "streamer", () => {
      const chatter = chatters.hopRandom();
      if (chatter === null) return errorJson(409, "INVALID", NOBODY_ON_THE_FLOOR);
      return json({ chatter });
    }),

    route("POST", "/api/health/:id/dismiss", "mod", ({ params }) => {
      health.dismiss(params.id!);
      return json({ ok: true });
    }),

    // The Dashboard's Shut down button. Order: confirm word → the note (who, in the Ledger before the process goes) →
    // the console line → the 200 → the hook on a timer, so the page has its answer before the listener closes. The hook is
    // main.ts's signal path: booted.stop() closes the listeners and the Ledger, then exit(0) — the container stays down
    // (compose `restart: on-failure`) until `just show`.
    route("POST", "/api/shutdown", "streamer", async ({ req, ctx }) => {
      // The overlay computer only: the broadcaster's own funnel session is role streamer too, and a pocket tap over the public Funnel
      // URL must not end the show (the same gate the broadcaster-link button uses).
      if (ctx.listener !== "streamer") return errorJson(403, "FORBIDDEN", "shut down from the overlay computer's own Dashboard only");
      const b = body(await readJson(req));
      if (b.confirm !== SHUTDOWN_CONFIRM) throw bad(`confirm must be ${JSON.stringify(SHUTDOWN_CONFIRM)}`);
      const hook = deps.onShutdownRequest;
      if (hook === undefined) return errorJson(503, "UNAVAILABLE", "shutdown is not wired on this process — stop it from the terminal");
      const actor = ctx.principal.actor;
      ledger.append("note", actor, { text: `Shut down from the Dashboard by ${actor}` });
      log(`shutdown requested from the Dashboard by ${actor}`);
      setTimeout(() => hook("dashboard"), SHUTDOWN_DELAY_MS).unref?.(); // never the thing keeping a process alive
      return json({ ok: true, inMs: SHUTDOWN_DELAY_MS });
    }),
  ];

  return async (req, ctx) => {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    for (const r of routes) {
      const m = r.pattern.exec(url.pathname);
      if (m === null || r.method !== method) continue;
      const csrf = requireCsrf(req);
      if (csrf !== null) return csrf;
      if (RANK[ctx.principal.role] < RANK[r.role]) return errorJson(403, "FORBIDDEN", `${r.role} only`);
      try {
        const params = Object.fromEntries(r.names.map((name, i) => [name, decodeParam(m[i + 1]!)]));
        return await r.run({ req, url, ctx, params });
      } catch (e) {
        if (e instanceof EngineError) return engineErrorResponse(e);
        throw e;
      }
    }
    return notFound();
  };
}
