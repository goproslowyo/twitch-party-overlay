#!/usr/bin/env bash
#
# Setup moved into the Dashboard. Start the service, then open the Setup page in a browser:
#
#     http://localhost:8700/setup
#
# It walks you through your channel, your own Twitch app, and the optional extras (StreamElements, mod access and
# Ko-fi, Firebot), saves the secrets file for you, and never needs a terminal. This script only opens that page, so
# `just setup` keeps working.

set -euo pipefail

STREAMER_PORT="${STREAMER_PORT:-8700}"
URL="http://localhost:${STREAMER_PORT}/setup"

printf 'Setup now lives in the Dashboard: %s\n' "$URL"
if ! curl -fsS "http://127.0.0.1:${STREAMER_PORT}/api/state" -o /dev/null 2>/dev/null; then
  printf 'The service is not running on port %s yet. Start it (just show, or the binary), then open that address.\n' "$STREAMER_PORT"
  exit 0
fi
if   command -v wslview     >/dev/null 2>&1; then wslview "$URL"
elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$URL"
elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$URL"
elif command -v open        >/dev/null 2>&1; then open "$URL"
else printf 'Open it in your browser.\n'; fi >/dev/null 2>&1 || printf 'Open it in your browser.\n'
