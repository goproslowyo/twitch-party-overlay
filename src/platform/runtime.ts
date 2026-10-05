/**
 * What differs between "bun src/main.ts" on a developer's computer, the double-clicked download on a streamer's computer, and the
 * Docker image — as pure functions, so main.ts stays a thin wiring layer and every rule here is unit-tested.
 *
 *   isCompiled          `bun build --compile` output vs. the bun runtime (process.execPath is the only reliable tell)
 *   resolveDataDir      DATA_DIR, else <folder beside the binary>/data when compiled, else ./data from the working directory
 *   openBrowserCommand  the per-OS "open this URL in the default browser" argv
 *   keepAwakeCommand    the per-OS "do not sleep while pid <n> lives" argv, or null when the OS has nothing we can use
 *   shouldOpenBrowser   only the double-clicked binary opens a browser: never from source, never in Docker, never with NO_OPEN=1
 */
import path from "node:path";

export type Platform = NodeJS.Platform;

export interface Runtime {
  platform: Platform;
  execPath: string;
  cwd: string;
}

export function currentRuntime(): Runtime {
  return { platform: process.platform, execPath: process.execPath, cwd: process.cwd() };
}

/** True when this process is a `bun build --compile` binary. The bun runtime itself is `bun` or `bun.exe` (the npm install on macOS is also named bun.exe). */
export function isCompiled(execPath: string): boolean {
  const base = path.basename(execPath.replaceAll("\\", "/")).toLowerCase();
  return base !== "bun" && base !== "bun.exe";
}

/** Where config.json, ledger.sqlite and the default secrets.env live. Absolute, so the log line is useful wherever the process was started from. */
export function resolveDataDir(env: Record<string, string | undefined>, rt: Runtime): string {
  if (env.DATA_DIR) return env.DATA_DIR;
  const p = rt.platform === "win32" ? path.win32 : path.posix;
  if (isCompiled(rt.execPath)) return p.join(p.dirname(rt.execPath), "data");
  return p.join(rt.cwd, "data");
}

export function dashboardUrl(streamerPort: number): string {
  return `http://localhost:${streamerPort}/`;
}

export function openBrowserCommand(platform: Platform, url: string): string[] {
  switch (platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      // `start` takes its first quoted argument as the window title; the empty title keeps the URL from being read as one.
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url];
  }
}

/**
 * Keeps the machine (and on macOS / Windows the display) awake for as long as our pid lives, so the child needs no cleanup
 * if we die hard: caffeinate's -w, PowerShell's Get-Process loop and GNU tail's --pid all end on their own.
 *
 * Windows: SetThreadExecutionState is per-thread and per-process, so a child must hold it, and PowerShell with Add-Type is
 * the only thing every Windows 10/11 ships that can call it without a native module. -EncodedCommand carries the script
 * as UTF-16LE base64, so no quoting survives to the command line; -WindowStyle Hidden keeps a console from flashing.
 */
export function keepAwakeCommand(platform: Platform, pid: number, has: (command: string) => boolean): string[] | null {
  switch (platform) {
    case "darwin":
      return ["caffeinate", "-dis", "-w", String(pid)];
    case "win32": {
      const script = [
        `Add-Type -Namespace TwitchPartyOverlay -Name Awake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'`,
        // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
        `[TwitchPartyOverlay.Awake]::SetThreadExecutionState(0x80000003) | Out-Null`,
        `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 15 }`,
      ].join("; ");
      return ["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    }
    case "linux":
      if (!has("systemd-inhibit")) return null;
      return ["systemd-inhibit", "--what=idle:sleep", "--who=twitch-party-overlay", "--why=stream overlay running", "tail", `--pid=${pid}`, "-f", "/dev/null"];
    default:
      return null;
  }
}

/** The Dockerfile sets IN_DOCKER=1; /.dockerenv covers an image built some other way. */
export function inDocker(env: Record<string, string | undefined>, exists: (p: string) => boolean): boolean {
  return env.IN_DOCKER === "1" || exists("/.dockerenv");
}

export function shouldOpenBrowser(env: Record<string, string | undefined>, where: { compiled: boolean; docker: boolean }): boolean {
  return where.compiled && !where.docker && env.NO_OPEN !== "1";
}
