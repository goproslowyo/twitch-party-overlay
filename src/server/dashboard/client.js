/*
 * Dashboard client. Every mutation goes through api(): a same-origin fetch carrying the CSRF header the API requires,
 * JSON in and out, the API's error envelope surfaced as a toast. The pages are server-rendered, so a successful mutation
 * simply reloads the page — except the Pool page's Outcome editor (the last section), which re-renders from
 * `/api/state` and keeps focus where it was. Money typed in dollars becomes cents by string arithmetic — never parseFloat.
 */
(function () {
  "use strict";

  var CSRF_HEADER = "X-Requested-With";
  var CSRF_VALUE = "twitch-party-overlay";
  var FIRE_ARM_MS = 4000;

  /**
   * Set once the Shut down confirm has been accepted by the server: from then on the process is going away, so every later
   * fetch is left pending (never a "failed to fetch" toast storm) and every toast is dropped. The page is replaced with one line.
   */
  var stopping = false;

  var toastTimer = null;
  /** Errors by default (red); `ok` for a confirmation ("… saved — live now"). */
  function toast(message, ok) {
    if (stopping) return;
    var el = document.getElementById("toast");
    if (!el) return alert(message);
    el.textContent = message;
    el.className = ok ? "ok" : "";
    el.style.display = "block";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.style.display = "none";
    }, 6000);
  }

  function api(method, path, body) {
    if (stopping) return new Promise(function () {}); // the server is gone or going: nothing to ask, nothing to report
    var headers = {};
    headers[CSRF_HEADER] = CSRF_VALUE;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          if (res.ok) return data;
          var message = data && data.error && data.error.message ? data.error.message : method + " " + path + " failed (" + res.status + ")";
          throw new Error(message);
        });
    });
  }

  /** HTML-escape a user string before it goes into innerHTML — the five characters the server's h escapes, the same way. */
  var esc = function (v) {
    return String(v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  /** Run a mutation; reload on success, toast on failure. */
  function run(promise) {
    promise
      .then(function () {
        location.reload();
      })
      .catch(function (e) {
        toast(e.message);
      });
  }

  function reasonFor(what) {
    var reason = prompt("Reason for " + what + "?");
    if (reason === null) return null;
    reason = reason.trim();
    if (reason === "") {
      toast("A reason is required");
      return null;
    }
    return reason;
  }

  /** "4.50" / "$4.5" / "12" → cents by string arithmetic; null when it is not a plain dollar amount. */
  function exactCents(text) {
    var m = /^\s*\$?(\d+)(?:\.(\d{0,2}))?\s*$/.exec(text);
    if (!m) return null;
    return Number(m[1]) * 100 + Number(((m[2] || "") + "00").slice(0, 2));
  }

  function positiveInt(text) {
    return /^\s*\d+\s*$/.test(text) && Number(text) > 0 ? Number(text) : null;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // FIRE — two taps: the first arms the button for 4 s, the second fires
  // -------------------------------------------------------------------------------------------------------------------

  var fire = document.getElementById("fire");
  if (fire) {
    var armed = null;
    var label = fire.textContent;
    var disarm = function () {
      if (armed) clearTimeout(armed);
      armed = null;
      fire.textContent = label;
      fire.classList.remove("armed");
      fire.disabled = false;
    };
    fire.addEventListener("click", function () {
      if (armed === null) {
        fire.textContent = "Tap again to Fire";
        fire.classList.add("armed");
        armed = setTimeout(disarm, FIRE_ARM_MS);
        return;
      }
      clearTimeout(armed);
      fire.disabled = true;
      fire.textContent = "Firing…";
      api("POST", "/api/fire")
        .then(function () {
          location.reload();
        })
        .catch(function (e) {
          toast(e.message);
          disarm();
        });
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Buttons: data-action="…" (forms carry data-action too, but are handled on submit below)
  // -------------------------------------------------------------------------------------------------------------------

  document.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-action]");
    if (!el || el.tagName === "FORM") return;
    var d = el.dataset;
    var reason;
    switch (d.action) {
      case "dismiss":
        run(api("POST", "/api/health/" + encodeURIComponent(d.id) + "/dismiss"));
        break;
      case "void":
        reason = reasonFor("voiding #" + d.seq);
        if (reason) run(api("POST", "/api/contributions/" + d.seq + "/void", { reason: reason }));
        break;
      case "rebank":
        // "Put it back" on Live, "Re-bank" on the Ledger page — one route, plain words in the prompt
        reason = reasonFor("putting #" + d.seq + " back");
        if (reason) run(api("POST", "/api/fires/" + d.seq + "/rebank", { reason: reason }));
        break;
      case "fire":
        // "Draw again" (Live): there is exactly one FIRE button — arm it and bring it into view; the second tap fires
        if (fire) {
          fire.scrollIntoView({ block: "center", behavior: "smooth" });
          fire.focus({ preventScroll: true });
          fire.click();
        }
        break;
      case "queue": {
        var delta = Number(d.delta);
        reason = reasonFor((delta > 0 ? "adding " : "removing ") + Math.abs(delta) + " unlock" + (Math.abs(delta) === 1 ? "" : "s"));
        if (reason) run(api("POST", "/api/queue/adjust", { delta: delta, reason: reason }));
        break;
      }
      case "threshold":
        run(api("POST", "/api/threshold", { cents: Number(d.cents) }));
        break;
      case "copy":
        // Config → Overlay URL for OBS: the localhost URL onto the clipboard, a toast either way, no reload
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(d.text).then(
            function () { toast("Copied " + d.text, true); },
            function () { toast("Could not copy. Select the link and copy it by hand."); },
          );
        } else {
          toast("Could not copy. Select the link and copy it by hand.");
        }
        break;
      // Debug panel (streamer only, pages.ts debugPage): the same routes Twitch / Ko-fi / a mod would hit, no prompts
      case "debug-credit":
        run(Promise.resolve().then(function () { return api("POST", "/api/contributions", debugCredit(JSON.parse(d.face))); }));
        break;
      case "debug-cross":
        // one tip that takes Progress exactly to the Threshold (×N crosses it N times), at the policy's tip rate
        run(
          withState(function (st) {
            return api("GET", "/api/config").then(function (data) {
              if (st.thresholdCents === 0) throw new Error("Threshold is 0 — set one on Config first");
              var rate = data.config.policy.tipPercent / 100;
              if (!(rate > 0)) throw new Error("Tips credit 0 % under the current policy");
              var cents = Math.ceil(Math.max(1, st.thresholdCents * Number(d.times || 1) - st.progressCents) / rate);
              return api("POST", "/api/contributions", debugCredit({ kind: "tip", cents: cents }));
            });
          }),
        );
        break;
      case "debug-queue":
        run(api("POST", "/api/queue/adjust", { delta: Number(d.delta), reason: "debug panel" }));
        break;
      case "debug-tier":
        // bank exactly enough Unlocks to reach the gate (the page showed the gates still ahead; check again in case it moved)
        run(
          withState(function (st) {
            var delta = Number(d.gate) - st.bankedTotal;
            if (delta < 1) throw new Error("That tier is already open");
            return api("POST", "/api/queue/adjust", { delta: delta, reason: "debug panel: open tier" });
          }),
        );
        break;
      case "debug-drop":
        // fire the next READY Unlock — one tap, no arm: this is the test board. Empty queue: bank one first. Drained pool:
        // restock one charge on a random live, restockable Outcome first, so the button always drops something.
        run(
          withState(function (st) {
            var steps = Promise.resolve();
            if (st.drained) {
              var options = st.outcomes.filter(function (o) {
                return o.restockable && o.status === "live" && o.tier <= st.tier;
              });
              if (options.length === 0) throw new Error("Pool drained and nothing restockable is live — restock an Outcome on the Pool page");
              var pick = options[Math.floor(Math.random() * options.length)];
              steps = api("POST", "/api/outcomes/" + encodeURIComponent(pick.id) + "/restock", { charges: 1 });
            }
            if (st.queue.length === 0) {
              steps = steps.then(function () {
                return api("POST", "/api/queue/adjust", { delta: 1, reason: "debug panel: drop" });
              });
            }
            return steps.then(function () {
              return api("POST", "/api/fire", { raffle: false }); // never a Firebot raffle: a test drop must not reach Twitch chat
            });
          }),
        );
        break;
      case "debug-cue":
        sendCue(d.name, d.value);
        break;
      // Giveaways page: Firebot holds the entries; close = close + draw (the winner is named in chat), draw = one more pick
      case "debug-giveaway":
        run(api("POST", "/api/giveaway/dry-run"));
        break;
      // Debug page: a made-up person on the dance floor / a hop for someone already there. Nothing is written
      // and no page state changes, so no reload: a toast names who walked on or who hopped (textContent, never HTML).
      case "debug-chatter":
        api("POST", "/api/chatters/fake")
          .then(function (data) { toast("Fake chatter added: " + data.chatter.name, true); })
          .catch(function (e) { toast(e.message); });
        break;
      case "debug-chat-hop":
        api("POST", "/api/chatters/hop")
          .then(function (data) { toast("Hopped " + data.chatter.name, true); })
          .catch(function (e) { toast(e.message); });
        break;
      // Giveaways page: one Firebot subcommand per button (close-and-draw is two); Done asks first — after clear the
      // winner cannot be re-drawn
      case "giveaway-close":
      case "giveaway-close-and-draw":
      case "giveaway-draw":
      case "giveaway-reopen":
        run(api("POST", "/api/giveaway/" + d.action.replace("giveaway-", "")));
        break;
      case "giveaway-clear":
        el.hidden = true;
        document.getElementById("giveaway-clear-confirm").hidden = false;
        break;
      case "giveaway-clear-cancel":
        document.getElementById("giveaway-clear-confirm").hidden = true;
        document.querySelector('[data-action="giveaway-clear"]').hidden = false;
        break;
      case "giveaway-clear-confirm":
        run(api("POST", "/api/giveaway/clear"));
        break;
      case "validate":
        validateJson();
        break;
      case "shutdown":
        // Config → Shut down: the inline confirm replaces the button (no window.confirm)
        el.hidden = true;
        document.getElementById("shutdown-confirm").hidden = false;
        break;
      case "shutdown-cancel":
        document.getElementById("shutdown-confirm").hidden = true;
        document.querySelector('[data-action="shutdown"]').hidden = false;
        break;
      case "shutdown-confirm":
        shutDown(el);
        break;
    }
  });

  /** "Yes, shut down": post the confirm word; on the 200 the page becomes one line and goes quiet — the process exits half a second later. */
  function shutDown(button) {
    var buttons = document.querySelectorAll("#shutdown-confirm button");
    buttons.forEach(function (b) {
      b.disabled = true;
    });
    button.textContent = "Shutting down…";
    api("POST", "/api/shutdown", { confirm: "SHUTDOWN" })
      .then(function () {
        stopping = true;
        document.body.innerHTML = '<main><section><p>Shutting down… start it again on the computer running the overlay.</p></section></main>';
      })
      .catch(function (e) {
        buttons.forEach(function (b) {
          b.disabled = false;
        });
        button.textContent = "Yes, shut down";
        toast(e.message);
      });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Forms
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * The Manual Credit form → a contribution face. "kofi" is a tip face (the API stamps every Manual Credit `source: "manual"`);
   * the submit handler adds `message: "Ko-fi"` so the Ledger summary can still tell it from a StreamElements tip.
   */
  function faceFrom(form) {
    var kind = form.elements.kind.value;
    var amount = form.elements.amount.value;
    var tier = form.elements.tier.value;
    switch (kind) {
      case "tip":
      case "kofi": {
        var cents = exactCents(amount);
        if (cents === null || cents < 1) throw new Error("Amount must be dollars, e.g. 4.50");
        return { kind: "tip", cents: cents };
      }
      case "bits": {
        var bits = positiveInt(amount);
        if (bits === null) throw new Error("Bits must be a whole number");
        return { kind: "bits", bits: bits };
      }
      case "sub":
        return { kind: "sub", tier: tier };
      case "gift": {
        var count = positiveInt(amount);
        if (count === null) throw new Error("Gift count must be a whole number");
        return { kind: "gift", tier: tier, count: count };
      }
      default:
        throw new Error("Pick a kind");
    }
  }

  /** A Debug-panel credit body: the face, plus the name box unless Anonymous is ticked; `message: "debug"` marks it in the Ledger. */
  function debugCredit(face) {
    var body = { face: face, message: "debug" };
    var nameBox = document.getElementById("debug-name");
    var anon = document.getElementById("debug-anon");
    var name = nameBox ? nameBox.value.trim() : "";
    if (!(anon && anon.checked) && name !== "") body.displayName = name;
    return body;
  }

  /** Read the live State first, then act on it — the Debug page's numbers may be stale by the time a button is tapped. */
  function withState(fn) {
    return api("GET", "/api/state").then(function (data) {
      return fn(data.state);
    });
  }

  /** A cue for the overlay (Debug page buttons and form). Cues write nothing, so no reload — a toast says it went. */
  function sendCue(name, rawValue) {
    if (!name) return toast("Cue name?");
    var body = { name: name };
    if (rawValue !== undefined && rawValue !== "") {
      var value = Number(rawValue);
      if (!isFinite(value)) return toast("Value must be a number");
      body.value = value;
    }
    api("POST", "/api/cue", body)
      .then(function () {
        toast("Cue sent: " + name + (body.value === undefined ? "" : " " + body.value), true);
      })
      .catch(function (e) {
        toast(e.message);
      });
  }

  /**
   * "5m", "120s", "2m30s", "90" (seconds), "off" / "" / "0" → whole seconds (0 = off); anything else → null.
   * The inverse of pages.ts's durationText.
   */
  function parseDuration(text) {
    var t = text.trim().toLowerCase();
    if (t === "" || t === "off" || t === "0") return 0;
    if (/^\d+$/.test(t)) return Number(t);
    var m = /^(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
    if (!m || (m[1] === undefined && m[2] === undefined)) return null;
    return Number(m[1] || 0) * 60 + Number(m[2] || 0);
  }

  var giveawayStart = document.getElementById("giveaway-start");
  if (giveawayStart) {
    giveawayStart.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var prize = giveawayStart.elements.prize.value.trim();
      if (prize === "") return toast("What is the prize?");
      var startBody = { prize: prize };
      if (giveawayStart.dataset.fireSeq) startBody.fireSeq = Number(giveawayStart.dataset.fireSeq); // the waiting Fire, prize as edited
      run(api("POST", "/api/giveaway/start", startBody));
    });
  }

  // "Firebot still holds a giveaway from before a restart": nothing is tracked here, so the act buttons are greyed;
  // the box turns them on for the person who knows better (Start stays as it is — a new giveaway is a different thing)
  var takeover = document.getElementById("giveaway-takeover");
  if (takeover) {
    takeover.addEventListener("change", function () {
      ["giveaway-close-and-draw", "giveaway-close", "giveaway-draw", "giveaway-reopen", "giveaway-clear"].forEach(function (action) {
        var b = document.querySelector('[data-action="' + action + '"]');
        if (b) b.disabled = !takeover.checked;
      });
    });
  }

  var giveawaySettings = document.getElementById("giveaway-settings");
  if (giveawaySettings) {
    giveawaySettings.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var seconds = parseDuration(giveawaySettings.elements.autoClose.value);
      if (seconds === null) return toast("Auto-close: type a time like 5m or 120s, or off");
      run(
        api("GET", "/api/config").then(function (data) {
          var cfg = data.config;
          cfg.firebot.enabled = giveawaySettings.elements.firebotEnabled.checked;
          cfg.firebot.autoCloseSeconds = seconds;
          return api("PUT", "/api/config", cfg);
        }),
      );
    });
  }

  var debugCue = document.getElementById("debug-cue");
  if (debugCue) {
    debugCue.addEventListener("submit", function (ev) {
      ev.preventDefault();
      sendCue(debugCue.elements.name.value.trim(), debugCue.elements.value.value.trim());
    });
  }

  var credit = document.getElementById("credit");
  if (credit) {
    var syncCredit = function () {
      var kind = credit.elements.kind.value;
      var amountField = document.getElementById("credit-amount");
      var tierField = document.getElementById("credit-tier");
      amountField.hidden = kind === "sub";
      tierField.hidden = kind === "tip" || kind === "kofi" || kind === "bits";
      amountField.querySelector("span").textContent = kind === "bits" ? "Bits" : kind === "gift" ? "Number of gift subs" : "Dollars";
      credit.elements.amount.inputMode = kind === "bits" || kind === "gift" ? "numeric" : "decimal";
    };
    credit.elements.kind.addEventListener("change", syncCredit);
    syncCredit();
    credit.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var body;
      try {
        body = { face: faceFrom(credit) };
      } catch (e) {
        return toast(e.message);
      }
      var name = credit.elements.displayName.value.trim();
      if (!credit.elements.anonymous.checked && name !== "") body.displayName = name;
      if (credit.elements.kind.value === "kofi") body.message = "Ko-fi";
      run(api("POST", "/api/contributions", body));
    });
  }

  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (form.dataset.action !== "winner") return;
    ev.preventDefault();
    var winner = form.elements.winner.value.trim();
    if (winner === "") return toast("Type the winner's name");
    run(api("POST", "/api/fires/" + form.dataset.seq + "/winner", { winner: winner }));
  });

  var thresholdForm = document.getElementById("threshold-form");
  if (thresholdForm) {
    thresholdForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var cents = exactCents(document.getElementById("threshold-custom").value);
      if (cents === null || cents < 1) return toast("Threshold must be dollars, e.g. 35");
      run(api("POST", "/api/threshold", { cents: cents }));
    });
  }

  /** The config the server rendered this page from (`#config-data`), or null on pages without it. */
  function serverConfig() {
    var el = document.getElementById("config-data");
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch (e) {
      return null;
    }
  }

  var quick = document.getElementById("quick");
  if (quick) {
    // Browsers (Firefox especially) restore form control values across a reload, so a select can show the choice from
    // before the save while the server holds the saved one — and the next quick save would submit the stale value.
    // The form is autocomplete="off"; on top of that, set every control from the config the server rendered.
    var current = serverConfig();
    if (current) {
      quick.elements.side.value = current.overlay.side;
      quick.elements.brand.value = current.overlay.brand;
      quick.elements.theme.value = current.overlay.theme;
      quick.elements["overlay.quality"].value = String(current.overlay.quality);
      quick.elements["overlay.renderScale"].value = current.overlay.renderScale;
      quick.elements["overlay.webgl"].value = current.overlay.webgl;
      quick.elements["overlay.floorPercent"].value = String(current.overlay.floorPercent);
      quick.elements["overlay.floorOpacity"].value = String(current.overlay.floorOpacity);
      var editor = document.getElementById("config-json");
      if (editor) editor.value = JSON.stringify(current, null, 2);
      var listsForm0 = document.getElementById("lists-form");
      if (listsForm0) {
        // the list keys come from the form's data-lists (pages.ts's LIST_NAMES), never from this script
        Object.keys(JSON.parse(listsForm0.dataset.lists)).forEach(function (key) {
          listsForm0.elements[key].value = current.lists[key].join("\n");
        });
      }
    }
    // the sliders: the readout follows the thumb, and letting go saves the form — the overlay follows at once, so the
    // room can be dimmed or raised mid-set without a Save click
    Array.prototype.forEach.call(quick.querySelectorAll('input[type="range"]'), function (slider) {
      var readout = quick.querySelector('output[data-for="' + slider.name + '"]');
      var show = function () { if (readout) readout.textContent = slider.value; };
      show();
      slider.addEventListener("input", show);
      slider.addEventListener("change", function () { quick.requestSubmit(); });
    });
    quick.addEventListener("submit", function (ev) {
      ev.preventDefault();
      run(
        api("GET", "/api/config").then(function (data) {
          var cfg = data.config;
          cfg.overlay.side = quick.elements.side.value;
          cfg.overlay.brand = quick.elements.brand.value;
          cfg.overlay.theme = quick.elements.theme.value;
          var quality = quick.elements["overlay.quality"].value;
          cfg.overlay.quality = quality === "auto" ? "auto" : Number(quality); // 1..5 | "auto"
          cfg.overlay.renderScale = quick.elements["overlay.renderScale"].value; // "1x" | "1.5x" | "2x"
          cfg.overlay.webgl = quick.elements["overlay.webgl"].value;
          cfg.overlay.floorPercent = Number(quick.elements["overlay.floorPercent"].value); // a whole percent; the server holds the 15..60 rule
          cfg.overlay.floorOpacity = Number(quick.elements["overlay.floorOpacity"].value); // 0..100
          return api("PUT", "/api/config", cfg);
        }),
      );
    });
  }

  // Config → Overlay URL for OBS: "OBS runs on another computer" saves listeners.overlayOnLan as soon as it is
  // ticked, through the whole-config PUT like the quick settings; the page reloads so the network addresses appear
  // under it. The listener itself rebinds on the next start, which the copy under the box says.
  var overlayLan = document.getElementById("overlay-lan");
  if (overlayLan) {
    var lanBox = overlayLan.elements["listeners.overlayOnLan"];
    var current1 = serverConfig();
    if (current1) lanBox.checked = current1.listeners.overlayOnLan; // never a browser-restored value (see quick settings)
    lanBox.addEventListener("change", function () {
      run(
        api("GET", "/api/config").then(function (data) {
          var cfg = data.config;
          cfg.listeners.overlayOnLan = lanBox.checked;
          return api("PUT", "/api/config", cfg);
        }),
      );
    });
  }

  // Chatter Dancers (Config page): three sliders that save as they are let go, the Chat Bot list one login per
  // line. Everything goes through the whole-config PUT like the quick settings. Controls are set from the server's
  // config, never from browser-restored values.
  var chattersForm = document.getElementById("chatters");
  if (chattersForm) {
    var chattersCurrent = serverConfig();
    if (chattersCurrent) {
      chattersForm.elements["chatters.windowMinutes"].value = String(chattersCurrent.chatters.windowMinutes);
      chattersForm.elements["chatters.nameLength"].value = String(chattersCurrent.chatters.nameLength);
      chattersForm.elements["chatters.dwellSeconds"].value = String(chattersCurrent.chatters.dwellSeconds);
      chattersForm.elements["chatters.bots"].value = chattersCurrent.chatters.bots.join("\n");
    }
    Array.prototype.forEach.call(chattersForm.querySelectorAll('input[type="range"]'), function (slider) {
      var readout = chattersForm.querySelector('output[data-for="' + slider.name + '"]');
      var show = function () { if (readout) readout.textContent = slider.value; };
      show();
      slider.addEventListener("input", show);
      slider.addEventListener("change", function () { chattersForm.requestSubmit(); });
    });
    chattersForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      run(
        api("GET", "/api/config").then(function (data) {
          var cfg = data.config;
          cfg.chatters.windowMinutes = Number(chattersForm.elements["chatters.windowMinutes"].value); // 5..240; the server holds the rule
          cfg.chatters.nameLength = Number(chattersForm.elements["chatters.nameLength"].value); // 4..25
          cfg.chatters.dwellSeconds = Number(chattersForm.elements["chatters.dwellSeconds"].value); // 30..300
          // one login per line; the server lower-cases, trims, dedupes and drops blanks as well (schema.ts normaliseBots)
          cfg.chatters.bots = chattersForm.elements["chatters.bots"].value.split("\n").map(function (line) { return line.trim().toLowerCase(); }).filter(function (line) { return line !== ""; });
          return api("PUT", "/api/config", cfg);
        }),
      );
    });
  }

  /**
   * Textarea text (one item per line) or Pool-page rows → the list the server stores: each item trimmed and upper-cased
   * (items show in CAPS on the pad, so they are stored that way — the two Dashboard surfaces always agree), blanks
   * dropped, exact repeats kept once (order kept). Mirrors schema.ts's normaliseList (the source of truth — this script
   * cannot import it), minus the length cut the server refuses.
   */
  function itemsOf(source) {
    var lines = typeof source === "string" ? source.split(/\r?\n/) : source;
    var out = [];
    lines.forEach(function (line) {
      var item = line.trim().toUpperCase();
      if (item === "" || out.indexOf(item) !== -1) return;
      out.push(item);
    });
    return out;
  }

  /** Non-blank lines (or rows) typed — what the streamer sees as "lines", so a repeat that was dropped shows as kept N of M. */
  function typedCount(source) {
    var lines = typeof source === "string" ? source.split(/\r?\n/) : source;
    return lines.filter(function (line) {
      return line.trim() !== "";
    }).length;
  }

  /**
   * One row of a Pool-page list editor: the radio is the selection (never a tab stop), the input is the item. pages.ts's
   * listRow paints these bytes for the first paint; this one re-paints after a save.
   */
  function listRow(key, name, max, item) {
    return (
      '<li class="lrow"><input type="radio" name="sel-' +
      key +
      '" tabindex="-1" aria-label="Select this row"><input class="item" maxlength="' +
      max +
      '" value="' +
      esc(item) +
      '" spellcheck="false" autocomplete="off" aria-label="' +
      esc(name) +
      ' item" style="text-transform:uppercase"></li>'
    );
  }

  // Draw lists (Config page): the two mini-draw lists, one item per line; saved through the whole-config PUT like the
  // quick settings, so a server-side rejection (an Outcome still draws from an emptied list) shows in the form.
  var listsForm = document.getElementById("lists-form");
  if (listsForm) {
    var LIST_NAMES = JSON.parse(listsForm.dataset.lists); // key → label, from the server (pages.ts's LIST_NAMES)
    listsForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var status = document.getElementById("lists-status");
      status.textContent = "";
      status.className = "";
      var dropped = [];
      api("GET", "/api/config")
        .then(function (data) {
          var cfg = data.config;
          Object.keys(LIST_NAMES).forEach(function (key) {
            var text = listsForm.elements[key].value;
            var items = itemsOf(text);
            var typed = typedCount(text);
            if (items.length < typed) dropped.push(LIST_NAMES[key] + ": kept " + items.length + " of " + typed + " lines (repeats dropped)");
            cfg.lists[key] = items;
          });
          return api("PUT", "/api/config", cfg);
        })
        .then(function () {
          if (dropped.length === 0) return location.reload();
          // say what was dropped before the reload wipes the form
          status.textContent = dropped.join("\n");
          toast("Draw lists saved — " + dropped.join("; "), true);
          setTimeout(function () {
            location.reload();
          }, 2500);
        })
        .catch(function (e) {
          status.textContent = e.message;
          status.className = "err";
          toast("Draw lists not saved");
        });
    });
  }

  // Draw lists (Pool page): one row editor per list — + adds a row, − removes the selected one (it asks in the row),
  // Save PUTs the whole config exactly as the Config page does, so the two surfaces can never disagree. The server
  // painted the rows; after a save they are re-painted from its answer (no reload — the Pool page never reloads).
  // Selection follows a click, typing, or ↑ ↓ — never Tab, so Tab can carry focus from the picked row to the − button.
  Array.prototype.forEach.call(document.querySelectorAll("form.list-editor"), function (form) {
    var key = form.dataset.list;
    var name = form.dataset.name;
    var max = Number(form.dataset.max);
    var rows = form.querySelector("ul.lrows");
    var addBtn = form.querySelector('[data-list-act="add"]');
    var removeBtn = form.querySelector('[data-list-act="remove"]');
    var saveBtn = form.querySelector('button[type="submit"]');
    var status = form.querySelector(".lstatus");
    var busy = false;

    var values = function () {
      return Array.prototype.map.call(rows.querySelectorAll("input.item"), function (input) {
        return input.value;
      });
    };
    var saved = itemsOf(values()); // what the server holds — it painted these rows
    var selected = function () {
      var radio = rows.querySelector('input[type="radio"]:checked');
      return radio ? radio.closest("li.lrow") : null;
    };
    var say = function (text, cls) {
      status.textContent = text;
      status.className = "lstatus small" + (cls ? " " + cls : "");
    };
    var sync = function () {
      saveBtn.disabled = busy || itemsOf(values()).join("\n") === saved.join("\n");
      removeBtn.disabled = busy || selected() === null;
    };
    var select = function (li) {
      var open = rows.querySelector("li.confirming");
      if (open && open !== li) cancelConfirm(); // one question at a time: picking another row closes a stale "Remove?"
      Array.prototype.forEach.call(rows.children, function (row) {
        row.classList.toggle("selected", row === li);
      });
      if (li) li.querySelector('input[type="radio"]').checked = true;
      else {
        var radio = rows.querySelector('input[type="radio"]:checked');
        if (radio) radio.checked = false;
      }
      sync();
    };
    var focusRow = function (li, atEnd) {
      var input = li.querySelector("input.item");
      input.focus();
      if (atEnd) input.setSelectionRange(input.value.length, input.value.length);
      select(li);
    };
    var cancelConfirm = function () {
      var li = rows.querySelector("li.confirming");
      if (!li) return null;
      li.classList.remove("confirming");
      li.querySelector(".confirm").remove();
      return li;
    };
    var addRow = function (after) {
      cancelConfirm();
      var li;
      if (after) {
        after.insertAdjacentHTML("afterend", listRow(key, name, max, ""));
        li = after.nextElementSibling;
      } else {
        rows.insertAdjacentHTML("beforeend", listRow(key, name, max, ""));
        li = rows.lastElementChild;
      }
      focusRow(li, false);
    };
    var removeRow = function (li) {
      var next = li.previousElementSibling || li.nextElementSibling;
      li.remove();
      if (next) focusRow(next, true);
      else {
        select(null);
        addBtn.focus();
      }
    };
    /** − on a row with text asks in the row (Enter = Remove, Esc = Cancel); an empty row just goes. */
    var askRemove = function (li) {
      var text = li.querySelector("input.item").value.trim().toUpperCase();
      if (text === "") return removeRow(li);
      cancelConfirm();
      li.classList.add("confirming");
      li.insertAdjacentHTML(
        "beforeend",
        '<span class="confirm"><span>Remove <b>"' + esc(text) + '"</b>?</span><button type="button" class="sm danger" data-list-act="confirm">Remove</button><button type="button" class="sm" data-list-act="cancel">Cancel</button></span>',
      );
      li.querySelector('[data-list-act="confirm"]').focus();
    };
    /** Re-paint from the saved list; focus that was in a row stays on that row (the rows are new elements). */
    var paint = function (items) {
      var focused = Array.prototype.indexOf.call(rows.querySelectorAll("input.item"), document.activeElement);
      rows.innerHTML = items
        .map(function (item) {
          return listRow(key, name, max, item);
        })
        .join("");
      if (focused >= 0 && rows.children.length > 0) focusRow(rows.children[Math.min(focused, rows.children.length - 1)], true);
      else sync();
    };

    // data-list-act, never data-act — the Outcome editor's document click handler acts on any [data-act] it sees
    form.addEventListener("click", function (ev) {
      var btn = ev.target.closest("button[data-list-act]");
      var li = ev.target.closest("li.lrow");
      if (btn) {
        var act = btn.dataset.listAct;
        if (act === "add") addRow(null);
        else if (act === "remove") {
          var sel = selected();
          if (sel) askRemove(sel);
        } else if (act === "confirm") {
          var gone = cancelConfirm();
          if (gone) removeRow(gone);
        } else if (act === "cancel") {
          var kept = cancelConfirm();
          if (kept) focusRow(kept, true);
        }
        return;
      }
      if (li && !li.classList.contains("confirming")) select(li);
    });
    rows.addEventListener("input", function (ev) {
      var li = ev.target.closest("li.lrow");
      if (li) select(li); // the row being typed in is the one − would remove; select() re-syncs Save
    });
    form.addEventListener("keydown", function (ev) {
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === "s" || ev.key === "S" || ev.key === "Enter")) {
        ev.preventDefault();
        if (!saveBtn.disabled) form.requestSubmit();
        return;
      }
      // Keys the Pool page's document handler also reads (Esc clears the filter, arrows walk the Outcome table) stay
      // inside the list editor while focus is here — the same separation `data-list-act` gives the click handler.
      if (ev.key === "Escape" || ev.key === "ArrowDown" || ev.key === "ArrowUp") ev.stopPropagation();
      var li = ev.target.closest("li.lrow");
      if (!li) return;
      if (li.classList.contains("confirming")) {
        // Enter activates the focused Remove / Cancel button natively; Esc cancels and goes back to the row
        if (ev.key === "Escape") {
          ev.preventDefault();
          ev.stopPropagation();
          focusRow(cancelConfirm(), true);
        }
        return;
      }
      if (!ev.target.classList.contains("item")) return;
      if (ev.key === "Enter") {
        ev.preventDefault();
        addRow(li);
      } else if (ev.key === "Backspace" && ev.target.value === "") {
        ev.preventDefault();
        removeRow(li);
      } else if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        var to = ev.key === "ArrowDown" ? li.nextElementSibling : li.previousElementSibling;
        if (to) {
          ev.preventDefault();
          focusRow(to, true);
        }
      }
    });
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (busy) return;
      cancelConfirm();
      var typed = values();
      var items = itemsOf(typed);
      var count = typedCount(typed);
      var note = items.length < count ? "kept " + items.length + " of " + count + " rows (repeats dropped)" : "";
      busy = true;
      sync();
      say("Saving…", "muted");
      api("GET", "/api/config")
        .then(function (data) {
          var cfg = data.config;
          cfg.lists[key] = items;
          return api("PUT", "/api/config", cfg);
        })
        .then(function (data) {
          busy = false;
          saved = data && data.config && data.config.lists && data.config.lists[key] ? data.config.lists[key] : items;
          paint(saved);
          say("Saved" + (note ? " — " + note : "") + ". Applies the next time the Outcome comes up.", "ok");
          toast(name + " saved" + (note ? " — " + note : ""), true);
        })
        .catch(function (e) {
          // the rows stay as typed — the server's message (an Outcome still draws from an emptied list, say) is the fix
          busy = false;
          sync();
          say(e.message, "err");
          toast(name + " not saved");
        });
    });
  });

  function configStatus(text, ok) {
    var el = document.getElementById("config-status");
    el.textContent = text;
    el.className = ok ? "ok" : "err";
  }

  function validateJson() {
    try {
      JSON.parse(document.getElementById("config-json").value);
      configStatus("Valid JSON", true);
      return true;
    } catch (e) {
      configStatus("Invalid JSON: " + e.message, false);
      return false;
    }
  }

  var configForm = document.getElementById("config-form");
  if (configForm) {
    configForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!validateJson()) return;
      api("PUT", "/api/config", JSON.parse(document.getElementById("config-json").value))
        .then(function () {
          location.reload();
        })
        .catch(function (e) {
          configStatus(e.message, false);
        });
    });
  }
  // ===== Outcome editor (Pool page) — a table grouped by Tier, expand in place =====================
  // State comes from the `#pool-data` island the server rendered; every change goes to the API, then `/api/state` is
  // fetched and the section re-rendered in place (no reload) with focus back on the row. Keyboard model: one tab stop
  // per row (row buttons and `?` tooltips are never stops); inside an open form Tab cycles the form's fields and wraps;
  // shortcuts are off while typing; key hints show only while navigating by keyboard (`body.kbd`), never on phones.

  var poolIsland = document.getElementById("pool-data");
  if (poolIsland) {
    var P = JSON.parse(poolIsland.textContent);
    var TIPS = P.tips;
    var GATES = P.gates;
    var LISTS = P.lists;
    var DESCRIPTION_MAX = P.descriptionMax;
    var SHAPES = ["challenge", "giveaway", "moment", "stunt"];
    var LABELS = { glyph: "Glyph", name: "Name", shape: "Shape", tier: "Tier", occupancy: "Occupancy", description: "What it is", restockable: "Restockable", raffle: "Firebot raffle", miniDraw: "Mini-draw", used: "Used", left: "Left", status: "Status", id: "Id", delete: "Delete", retire: "Retire", filter: "Filter" };
    var isStreamer = P.role === "streamer";
    var outcomes = P.outcomes;
    var openTier = P.openTier;
    var queue = P.queue;
    var editing = null; // outcome id being edited, "new" for add, or null
    var draft = null; // working copy of the form
    var filter = "";
    var legend = false;
    var focusAfter = null; // id of the row to focus after render
    var busy = false; // one request at a time; a second click while saving is ignored
    var isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    var MODKEY = isMac ? "⌘" : "Ctrl";
    var section = document.getElementById("pool");

    var byId = function (id) {
      for (var i = 0; i < outcomes.length; i++) if (outcomes[i].id === id) return outcomes[i];
      return null;
    };
    /** The id the server will derive from a name (`slugId`): the preview on the add form. */
    var slug = function (name) {
      var base =
        name
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "outcome";
      if (!byId(base)) return base;
      for (var n = 2; ; n++) if (!byId(base + "-" + n)) return base + "-" + n;
    };
    var newDraft = function (tier) {
      return { id: "", name: "", glyph: "🎯", shape: "challenge", tier: tier, left: 1, used: 0, status: "live", restockable: true, occupancy: "", description: "", miniDraw: undefined, raffle: false };
    };
    var sorted = function () {
      return outcomes.slice().sort(function (a, b) {
        return a.tier - b.tier;
      });
    };
    var flags = function (o) {
      return [o.restockable ? "restockable" : "one-off", o.raffle === true ? "raffle" : "", o.miniDraw ? "draws " + LISTS[o.miniDraw].toLowerCase() : ""]
        .filter(function (f) {
          return f !== "";
        })
        .join(" · ");
    };
    var matches = function (o) {
      if (!filter) return true;
      return [o.name, o.shape, "tier " + o.tier, o.status, o.occupancy, o.description, flags(o)].join(" ").toLowerCase().indexOf(filter.toLowerCase()) >= 0;
    };
    // tooltips are never tab stops: hover / tap for the mouse, the help bar for the keyboard
    var tip = function (key) {
      return '<i class="tip" data-tip="' + key + '" aria-hidden="true">?<span class="bubble">' + esc(TIPS[key]) + "</span></i>";
    };
    // key hint: underline the letter when it is in the word, else a faint suffix; CSS shows them only while body.kbd
    var hint = function (label, key) {
      var i = label.toLowerCase().indexOf(key);
      if (i < 0) return "<span>" + label + '<span class="k">' + key + "</span></span>";
      return "<span>" + label.slice(0, i) + '<u class="k">' + label[i] + "</u>" + label.slice(i + 1) + "</span>";
    };

    // --- markup (mirrors pages.ts's pool(): the server paints the same rows first; the buttons must match byte for byte —
    // each carries its TIP as the native title and data-help for the help bar)
    var rowButtons = function (o) {
      var b = [];
      var button = function (act, label, key, danger) {
        return '<button type="button" class="sm' + (danger ? " danger" : "") + '" data-act="' + act + '" data-id="' + esc(o.id) + '" tabindex="-1" title="' + esc(TIPS[act]) + '" data-help="' + act + '">' + hint(label, key) + "</button>";
      };
      if (o.status === "live") b.push(button("suspend", "Suspend", "s"));
      if (o.status === "suspended") b.push(button("resume", "Resume", "s"));
      if (o.status !== "retired") {
        if (o.restockable) b.push(button("restock", "Restock +1", "r"));
        b.push(button("retire", "Retire", "x", true));
      }
      return b.join("");
    };
    // the What it is line: an ⓘ after the name whose bubble is the description — nothing at all when there is nothing to say; no row title
    var info = function (o) {
      return o.description ? '<i class="tip info" data-tip="description" title="" aria-hidden="true">i<span class="bubble">' + esc(o.description) + "</span></i>" : "";
    };
    var rowHtml = function (o) {
      var open = editing === o.id;
      return (
        '<tr class="orow' + (open ? " open" : "") + (o.status === "retired" ? " retired" : "") + '" tabindex="0"' + (isStreamer ? ' role="button" aria-expanded="' + open + '"' : "") + ' data-act="' + (isStreamer ? "edit" : "noop") + '" data-id="' + esc(o.id) + '">' +
        '<td class="glyph">' + (isStreamer ? '<span class="caret dsk">▸</span>' : "") + esc(o.glyph) + "</td>" +
        '<td class="name"><strong>' + esc(o.name) + "</strong>" + info(o) + '<span class="sub">' + o.shape + " · " + esc(o.occupancy) + " · " + flags(o) + "</span></td>" +
        '<td class="meta mob">' + o.shape + " · " + esc(o.occupancy) + "</td>" +
        '<td class="num used muted">' + o.used + "</td>" +
        '<td class="num left"><strong>' + o.left + '</strong><small class="mob">' + o.used + " used</small></td>" +
        '<td class="status status-' + o.status + '">' + o.status + "</td>" +
        '<td class="act"><div class="actions">' + rowButtons(o) + "</div></td></tr>"
      );
    };
    var tierHeader = function (tier) {
      return '<tr class="tier"><th colspan="7">Tier ' + tier + (tier > openTier ? " (locked)" : "") + "<span>" + (tier === 0 ? "live from the start" : "opens at " + GATES[tier] + " banked") + "</span></th></tr>";
    };
    var formHtml = function (d) {
      var isNew = editing === "new";
      var canDelete = !isNew && d.used === 0;
      var tierOptions = GATES.map(function (g, i) {
        return '<option value="' + i + '"' + (i === d.tier ? " selected" : "") + ">Tier " + i + (i === 0 ? " — live from the start" : " — opens at " + g + " banked") + (i > openTier ? " (still locked)" : "") + "</option>";
      }).join("");
      var listOptions = Object.keys(LISTS).map(function (k) {
        return '<option value="' + k + '"' + (k === d.miniDraw ? " selected" : "") + ">" + esc(LISTS[k]) + "</option>";
      }).join("");
      var idLine = isNew
        ? "Id will be <code>" + esc(slug(d.name || "")) + "</code> " + tip("id")
        : "Id <code>" + esc(d.id) + "</code> " + tip("id") + ' · status <span class="status-' + d.status + '">' + d.status + "</span> " + tip("status");
      var tail = isNew
        ? ""
        : canDelete
          ? '<button type="button" class="danger" data-act="delete" data-help="delete">Delete ' + tip("delete") + "</button>"
          : '<span class="muted small">Used ' + d.used + " — can't delete " + tip("delete") + "</span> " + (d.status !== "retired" ? '<button type="button" class="danger" data-act="retire" data-help="retire">Retire ' + tip("retire") + "</button>" : "");
      return (
        '<form class="form three" id="edit-form" autocomplete="off" aria-label="' + (isNew ? "New Outcome" : "Edit " + esc(d.name)) + '">' +
        '<label class="field"><span>Glyph ' + tip("glyph") + '</span><input name="glyph" data-help="glyph" value="' + esc(d.glyph) + '" maxlength="4" style="font-size:1.4rem"></label>' +
        '<label class="field"><span>Name ' + tip("name") + '</span><input name="name" data-help="name" value="' + esc(d.name) + '" placeholder="E.G. VINYL ONLY" required style="text-transform:uppercase"></label>' +
        '<label class="field"><span>Shape ' + tip("shape") + '</span><select name="shape" data-help="shape">' + SHAPES.map(function (sh) { return '<option value="' + sh + '"' + (sh === d.shape ? " selected" : "") + ">" + sh + "</option>"; }).join("") + "</select></label>" +
        '<label class="field"><span>Tier ' + tip("tier") + '</span><select name="tier" data-help="tier">' + tierOptions + "</select></label>" +
        '<label class="field"><span>Occupancy ' + tip("occupancy") + '</span><input name="occupancy" data-help="occupancy" value="' + esc(d.occupancy) + '" placeholder="instant · 1 transition · ~10 min"></label>' +
        '<label class="field"><span>Mini-draw ' + tip("miniDraw") + '</span><select name="miniDraw" data-help="miniDraw"><option value="">none</option>' + listOptions + "</select></label>" +
        '<label class="field full"><span>What it is ' + tip("description") + '</span><input name="description" data-help="description" value="' + esc(d.description || "") + '" maxlength="' + DESCRIPTION_MAX + '" placeholder="One line for you and the mods — what happens when it comes up"></label>' +
        "<div>" +
        '<label class="check"><input type="checkbox" name="restockable" data-help="restockable"' + (d.restockable ? " checked" : "") + ">Restockable " + tip("restockable") + "</label>" +
        '<label class="check"><input type="checkbox" name="raffle" data-help="raffle"' + (d.raffle ? " checked" : "") + ">Firebot raffle " + tip("raffle") + "</label>" +
        "</div>" +
        '<div class="uses">' +
        '<label class="field"><span>Used ' + tip("used") + '</span><div class="big muted">' + d.used + "</div></label>" +
        '<label class="field"><span>Left ' + tip("left") + '</span><input name="left" data-help="left" type="number" min="0" step="1" value="' + d.left + '" inputmode="numeric"></label>' +
        "</div>" +
        '<div class="helpbar" id="helpbar" aria-live="polite"><b>Name</b><span>' + esc(TIPS.name) + "</span></div>" +
        '<p class="hint">' + idLine + " · Changes apply from the next drop; the overlay updates live.</p>" +
        '<div class="form-actions">' +
        '<button type="submit" class="primary">' + (isNew ? "Add Outcome" : "Save") + ' <kbd class="dsk">' + MODKEY + "⏎</kbd></button>" +
        '<button type="button" class="ghost" data-act="cancel">Cancel <kbd class="dsk">Esc</kbd></button>' +
        '<span class="spacer"></span>' + tail +
        "</div></form>"
      );
    };
    var legendHtml = function () {
      var row = function (keys, text) {
        return "<tr><td>" + keys + "</td><td>" + text + "</td></tr>";
      };
      return (
        '<div class="legend" data-act="legend-close"><div role="dialog" aria-label="Keyboard shortcuts"><h3>Keyboard shortcuts</h3><table>' +
        row("<kbd>↑</kbd> <kbd>↓</kbd> or <kbd>k</kbd> <kbd>j</kbd>", "Move between Outcomes. Tab does the same — one stop per row, the buttons inside a row aren't stops.") +
        (isStreamer ? row("<kbd>⏎</kbd> or <kbd>e</kbd>", "Open the editor for this row (again to close).") : "") +
        row("<kbd>s</kbd>", "Suspend, or resume if suspended.") +
        row("<kbd>r</kbd>", "Restock +1 (restockable Outcomes only).") +
        row("<kbd>x</kbd>", "Retire (asks first).") +
        (isStreamer ? row("<kbd>n</kbd>", "New Outcome.") : "") +
        row("<kbd>/</kbd>", "Jump to the filter. <kbd>Esc</kbd> clears it and returns to the list.") +
        (isStreamer
          ? row("<kbd>" + MODKEY + "</kbd>+<kbd>⏎</kbd>", "In the editor: save.") +
            row("<kbd>Esc</kbd>", "In the editor: cancel and return to the row. Anywhere else: close this, clear the filter.") +
            row("<kbd>Tab</kbd> in the editor", "Cycles the editor's own fields and wraps — it never wanders back into the list.")
          : row("<kbd>Esc</kbd>", "Close this, clear the filter.")) +
        row("<kbd>?</kbd>", "This legend.") +
        '</table><p class="muted small">Shortcuts are off while you\'re typing in a field.</p><p><button type="button" class="primary" data-act="legend-close">Close</button></p></div></div>'
      );
    };
    var poolHtml = function () {
      var html =
        '<h2><span>Outcome pool <span class="count">· ' + outcomes.length + ' Outcomes</span></span><span class="toolbar"><input id="filter" placeholder="Filter…  /" aria-label="Filter Outcomes" data-help="filter" title="' + esc(TIPS.filter) + '" autocomplete="off" value="' + esc(filter) + '">' +
        (isStreamer ? '<button type="button" class="primary" data-act="add" data-tier="0"><span>+ Add Outcome<span class="k">n</span></span></button>' : "") +
        "</span></h2>";
      if (editing === "new") html += '<div class="addbox">' + formHtml(draft) + "</div>";
      html += '<div class="wrap"><table><thead><tr><th></th><th>Outcome ' + tip("name") + '</th><th class="num">Used ' + tip("used") + '</th><th class="num">Left ' + tip("left") + "</th><th>Status " + tip("status") + "</th><th></th></tr></thead><tbody>";
      var lastTier = -1;
      var shown = 0;
      sorted().forEach(function (o) {
        if (!matches(o)) return;
        shown++;
        if (o.tier !== lastTier) {
          lastTier = o.tier;
          html += tierHeader(o.tier);
        }
        html += rowHtml(o);
        if (editing === o.id) html += '<tr class="expand"><td colspan="7">' + formHtml(draft) + "</td></tr>";
      });
      if (shown === 0) html += '<tr><td colspan="7" class="muted empty">Nothing matches “' + esc(filter) + "”. <kbd>Esc</kbd> clears the filter.</td></tr>";
      html += "</tbody></table></div>";
      html += '<p class="keys dsk">' + (isStreamer ? "Hover or arrow to a row for its buttons · <kbd>⏎</kbd> edit" : "Arrow to a row, then <kbd>s</kbd> suspend / resume · <kbd>r</kbd> restock · <kbd>x</kbd> retire") + " · <kbd>?</kbd> keyboard shortcuts</p>";
      if (isStreamer) html += '<p class="muted small mob">Tap a row to edit it.</p>';
      if (legend) html += legendHtml();
      return html;
    };

    // --- render + focus
    function render() {
      section.innerHTML = poolHtml();
      var meta = document.getElementById("queue-meta");
      if (meta) meta.textContent = "Banked " + queue.banked + " · fired " + queue.fired + " · Tier " + openTier + " open" + (queue.drained ? " · POOL DRAINED" : "");
      var fader = document.querySelector(".queuebar .fader");
      if (fader) fader.textContent = "READY " + queue.ready;
      if (legend) {
        var close = section.querySelector(".legend button");
        if (close) close.focus();
        return;
      }
      var nameField = section.querySelector("#edit-form input[name=name]");
      if (nameField && editing) {
        nameField.focus({ preventScroll: editing !== "new" });
        if (editing !== "new") nameField.select();
        return;
      }
      if (focusAfter) {
        var row = section.querySelector('tr.orow[data-id="' + CSS.escape(focusAfter) + '"]');
        focusAfter = null;
        if (row) row.focus({ preventScroll: true });
      }
    }
    var rows = function () {
      return Array.prototype.slice.call(section.querySelectorAll("tr.orow"));
    };
    var focusedRow = function () {
      var a = document.activeElement;
      return a && a.closest ? a.closest("tr.orow") : null;
    };
    var moveRow = function (delta) {
      var rs = rows();
      if (!rs.length) return;
      var i = rs.indexOf(focusedRow());
      var n = i < 0 ? (delta > 0 ? 0 : rs.length - 1) : Math.min(rs.length - 1, Math.max(0, i + delta));
      rs[n].focus();
      rs[n].scrollIntoView({ block: "nearest" });
    };
    var openEditor = function (id) {
      if (!isStreamer) return;
      editing = editing === id ? null : id;
      draft = editing ? Object.assign({}, byId(id)) : null;
      if (!editing) focusAfter = id;
      render();
    };
    var closeEditor = function () {
      var id = editing !== "new" ? editing : null;
      editing = null;
      draft = null;
      focusAfter = id;
      render();
    };

    // --- the API: every change, then a fresh /api/state and a re-render with focus back on the row
    function refresh() {
      return api("GET", "/api/state").then(function (data) {
        outcomes = data.state.outcomes;
        openTier = data.state.tier;
        queue = { ready: data.state.queue.length, banked: data.state.bankedTotal, fired: data.state.firedTotal, drained: data.state.drained };
        if (editing && editing !== "new") {
          var fresh = byId(editing);
          if (!fresh) {
            editing = null;
            draft = null;
          } else if (draft) {
            // the form renders from the draft; Used / Left / status belong to the store, so a re-render after a lost request shows the truth
            draft.used = fresh.used;
            draft.left = fresh.left;
            draft.status = fresh.status;
          }
        }
        render();
      });
    }
    /** Run one mutation: refresh and toast on success, toast the error and leave the page as it was otherwise. */
    function mutate(promise, done, onError) {
      if (busy) return;
      busy = true;
      promise
        .then(function (data) {
          return refresh().then(function () {
            busy = false;
            if (done) done(data);
          });
        })
        .catch(function (e) {
          busy = false;
          if (onError) onError(e);
          else toast(e.message);
        });
    }
    /** A request that lost (the Outcome came up after the form opened): say so, then refetch so the form shows what the store holds. */
    function resync(message) {
      toast(message);
      refresh().catch(function () {
        render();
      });
    }
    var outcomePath = function (id) {
      return "/api/outcomes/" + encodeURIComponent(id);
    };
    function act(action, o) {
      if (!o) return;
      switch (action) {
        case "suspend":
          focusAfter = o.id;
          mutate(api("POST", outcomePath(o.id) + "/status", { status: "suspended" }), function () {
            toast(o.name + " suspended", true);
          });
          return;
        case "resume":
          focusAfter = o.id;
          mutate(api("POST", outcomePath(o.id) + "/status", { status: "live" }), function () {
            toast(o.name + " back in the pool", true);
          });
          return;
        case "toggle":
          return act(o.status === "suspended" ? "resume" : "suspend", o);
        case "restock":
          if (!o.restockable || o.status === "retired") return;
          focusAfter = o.id;
          // the body key belongs to the restock API; nobody sees it
          mutate(api("POST", outcomePath(o.id) + "/restock", { charges: 1 }), function () {
            var now = byId(o.id);
            toast(o.name + ": " + (now ? now.left : "?") + " left", true);
          });
          return;
        case "retire":
          if (o.status === "retired") return;
          if (!confirm("Retire " + o.name + "? Retiring is permanent.")) return;
          focusAfter = o.id;
          mutate(
            api("POST", outcomePath(o.id) + "/status", { status: "retired" }),
            function () {
              if (editing === o.id) {
                editing = null;
                draft = null;
                render();
              }
              toast(o.name + " retired", true);
            },
            function (e) {
              resync(e.message);
            },
          );
          return;
      }
    }
    function deleteOutcome(target) {
      if (!target) return;
      if (target.used !== 0) return toast("Can't delete — it has come up. Retire it instead.");
      if (!confirm("Delete " + target.name + "? It has never come up, so nothing in the Ledger refers to it.")) return;
      mutate(
        api("DELETE", outcomePath(target.id)),
        function () {
          editing = null;
          draft = null;
          render();
          toast(target.name + " deleted", true);
        },
        function (e) {
          resync(/retire it instead/i.test(e.message) ? "Can't delete — it has come up. Retire it instead." : e.message);
        },
      );
    }
    /** The form → the API body. A raffle only rides on a giveaway: save() refuses a ticked box on any other shape; an unticked box sends null, so leaving giveaway clears it in the same save. */
    function readForm(form) {
      var f = new FormData(form);
      var shape = String(f.get("shape"));
      return {
        glyph: String(f.get("glyph") || "").trim() || "🎯",
        name: String(f.get("name") || "").trim().toUpperCase(),
        shape: shape,
        tier: Number(f.get("tier")),
        occupancy: String(f.get("occupancy") || "").trim(),
        description: String(f.get("description") || "").trim(),
        miniDraw: f.get("miniDraw") ? String(f.get("miniDraw")) : null,
        restockable: f.get("restockable") === "on",
        raffle: f.get("raffle") === "on" ? true : null,
        left: Math.max(0, Math.floor(Number(f.get("left")) || 0)),
      };
    }
    function save(form) {
      var body = readForm(form);
      if (!body.name) {
        toast("Give it a name.");
        form.querySelector("[name=name]").focus();
        return;
      }
      if (body.raffle && body.shape !== "giveaway") {
        toast("Firebot raffles only make sense for giveaways.");
        form.querySelector("[name=raffle]").focus();
        return;
      }
      if (editing === "new") {
        mutate(api("POST", "/api/outcomes", body), function (data) {
          focusAfter = data.outcome.id;
          editing = null;
          draft = null;
          render();
          toast(body.name + " added to Tier " + body.tier + " — live now", true);
        });
        return;
      }
      var id = editing;
      var before = byId(id);
      if (before && body.left === before.left) delete body.left; // Left rides along only when it changed: no stock entry otherwise
      mutate(api("PUT", outcomePath(id), body), function () {
        focusAfter = id;
        editing = null;
        draft = null;
        render();
        toast(body.name + " saved — live now", true);
      });
    }

    // --- tooltips: hover or tap; positioned in viewport coordinates and clamped so they never clip or run off screen
    function showTip(t) {
      document.querySelectorAll(".tip.show").forEach(function (x) {
        if (x !== t) x.classList.remove("show", "open");
      });
      t.classList.add("show");
      var b = t.querySelector(".bubble");
      var r = t.getBoundingClientRect();
      var W = Math.min(320, innerWidth - 16);
      b.style.width = W + "px";
      var left = r.left;
      if (left + W > innerWidth - 8) left = innerWidth - 8 - W;
      if (left < 8) left = 8;
      b.style.left = left + "px";
      var H = b.offsetHeight;
      b.style.top = (r.bottom + 6 + H > innerHeight - 8 ? r.top - 6 - H : r.bottom + 6) + "px";
    }
    var hideTips = function () {
      document.querySelectorAll(".tip.show").forEach(function (x) {
        x.classList.remove("show", "open");
      });
    };
    document.addEventListener("mouseover", function (ev) {
      var t = ev.target.closest(".tip");
      if (t) showTip(t);
    });
    document.addEventListener("mouseout", function (ev) {
      var t = ev.target.closest(".tip");
      if (t && !t.classList.contains("open")) t.classList.remove("show");
    });
    document.addEventListener("scroll", hideTips, true);

    // --- clicks: data-act (the generic data-action handler above is for the other pages' buttons)
    document.addEventListener("click", function (ev) {
      var t = ev.target.closest(".tip");
      if (t) {
        ev.preventDefault();
        ev.stopPropagation();
        if (t.classList.contains("open")) t.classList.remove("open", "show");
        else {
          showTip(t);
          t.classList.add("open");
        }
        return;
      }
      hideTips();
      var el = ev.target.closest("[data-act]");
      if (!el) return;
      if (ev.target.closest("form") && el.tagName !== "BUTTON") return; // a click inside the form is not a row click
      var action = el.dataset.act;
      var id = el.dataset.id;
      var o = id ? byId(id) : null;
      switch (action) {
        case "noop":
          return;
        case "legend-close":
          if (ev.target.closest("[role=dialog]") && el.tagName !== "BUTTON") return;
          legend = false;
          render();
          return;
        case "add":
          if (!isStreamer) return;
          editing = "new";
          draft = newDraft(Number(el.dataset.tier || 0));
          render();
          return;
        case "edit":
          ev.stopPropagation();
          openEditor(id);
          return;
        case "cancel":
          closeEditor();
          return;
        case "suspend":
        case "resume":
        case "restock":
          ev.stopPropagation();
          act(action, o);
          return;
        case "retire":
          ev.stopPropagation();
          act("retire", o || byId(editing));
          return;
        case "delete":
          deleteOutcome(byId(editing));
          return;
      }
    });
    document.addEventListener("submit", function (ev) {
      if (ev.target.id !== "edit-form") return;
      ev.preventDefault();
      if (isStreamer) save(ev.target);
    });
    document.addEventListener("input", function (ev) {
      if (ev.target.name === "name" && editing === "new") {
        var c = ev.target.closest("form").querySelector(".hint code");
        if (c) c.textContent = slug(ev.target.value);
      }
      if (ev.target.id === "filter") {
        filter = ev.target.value;
        var pos = ev.target.selectionStart;
        render();
        var f = document.getElementById("filter");
        f.focus();
        f.setSelectionRange(pos, pos);
      }
    });

    // --- help bar follows keyboard focus (and taps) inside the form: the tooltip of the field that has focus
    function updateHelp(el) {
      var key = el && el.dataset ? el.dataset.help : null;
      var bar = document.getElementById("helpbar");
      if (key && bar && TIPS[key]) bar.innerHTML = "<b>" + (LABELS[key] || key) + "</b><span>" + esc(TIPS[key]) + "</span>";
    }
    document.addEventListener("focusin", function (ev) {
      updateHelp(ev.target);
      // arrow or tab onto a row and its What it is bubble shows (positioned like a hover); it goes when focus leaves the row
      var icon = ev.target.classList && ev.target.classList.contains("orow") ? ev.target.querySelector(".tip.info") : null;
      if (icon) showTip(icon);
    });
    document.addEventListener("focusout", function (ev) {
      // only this row's bubble goes — a tooltip the streamer click-pinned elsewhere stays open
      var icon = ev.target.classList && ev.target.classList.contains("orow") ? ev.target.querySelector(".tip.info") : null;
      if (icon && !icon.classList.contains("open")) icon.classList.remove("show");
    });
    document.addEventListener("pointerdown", function (ev) {
      updateHelp(ev.target.closest("[data-help]"));
    });

    // --- keyboard: key hints while navigating, Tab trapped in the form, shortcuts off while typing
    var typing = function () {
      var a = document.activeElement;
      return !!a && (["INPUT", "TEXTAREA", "SELECT"].indexOf(a.tagName) >= 0 || a.isContentEditable);
    };
    document.addEventListener("mousedown", function () {
      document.body.classList.remove("kbd");
    });
    document.addEventListener("keydown", function (ev) {
      if (["ArrowUp", "ArrowDown", "j", "k", "Tab"].indexOf(ev.key) >= 0 && !typing()) document.body.classList.add("kbd");
      var form = document.getElementById("edit-form");
      var inForm = form && form.contains(document.activeElement);
      if (inForm) {
        if (ev.key === "Tab") {
          var els = Array.prototype.filter.call(form.querySelectorAll("input,select,button"), function (e) {
            return !e.disabled && e.tabIndex >= 0;
          });
          var i = els.indexOf(document.activeElement);
          var next;
          if (ev.shiftKey && i <= 0) next = els[els.length - 1];
          else if (!ev.shiftKey && i === els.length - 1) next = els[0];
          else next = els[i + (ev.shiftKey ? -1 : 1)];
          ev.preventDefault();
          next.focus();
          updateHelp(next);
          return;
        }
        if (ev.key === "Escape") {
          ev.preventDefault();
          closeEditor();
          return;
        }
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          form.requestSubmit();
          return;
        }
        return;
      }
      if (document.activeElement && document.activeElement.id === "filter") {
        if (ev.key === "Escape") {
          ev.preventDefault();
          filter = "";
          render();
          moveRow(1);
        }
        if (ev.key === "Enter" || ev.key === "ArrowDown") {
          ev.preventDefault();
          moveRow(1);
        }
        return;
      }
      if (ev.key === "Escape") {
        if (legend) {
          legend = false;
          render();
          return;
        }
        if (editing) return closeEditor();
        if (filter) {
          filter = "";
          render();
        }
        return;
      }
      if (typing()) return;
      if (legend) {
        if (ev.key === "?") {
          legend = false;
          render();
        }
        return;
      }
      var row = focusedRow();
      var o = row ? byId(row.dataset.id) : null;
      switch (ev.key) {
        case "?":
          ev.preventDefault();
          legend = true;
          render();
          return;
        case "/": {
          ev.preventDefault();
          var f = document.getElementById("filter");
          if (f) f.focus();
          return;
        }
        case "n":
          if (isStreamer) {
            ev.preventDefault();
            editing = "new";
            draft = newDraft(0);
            render();
          }
          return;
        case "ArrowDown":
        case "j":
          ev.preventDefault();
          moveRow(1);
          return;
        case "ArrowUp":
        case "k":
          ev.preventDefault();
          moveRow(-1);
          return;
        case "Enter":
        case " ":
        case "e":
          if (o && isStreamer) {
            ev.preventDefault();
            openEditor(o.id);
          }
          return;
        case "s":
          if (o) {
            ev.preventDefault();
            act("toggle", o);
          }
          return;
        case "r":
          if (o) {
            ev.preventDefault();
            act("restock", o);
          }
          return;
        case "x":
          if (o) {
            ev.preventDefault();
            act("retire", o);
          }
          return;
      }
    });
  }
  // ===== end Outcome editor ===========================================================================================

  // ===== Setup page =============================================================================================
  // Server-rendered like every other page. Each section is one form[data-setup=<name>] posting to /api/setup/<name>;
  // a save reloads the page (the server re-renders progress, masks and the URLs that depend on what was saved), except
  // Connect Twitch, whose answer carries `next` (the broadcaster link) and the browser follows it. A switch
  // (input[data-toggle]) shows or hides the block(s) whose data-toggled lists its name; the switch's own value is what
  // gets saved, so turning it off and pressing Save is "off". Check buttons post to /api/setup/<name>/check and write
  // the answer under the form, no reload. Copy buttons put the exact URL on the clipboard.
  var setupRoot = document.getElementById("setup");
  if (setupRoot) {
    var tokens = function (s) {
      return String(s || "").split(/\s+/).filter(Boolean);
    };
    var toggles = document.querySelectorAll("input[data-toggle]");
    var isOn = function (name) {
      var box = document.querySelector('input[data-toggle="' + name + '"]');
      return !!(box && box.checked);
    };
    var applyToggles = function () {
      Array.prototype.forEach.call(document.querySelectorAll("[data-toggled]"), function (el) {
        el.hidden = !tokens(el.getAttribute("data-toggled")).some(isOn);
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-untoggled]"), function (el) {
        el.hidden = tokens(el.getAttribute("data-untoggled")).some(isOn); // the lone Save under an off switch: gone once the fields (with their own Save) show
      });
    };
    Array.prototype.forEach.call(toggles, function (box) {
      box.addEventListener("change", applyToggles);
    });
    applyToggles();

    /** The body for a section: every named control, checkboxes as booleans, text trimmed. */
    var fieldsOf = function (form) {
      var out = {};
      Array.prototype.forEach.call(form.querySelectorAll("input[name]"), function (input) {
        out[input.name] = input.type === "checkbox" ? input.checked : input.value.trim();
      });
      return out;
    };

    var resultLine = function (form, text, ok) {
      var el = form.querySelector(".check-result");
      if (!el) return toast(text, ok);
      el.textContent = text;
      el.className = "check-result small " + (ok ? "yes" : "no"); // its own two classes: the page-wide .err is the monospace one
    };

    Array.prototype.forEach.call(document.querySelectorAll("form[data-setup]"), function (form) {
      var name = form.getAttribute("data-setup");
      var connect = false;
      Array.prototype.forEach.call(form.querySelectorAll("button[data-connect]"), function (button) {
        button.addEventListener("click", function () {
          connect = true;
        });
      });
      form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var body = fieldsOf(form);
        if (connect) body.connect = true;
        connect = false;
        var buttons = form.querySelectorAll("button");
        Array.prototype.forEach.call(buttons, function (b) {
          b.disabled = true;
        });
        api("POST", "/api/setup/" + name, body)
          .then(function (data) {
            if (data && data.next) {
              location.href = data.next;
              return;
            }
            toast("Saved", true);
            location.hash = "#" + form.closest("section").id;
            location.reload();
          })
          .catch(function (e) {
            Array.prototype.forEach.call(buttons, function (b) {
              b.disabled = false;
            });
            resultLine(form, e.message, false);
            toast(e.message);
          });
      });
      Array.prototype.forEach.call(form.querySelectorAll("button[data-check]"), function (button) {
        button.addEventListener("click", function () {
          var what = button.getAttribute("data-check");
          button.disabled = true;
          resultLine(form, "Checking…", true);
          api("POST", "/api/setup/" + what + "/check", fieldsOf(form))
            .then(function (data) {
              if (what === "streamelements") resultLine(form, "StreamElements answered: this token belongs to " + (data.username || "your channel") + ". Press Save.", true);
              else resultLine(form, data.message || "Firebot answered.", data.command !== false);
            })
            .catch(function (e) {
              resultLine(form, e.message, false);
            })
            .then(function () {
              button.disabled = false;
            });
        });
      });
    });

    document.addEventListener("click", function (ev) {
      var button = ev.target.closest("button[data-copy]");
      if (!button) return;
      var value = button.getAttribute("data-copy");
      var failed = function () {
        toast("Could not copy. Select the text and copy it yourself.");
      };
      var done = function () {
        var was = button.textContent;
        button.textContent = "Copied";
        setTimeout(function () {
          button.textContent = was;
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(value).then(done, failed);
      var input = button.parentElement && button.parentElement.querySelector("input");
      if (!input) return failed();
      input.focus();
      input.select();
      try {
        document.execCommand("copy");
        done();
      } catch (e) {
        failed();
      }
    });
  }
  // ===== end Setup page ===============================================================================================
})();
