# Changelog

What changed in each release, in plain words. Newest first.

## v2.0.0 — 2026-10-05

The first public release. The overlay was built for one streamer's event and is now a
program anyone can download and run.

- **Download and run.** Prebuilt programs for Windows, macOS (Apple silicon and Intel)
  and Linux on the Releases page. Double-click, and the Dashboard opens in your browser.
  The program keeps its data in a `data` folder beside itself and keeps your computer
  awake while it runs. No terminal, Docker or git needed.
- **A Setup page.** The first start lands on `/setup`, which walks you through your
  channel, making your own Twitch app in the Twitch developer console, and connecting
  Twitch. StreamElements tips, mod access from other computers, Ko-fi and Firebot
  giveaways are each optional, off until you turn them on, with the steps on the page.
  Saving there needs no restart.
- **OBS on the same computer by default.** The overlay URL is `http://localhost:8702/overlay`
  and nothing is opened to the network. OBS on another computer is a checkbox on the
  Config page that lists this computer's address.
- **Neutral defaults.** A fresh install starts with a starter pool any stream can run,
  no personal names, paths or time zone anywhere. The DJ party pool the overlay was
  first built for is kept as `examples/outcome-pool-dj-party.json`.
- **Room lights are gone.** The Govee and Home Assistant integration and its Config
  section are removed. An older `config.json` that still has a `lights` block loses it
  quietly on load.
- **Port 8700 only answers to localhost.** The streamer port refuses requests addressed
  to any other name, so a web page cannot reach it by pointing its own domain at your
  computer. The Dashboard is `http://localhost:8700/`; Firebot uses `http://127.0.0.1:8700`.
- **Generic Help page, README and comments.** The in-app Help and the README describe
  the software for a stranger, not one stream.
- **MIT license.**

Earlier versions were built for a single stream and are not listed.
