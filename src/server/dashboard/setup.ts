/**
 * The Setup page: the first-run wizard, in the browser, on the streamer listener only (`GET /setup`). It replaces
 * the terminal wizard scripts/setup.sh. Three required steps with a progress line (channel name, your own Twitch app,
 * Connect Twitch), then the optional extras, each behind its own switch and OFF until the streamer turns it on:
 * StreamElements tips, mod access from other computers plus Ko-fi (both need a public address), Firebot giveaways.
 * The last section sends them to the Debug page to see a fake cheer land in OBS.
 *
 * Every save is one `POST /api/setup/<section>` (Streamer, streamer listener, CSRF header). Config fields go through
 * `ConfigStore.update` with a `config_change` entry and a skin broadcast, exactly like the Config page's PUT; secrets go
 * through `Secrets.set()`. A secret is never sent back to the page: the form shows "saved (ending in …xxxx)" and an empty
 * secret field on save means "keep what is there".
 *
 * Reload after a save: the Twitch app keys are read live (Helix and OAuth take a getter, see boot.ts), so saving them
 * needs no restart; the StreamElements adapter reads its JWT when it starts, so boot.ts's `onSetupChange` hook stops
 * and starts it in place. A double-clicked binary has no supervisor to restart it, which is why nothing here exits.
 */
import { randomBytes } from "node:crypto";
import { ConfigError, validateConfig, type Config } from "../../config/schema.ts";
import type { Secrets } from "../../config/secrets.ts";
import type { ConfigStore } from "../../config/store.ts";
import { SeRest, type FetchLike } from "../../ingest/streamelements/rest.ts";
import { KOFI_TOKEN_KEY } from "../../ingest/kofi/webhook.ts";
import type { Ledger } from "../../ledger/ledger.ts";
import { requireCsrf, type AppListener, type Principal } from "../auth.ts";
import type { Health } from "../health.ts";
import { HttpError, errorJson, html, json, notFound, readJson } from "../http-util.ts";
import { CALLBACK_PATH } from "../oauth.ts";
import { h, layout, raw, type Raw } from "./layout.ts";

export const SETUP_PATH = "/setup";
export const SETUP_API_PREFIX = "/api/setup/";
export const TWITCH_APP_KEYS = { id: "TWITCH_CLIENT_ID", secret: "TWITCH_CLIENT_SECRET" } as const;
export const SE_JWT_KEY = "STREAMELEMENTS_JWT";
/** boot.ts's health id for the "Twitch app not set up" banner (a literal here: boot imports this file's neighbors, never the reverse). */
export const TWITCH_APP_HEALTH_ID = "twitch-app";
const BROADCASTER_LINK = "/auth/twitch/broadcaster";
const KOFI_HOOK_PREFIX = "/hooks/kofi/";
const FIREBOT_COMMANDS_PATH = "/api/v1/commands/custom";
const CHECK_TIMEOUT_MS = 5_000;

/** Which part of the service a save touched; boot.ts decides what (if anything) to restart. */
export type SetupArea = "channel" | "twitch" | "streamelements" | "public" | "firebot";

export interface SetupDeps {
  config: ConfigStore;
  secrets: Secrets;
  ledger: Ledger;
  health: Health;
  hub: { skinChanged(): void };
  /** After a successful save: boot.ts restarts the adapter that read the changed secret at start. */
  onSetupChange?: (area: SetupArea) => void;
  /** The two Check buttons' fetch (StreamElements `channels/me`, Firebot's command list); default global fetch. */
  fetchImpl?: FetchLike;
  /** The Ko-fi webhook path when one is first needed; default 16 random bytes, hex. */
  random?: () => string;
}

export interface SetupContext {
  principal: Principal;
  listener: AppListener;
}

type Rec = Record<string, unknown>;
const bad = (message: string) => new HttpError(400, "VALIDATION", message);
const isRecord = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const flag = (v: unknown): boolean => v === true;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Both Twitch app keys present and non-empty. */
export function twitchAppConfigured(secrets: Secrets): boolean {
  return (secrets.get(TWITCH_APP_KEYS.id) ?? "") !== "" && (secrets.get(TWITCH_APP_KEYS.secret) ?? "") !== "";
}

/** `/` on the streamer listener goes to Setup while this is true: no Twitch app yet, or the broadcaster not linked. */
export function setupNeeded(secrets: Secrets, config: Config): boolean {
  return !twitchAppConfigured(secrets) || config.channel.broadcasterId === "";
}

/** "saved (ending in …xxxx)" for a stored secret: the last four characters, never more. */
export function maskSecret(value: string): string {
  return `saved (ending in …${value.slice(-4)})`;
}

/** A pasted channel name as a login: an `@`, a twitch.tv address, upper case and slashes are forgiven. */
export function normalizeLogin(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/^(www\.|m\.)?twitch\.tv\//, "");
  s = s.replace(/^@/, "").replace(/\/+$/, "");
  return s;
}
const LOGIN = /^[a-z0-9_]{3,25}$/;
/** The same paste, case kept, for `channel.displayName` when it is still empty. */
const displayNameOf = (input: string): string =>
  input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^(www\.|m\.)?twitch\.tv\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");

/** `https://host[:port]`, no path, no query, trailing slashes dropped; null when it is not that. */
export function normalizePublicUrl(input: string): string | null {
  const s = input.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") return null;
  return url.origin;
}

/** `http(s)://host[:port]` for Firebot, trailing slashes dropped; null when it is not that. */
function normalizeBaseUrl(input: string): string | null {
  const s = input.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search !== "") return null;
  return url.origin;
}

export function createSetup(deps: SetupDeps) {
  const { config, secrets, ledger, health, hub } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const random = deps.random ?? (() => randomBytes(16).toString("hex"));
  const changed = (area: SetupArea): void => deps.onSetupChange?.(area);

  /** Mutate a copy, validate, write, record: the Config page's PUT in one call. A rule it breaks is the client's 400. */
  const saveConfig = (actor: string, mutate: (c: Config) => void): void => {
    const next = structuredClone(config.get());
    mutate(next);
    try {
      validateConfig(next);
    } catch (e) {
      if (e instanceof ConfigError) throw bad(e.message);
      throw e;
    }
    const diff = config.update(next);
    if (diff.length > 0) {
      ledger.append("config_change", actor, { diff });
      hub.skinChanged();
    }
  };

  const stored = (key: string): string => secrets.get(key) ?? "";

  // -------------------------------------------------------------------------------------------------------------------
  // The page
  // -------------------------------------------------------------------------------------------------------------------

  const copyField = (value: string, label: string): Raw =>
    h`<div class="copy"><input value="${value}" readonly aria-label="${label}" onfocus="this.select()"><button type="button" class="sm" data-copy="${value}">Copy</button></div>`;

  const secretField = (name: string, label: string, key: string, hint: string): Raw => {
    const saved = stored(key);
    return h`<label class="field"><span>${label}${saved === "" ? "" : h` · <em class="ok">${maskSecret(saved)}</em>`}</span><input type="password" name="${name}" autocomplete="off" spellcheck="false" placeholder="${saved === "" ? "Paste it here" : "Paste a new one to replace it, or leave this empty"}"></label><p class="muted small">${hint}</p>`;
  };

  const switchRow = (name: string, on: boolean, label: string, what: string): Raw =>
    h`<label class="row switch"><input type="checkbox" name="${name}" data-toggle="${name}"${on ? raw(" checked") : ""}><span><strong>${label}</strong><br><span class="muted small">${what}</span></span></label>`;

  const progress = (cfg: Config): Raw => {
    const steps: Array<[string, boolean]> = [
      ["Channel", cfg.channel.login !== ""],
      ["Twitch app", twitchAppConfigured(secrets)],
      ["Connect", cfg.channel.broadcasterId !== ""],
    ];
    const done = steps.filter(([, ok]) => ok).length;
    const current = steps.findIndex(([, ok]) => !ok);
    const headline = done === steps.length ? "All set. Twitch is connected." : `Step ${current + 1} of ${steps.length}`;
    return h`<p class="progress-line"><strong>${headline}</strong></p>
<ol class="steps">${steps.map(([label, ok], i) => h`<li class="${ok ? "done" : i === current ? "now" : ""}"><span class="dot">${ok ? "✓" : i + 1}</span>${label}</li>`)}</ol>`;
  };

  const channelSection = (cfg: Config): Raw => h`<section id="channel"><h2>1. Your channel</h2>
<form data-setup="channel" autocomplete="off">
<label class="field"><span>Channel name</span><input name="login" value="${cfg.channel.login}" placeholder="the name in your twitch.tv address" required autocomplete="off" spellcheck="false"></label>
<p class="muted small">The part after twitch.tv/ in your channel's address. Pasting the whole address works too. The overlay uses it to say whose channel this is; connecting Twitch below fills in the rest.</p>
<button type="submit" class="primary">Save</button>
<p class="check-result small" aria-live="polite"></p>
</form>
</section>`;

  const twitchSection = (cfg: Config): Raw => {
    const linked = cfg.channel.broadcasterId !== "";
    const localRedirect = `http://localhost:${cfg.listeners.streamerPort}${CALLBACK_PATH}`;
    const publicRedirect = cfg.funnel.publicUrl === "" ? null : `${cfg.funnel.publicUrl}${CALLBACK_PATH}`;
    return h`<section id="twitch-app"><h2>2. Your Twitch app</h2>
${
  linked
    ? h`<p class="status-live"><strong>Connected</strong> as <strong>@${cfg.channel.login}</strong>. Cheers, subs and gift subs on your channel count toward unlocks.</p>`
    : h`<p>The overlay talks to Twitch through an app that belongs to you. Making one takes about two minutes and is free. Follow the steps in order.</p>`
}
<details class="byhand"${linked ? "" : raw(" open")}><summary>How to make the app</summary>
<ol class="howto">
<li>Twitch only lets accounts with two-factor authentication make apps. If yours does not have it yet, turn it on first: <a href="https://www.twitch.tv/settings/security" target="_blank" rel="noopener">twitch.tv/settings/security</a>, under Two-Factor Authentication.</li>
<li>Open <a href="https://dev.twitch.tv/console/apps/create" target="_blank" rel="noopener">dev.twitch.tv/console/apps/create</a> and sign in with your Twitch account. Click <strong>Register Your Application</strong> if the form is not already open.</li>
<li><strong>Name:</strong> anything you like, such as "party overlay". Names are unique across Twitch, so add your channel name if yours is taken.</li>
<li><strong>OAuth Redirect URLs:</strong> paste this exactly, then click Add.${copyField(localRedirect, "Redirect URL")}${
      publicRedirect === null ? "" : h`<p class="small">Mod access is on, so add this second one too:</p>${copyField(publicRedirect, "Public redirect URL")}`
    }</li>
<li><strong>Category:</strong> Broadcaster Suite. <strong>Client Type:</strong> Confidential.</li>
<li>Click <strong>Create</strong>. Back on the list, click <strong>Manage</strong> next to your new app.</li>
<li>Copy the <strong>Client ID</strong> into the first field below. Then click <strong>New Secret</strong>, confirm, and copy the <strong>Client Secret</strong> into the second field. Twitch shows a secret only once, so if you lose it, make a new one the same way.</li>
<li>Press <strong>Connect Twitch</strong>. Twitch asks you to let the overlay see your bits, subs, moderator list and chat. Approve it and you come back here.</li>
</ol>
</details>
<form data-setup="twitch-app" autocomplete="off">
<label class="field"><span>Client ID</span><input name="clientId" value="${stored(TWITCH_APP_KEYS.id)}" autocomplete="off" spellcheck="false" placeholder="about 30 letters and numbers" required></label>
${secretField("clientSecret", "Client Secret", TWITCH_APP_KEYS.secret, "From Manage, New Secret. It is stored in your secrets file on this computer and never shown again here.")}
<div class="actions">${
      linked
        ? h`<button type="submit" class="primary">Save</button><button type="submit" data-connect="1">Connect again</button>`
        : h`<button type="submit" class="primary" data-connect="1">Connect Twitch</button>`
    }</div>
<p class="muted small">${linked ? "Connect again if you made a new app or Twitch stops hearing chat." : "Saves both values, then sends you to Twitch to approve the overlay."}</p>
<p class="check-result small" aria-live="polite"></p>
</form>
</section>`;
  };

  const streamElementsSection = (cfg: Config): Raw => {
    const on = cfg.ingest.streamelements.enabled;
    return h`<section id="streamelements" class="optional"><h2>Optional: StreamElements tips</h2>
<form data-setup="streamelements" autocomplete="off">
${switchRow("streamelements", on, "Count tips from StreamElements", "Tips sent through your StreamElements tip page, PayPal ones included, count toward unlocks the moment they land, and any the overlay missed are caught up.")}
<div data-toggled="streamelements"${on ? "" : raw(" hidden")}>
<ol class="howto">
<li>Open <a href="https://streamelements.com/dashboard/account/channels" target="_blank" rel="noopener">streamelements.com/dashboard/account/channels</a> and sign in.</li>
<li>On the <strong>Channels</strong> tab click <strong>Show secrets</strong>.</li>
<li>Copy the <strong>JWT Token</strong>, the long one, and paste it below. Press Check to make sure it works, then Save.</li>
</ol>
${secretField("jwt", "JWT Token", SE_JWT_KEY, "This token is your StreamElements login. Keep it to yourself, like a password.")}
<div class="actions"><button type="button" data-check="streamelements">Check</button><button type="submit" class="primary">Save</button></div>
<p class="check-result small" aria-live="polite"></p>
</div>
${on ? "" : h`<div class="actions" data-untoggled="streamelements"><button type="submit" class="primary">Save</button></div>`}
</form>
</section>`;
  };

  const publicSection = (cfg: Config): Raw => {
    const url = cfg.funnel.publicUrl;
    const modAccess = url !== "";
    const kofi = cfg.ingest.kofi.enabled;
    const any = modAccess || kofi;
    const funnelPort = cfg.listeners.funnelPort;
    const webhookUrl = url === "" || cfg.ingest.kofi.webhookPath === "" ? null : `${url}${KOFI_HOOK_PREFIX}${cfg.ingest.kofi.webhookPath}`;
    return h`<section id="public" class="optional"><h2>Optional: mods on other computers, and Ko-fi</h2>
<p class="muted small">Both of these need this computer to have a public address on the internet, which it normally does not. This part is for the technically comfortable. Skip it and everything else still works.</p>
<form data-setup="public" autocomplete="off">
${switchRow("modAccess", modAccess, "Let my mods use the Dashboard from their own computers", "Mods open your public address, sign in with Twitch, and get the Dashboard with Fire, credits, voids and the pool. Only people on your channel's moderator list get in.")}
${switchRow("kofi", kofi, "Count Ko-fi donations", "Ko-fi sends each donation to your public address and it counts toward unlocks like a tip.")}
<div data-toggled="modAccess kofi"${any ? "" : raw(" hidden")}>
<h3>Your public address</h3>
<p class="small">A <strong>tunnel</strong> gives this computer a public https address and passes visitors through to it. Tailscale Funnel is the free one these steps use; any tunnel that gives you an https address and points it at port ${funnelPort} on this computer works the same way.</p>
<ol class="howto">
<li>Install Tailscale from <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a> on this computer and sign in.</li>
<li>Open a terminal (Terminal on a Mac, PowerShell on Windows) and run <code>tailscale funnel --bg ${funnelPort}</code>. On a Mac with the Tailscale app, the command is <code>/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg ${funnelPort}</code>. The first time, it prints a link to turn Funnel on for this machine; open it and come back.</li>
<li>Run <code>tailscale funnel status</code>. It prints your address, which looks like <code>https://laptop.tail1234.ts.net</code>. Paste it below.</li>
</ol>
<label class="field"><span>Public address</span><input name="publicUrl" value="${url}" placeholder="https://laptop.tail1234.ts.net" autocomplete="off" spellcheck="false" inputmode="url"></label>
<p class="muted small">Must start with https:// and have nothing after the name. Run the funnel command again whenever this computer restarts; <code>tailscale funnel --https=443 off</code> takes it down after the night.</p>
<div data-toggled="modAccess"${modAccess ? "" : raw(" hidden")}>
<h3>Mods</h3>
${
  url === ""
    ? h`<p class="small">Save the address first. The second redirect URL for your Twitch app appears here.</p>`
    : h`<p class="small">Add this second redirect URL to your Twitch app (Manage, OAuth Redirect URLs, Add), or mods cannot sign in:</p>${copyField(`${url}${CALLBACK_PATH}`, "Public redirect URL")}<p class="small">Then send your mods the address <code>${url}</code> and tell them to read the Help page.</p>`
}
</div>
<div data-toggled="kofi"${kofi ? "" : raw(" hidden")}>
<h3>Ko-fi</h3>
<ol class="howto">
<li>Open <a href="https://ko-fi.com/manage/webhooks" target="_blank" rel="noopener">ko-fi.com/manage/webhooks</a>.</li>
<li><strong>Webhook URL:</strong> ${webhookUrl === null ? h`save the address with the Ko-fi switch on first. The exact URL to paste appears here.` : h`paste this exactly.${copyField(webhookUrl, "Ko-fi webhook URL")}`}</li>
<li>Click <strong>Update</strong>. Then expand <strong>Advanced</strong> and copy the <strong>Verification Token</strong> into the field below.</li>
<li>Later, with the overlay running, press Ko-fi's <strong>Send Test</strong> button on that page. The test shows up on the Ledger page.</li>
</ol>
${secretField("kofiToken", "Verification Token", KOFI_TOKEN_KEY, "Ko-fi sends it with every donation so nobody else can pretend to be Ko-fi.")}
</div>
<div class="actions"><button type="submit" class="primary">Save</button></div>
</div>
${any ? "" : h`<div class="actions" data-untoggled="modAccess kofi"><button type="submit" class="primary">Save</button></div>`}
<p class="check-result small" aria-live="polite"></p>
</form>
</section>`;
  };

  const firebotSection = (cfg: Config): Raw => {
    const on = cfg.firebot.enabled;
    return h`<section id="firebot" class="optional"><h2>Optional: Firebot giveaways</h2>
<form data-setup="firebot" autocomplete="off">
${switchRow("firebot", on, "Run giveaways through Firebot", `When a giveaway comes up, the overlay has Firebot open a chat raffle (viewers type ${cfg.firebot.commandTrigger} enter), names the prize, and closes and draws the winner from the Giveaways page.`)}
<div data-toggled="firebot"${on ? "" : raw(" hidden")}>
<ol class="howto">
<li>Install and open <a href="https://firebot.app" target="_blank" rel="noopener">Firebot</a> on this computer and sign in with your Twitch account.</li>
<li>Download <strong>giveaway.firebotsetup</strong> from <a href="https://github.com/CaveMobster/firebot-setup-giveaway-command/releases/latest" target="_blank" rel="noopener">CaveMobster's giveaway command</a>.</li>
<li>In Firebot: <strong>Settings</strong>, <strong>Setups</strong>, <strong>Import Setup</strong>, pick that file. It asks one question, the message for a plain ${cfg.firebot.commandTrigger}; anything like "Giveaways run during unlocks, watch the overlay!" is fine.</li>
<li>In Firebot's <strong>Settings</strong>, <strong>Advanced</strong>, make sure the local API is on. Then press Check below.</li>
</ol>
<label class="field"><span>Firebot address</span><input name="baseUrl" value="${cfg.firebot.baseUrl}" placeholder="http://127.0.0.1:7472" autocomplete="off" spellcheck="false" inputmode="url"></label>
<p class="muted small">Where Firebot answers on this computer. Leave it alone unless Firebot runs on another machine. Under Docker it is <code>http://host.docker.internal:7472</code>.</p>
<div class="actions"><button type="button" data-check="firebot">Check</button><button type="submit" class="primary">Save</button></div>
<p class="check-result small" aria-live="polite"></p>
</div>
${on ? "" : h`<div class="actions" data-untoggled="firebot"><button type="submit" class="primary">Save</button></div>`}
</form>
</section>`;
  };

  const tryItSection = (): Raw => h`<section id="try-it"><h2>Last step: see it work</h2>
<p>Add the overlay to OBS from the <a href="/config">Config page</a>, which lists the address to paste into a Browser source. Then open the Debug page and press a Credits button, say <strong>100 bits</strong>. A fake cheer lands on the overlay in OBS, and on the Ledger page. Void it there afterwards if you like.</p>
<p><a class="btn primary" href="/debug">Open the Debug page</a></p>
</section>`;

  const body = (cfg: Config): Raw => h`<section id="setup"><h1>Setup</h1>
<p class="muted">Three steps connect the overlay to your Twitch channel. Everything after that is optional and off until you turn it on. Come back any time from the Config page.</p>
${progress(cfg)}
</section>
${channelSection(cfg)}
${twitchSection(cfg)}
${streamElementsSection(cfg)}
${publicSection(cfg)}
${firebotSection(cfg)}
${tryItSection()}`;

  const page = (_req: Request, ctx: SetupContext): Response => {
    if (ctx.listener !== "streamer") return notFound(); // the funnel never shows it, whoever is asking
    if (ctx.principal.role !== "streamer") return html(layout({ title: "Streamer only", active: "setup", principal: ctx.principal, listener: ctx.listener, body: h`<section><h1>Streamer only</h1></section>` }), 403);
    return html(layout({ title: "Setup", active: "setup", principal: ctx.principal, listener: ctx.listener, body: body(config.get()), mainClass: "setup" }));
  };

  // -------------------------------------------------------------------------------------------------------------------
  // The API: POST /api/setup/<section>
  // -------------------------------------------------------------------------------------------------------------------

  const bodyOf = async (req: Request): Promise<Rec> => {
    const v = await readJson(req);
    if (!isRecord(v)) throw bad("body must be a JSON object");
    return v;
  };

  const handlers: Record<string, (b: Rec, actor: string) => Promise<Response> | Response> = {
    channel(b, actor) {
      const login = normalizeLogin(text(b.login));
      if (!LOGIN.test(login)) throw bad("Channel name: use the name from your twitch.tv address. Letters, numbers and underscores only, 3 to 25 of them.");
      saveConfig(actor, (c) => {
        c.channel.login = login;
        if (c.channel.displayName === "") c.channel.displayName = displayNameOf(text(b.login)); // the overlay's "whose channel" line, in the case they typed
      });
      changed("channel");
      return json({ ok: true });
    },

    "twitch-app"(b) {
      const clientId = text(b.clientId);
      const clientSecret = text(b.clientSecret);
      if (clientId === "" || /\s/.test(clientId)) throw bad("Client ID: paste the Client ID from your Twitch app's Manage page. It has no spaces.");
      if (clientSecret === "" && stored(TWITCH_APP_KEYS.secret) === "") throw bad("Client Secret: click New Secret on your Twitch app's Manage page and paste what it shows.");
      if (/\s/.test(clientSecret)) throw bad("Client Secret: it has no spaces. Copy it again.");
      secrets.set(TWITCH_APP_KEYS.id, clientId);
      if (clientSecret !== "") secrets.set(TWITCH_APP_KEYS.secret, clientSecret);
      health.clear(TWITCH_APP_HEALTH_ID);
      changed("twitch");
      const connect = flag(b.connect) || config.get().channel.broadcasterId === "";
      return json(connect ? { ok: true, next: BROADCASTER_LINK } : { ok: true });
    },

    streamelements(b, actor) {
      const enabled = flag(b.enabled);
      const jwt = text(b.jwt);
      if (/\s/.test(jwt)) throw bad("JWT Token: it has no spaces or line breaks. Copy it again.");
      if (enabled && jwt === "" && stored(SE_JWT_KEY) === "") throw bad("JWT Token: paste the token from StreamElements, Channels tab, Show secrets.");
      if (jwt !== "") secrets.set(SE_JWT_KEY, jwt);
      saveConfig(actor, (c) => void (c.ingest.streamelements.enabled = enabled));
      changed("streamelements");
      return json({ ok: true });
    },

    async "streamelements/check"(b) {
      const jwt = text(b.jwt) !== "" ? text(b.jwt) : stored(SE_JWT_KEY);
      if (jwt === "") throw bad("JWT Token: paste the token first, then Check.");
      try {
        const me = await new SeRest({ jwt, fetchImpl, log: () => {} }).me();
        return json({ ok: true, username: me.username });
      } catch (e) {
        return errorJson(502, "STREAMELEMENTS", `StreamElements did not accept that token (${errorText(e)}). Copy the JWT Token again from streamelements.com, Channels tab, Show secrets.`);
      }
    },

    public(b, actor) {
      const modAccess = flag(b.modAccess);
      const kofi = flag(b.kofi);
      const kofiToken = text(b.kofiToken);
      let publicUrl = "";
      if (modAccess || kofi) {
        const given = text(b.publicUrl);
        if (given === "") throw bad("Public address: paste the https address Tailscale printed, such as https://laptop.tail1234.ts.net.");
        const normalized = normalizePublicUrl(given);
        if (normalized === null) throw bad("Public address: it must start with https:// and have nothing after the name, such as https://laptop.tail1234.ts.net.");
        publicUrl = normalized;
      }
      if (/\s/.test(kofiToken)) throw bad("Verification Token: it has no spaces. Copy it again.");
      if (kofi && kofiToken === "" && stored(KOFI_TOKEN_KEY) === "") throw bad("Verification Token: copy it from ko-fi.com/manage/webhooks under Advanced.");
      if (kofiToken !== "") secrets.set(KOFI_TOKEN_KEY, kofiToken);
      saveConfig(actor, (c) => {
        c.funnel.publicUrl = publicUrl;
        c.ingest.kofi.enabled = kofi;
        if (kofi && c.ingest.kofi.webhookPath === "") c.ingest.kofi.webhookPath = random();
      });
      changed("public");
      return json({ ok: true });
    },

    firebot(b, actor) {
      const enabled = flag(b.enabled);
      const baseUrl = normalizeBaseUrl(text(b.baseUrl));
      if (baseUrl === null) throw bad("Firebot address: it looks like http://127.0.0.1:7472, with nothing after the port.");
      saveConfig(actor, (c) => {
        c.firebot.enabled = enabled;
        c.firebot.baseUrl = baseUrl;
      });
      changed("firebot");
      return json({ ok: true });
    },

    async "firebot/check"(b) {
      const baseUrl = normalizeBaseUrl(text(b.baseUrl));
      if (baseUrl === null) throw bad("Firebot address: it looks like http://127.0.0.1:7472, with nothing after the port.");
      const trigger = config.get().firebot.commandTrigger;
      let commands: unknown;
      try {
        const res = await fetchImpl(`${baseUrl}${FIREBOT_COMMANDS_PATH}`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`answered ${res.status}`);
        commands = await res.json();
      } catch (e) {
        return errorJson(502, "FIREBOT", `Firebot did not answer at ${baseUrl} (${errorText(e)}). Is Firebot open, with its local API turned on under Settings, Advanced?`);
      }
      const found = Array.isArray(commands) && (commands as Array<{ trigger?: unknown }>).some((c) => c.trigger === trigger);
      return json({ ok: true, command: found, message: found ? `Firebot answered and the ${trigger} command is there.` : `Firebot answered, but it has no ${trigger} command yet. Import giveaway.firebotsetup (step 3), then Check again.` });
    },
  };

  const api = async (req: Request, ctx: SetupContext): Promise<Response> => {
    const csrf = requireCsrf(req);
    if (csrf !== null) return csrf;
    // The overlay computer only, like Shut down and the broadcaster link: the broadcaster's own funnel session is role streamer too.
    if (ctx.listener !== "streamer" || ctx.principal.role !== "streamer") return errorJson(403, "FORBIDDEN", "set up from the overlay computer's own Dashboard only");
    const name = new URL(req.url).pathname.slice(SETUP_API_PREFIX.length);
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
    if (handler === undefined || req.method.toUpperCase() !== "POST") return notFound();
    return handler(await bodyOf(req), ctx.principal.actor);
  };

  return { page, api };
}
