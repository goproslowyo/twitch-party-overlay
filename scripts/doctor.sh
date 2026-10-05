#!/usr/bin/env bash
# Preflight for `just up`: everything that has made a start fail or a night go quietly wrong. Exit 1 on a hard failure.
set -euo pipefail
cd "$(dirname "$0")/.."

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; WARN=1; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
WARN=0; FAIL=0
case "$(uname -s)" in
  Darwin) docker_hint="OrbStack: brew install --cask orbstack"; docker_start="start OrbStack";;
  MINGW*|MSYS*|CYGWIN*) docker_hint="install Docker Desktop"; docker_start="start Docker Desktop";;
  *) docker_hint="install Docker Engine (or Docker Desktop)"; docker_start="start the Docker service";;
esac

# .env — justfile loads it, but this script also runs on its own.
if [[ -f .env ]]; then set -a; source .env; set +a; ok ".env present"; else fail ".env missing — cp .env.example .env and set SECRETS_FILE"; fi

# secrets file
if [[ -z "${SECRETS_FILE:-}" ]]; then fail "SECRETS_FILE not set (in .env)"
elif [[ -d "$SECRETS_FILE" ]]; then fail "SECRETS_FILE is a directory (Docker created it before the wizard ran): rm -r '$SECRETS_FILE' then scripts/setup.sh"
elif [[ ! -f "$SECRETS_FILE" ]]; then fail "SECRETS_FILE not found: $SECRETS_FILE — run scripts/setup.sh"
else
  ok "secrets file: $SECRETS_FILE"
  # Inside the repo is only a problem if git would ever pick it up (data/ is ignored, so that one is fine).
  case "$(cd "$(dirname "$SECRETS_FILE")" && pwd -P)/" in "$(pwd -P)/"*)
    git check-ignore -q "$SECRETS_FILE" 2>/dev/null || warn "secrets file is inside the repo and NOT git-ignored — move it out (e.g. ~/twitch-party-overlay-secrets/) and update .env";; esac
  if ! grep -qE '^TWITCH_CLIENT_ID=.+' "$SECRETS_FILE"; then
    fail "secrets file has no TWITCH_CLIENT_ID — wrong file? (the service creates an empty one at a missing path; the wizard-written one has 10+ keys)"
  else
    ok "secrets file has the app keys"
    grep -qE '^TWITCH_BROADCASTER_(ACCESS|REFRESH)_TOKEN=.+' "$SECRETS_FILE" && ok "broadcaster tokens present" \
      || warn "no broadcaster tokens yet — after start, open http://localhost:8700/auth/twitch/broadcaster"
  fi
fi

# docker
if ! command -v docker >/dev/null; then fail "docker not installed ($docker_hint)"
elif ! docker info >/dev/null 2>&1; then fail "docker is not running — $docker_start"
else
  ok "docker $(docker version --format '{{.Server.Version}}') running"
  if docker image inspect twitch-party-overlay:latest >/dev/null 2>&1; then
    ok "image twitch-party-overlay:latest present ($(docker image inspect twitch-party-overlay:latest --format '{{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}}'))"
  else fail "no image yet — run: just build"; fi
fi

# config.json — under Docker, 127.0.0.1 is the container, so Firebot must be reached via host.docker.internal.
if [[ -f data/config.json ]]; then
  if grep -qE '"baseUrl": *"http://(localhost|127\.0\.0\.1)' data/config.json; then
    if grep -qE '"enabled": *true' <(sed -n '/"firebot"/,/}/p' data/config.json); then
      fail "firebot.baseUrl points at localhost — inside Docker that is the container. Set it to http://host.docker.internal:7472 (Dashboard → Config)"
    else
      warn "firebot.baseUrl points at localhost (Firebot is disabled, so fine for now — use http://host.docker.internal:7472 when you enable it)"
    fi
  else ok "firebot.baseUrl is not localhost"; fi
  if grep -qE '"eventsubUrl": *"ws://(localhost|127\.0\.0\.1)' data/config.json; then
    warn "ingest.twitch.eventsubUrl points at the mock server on localhost — real events need wss://eventsub.wss.twitch.tv/ws"
  fi
else
  ok "no data/config.json yet — it is created with defaults on first start"
fi

# ports — free, or held by our own container (lsof is macOS / Linux; Git Bash on Windows has none, so the check is skipped there)
if command -v lsof >/dev/null; then
  ours=$(docker compose ps -q 2>/dev/null || true)
  for p in 8700 8701 8702; do
    if pids=$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null) && [[ -n "$pids" ]]; then
      if [[ -n "$ours" ]]; then ok "port $p in use by our container"; else fail "port $p is taken by another process (pid $pids) — the binary or a dev server still running?"; fi
    else ok "port $p free"; fi
  done
else
  warn "no lsof here, so ports 8700-8702 were not checked — if the start fails, something else may be listening on them"
fi

if (( FAIL )); then echo "doctor: fix the ✗ lines, then try again"; exit 1; fi
(( WARN )) && echo "doctor: warnings above, but nothing blocking" || echo "doctor: all clear"
exit 0
