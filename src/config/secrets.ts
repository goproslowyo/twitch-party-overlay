/**
 * Secrets file: `KEY=VALUE` lines, `#` comments, no quoting. Mode 0600 whenever the service writes it.
 *
 * Keys the service uses:
 *   TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET,
 *   TWITCH_BROADCASTER_ACCESS_TOKEN, TWITCH_BROADCASTER_REFRESH_TOKEN, TWITCH_BROADCASTER_EXPIRES_AT (ISO),
 *   STREAMELEMENTS_JWT, KOFI_VERIFICATION_TOKEN, SESSION_SECRET,
 *   CHANNEL_LOGIN, FUNNEL_PUBLIC_URL, KOFI_WEBHOOK_PATH   (wizard identity values, seeded into config.json once)
 *
 * Any other key in the file is kept as written and never read (a `haToken` or `goveeApiKey` line left over from the
 * Room lights feature, removed since, is harmless).
 */
import fs from "node:fs";
import path from "node:path";

/** `$SECRETS_FILE`, else `$DATA_DIR/secrets.env` (DATA_DIR defaults to `./data`). */
export function secretsPathFromEnv(env: Record<string, string | undefined> = process.env): string {
  return env.SECRETS_FILE || path.join(env.DATA_DIR || "data", "secrets.env");
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseLine(line: string): { key: string; value: string } | null {
  const t = line.trim();
  if (t === "" || t.startsWith("#")) return null;
  const eq = t.indexOf("=");
  if (eq === -1) return null;
  const key = t.slice(0, eq).trim();
  if (!KEY.test(key)) return null;
  return { key, value: t.slice(eq + 1).trim() };
}

export class Secrets {
  readonly #path: string;
  #lines: string[] = [];
  #values = new Map<string, string>();

  constructor(filePath: string) {
    this.#path = filePath;
    this.reload();
  }

  get(key: string): string | undefined {
    return this.#values.get(key);
  }

  /** Upsert in place (comments and unknown lines untouched), write, chmod 0600. */
  set(key: string, value: string): void {
    if (!KEY.test(key)) throw new TypeError(`Secrets.set: invalid key ${JSON.stringify(key)}`);
    if (/[\r\n]/.test(value)) throw new TypeError(`Secrets.set: value for ${key} must not contain a newline`);
    const entry = `${key}=${value}`;
    const idx = this.#lines.findLastIndex((line) => parseLine(line)?.key === key);
    if (idx === -1) this.#lines.push(entry);
    else this.#lines[idx] = entry;
    this.#values.set(key, value);
    this.#write();
  }

  /** Re-read the file from disk; a missing file reads as empty. */
  reload(): void {
    let text = "";
    try {
      text = fs.readFileSync(this.#path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.#lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
    this.#values = new Map();
    for (const line of this.#lines) {
      const kv = parseLine(line);
      if (kv) this.#values.set(kv.key, kv.value); // last occurrence wins, matching set()'s findLastIndex
    }
  }

  #write(): void {
    fs.mkdirSync(path.dirname(this.#path), { recursive: true });
    fs.writeFileSync(this.#path, this.#lines.map((l) => `${l}\n`).join(""), { mode: 0o600 });
    fs.chmodSync(this.#path, 0o600); // mode above only applies on create; enforce on every write
  }
}
