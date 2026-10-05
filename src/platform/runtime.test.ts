import { test, expect } from "bun:test";
import path from "node:path";
import { dashboardUrl, inDocker, isCompiled, keepAwakeCommand, openBrowserCommand, resolveDataDir, shouldOpenBrowser } from "./runtime.ts";

test("isCompiled: the bun runtime itself (any path, with or without .exe, any case) is source mode; anything else is a compiled binary", () => {
  expect(isCompiled("/Users/me/.bun/bin/bun")).toBe(false);
  expect(isCompiled("/usr/local/lib/node_modules/bun/bin/bun.exe")).toBe(false); // the npm-installed bun on macOS is named bun.exe
  expect(isCompiled("C:\\Users\\me\\.bun\\bin\\bun.exe")).toBe(false);
  expect(isCompiled("C:\\Users\\me\\.bun\\bin\\BUN.EXE")).toBe(false);
  expect(isCompiled("/Users/me/Downloads/twitch-party-overlay-macos-apple-silicon")).toBe(true);
  expect(isCompiled("C:\\Users\\me\\Downloads\\twitch-party-overlay-windows.exe")).toBe(true);
  expect(isCompiled("/twitch-party-overlay")).toBe(true); // the Docker image
});

test("resolveDataDir: DATA_DIR wins; a compiled binary uses <its folder>/data; source mode keeps ./data under the working directory", () => {
  const compiled = { platform: "darwin" as const, execPath: "/Users/me/Downloads/twitch-party-overlay-macos-apple-silicon", cwd: "/Users/me" };
  const source = { platform: "darwin" as const, execPath: "/Users/me/.bun/bin/bun", cwd: "/Users/me/repos/overlay" };
  expect(resolveDataDir({ DATA_DIR: "/data" }, compiled)).toBe("/data");
  expect(resolveDataDir({ DATA_DIR: "/data" }, source)).toBe("/data");
  expect(resolveDataDir({}, compiled)).toBe(path.join("/Users/me/Downloads", "data"));
  expect(resolveDataDir({}, source)).toBe(path.join("/Users/me/repos/overlay", "data"));
  expect(resolveDataDir({ DATA_DIR: "" }, source)).toBe(path.join("/Users/me/repos/overlay", "data")); // empty counts as unset, as before
});

test("resolveDataDir: a Windows binary gets the folder beside the .exe, with the drive kept", () => {
  const rt = { platform: "win32" as const, execPath: "C:\\Users\\me\\Downloads\\twitch-party-overlay-windows.exe", cwd: "C:\\Users\\me" };
  expect(resolveDataDir({}, rt)).toBe(path.win32.join("C:\\Users\\me\\Downloads", "data"));
});

test("dashboardUrl: localhost on the streamer port with the trailing slash", () => {
  expect(dashboardUrl(8700)).toBe("http://localhost:8700/");
  expect(dashboardUrl(51234)).toBe("http://localhost:51234/");
});

test("openBrowserCommand: open on macOS, cmd start with an empty title on Windows (the URL is not read as the title), xdg-open elsewhere", () => {
  const url = "http://localhost:8700/";
  expect(openBrowserCommand("darwin", url)).toEqual(["open", url]);
  expect(openBrowserCommand("win32", url)).toEqual(["cmd", "/c", "start", "", url]);
  expect(openBrowserCommand("linux", url)).toEqual(["xdg-open", url]);
  expect(openBrowserCommand("freebsd", url)).toEqual(["xdg-open", url]);
});

test("keepAwakeCommand: macOS caffeinate tied to our pid; Windows a hidden PowerShell holding SetThreadExecutionState while our pid lives (encoded, so no quoting); Linux systemd-inhibit around a wait on our pid, or nothing without systemd-inhibit", () => {
  expect(keepAwakeCommand("darwin", 4242, () => true)).toEqual(["caffeinate", "-dis", "-w", "4242"]);

  const win = keepAwakeCommand("win32", 4242, () => true)!;
  expect(win.slice(0, 5)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden"]);
  expect(win[5]).toBe("-EncodedCommand");
  const script = Buffer.from(win[6]!, "base64").toString("utf16le");
  expect(script).toContain("SetThreadExecutionState");
  expect(script).toContain("0x80000003"); // ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
  expect(script).toContain("Get-Process -Id 4242");

  const seen: string[] = [];
  expect(keepAwakeCommand("linux", 4242, (cmd) => (seen.push(cmd), true))).toEqual(["systemd-inhibit", "--what=idle:sleep", "--who=twitch-party-overlay", "--why=stream overlay running", "tail", "--pid=4242", "-f", "/dev/null"]);
  expect(seen).toEqual(["systemd-inhibit"]);
  expect(keepAwakeCommand("linux", 4242, () => false)).toBeNull();
  expect(keepAwakeCommand("freebsd", 4242, () => true)).toBeNull();
});

test("inDocker: the IN_DOCKER flag or a /.dockerenv file", () => {
  expect(inDocker({ IN_DOCKER: "1" }, () => false)).toBe(true);
  expect(inDocker({}, (p) => p === "/.dockerenv")).toBe(true);
  expect(inDocker({}, () => false)).toBe(false);
  expect(inDocker({ IN_DOCKER: "0" }, () => false)).toBe(false);
});

test("shouldOpenBrowser: only a compiled binary outside Docker without NO_OPEN=1", () => {
  expect(shouldOpenBrowser({}, { compiled: true, docker: false })).toBe(true);
  expect(shouldOpenBrowser({ NO_OPEN: "1" }, { compiled: true, docker: false })).toBe(false);
  expect(shouldOpenBrowser({ NO_OPEN: "0" }, { compiled: true, docker: false })).toBe(true);
  expect(shouldOpenBrowser({}, { compiled: false, docker: false })).toBe(false);
  expect(shouldOpenBrowser({}, { compiled: true, docker: true })).toBe(false);
});
