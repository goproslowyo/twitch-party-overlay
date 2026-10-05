#!/usr/bin/env bash
# The address of THIS computer on the network it is actually using — the one to paste into OBS on another computer.
#
# `just up` passes it into the container as HOST_LAN_IP, because a container cannot see the NICs of the computer it runs
# on; all it has is its own bridge address, which on macOS reaches neither this computer nor the LAN. See
# src/server/overlay-urls.ts.
#
# Picks the interface carrying the default route, so it follows you from Wi-Fi to Ethernet without being told. Prints
# nothing and exits 0 when there is no answer: a missing address must not stop the container from starting.
set -uo pipefail

case "$(uname -s)" in
  Darwin)
    iface=$(route -n get default 2>/dev/null | awk '/interface:/ { print $2; exit }')
    [ -n "${iface:-}" ] && ipconfig getifaddr "$iface" 2>/dev/null
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash on Windows: the first IPv4 address ipconfig lists. No default-route lookup to lean on here.
    ipconfig 2>/dev/null | tr -d '\r' | awk '/IPv4 Address/ { sub(/.*: */, ""); print; exit }'
    ;;
  *)
    # Linux: `ip route get` names the source address of the route to a public address; no packet is sent. Without `ip`
    # (or offline), the first address `hostname -I` knows.
    addr=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }')
    [ -z "${addr:-}" ] && addr=$(hostname -I 2>/dev/null | awk '{ print $1 }')
    [ -n "${addr:-}" ] && echo "$addr"
    ;;
esac
exit 0
