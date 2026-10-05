/**
 * The `http://…:<overlayPort>/overlay` list the Config page prints and `/api/state` returns — what you paste into OBS
 * as a Browser source.
 *
 * `http://localhost:<port>/overlay` is always first: most streamers run OBS on the same computer, and the overlay
 * listener binds 127.0.0.1 by default. The network addresses follow only when `listeners.overlayOnLan` is on
 * (the Config page's "OBS runs on another computer"), and there are two situations because the service may run in a
 * container:
 *
 *  - On the machine itself (the bare binary from `just build`): every non-internal IPv4 the machine has. One of them is
 *    the address the OBS PC needs, and we cannot tell which, so we list them all.
 *  - In Docker: a container cannot see the NICs of the machine it runs on. All it has is its own bridge address, which
 *    on macOS is not reachable from the machine OR the LAN, so printing it sends people to a dead link. `just up` looks
 *    the machine's address up on the host and passes it in as HOST_LAN_IP; when that is set it is the only LAN answer
 *    worth giving, so it replaces the list rather than joining it.
 */
import os from "node:os";

/** A dotted-quad whose octets are all 0..255. `0.0.0.0` and loopback are rejected separately: neither reaches the OBS PC. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The trimmed address, or undefined when it is blank, malformed, or an address no other machine can reach. */
export function usableHostIp(raw: string | undefined): string | undefined {
  const ip = (raw ?? "").trim();
  const m = IPV4.exec(ip);
  if (m === null) return undefined;
  if (m.slice(1).some((octet) => Number(octet) > 255)) return undefined;
  if (ip === "0.0.0.0" || m[1] === "127") return undefined;
  return ip;
}

export interface OverlayUrlDeps {
  /** `config.listeners.overlayPort` — the published port, not a hard-coded 8702. */
  overlayPort: number;
  /** `config.listeners.overlayOnLan`: OBS runs on another computer, so the network addresses are wanted too. */
  overlayOnLan: boolean;
  /** Default `os.networkInterfaces`; injected in tests. */
  networkInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** `$HOST_LAN_IP`: this computer's own LAN address, looked up on the host by `just up`. Absent outside Docker. */
  hostLanIp?: string;
}

/** The localhost URL that OBS on this computer uses; always the first entry of `overlayUrls`. */
export function localOverlayUrl(overlayPort: number): string {
  return `http://localhost:${overlayPort}/overlay`;
}

/**
 * The localhost URL, then (only with `overlayOnLan`) the LAN ones: the host's address when it is known, otherwise one
 * per non-internal IPv4 this machine has. Index 0 is always localhost, so callers may split the list there.
 */
export function overlayUrls(deps: OverlayUrlDeps): string[] {
  const url = (address: string): string => `http://${address}:${deps.overlayPort}/overlay`;
  const urls = [localOverlayUrl(deps.overlayPort)];
  if (!deps.overlayOnLan) return urls;

  const host = usableHostIp(deps.hostLanIp);
  if (host !== undefined) return [...urls, url(host)];

  for (const infos of Object.values(deps.networkInterfaces())) {
    for (const info of infos ?? []) if (info.family === "IPv4" && !info.internal) urls.push(url(info.address));
  }
  return urls;
}
