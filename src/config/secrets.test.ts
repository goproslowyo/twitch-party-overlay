import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Secrets, secretsPathFromEnv } from "./secrets.ts";

function tmpSecretsPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tpo-secrets-"));
  return path.join(dir, "secrets.env");
}

test("missing file reads as empty; set then get round-trips and reload reads from disk", () => {
  const p = tmpSecretsPath();
  const s = new Secrets(p);
  expect(s.get("SESSION_SECRET")).toBeUndefined();
  s.set("SESSION_SECRET", "abc123");
  s.set("TWITCH_CLIENT_ID", "cid");
  expect(s.get("SESSION_SECRET")).toBe("abc123");
  expect(fs.readFileSync(p, "utf8")).toBe("SESSION_SECRET=abc123\nTWITCH_CLIENT_ID=cid\n");

  const fresh = new Secrets(p);
  expect(fresh.get("TWITCH_CLIENT_ID")).toBe("cid");

  fs.writeFileSync(p, "SESSION_SECRET=changed-outside\n");
  expect(s.get("SESSION_SECRET")).toBe("abc123");
  s.reload();
  expect(s.get("SESSION_SECRET")).toBe("changed-outside");
  expect(s.get("TWITCH_CLIENT_ID")).toBeUndefined();
});

test("file mode is 0o600 after every write, even when it was looser before", () => {
  const p = tmpSecretsPath();
  fs.writeFileSync(p, "A=1\n", { mode: 0o644 });
  const s = new Secrets(p);
  s.set("B", "2");
  expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  s.set("A", "3");
  expect(fs.statSync(p).mode & 0o777).toBe(0o600);
});

test("comments and unknown lines survive a set; existing keys are updated in place", () => {
  const p = tmpSecretsPath();
  fs.writeFileSync(p, "# twitch app\nWEIRD LINE\nTWITCH_CLIENT_ID = old \n\nSTREAMELEMENTS_JWT=jwt\n");
  const s = new Secrets(p);
  expect(s.get("TWITCH_CLIENT_ID")).toBe("old");
  s.set("TWITCH_CLIENT_ID", "new");
  s.set("KOFI_VERIFICATION_TOKEN", "tok");
  expect(fs.readFileSync(p, "utf8")).toBe(
    "# twitch app\nWEIRD LINE\nTWITCH_CLIENT_ID=new\n\nSTREAMELEMENTS_JWT=jwt\nKOFI_VERIFICATION_TOKEN=tok\n",
  );
  expect(new Secrets(p).get("KOFI_VERIFICATION_TOKEN")).toBe("tok");
});

test("set creates the parent directory and rejects keys/values that would corrupt the file", () => {
  const p = path.join(tmpSecretsPath(), "nested", "secrets.env");
  const s = new Secrets(p);
  s.set("SESSION_SECRET", "x");
  expect(fs.readFileSync(p, "utf8")).toBe("SESSION_SECRET=x\n");
  expect(() => s.set("bad key", "x")).toThrow(/key/i);
  expect(() => s.set("OK", "line1\nline2")).toThrow(/newline/i);
});

test("secretsPathFromEnv: $SECRETS_FILE, else $DATA_DIR/secrets.env, else ./data/secrets.env", () => {
  expect(secretsPathFromEnv({ SECRETS_FILE: "/etc/tpo/secrets.env", DATA_DIR: "/var/tpo" })).toBe("/etc/tpo/secrets.env");
  expect(secretsPathFromEnv({ DATA_DIR: "/var/tpo" })).toBe("/var/tpo/secrets.env");
  expect(secretsPathFromEnv({})).toBe(path.join("data", "secrets.env"));
});

test("leftover Room lights keys (haToken, goveeApiKey) in a secrets file are read like any other line and otherwise ignored", () => {
  const p = tmpSecretsPath();
  fs.writeFileSync(p, "TWITCH_CLIENT_ID=cid\nhaToken=fake-ha-token\ngoveeApiKey=fake-govee-key\n");
  const s = new Secrets(p);
  expect(s.get("TWITCH_CLIENT_ID")).toBe("cid");
  s.set("SESSION_SECRET", "abc");
  expect(fs.readFileSync(p, "utf8")).toBe("TWITCH_CLIENT_ID=cid\nhaToken=fake-ha-token\ngoveeApiKey=fake-govee-key\nSESSION_SECRET=abc\n");
});
