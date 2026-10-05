import { describe, expect, test } from "bun:test";
import os from "node:os";
import { overlayUrls } from "./overlay-urls.ts";

const ipv4 = (address: string, internal: boolean): os.NetworkInterfaceInfo => ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` });
const ipv6 = (address: string): os.NetworkInterfaceInfo => ({ address, netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/64`, scopeid: 0 });

const laptop = () => ({ lo0: [ipv4("127.0.0.1", true)], en0: [ipv4("192.168.1.20", false), ipv6("fe80::1")], utun3: [ipv4("100.64.0.9", false)] });
/** What a container sees: one bridge address, and nothing of the computer it runs on. */
const container = () => ({ lo: [ipv4("127.0.0.1", true)], eth0: [ipv4("192.168.97.2", false)] });

const LOCAL = "http://localhost:8702/overlay";

describe("overlayUrls", () => {
  test("OBS on the same computer (the default): the localhost URL alone, whatever addresses the machine has", () => {
    expect(overlayUrls({ overlayPort: 8702, overlayOnLan: false, networkInterfaces: laptop })).toEqual([LOCAL]);
    expect(overlayUrls({ overlayPort: 8702, overlayOnLan: false, networkInterfaces: container, hostLanIp: "192.168.1.20" })).toEqual([LOCAL]);
  });

  test("OBS on another computer, no host address: localhost first, then every non-internal IPv4 the machine has", () => {
    expect(overlayUrls({ overlayPort: 8702, overlayOnLan: true, networkInterfaces: laptop })).toEqual([LOCAL, "http://192.168.1.20:8702/overlay", "http://100.64.0.9:8702/overlay"]);
  });

  test("OBS on another computer, in Docker: the host address is the one LAN link, the container's own address is not offered", () => {
    expect(overlayUrls({ overlayPort: 8702, overlayOnLan: true, networkInterfaces: container, hostLanIp: "192.168.1.20" })).toEqual([LOCAL, "http://192.168.1.20:8702/overlay"]);
  });

  test("the overlay port comes from config, not from a hard-coded 8702", () => {
    expect(overlayUrls({ overlayPort: 9000, overlayOnLan: true, networkInterfaces: container, hostLanIp: "10.0.0.5" })).toEqual(["http://localhost:9000/overlay", "http://10.0.0.5:9000/overlay"]);
    expect(overlayUrls({ overlayPort: 9000, overlayOnLan: false, networkInterfaces: laptop })).toEqual(["http://localhost:9000/overlay"]);
  });

  test("a blank or malformed host address is ignored, so a bad env var cannot replace the real list with a dead link", () => {
    for (const bad of ["", "   ", "not-an-ip", "192.168.1", "192.168.1.999", "1.2.3.4.5", "0.0.0.0", "127.0.0.1", "::1"]) {
      expect(overlayUrls({ overlayPort: 8702, overlayOnLan: true, networkInterfaces: laptop, hostLanIp: bad })).toEqual([LOCAL, "http://192.168.1.20:8702/overlay", "http://100.64.0.9:8702/overlay"]);
    }
  });

  test("surrounding whitespace on the host address is trimmed, because it arrives from a shell variable", () => {
    expect(overlayUrls({ overlayPort: 8702, overlayOnLan: true, networkInterfaces: container, hostLanIp: " 192.168.1.20\n" })).toEqual([LOCAL, "http://192.168.1.20:8702/overlay"]);
  });

  test("OBS on another computer but no network address at all: localhost alone, so the page can say so instead of printing a broken link", () => {
    expect(overlayUrls({ overlayPort: 8702, overlayOnLan: true, networkInterfaces: () => ({ lo0: [ipv4("127.0.0.1", true)] }) })).toEqual([LOCAL]);
  });
});
