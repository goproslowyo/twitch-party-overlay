# twitch-party-overlay

A Twitch stream overlay that turns support into moments. Tips, cheers, subs and gift
subs fill a fader on screen. Every time it fills, the crowd banks one **Unlock**. A mod
(or you) presses **Fire** and a parachutist drops onto a board of pads in OBS and reveals
an **Outcome**: a challenge, a giveaway, a stunt, a stream moment. Everything that
happens is written to a local **Ledger**, so a restart never loses anything, and
everyone who chats shows up on the overlay's dance floor as a dancer wearing their
Twitch picture.

It is one program that runs on your computer. OBS loads a web page from it. You drive
it from a Dashboard in your browser. No account, no cloud, no monthly fee.

## Getting started

### 1. Download and run

Open the [Releases page](https://github.com/goproslowyo/twitch-party-overlay/releases/latest)
and download the file for your computer:

| Computer | File |
| --- | --- |
| Windows | `twitch-party-overlay-windows.exe` |
| Mac with Apple silicon (M1 or newer) | `twitch-party-overlay-macos-apple-silicon.zip` |
| Mac with an Intel chip | `twitch-party-overlay-macos-intel.zip` |
| Linux | `twitch-party-overlay-linux-x64.zip` (or `-arm64.zip` on a Raspberry Pi or similar) |

Put it in a folder of its own, such as `Documents/twitch-party-overlay`. If it is a
`.zip`, double-click the zip first to unpack it. Then double-click the program.

The downloads are not signed yet, so the first start asks once:

- **Windows** shows "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS** says the app "cannot be opened because it is from an unidentified developer"
  or "Apple could not verify" it. Click **Done** (or **OK**), open **System Settings →
  Privacy & Security**, scroll down to the line about `twitch-party-overlay`, click
  **Open Anyway**, then confirm with **Open**. On older macOS versions, right-click the
  program and choose **Open** instead.
- **Linux** may ask whether to run or display the file; choose run. If a double-click does
  nothing, open a terminal in that folder and run `./twitch-party-overlay-linux-x64`.

A small window with log lines opens, and the Dashboard opens in your browser at
`http://localhost:8700/`. Leave the log window open while you stream. To stop, close
that window, press Ctrl-C in it, or press **Shut down** at the bottom of the Dashboard's
Config page.

The program creates a `data` folder beside itself and keeps everything there: your
settings (`config.json`), the Ledger (`ledger.sqlite`) and your keys (`secrets.env`).
Keep the program and that folder together; moving the program to a new folder starts
it fresh. While it runs it keeps your computer awake.

### 2. The Setup page

Until Twitch is connected, the Dashboard lands on the Setup page
(`http://localhost:8700/setup`). Three steps, then the optional extras:

1. **Your channel.** The name from your twitch.tv address.
2. **Your Twitch app.** The overlay talks to Twitch through an app that belongs to you.
   Making one is free and takes about two minutes; the page walks you through the
   Twitch developer console step by step and shows the exact redirect URL to paste.
   Twitch only lets accounts with two-factor authentication make apps, so turn that on
   first if you have not. Paste the Client ID and Client Secret into the page.
3. **Connect Twitch.** Twitch asks you to let the overlay see your bits, subs,
   moderator list and chat. Approve it and you are back on the Dashboard, connected.

Everything is saved as you go. Secrets go into `secrets.env` and are never shown again
in full. The Config page keeps a **Setup** button so you can come back any time.

### 3. Add the overlay to OBS

OBS normally runs on the same computer as the overlay, and that is the default: the
overlay page is reachable from this computer only and nothing is opened to the network.

1. Open the Dashboard's Config page and find **Overlay URL for OBS**. Press **Copy**.
2. In OBS add a **Browser** source with that URL (`http://localhost:8702/overlay`),
   width 1920, height 1080, FPS 30. Nothing else to tick. The page is transparent.
3. You should see the fader and the rack of pads.

If the source ever looks stuck, right-click it and press **Refresh**. It reconnects and
redraws from the current state.

**OBS on another computer:** on the Config page, under Overlay URL for OBS, tick **OBS
runs on another computer**, then restart the program. The page then lists this
computer's network address as `http://<this-computer>:8702/overlay`; use that in the
Browser source on the other computer. Windows may ask to allow the overlay through the
firewall. If more than one address is listed, try them in order.

### 4. See it work

Open the Dashboard's **Debug** page and press a Credits button, say **100 bits**. A fake
cheer lands on the overlay in OBS and on the Ledger page. Every button on that page goes
through the same routes the real sources use, so the overlay reacts exactly as it will
on stream. The rows are marked `debug`; void them on the Ledger page afterwards.

That is the whole setup. Cheers, subs and gift subs on your channel now count toward
unlocks.

## Optional extras

Each of these is off until you turn it on from the Setup page.

### StreamElements tips

**What you get:** tips sent through your StreamElements tip page (PayPal ones included)
count toward unlocks the moment they land, and any the overlay missed while it was off
are caught up.

**How:** on the Setup page turn on **Count tips from StreamElements**, copy the JWT Token
from streamelements.com (Channels tab, Show secrets), press **Check**, then **Save**.
Test it with StreamElements' **Send test tip** button.

### Mods on other computers, and Ko-fi

**What you get:** your mods open a public address, sign in with Twitch and get the
Dashboard with Fire, credits, voids and the pool, from wherever they are. Only people on
your channel's moderator list get in. Ko-fi donations and subscriptions count toward
unlocks like a tip (shop orders are recorded but do not count).

Both need your computer to have a public https address on the internet, which it
normally does not. A **tunnel** gives it one. The Setup page documents Tailscale Funnel,
which is free; any tunnel that gives you an https address and points it at port 8701 on
this computer works the same way.

**How, with Tailscale Funnel:**

1. Install Tailscale from tailscale.com/download and sign in.
2. In a terminal run `tailscale funnel --bg 8701`. The first time, it prints a link to
   turn Funnel on for this machine; open it and come back. On a Mac with the Tailscale
   app the command is `/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 8701`.
3. `tailscale funnel status` prints your address, which looks like
   `https://yourpc.tail1234.ts.net`. Paste it on the Setup page and Save.
4. For mods: the page then shows a second redirect URL to add to your Twitch app. Add
   it, then send your mods the public address and tell them to read the Help page.
5. For Ko-fi: the page shows the webhook URL to paste at ko-fi.com/manage/webhooks, and
   asks for the Verification Token from that page's Advanced section. Ko-fi's **Send
   Test** button shows up on the Ledger page.

Run the funnel command again whenever your computer restarts. `tailscale funnel
--https=443 off` takes it down after the stream, and `tailscale funnel reset` clears
everything if it is stuck.

### Firebot giveaways and `!fire`

**What you get:** when a giveaway Outcome comes up, the overlay has
[Firebot](https://firebot.app) open a chat raffle (viewers type `!giveaway enter`),
names the prize, and closes and draws the winner from the Dashboard's Giveaways page.

**How:** install Firebot on this computer and sign in. Download `giveaway.firebotsetup`
from https://github.com/CaveMobster/firebot-setup-giveaway-command/releases/latest and
import it under Firebot's **Settings → Setups → Import Setup** (answer the one question
with anything). Make sure Firebot's local API is on (Settings → Advanced). On the Setup
page turn on **Run giveaways through Firebot**, press **Check**, then **Save**.

**`!fire` from chat** is a separate, optional mod-only chat command that presses Fire,
useful when no mod can reach the Dashboard. In Firebot: Commands → **New Custom
Command**, trigger `!fire`, permissions **Moderators**, with an **HTTP Request** effect:
method `POST`, URL `http://127.0.0.1:8700/api/fire`, header
`X-Requested-With: twitch-party-overlay`, raw JSON body `{"actor":"$user"}`. The Ledger
records the Fire as `twitch:<your login> via <their name>`.

## Using it on stream

### The Dashboard pages

- **Live**: the fader, how many Unlocks are READY, the current Tier, the **Fire**
  button, what just came up (with **Put it back**), the latest Ledger rows, and **Add a
  tip by hand** for anything that arrived while the program was off.
- **Ledger**: every entry, newest first. Void or re-bank a row. **Show all** under a
  summary opens every detail, with before and after.
- **Pool**: the Outcome editor and the queue. Mods can Suspend, Resume, Restock and
  Retire; the streamer adds, edits and deletes.
- **Giveaways**: a Fired giveaway waits here until someone presses **Start**. Then
  **Close & draw**, **Close only**, **Draw a winner**, **Reopen entries** and **Done**,
  each saying under it what Firebot will do and say. A **Winner** field on every row.
- **Config** (streamer only): the Threshold, quick settings (rack side, theme, dance
  floor, Quality, Detail), Chatter Dancers, draw lists, the broadcaster account, the
  overlay URL, the full `config.json`, and **Shut down**.
- **Debug** (streamer only): a button for every moment, through the real routes, with
  nothing reaching Twitch chat. Also a dry-run giveaway and fake chatters.
- **Help**: the in-app guide for you and your mods.

### Threshold and Tiers

The Threshold is how much fills the fader once. Change it on the Config page (the
suggested amounts are one-tap buttons, or type your own); it applies at once and partial
progress carries across the change. You should only ever lower it during a stream.
Tier 1 opens after 3 Unlocks are banked and Tier 2 after 6, whatever the Threshold is
(`tiers.gates` in the config).

Tips and bits count in full, to the cent. Subs count a flat amount a little above what
you keep: $2 for a Tier 1 or Prime sub, $3.50 for Tier 2, $8.75 for Tier 3, and gifts
count per sub (`policy.subCents`).

### The Outcome editor

The Pool page lists every Outcome by Tier, with a **Used** count (from the Ledger) and
a **Left** count (how many more times it can come up). Click a row to edit it in place,
**+ Add Outcome** for a new one, `?` for the keyboard shortcuts. Left is the only number
you change; Delete only while Used is 0, otherwise Retire. Edits apply from the next
drop and the overlay updates live.

A fresh install starts with a neutral starter pool that any stream can run. The DJ
party pool the overlay was first built for is in
`examples/outcome-pool-dj-party.json`: on the Config page, under **Full config**,
replace the `outcomes` and `lists` values with the file's and press **Save**.

Two Outcomes draw from a list when they come up (GENRE ROULETTE and CHAT-RULE DRAW).
Edit the lists on the Pool page or under **Draw lists** on the Config page, one item
per line.

### Starting a fresh Ledger

The Ledger replays on every start, so a test session's credits and Unlocks are still
there when you go live. To start clean: stop the program, move `data/ledger.sqlite` out
of the `data` folder (keep it somewhere, nothing needs deleting), and start again. Your
settings and keys stay.

### Backups

Copy the `data` folder. That is everything: settings, Ledger and keys. Under Docker,
`just backup` does it for you.

### Chatter Dancers

Anyone who chats walks onto the dance floor within a few seconds, wearing their Twitch
picture and their name, hops when they say something, and walks off after a quiet
spell. Bots never get a dancer (the list comes filled in). Config → Chatter Dancers has
the sliders and the bot list. The message itself is never shown and none of it touches
the Ledger.

### A 4K source

The overlay is laid out for 1920 × 1080 whatever size the source is, so it keeps its
proportions at 3840 × 2160. Config → Quick settings → **Detail** decides how sharp it is
and how much work your computer does: **Standard** draws 1920 × 1080 and lets the
browser scale it up, **Sharper** draws 2880 × 1620, **Sharpest** draws all four times the
pixels and loads crisper artwork. When Sharpest is too much, the overlay holds its frame
rate by dropping the lasers, the smoke and some of the confetti. Move up one step at a
time and watch the Live page's "Overlay · Level N" line.

## Troubleshooting

- **Anything odd**: restart the program (the Ledger replays). Refresh the OBS browser
  source. If you use a tunnel, start it again.
- **"Broadcaster account not linked"** banner: open the Config page on this computer and
  press **Link broadcaster account**.
- **Mod login fails at Twitch** ("redirect mismatch" or an error page): your Twitch app
  needs both redirect URLs exactly, `http://localhost:8700/auth/twitch/callback` and
  `<public address>/auth/twitch/callback`. The Setup page shows both.
- **"Not a moderator of this channel"**: Twitch does not list them as a mod right now.
  `/mod <name>` in chat, then they log in again.
- **"config.json is invalid, last good config still in use"**: fix the JSON (the banner
  names the problem) or paste the config back on the Config page.
- **"Twitch EventSub: all sessions disconnected"** or **"StreamElements: realtime socket
  down"**: the program reconnects by itself. If anything from that window is missing, add
  it on the Live page under **Add a tip by hand**.
- **"Ko-fi webhooks during downtime are lost"** (shown after every start): check the
  Ko-fi dashboard for anything that arrived while the program was off and add it by hand.
- **"Firebot didn't respond"**: type `!raffle 1 120` in chat and StreamElements runs the
  raffle instead. Then check Firebot is open and its address on the Setup page is right.
- **Port already in use** on start: another copy is running. Stop it first.
- **"This port only answers requests addressed to localhost."** (a plain 403 from port
  8700): you opened the Dashboard, or pointed Firebot, at a name other than `localhost`,
  `127.0.0.1` or `[::1]`, for example this computer's network address. Port 8700 trusts
  whoever reaches it, so it refuses any other name on purpose. Use
  `http://localhost:8700/` for the Dashboard and `http://127.0.0.1:8700/api/fire` in
  Firebot. Ports 8701 and 8702 are not affected.
- **OBS on another computer shows nothing**: open the overlay URL in a normal browser on
  that computer. If it fails there too, the computers cannot see each other (network,
  firewall). Check **OBS runs on another computer** is ticked and the program was
  restarted after.

## Advanced

### How it fits together

One process, three listeners. Which port a request arrives on decides who it is:

| Listener | Port | Who reaches it | What it serves |
|---|---|---|---|
| streamer | `127.0.0.1:8700` | you, on this computer only | Dashboard (no login, you are the Streamer), API, Setup, Debug |
| funnel | `127.0.0.1:8701`, published by your tunnel | mods (Twitch login), Ko-fi | Dashboard, API, `/login`, the Ko-fi webhook |
| overlay | `127.0.0.1:8702`, or every interface with **OBS runs on another computer** | OBS | `/overlay` and its WebSocket |

Anything that reaches port 8700 is treated as you. Never expose it beyond this computer.

Files, all in the data folder (beside the program, `./data` from source, `/data` in
Docker):

| File | What |
|---|---|
| `config.json` | every setting. Edit on the Config page or by hand. Created on first start. |
| `ledger.sqlite` | the append-only Ledger, replayed on every start. |
| `mods.json` | the last known moderator list, used if Twitch is unreachable at login. |
| `secrets.env` | your keys and tokens. The Setup page writes it (mode 0600). |

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | see above | where the files above live |
| `CONFIG_FILE`, `LEDGER_FILE`, `SECRETS_FILE` | inside `DATA_DIR` | move one file somewhere else |
| `TZ` | unset | time zone for log timestamps, an IANA name such as `America/New_York`. Unset, the machine's zone applies (UTC in Docker). |
| `NO_OPEN=1` | unset | do not open the Dashboard in the browser on start (the downloaded program only) |
| `BIND_ALL=1` | unset | bind every listener on every interface (Docker only; the compose file decides what is published) |
| `VERBOSE=1` | unset | one log line per real event: every unlock, EventSub frames, StreamElements events, token refreshes, overlay clients |
| `DEBUG=1` | unset | everything: `VERBOSE` plus keepalives, empty backfill runs and one line per HTTP request |

Config edits are live: a change to `config.json`, by hand or on the Config page, is
picked up within a couple of seconds and logged to the Ledger. Invalid JSON raises a
banner and the last good config stays in use. What needs a restart: `tiers`,
`ingest.*.enabled`, `ingest.twitch.eventsubUrl`, `listeners.*` and `funnel.publicUrl`
(the Setup page restarts the StreamElements adapter itself when you save there).

### Running two copies

Give the second copy its own `DATA_DIR` whose `config.json` sets
`listeners.streamerPort`, `funnelPort` and `overlayPort` to free ports.

### Docker and `just`

The container path is Docker driven by [`just`](https://github.com/casey/just). The
image is the compiled program in an otherwise empty container, about 80 MB.

```sh
cp .env.example .env      # set SECRETS_FILE to a path outside the checkout
just build
just show                 # doctor → up → follow the logs; Ctrl-C leaves it running
```

| Command | What |
|---|---|
| `just` | list every command |
| `just show` | preflight, start in the background, follow the logs |
| `just up` / `just down` / `just restart` | start / stop / recreate (picks up `.env` changes) |
| `just logs` / `just status` | follow the logs / is it running and answering |
| `just doctor` | preflight: `.env`, secrets file, Docker running, image built, Firebot address, ports |
| `just build` | build the image (`twitch-party-overlay:latest` and `:<version>`) |
| `just check` | typecheck and tests |
| `just backup` | copy `data/` and the secrets file to `~/twitch-party-overlay-backups/<timestamp>/` |
| `just fresh-ledger` | archive the Ledger to the backups folder and start again at $0 |
| `just setup` | open the Setup page in your browser |
| `just build-binary` | the bare program at `dist/twitch-party-overlay`, for running without Docker |
| `just release 1.2.3` | bump `package.json`, commit and tag |

`.env` holds `SECRETS_FILE`, the log level and `TZ`. `./data/` is mounted as `/data`;
the secrets file is mounted read-write because the program writes your Twitch tokens
into it. Ports 8700, 8701 and 8702 are published on `127.0.0.1` only; for OBS on another
computer change the 8702 line to `"8702:8702"` as the comment there says. Restart
policy is `on-failure`: a crash restarts the container, a clean stop (Shut down, `just
down`) stays down, so after a reboot run `just show` again.

Inside the container `127.0.0.1` is the container, not your computer, so point Firebot
at `http://host.docker.internal:7472` (the Setup page says so) and the mock EventSub
below at `ws://host.docker.internal:8080/ws`.

Never pass `SECRETS_FILE=` on the command line; `.env` is the one place the path lives.
A path that points at nothing is not an error: the program treats it as a first run and
creates a new, nearly empty secrets file there while the real one sits untouched
elsewhere. `just doctor` refuses a secrets file without the Twitch app keys for exactly
that reason. `EISDIR` / `secrets.env is a directory` means Docker was started before the
file existed and made a folder there; delete the folder and start again.

### Building from source

You need [bun](https://bun.sh).

```sh
bun install --frozen-lockfile
bun run start                                    # from source; the data folder is ./data
just build-binary && ./dist/twitch-party-overlay # one file; the data folder is dist/data
bun build --compile --minify --target=bun-windows-x64 src/main.ts --outfile dist/twitch-party-overlay.exe   # any OS from any OS
```

The program embeds the overlay page, the Dashboard and the Help page, so a single file
runs anywhere. What a start looks like:

```
twitch-party-overlay 1.15.1
data folder: /Users/you/Documents/twitch-party-overlay/data
replayed 0 entries
listening streamer=127.0.0.1:8700 funnel=127.0.0.1:8701 overlay=127.0.0.1:8702
opening http://localhost:8700/ in your browser (NO_OPEN=1 turns this off)
```

From source and in Docker there is no `opening` line.

### Wiring check without real money

The Debug page covers the overlay. To check the Twitch path itself, use the Twitch
CLI's mock EventSub server (`brew install twitchdev/twitch/twitch-cli`, or see its
README for other systems). No real Twitch traffic is involved.

1. Start the mock and leave it running: `twitch event websocket start-server`.
2. Config → Full config → set `ingest.twitch.eventsubUrl` to `ws://127.0.0.1:8080/ws`
   and Save. Restart the program; the log says `twitch: mock mode`.
3. Trigger events to your broadcaster id (the Config page shows it next to the linked
   account):

   ```sh
   twitch event trigger channel.cheer --transport=websocket --to-user <id> --cost 500
   twitch event trigger channel.subscribe --transport=websocket --to-user <id> --tier 1000
   twitch event trigger channel.subscription.message --transport=websocket --to-user <id> --tier 1000
   twitch event trigger channel.subscription.gift --transport=websocket --to-user <id> --tier 1000
   ```

   The mock's gift event is always 5 subs; `--count N` repeats any event N times. The
   mock knows no `channel.bits.use`, so the log says it was skipped (4 of 5 subscribed);
   cheers still arrive via `channel.cheer`.
4. Each event shows as a log line, a row on the Ledger page and movement on the fader.
5. When done, set `ingest.twitch.eventsubUrl` back to `wss://eventsub.wss.twitch.tv/ws`,
   Save and restart.

`bun test src/e2e.test.ts` walks the same path without OBS or the internet: a Ko-fi
webhook, a manual credit, two Fires, a re-bank, a Threshold change and a restart,
through the real listeners on temp files.

### Development

```sh
bun run dev          # bun --watch src/main.ts, restarts on server edits
bun test             # the suite
bun run typecheck    # bun x tsc --noEmit
```

The overlay page is served through Bun's HTML import (`src/server/overlay-page.ts`
imports `src/overlay/index.html`), which is what lets `bun build --compile` embed it in
the binary with no prebuild step. One consequence: `bun --watch` does not rebuild the
HTML import, so after editing anything under `src/overlay/` restart the dev server.
Anything the overlay imports by value must live under `src/`; the Docker image copies
only `src/`.

### Sprites

The Chrome Lounge theme draws its canopy, airship, pads, lights, motes and dancers from
a sprite sheet. The source of every sprite is `scripts/sprites/draw.ts`: original vector,
emitted as SVG, with no text inside a sprite (text and emoji are drawn at runtime).
`just sprites` bakes it with resvg-js at four scales (2x, 1x, 0.75x and 0.5x) into
`src/overlay/art/`: one PNG per scale, the 2x scale as several sheets of at most 4096 px
a side, and `chrome-lounge.json`, the atlas (a frame and an anchor per sprite per scale;
generated, never hand-edited). The PNGs and the atlas are committed and reviewed as a
diff. The overlay imports them from client code, so Bun hashes them into the page
bundle; the bake never runs in Docker or at boot. A theme names its sheet with
`"sheet": "chrome-lounge"`; `"sheet": ""` keeps the procedural look (Club-Deck,
Duck-Farm). White masters are tinted from the theme's colors once at boot.

1x, 0.75x and 0.5x are the Quality Level bands. 2x exists for Detail Sharpest on a 4K
source; a sprite is always taken from the smallest sheet big enough to draw it without
scaling up, and the 2x sheets are fetched only at Sharpest. If they fail to load, the
smaller sheets keep drawing.

### Releases

A `v*` tag pushed to GitHub runs `.github/workflows/release.yml`: typecheck, tests, then
one binary each for Windows x64, macOS Apple silicon, macOS Intel, Linux x64 and Linux
arm64, attached to a GitHub Release with a `SHA256SUMS` file. The macOS and Linux
binaries ship zipped so they keep their executable bit. `ci.yml` runs the typecheck and
tests on every push and pull request. `just release 1.2.3` bumps `package.json`, commits
and tags; write the release into `CHANGELOG.md` first.

## License

MIT. All sprites are original vector drawn by `scripts/sprites/draw.ts`.
