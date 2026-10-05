/**
 * Ko-fi webhook handler: `POST /hooks/kofi/<webhookPath>` on the funnel listener only, and only while
 * `ingest.kofi.enabled` (off → 404, like a wrong path). The path and the verification token are both secrets Ko-fi was
 * given — a wrong path is a plain 404, a wrong token a 401 plus an `auth_failure` entry (a passive tripwire) that
 * names the hook, never the path. Donation / Subscription credit through the Engine, whose transaction
 * records the raw event, so a redelivery is a duplicate; other types are recorded raw here and never credited. Always 200
 * on success; the token is never echoed in a response or a log line.
 */
import { timingSafeEqual } from "node:crypto";
import type { Config } from "../../config/schema.ts";
import type { Secrets } from "../../config/secrets.ts";
import type { Engine } from "../../engine/engine.ts";
import type { Ledger } from "../../ledger/ledger.ts";
import { HttpError, clientIp, errorJson, json, notFound, readForm } from "../../server/http-util.ts";
import type { Contribution } from "../contribution.ts";
import { normalizeKofi, parseKofiBody, type KofiPayload } from "./normalize.ts";

export const KOFI_TOKEN_KEY = "KOFI_VERIFICATION_TOKEN";
export const KOFI_ACTOR = "system:kofi";
export const KOFI_SOURCE = "kofi";
/** What an `auth_failure` records as its path: the Ledger page shows entries, and the real path is half of the secret. */
export const KOFI_AUDIT_PATH = "/hooks/kofi/<redacted>";

export interface KofiHandlerDeps {
  config: () => Config;
  secrets: Secrets;
  engine: Engine;
  ledger: Ledger;
  /** Operational log line (never carries the token). Default: console.error. */
  log?: (message: string) => void;
}

/** `path` is what followed `/hooks/kofi/` in the URL. */
export type KofiHandler = (req: Request, path: string) => Promise<Response>;

const bad = (message: string): Response => errorJson(400, "VALIDATION", message);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Constant-time string equality; a length mismatch is a mismatch. */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createKofiHandler(deps: KofiHandlerDeps): KofiHandler {
  const log = deps.log ?? ((message: string) => console.error(message));

  return async (req, path) => {
    const { enabled, webhookPath: expectedPath } = deps.config().ingest.kofi;
    if (!enabled || expectedPath === "" || !safeEqual(path, expectedPath)) return notFound();

    let form: URLSearchParams;
    try {
      form = await readForm(req);
    } catch (e) {
      if (e instanceof HttpError) return e.toResponse(); // over the body cap → 413
      throw e;
    }
    let data: KofiPayload;
    try {
      data = parseKofiBody(form.toString()).data;
    } catch {
      return bad("body must be form-encoded with a data field holding JSON");
    }
    if (!isRecord(data) || typeof data.verification_token !== "string" || typeof data.message_id !== "string" || data.message_id === "") {
      return bad("data must carry verification_token and message_id");
    }

    const expectedToken = deps.secrets.get(KOFI_TOKEN_KEY) ?? "";
    if (expectedToken === "" || !safeEqual(data.verification_token, expectedToken)) {
      deps.ledger.append("auth_failure", KOFI_ACTOR, { ip: clientIp(req), path: KOFI_AUDIT_PATH, reason: "bad verification token" });
      return errorJson(401, "UNAUTHORIZED", "bad verification token");
    }

    // The token is a credential Ko-fi shares with us, not part of the event, and the donor's email is PII the service
    // never needs: both stay out of the raw_events row.
    const { verification_token: _token, email: _email, ...raw } = data;
    const sourceId = `${KOFI_SOURCE}:${data.message_id}`;

    let contribution: Contribution | null;
    try {
      contribution = normalizeKofi(data);
    } catch (e) {
      log(`ko-fi: message ${data.message_id} not credited: ${errorText(e)}`);
      return bad("amount must be a decimal money string");
    }

    if (contribution === null) {
      // Shop Order, Commission, …: kept for the record, never credited — and deduped like everything else.
      const { duplicate } = deps.ledger.recordRaw(KOFI_SOURCE, sourceId, raw);
      return json(duplicate ? { ok: true, duplicate: true } : { ok: true, credited: false });
    }
    const result = deps.engine.contribute(contribution, KOFI_ACTOR, raw); // records the raw event in the same transaction
    return json(result.duplicate ? { ok: true, duplicate: true } : { ok: true, credited: true });
  };
}
