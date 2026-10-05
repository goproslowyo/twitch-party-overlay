# twitch-party-overlay — `just` is the front door. `just` alone lists these.
# Settings come from ./.env (copy .env.example): SECRETS_FILE, VERBOSE, DEBUG, TZ.

set dotenv-load := true
set shell := ["bash", "-euo", "pipefail", "-c"]

version := `bun -e 'console.log(require("./package.json").version)'`
git_sha := `git rev-parse --short HEAD 2>/dev/null || echo unknown`
# This computer's address on the network it is using. The container cannot see it for itself, and prints it on the Config
# page as the overlay URL for OBS. Re-read on every `just` command, so moving to another network then `just restart`
# is enough. Empty when offline, which the Config page handles.
host_lan_ip := `bash scripts/lan-ip.sh`
export VERSION := version
export GIT_SHA := git_sha
export HOST_LAN_IP := host_lan_ip

# List the recipes.
default:
    @just --list --unsorted

# Ctrl-C stops the log tail; the container keeps running.
# Game night: doctor → up → logs. On a Mac the computer is also kept awake (caffeinate) while you watch. Needs a `just build` beforehand.
show: up
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v caffeinate >/dev/null; then
        echo "Dashboard: http://localhost:8700/   (this Mac stays awake while this is open)"
        exec caffeinate -dis docker compose logs -f --since 1m
    fi
    echo "Dashboard: http://localhost:8700/"
    exec docker compose logs -f --since 1m

# Start the container in the background from the image `just build` made (no build here: nothing to download on the night).
up: doctor
    docker compose up -d
    @echo "up — twitch-party-overlay {{version}} ({{git_sha}}). Dashboard: http://localhost:8700/"

# Stop the container (the Ledger replays on the next start).
down:
    docker compose down

# Stop and start (recreates the container, so .env changes take effect).
restart:
    docker compose up -d --force-recreate

# Follow the logs.
logs:
    docker compose logs -f

# Is it running, and is it answering?
status:
    @docker compose ps
    @curl -fsS -o /dev/null -w 'overlay   http://127.0.0.1:8702/overlay  → %{http_code}\n' http://127.0.0.1:8702/overlay || echo "overlay   not answering on 8702"
    @curl -fsS -o /dev/null -w 'dashboard http://127.0.0.1:8700/         → %{http_code}\n' http://127.0.0.1:8700/ || echo "dashboard not answering on 8700"

# Preflight: .env, secrets file, Docker, Firebot address, ports.
doctor:
    @scripts/doctor.sh

# Build the Docker image (tags twitch-party-overlay:latest and :<version>).
build:
    docker compose build
    docker tag twitch-party-overlay:latest twitch-party-overlay:{{version}}
    @echo "built twitch-party-overlay:{{version}} ({{git_sha}}), $(docker image inspect twitch-party-overlay:latest --format '{{"{{"}}.Size{{"}}"}}' | awk '{printf "%.0f MB", $1/1e6}')"

# Build the bare binary (dist/twitch-party-overlay) for this machine, for running without Docker.
# The downloads on the Releases page are the same build for every OS (.github/workflows/release.yml).
build-binary:
    bun build --compile --minify src/main.ts --outfile dist/twitch-party-overlay
    @ls -lh dist/twitch-party-overlay

# Bake the Chrome Lounge sprite sheets (1x / 0.75x / 0.5x, the 2x scale as several sheets, + atlas) into src/overlay/art/ from scripts/sprites/draw.ts. Commit the result.
sprites:
    bun scripts/sprites/draw.ts
    @ls -l src/overlay/art/*.png

# Typecheck and run the tests.
check:
    bun x tsc --noEmit
    bun test

# Copy data/ (Ledger via sqlite's online backup) and the secrets file to ~/twitch-party-overlay-backups/<timestamp>/.
backup:
    #!/usr/bin/env bash
    set -euo pipefail
    dest="$HOME/twitch-party-overlay-backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dest/data"
    for f in data/config.json data/mods.json; do [[ -f "$f" ]] && cp "$f" "$dest/data/"; done
    [[ -f data/ledger.sqlite ]] && sqlite3 data/ledger.sqlite ".backup '$dest/data/ledger.sqlite'"
    cp "$SECRETS_FILE" "$dest/secrets.env"
    chmod 600 "$dest/secrets.env"
    echo "backed up data/ and secrets to $dest"

# Bump package.json to VERSION, commit and tag (e.g. `just release 1.0.0`). Does not push.
# Write the release into CHANGELOG.md first: this only moves the version, it does not describe it.
release new_version:
    #!/usr/bin/env bash
    set -euo pipefail
    [[ "{{new_version}}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3"; exit 1; }
    git diff --quiet && git diff --cached --quiet || { echo "commit or set aside your changes first"; exit 1; }
    perl -pi -e 's/"version": "[^"]*"/"version": "{{new_version}}"/' package.json
    git add package.json
    git commit -q -m "chore(release): v{{new_version}}"
    git tag -a "v{{new_version}}" -m "twitch-party-overlay v{{new_version}}"
    echo "released v{{new_version}} — now: just build"

# Start the night clean: stop, archive data/ledger.sqlite to ~/twitch-party-overlay-backups/<timestamp>/, start again.
# The Ledger is the rehearsal's memory (tier, threshold, every credit); without it the fader starts at $0.
fresh-ledger: backup
    #!/usr/bin/env bash
    set -euo pipefail
    docker compose down
    dest="$HOME/twitch-party-overlay-backups/ledger-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$dest"
    mv data/ledger.sqlite* "$dest/" 2>/dev/null || true
    echo "ledger archived to $dest — starting with an empty one"
    just up

# Run the setup wizard against the secrets file in .env. Stops the container first: the wizard replaces the file,
# and a running container would keep the old copy.
setup:
    docker compose down
    SECRETS_FILE="$SECRETS_FILE" scripts/setup.sh

# Open the Dashboard in the browser (macOS, Windows and Linux).
open:
    bun -e 'import { openBrowserCommand } from "./src/platform/runtime.ts"; Bun.spawn(openBrowserCommand(process.platform, "http://localhost:8700/"))'
