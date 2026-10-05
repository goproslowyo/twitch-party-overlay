### How this works
Tips and bits count in full, to the cent. Subs count a flat rate just above what the streamer keeps: $2 for a Tier 1 or Prime sub, $3.50 for Tier 2, $8.75 for Tier 3, and gifts count per sub (25 gifted Tier 1s = $50). Nothing is rounded to whole dollars. Every $X (shown on the fader) banks one unlock. Unlocks bank even while the streamer is busy; nothing is ever lost.

### Firing
- Press **Fire** to drop one jumper. Press again to drop another (up to 6 in the air). Reveals queue in landing order, then the pads shuffle once. Wait for the shuffle if you want a clean single drop.
- "$50 of $50 · FULL" shows for a beat before the +UNLOCK stinger. That is intentional, not a stuck bar.
- If the Outcome cannot happen right now, say a guest is not up for it or a prop is missing: re-bank the Unlock, retire or suspend the pad, and Fire again. The crowd never loses an unlock. Suspend an Outcome that needs a guest once the guest has called it a night.

### Threshold
The streamer sets the Threshold by feel. You should only ever lower it; partial progress carries across a change. Suggested landing spots: $50 → $35 → $25 → $20 → $10. Tier 1 opens at 3 banked, Tier 2 at 6 banked, regardless of Threshold.

### Restock
A drained pool is the celebration, not an error. Re-arming happens only from the Dashboard's Pool page, and only for restockable Outcomes, the challenges. **Restock +1** adds one more go to its Left. Giveaways and one-off stunts never come back.

### Editing the pool
Every Outcome has a Used count, how many times it has come up this stream according to the Ledger, and a Left count, how many more times it can come up. The Pool page lists them by Tier; hover or arrow to a row for its buttons, `?` shows the keyboard shortcuts. Every Outcome also has a What it is line. The ⓘ next to its name says what happens when it comes up, and the streamer edits it in the form.
- **Mods**: Suspend skips an Outcome for now and Resume puts it back. Restock +1 adds one more go to a restockable one. Retire takes it off the board for the rest of the stream, for good, so it asks first. Anything it already did stays in the Ledger.
- **Streamer**: click a row, or press ⏎, to edit it in place. + Add Outcome opens the same form. Left is the only number you change, since Used comes from the Ledger. Changes apply from the next drop and the overlay updates live. Delete only while Used is 0. Once it has come up, Retire it instead so the stream's history still makes sense.

### Genre roulette and chat rules
The two draw lists, the genres GENRE ROULETTE picks from and the rules CHAT-RULE DRAW picks from, are edited in either of two places that save the same list. On the Pool page, for the streamer, each list is a row editor. + adds a row at the bottom and ⏎ in a row adds one below it. Pick a row and − removes it, after asking; Backspace in an empty row just drops it. Then Save. On the Config page under Draw lists they are one item per line, or in the full config editor below it. Items are stored and shown in CAPS whatever case you type. A saved change applies the next time that Outcome comes up. Nothing needs a restart, and an item the overlay has already picked stays in the Ledger as it was.

### The Ledger page
Every entry, newest first, with the console's one-line summary. When a summary had to cut something, such as a config save that changed more than four settings or a long tip message, a **Show all** link under it opens every item in full: each setting with its value before and after. A change to a draw list or to the Outcome pool is shown as what was added and what was removed, never as which position moved.

### Manual Credit
Resubs that were not shared in chat and Prime subs arrive as plain Tier 1 or not at all. Manual Credit them from the Live page, under Add a tip by hand.

### Giveaways
Firing a giveaway pad does not touch chat. The giveaway waits on the Giveaways page until someone presses Start. The prize is filled in, and you can edit it. Start runs Firebot's `!giveaway start`, which empties the entrant list and tells chat to type `!giveaway enter`, then names the prize. Entries stay open and nobody is on a clock. Everything after that is a button on the Giveaways page, and each button says under it exactly what Firebot will do and say. Close & draw stops entries and Firebot congratulates the winner in chat. Close only stops entries without drawing. Draw a winner, or Draw again, picks someone. A second draw is always someone new, because the last winner is dropped from the list. Reopen entries is for a close that came too soon, and everyone already in stays in. Done clears the list once the winner has answered. It asks first, because after it nobody can be re-drawn. With nothing waiting, Start with a typed prize opens a giveaway by hand, no Fire needed. Every button is always on the page and grayed out whenever it makes no sense right now. Viewers' own `!giveaway enter` and `!giveaway leave` have no button. Type the winner's name on that Fire's row on the Giveaways page. Fulfillment happens after the stream. If Firebot does not respond, a banner says so. Type `!raffle 1 120` in chat and StreamElements runs it.

### Chatter Dancers
Everyone who chats is on the dance floor. A dancer walks on with their Twitch picture as its head and their name above it, hops each time they send a message, and walks off once the Chat Window has passed since their last one (15 minutes unless the streamer changes it on the Config page). Mods count like anyone else. The streamer's own messages and the chat bots do not. Nothing for the mods to do. The bot list, the window and how much of a name fits are the streamer's, under Config → Chatter Dancers. The Live page shows how many people are chatting right now. If a banner says "Connect the broadcaster account again to hear chat", the streamer clicks the broadcaster link on the Config page once, on the computer running the overlay, and the floor fills.

### Chat picks what comes next
A mod runs a poll of what happens next: a game, a level, a song, a topic. The streamer gives a thumbs-up over comms. If the pick cannot happen right now, swap to the closest thing that can.

### Before signing off
Fire anything still banked. Then the streamer stops the program with Config → Shut down on the Dashboard (under Docker, `just down` does the same). OBS loses the overlay and the Dashboard goes offline until the next start. The Ledger replays on the next start, so nothing is lost. If you use a tunnel for mod access, turn it off so the Dashboard stops being reachable from the internet: with Tailscale that is `tailscale funnel --https=443 off`, and `tailscale funnel --bg 8701` brings it back next time.

### If something breaks
Restart the program; the Ledger replays. Refresh the OBS browser source. If you use a tunnel, start it again (with Tailscale, `tailscale funnel --bg 8701`, and if it still answers nothing, `tailscale funnel reset` and then the same command again). That is it.

### Before the show
The things that bite if forgotten:
- **Custom Power-Ups**, if you use them: switch them on under Creator Dashboard → Power-ups & Channel Points before you go live.
- **Giveaway stock and claim links** ready for every giveaway in the pool, and one claim tested with a Twitch login.
- **Props** for every stunt and challenge in the pool: whatever your Outcomes call for, the costume, the pie, the oven mitts, the blindfold, the chopsticks.
- **Genre roulette** and **chat-rule** lists filled in, on the Pool page or under Config → Draw lists; the `!unlocks` command; the Firebot raffle tested once, through Giveaways page → Close & draw; the OBS browser source at 1920×1080 (3840×2160 works too, see Detail on the Config page). Config → Dance floor height sets how much of the frame the floor takes from the bottom, and Dance floor opacity fades the room out when an Outcome is watched on camera. The pads, the drop and the tip and sub lines stay, so nothing is missed while the room is down.
- **Try every moment once on the Debug page**, which only the streamer sees: a tip, bits, a sub, a gift, Cross the Threshold now, Drop a jumper, Open Tier 1, a floor-energy cue. All go through the real routes, so no bits or test hooks are needed. They land in the Ledger like anything else, marked `debug`. Void or re-bank them on the Ledger page when you are done. Drops from the Debug page skip the Firebot raffle, so nothing is announced in Twitch chat. To rehearse a giveaway, press Open a dry-run giveaway on the Debug page. The announcement, the countdown and Close & draw all run, but into a transcript on the page instead of chat.
- **Run the overlay in OBS once** with Quality on Auto and note where it settles. The Live page shows "Overlay · Level N". If it steps down a lot, set the level by hand on Config.
- **Send your mods the public address**, if they use the Dashboard from their own computers, and ask them to read this Help page.

### !unlocks command text
Paste this as a static `!unlocks` command in StreamElements or Firebot:

Tips and bits count in full. Subs count what the streamer actually keeps: $2 a Tier 1 or Prime sub, $3.50 Tier 2, $8.75 Tier 3, gifts per sub. Each unlock drops a parachute onto the board. Tips, bits and subs push the fader up. Contributions go towards filling it and a drop unlocks!

### Firebot raffle setup
- Install Firebot on the computer running the overlay and connect the channel and bot accounts.
- Import CaveMobster's `giveaway.firebotsetup` under Settings → Setups → Import. The file lives at `github.com/CaveMobster/firebot-setup-giveaway-command`. Answer the one import question. It creates the `!giveaway` command, which viewers join with `!giveaway enter`, plus the entrant role and the draw effects.
- Turn Firebot on from the Setup page or at the bottom of the Giveaways page. Auto-close after stays `off` unless you want the program to close and draw on its own. Type `5m` or `120s` there and chat is told the window.
- That is it. When a giveaway pad Fires it waits on the Giveaways page. Start runs `!giveaway start` and names the prize in chat. Entries stay open until a button on the Giveaways page. Firebot congratulates the winner in chat. Note the name in the Winner field on that Fire's row, then press Done to clear the list.
- Test it once before you go live. Queue +1 on the Pool page, Fire a giveaway pad, press Start on the Giveaways page, and watch chat run start → prize → entries → Close & draw → Done. Then Re-bank that Fire and Queue −1 to undo the test. Drops from the Debug page never open a raffle, so use a real Fire for this one.
- Fallback if Firebot is dead: type `!raffle 1 120` in chat and StreamElements runs it.
