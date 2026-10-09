(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* =====================================================================
     WebSDR list  —  fixed set of receivers, all verified working
     ===================================================================== */
  // coverage: kHz ranges this receiver can actually tune, used by "Auto" to pick
  // a receiver for the rig's band and to warn when one cannot reach a frequency.
  // Measured from each receiver's own bandinfo (centre ± samplerate/2).
  const SDRS = [
    { id:"auto", name:"Auto — pick by band", url:"", auto:true },

    { id:"maasbree_low",  name:"Maasbree PH4RTM — low (160–15 m)",
      url:"http://sdr.websdrmaasbree.nl:8901/",
      coverage:[[1800,2000],[3500,3800],[5250,5450],[6900,7300],[10050,10250],
                [13980,14400],[18000,18220],[20800,21600]] },

    { id:"maasbree_high", name:"Maasbree PH4RTM — high (40–10 m)",
      url:"http://sdr.websdrmaasbree.nl:8902/",
      coverage:[[6908,7292],[10054,10246],[13983,14367],[18022,18214],
                [20841,21609],[24844,25036],[27966,28734],[28716,29484]] },

    { id:"hackgreen", name:"Hack Green G4NNS — UK (160–17 m)",
      url:"http://hackgreensdr.org:8901/",
      coverage:[[1708,2092],[3266,4034],[5158,5542],[6858,7242],
                [13816,14584],[17908,18292]] },

    { id:"bordeaux", name:"Bordeaux — HF + 2 m / 70 cm / QO-100",
      url:"http://ham.websdrbordeaux.fr:8000/",
      squelchOff: true,          // this one arrives with squelch closed

      coverage:[[3408,3792],[6446,7214],[14008,14392],[20866,21634],[27976,30024],
                [144026,146074],[431996,434044],[10489366,10490134]] },

    { id:"twente", name:"Twente PI4THT — wideband (0–29 MHz)",
      url:"http://websdr.ewi.utwente.nl:8901/",
      coverage:[[0,29160]] },
  ];

  function covers(entry, kHz) {
    if (!entry || !entry.coverage) return true;      // unknown: assume it might
    return entry.coverage.some((r) => kHz >= r[0] && kHz <= r[1]);
  }

  /* =====================================================================
     Logging
     ===================================================================== */
  const logEl = $("log");
  function log(msg, colour) {
    const d = document.createElement("div");
    const t = new Date().toISOString().slice(11, 19);
    d.textContent = t + "  " + msg;
    if (colour) d.style.color = colour;
    logEl.appendChild(d);
    while (logEl.childElementCount > 400) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function banner(msg) {
    const b = $("banner");
    if (msg) { b.textContent = msg; b.classList.add("show"); }
    else { b.classList.remove("show"); b.textContent = ""; }
  }

  /* =====================================================================
     Settings persistence
     ===================================================================== */
  const SETTING_IDS = ["rigHost","rigPort","freqPoll","txPoll","sdrSelect","sdrMode","offsetHz","tolHz"];
  const CHECK_IDS = ["chkFollow","chkMuteTx","chkBlankTx"];
  // Panels are not form controls, so they are stored as their own map of
  // open/closed rather than a value. An id with nothing stored falls back to
  // the default here -- which is also what a fresh install gets.
  const PANEL_DEFAULT_OPEN = { rigStrip: true, sdrStrip: true, logWrap: false };
  const PANEL_IDS = Object.keys(PANEL_DEFAULT_OPEN);
  const LS_KEY = "websdrsync_settings_v1";
  const LS_KEY_LEGACY = "catwebsdr_settings_v1";   // pre-rename; migrated once

  function saveSettings() {
    const o = {};
    SETTING_IDS.forEach((id) => { if ($(id)) o[id] = $(id).value; });
    CHECK_IDS.forEach((id) => { if ($(id)) o[id] = $(id).checked; });
    o.panels = {};
    PANEL_IDS.forEach((id) => {
      if ($(id)) o.panels[id] = !$(id).classList.contains("hidden");
    });
    try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {}
  }
  function loadSettings() {
    let o = {};
    try {
      let raw = localStorage.getItem(LS_KEY);
      if (raw === null) {
        // Renamed from the previous extension name; don't make the operator retype
        // their rigctld host and receiver choice.
        raw = localStorage.getItem(LS_KEY_LEGACY);
        if (raw !== null) {
          localStorage.setItem(LS_KEY, raw);
          localStorage.removeItem(LS_KEY_LEGACY);
        }
      }
      o = JSON.parse(raw || "{}");
    } catch (e) {}
    SETTING_IDS.forEach((id) => { if ($(id) && o[id] !== undefined) $(id).value = o[id]; });
    CHECK_IDS.forEach((id) => { if ($(id) && o[id] !== undefined) $(id).checked = !!o[id]; });
    const panels = (o && typeof o.panels === "object" && o.panels) || {};
    PANEL_IDS.forEach((id) => {
      const el = $(id); if (!el) return;
      const open = panels[id] === undefined ? PANEL_DEFAULT_OPEN[id] : !!panels[id];
      el.classList.toggle("hidden", !open);
    });
    return o;
  }

  /* =====================================================================
     Populate selects
     ===================================================================== */
  SDRS.forEach((s) => {
    const op = document.createElement("option");
    op.value = s.id; op.textContent = s.name; $("sdrSelect").appendChild(op);
  });
  $("sdrSelect").value = "maasbree_low";

  loadSettings();

  SETTING_IDS.concat(CHECK_IDS).forEach((id) => {
    const el = $(id); if (!el) return;
    el.addEventListener("change", saveSettings);
  });

  /* =====================================================================
     Rig link — rigctld over TCP, via the native messaging relay

     Chrome cannot open a TCP socket, so websdrsync_host.py does it for us and
     Chrome starts that host on demand. Everything below speaks Hamlib's
     rigctl line protocol: send a short command, read a fixed number of
     reply lines, or a single "RPRT -n" if the backend refuses.

     Only one command is ever outstanding, so replies can be matched to
     requests by order alone — the protocol carries no request ids.
     ===================================================================== */
  const HOST_NAME = "nl.websdrsync.rigctld_bridge";
  // The relay was called nl.catsdr.rigctld_bridge before the rename. If the
  // installer has not been re-run yet, fall back to it once rather than fail.
  const HOST_NAME_LEGACY = "nl.catsdr.rigctld_bridge";
  let hostNameInUse = HOST_NAME;
  let triedLegacyHost = false;

  let nativePort = null;        // chrome.runtime.Port to websdrsync_host.py
  let linkUp = false;           // TCP connection to rigctld is open
  let rxBuf = "";               // partial line buffer
  let pending = null;           // { cmd, expect, lines, resolve, timer }
  const queue = [];

  let rigHz = null, rigMode = null, rigTx = false;
  let txKnown = false;          // false until the first PTT reading of this session
  let rigName = "";             // e.g. "Yaesu FTDX-10", from \\dump_caps
  let lastFreqAt = 0;
  let pttUnsupported = false;

  const rigHost = () => ($("rigHost").value || "127.0.0.1").trim();
  const rigPort = () => Math.min(65535, Math.max(1, parseInt($("rigPort").value, 10) || 4532));

  /* ---- command queue ---------------------------------------------------- */
  function rigctl(cmd, expect, timeoutMs) {
    return new Promise((resolve) => {
      if (!linkUp) { resolve(null); return; }
      if (queue.length > 6) { resolve(null); return; }   // rig has stopped answering
      queue.push({ cmd, expect, lines: [], resolve, timeoutMs: timeoutMs || 2500 });
      pump();
    });
  }

  function pump() {
    if (pending || !queue.length || !nativePort) return;
    pending = queue.shift();
    pending.timer = setTimeout(() => {
      const p = pending;
      pending = null;
      if (p) {
        log("[rig] timeout waiting for reply to '" + p.cmd.trim() + "'", "var(--danger)");
        p.resolve(null);
      }
      pump();
    }, pending.timeoutMs);
    try {
      nativePort.postMessage({ op: "send", data: pending.cmd });
    } catch (e) {
      const p = pending; pending = null;
      log("[rig] send failed: " + (e.message || e), "var(--danger)");
      if (p) p.resolve(null);
    }
  }

  function finish(value) {
    const p = pending;
    pending = null;
    if (p) { clearTimeout(p.timer); p.resolve(value); }
    pump();
  }

  function onLine(line) {
    if (!pending) return;                      // unsolicited chatter; ignore
    if (/^RPRT\s+(-?\d+)/.test(line)) {
      const code = parseInt(line.match(/^RPRT\s+(-?\d+)/)[1], 10);
      if (code !== 0) {
        if (pending.cmd[0] === "t" && !pttUnsupported) {
          pttUnsupported = true;
          // Say so on the badge as well: TX/RX is genuinely unknowable here,
          // and leaving it on IDLE reads like nothing has been polled yet.
          $("txBadge").className = "txbadge";
          $("txBadge").textContent = "NO PTT";
          log("[rig] this backend does not report PTT (RPRT " + code + ") — TX detection unavailable",
              "var(--danger)");
          banner("rigctld will not report PTT for this rig, so TX muting cannot work. " +
                 "Check that rigctld is started with the right model for this radio.");
        }
        finish(null);
      } else {
        finish(pending.lines.length ? pending.lines : []);
      }
      return;
    }
    pending.lines.push(line);
    if (pending.lines.length >= pending.expect) finish(pending.lines);
  }

  function onData(text) {
    rxBuf += text;
    let i;
    while ((i = rxBuf.indexOf("\n")) >= 0) {
      const line = rxBuf.slice(0, i).replace(/\r$/, "").trim();
      rxBuf = rxBuf.slice(i + 1);
      if (line) onLine(line);
    }
    if (rxBuf.length > 4096) rxBuf = "";
  }

  /* ---- rigctl vocabulary ------------------------------------------------ */
  // Hamlib mode strings -> what the WebSDR understands
  const MODE_MAP = {
    USB: "usb", LSB: "lsb", CW: "cw", CWR: "cw", AM: "am", AMS: "am",
    FM: "fm", WFM: "fm", FMN: "fm", PKTUSB: "usb", PKTLSB: "lsb",
    PKTFM: "fm", RTTY: "lsb", RTTYR: "usb", USBD: "usb", LSBD: "lsb",
  };

  async function readFrequency() {
    const r = await rigctl("f\n", 1);
    if (!r || !r.length) return;
    const hz = parseInt(r[0], 10);
    if (Number.isFinite(hz) && hz > 0) setRigFreq(hz);
  }

  async function readMode() {
    const r = await rigctl("m\n", 2);          // mode, then passband width
    if (!r || !r.length) return;
    const m = MODE_MAP[String(r[0]).toUpperCase()];
    if (m) setRigMode(m);
  }

  // Ask once per connection who we are talking to. \\dump_caps is ~220 lines
  // terminated by RPRT 0, so collect until the terminator rather than a count.
  async function readRigName() {
    const r = await rigctl("\\dump_caps\n", 9999, 6000);
    if (!r || !r.length) return;
    let model = "", mfg = "";
    for (const line of r) {
      const m = line.match(/^Model name:\s*(.+?)\s*$/i);
      if (m) { model = m[1]; continue; }
      const g = line.match(/^Mfg name:\s*(.+?)\s*$/i);
      if (g) { mfg = g[1]; }
      if (model && mfg) break;
    }
    rigName = [mfg, model].filter(Boolean).join(" ").trim();
    if (rigName) {
      log("[rig] " + rigName, "var(--ok)");
      paintStatus();
    }
  }

  // Strict about the answer: "t" replies 0 or 1 and nothing else. Anything
  // longer is a reply that belongs to another command (a stray line can shift
  // the queue by one), and treating a frequency as "not 0" would key the badge.
  async function readPtt() {
    if (pttUnsupported) return;
    const r = await rigctl("t\n", 1);
    if (!r || !r.length) return;
    const v = String(r[0]).trim();
    if (!/^[01]$/.test(v)) return;
    setRigTx(v === "1");
  }

  /* ---- state ------------------------------------------------------------ */
  function setRigFreq(hz) {
    lastFreqAt = Date.now();
    if (rigHz === hz) { paintFreq(); return; }
    rigHz = hz;
    paintFreq();
    scheduleSdrSync();
  }
  function setRigMode(mode) {
    if (!mode || rigMode === mode) return;
    rigMode = mode;
    $("modeRead").textContent = mode.toUpperCase();
    scheduleSdrSync();
  }
  // txKnown, not just a value comparison: rigTx starts false, so a first
  // reading of "receiving" is not a change and would leave the badge on its
  // disconnected IDLE. The first reading after a connect always paints.
  function setRigTx(on) {
    on = !!on;
    if (txKnown && rigTx === on) return;
    txKnown = true;
    rigTx = on;
    const badge = $("txBadge");
    badge.className = "txbadge " + (on ? "tx" : "rx");
    badge.textContent = on ? "TX" : "RX";
    document.body.classList.toggle("txing", on);
    $("sdrOverlay").classList.toggle("show", on && $("chkMuteTx").checked);
    log(on ? "[rig] TX" : "[rig] RX", on ? "var(--tx)" : "var(--ok)");
    applyMute(on && $("chkMuteTx").checked);
  }
  // 14074000 -> "14.074.000"   3600000 -> "3.600.000"   no leading zeros.
  function groupHz(hz) {
    const s = String(hz);
    let out = "";
    for (let i = s.length; i > 0; i -= 3) {
      out = s.slice(Math.max(0, i - 3), i) + (out ? "." + out : "");
    }
    return out;
  }
  function paintFreq() {
    const el = $("freqRead");
    if (rigHz == null) { el.textContent = "—.———.———"; el.classList.add("stale"); return; }
    el.textContent = groupHz(rigHz);
    el.classList.toggle("stale", Date.now() - lastFreqAt > 4000);
  }
  setInterval(paintFreq, 1000);

  /* ---- polling ---------------------------------------------------------- */
  let freqTimer = null, txTimer = null;
  function startPolling() {
    stopPolling();
    const fp = Math.max(200, parseInt($("freqPoll").value, 10) || 1000);
    const tp = Math.max(100, parseInt($("txPoll").value, 10) || 300);
    freqTimer = setInterval(() => { readFrequency(); readMode(); }, fp);
    txTimer = setInterval(() => { readPtt(); }, tp);
    readFrequency(); readMode(); readPtt();
    log("[rig] polling: frequency and mode every " + fp + " ms, PTT every " + tp + " ms",
        "var(--accent)");
  }
  function stopPolling() {
    if (freqTimer) clearInterval(freqTimer);
    if (txTimer) clearInterval(txTimer);
    freqTimer = txTimer = null;
  }
  ["freqPoll", "txPoll"].forEach((id) =>
    $(id).addEventListener("change", () => { if (linkUp) startPolling(); }));

  /* ---- connection ------------------------------------------------------- */
  // The status line shows the radio, not the address -- host and port are a
  // glance away in Rig setup, and the log records what was connected to.
  function paintStatus() {
    if (!linkUp) return;
    $("statusText").textContent = rigName || "Connected";
  }

  function setConnected(on, msg) {
    $("statusDot").className = "dot" + (on ? " on" : "");
    $("statusText").textContent = on ? (rigName || "Connected") : (msg || "Not connected");
    $("btnConnect").disabled = on;
    $("btnDisconnect").disabled = !on;
    ["rigHost", "rigPort"].forEach((id) => { if ($(id)) $(id).disabled = on; });
    if (!on) {
      $("txBadge").className = "txbadge";
      $("txBadge").textContent = "IDLE";
      document.body.classList.remove("txing");
      $("sdrOverlay").classList.remove("show");
    }
  }

  function hostMissing(err) {
    banner("Cannot start the TCP relay: " + (err || "native host not found") +
           ". Run host/install-host.sh once, then quit and reopen Chrome.");
    log("[host] " + (err || "not found"), "var(--danger)");
  }

  function openNativePort() {
    if (nativePort) return nativePort;
    try {
      nativePort = chrome.runtime.connectNative(hostNameInUse);
    } catch (e) {
      hostMissing(e.message || String(e));
      return null;
    }
    nativePort.onMessage.addListener((m) => {
      if (!m || typeof m !== "object") return;
      if (m.op === "data") onData(m.data || "");
      else if (m.op === "connected") {
        linkUp = true;
        rxBuf = "";
        pttUnsupported = false;
        txKnown = false;
        rigName = "";
        setConnected(true);
        banner("");
        log("[rig] connected to rigctld at " + m.peer, "var(--ok)");
        readRigName();
        startPolling();
      } else if (m.op === "closed") {
        if (linkUp) log("[rig] rigctld closed the connection", "var(--danger)");
        teardown("rigctld disconnected");
      } else if (m.op === "error") {
        log("[rig] " + m.error, "var(--danger)");
        banner("rigctld: " + m.error);
        teardown("Connection failed");
      } else if (m.op === "pong") {
        log("[host] relay v" + m.version + " ready", "var(--muted)");
      }
    });
    nativePort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      nativePort = null;

      // Not registered under the new name? Try the pre-rename one before giving up.
      if (err && /not found/i.test(err.message || "") &&
          hostNameInUse === HOST_NAME && !triedLegacyHost) {
        triedLegacyHost = true;
        hostNameInUse = HOST_NAME_LEGACY;
        log("[host] " + HOST_NAME + " is not registered — trying the pre-rename name",
            "var(--warn)");
        banner("Running against the old relay registration. Re-run host/install-host.sh " +
               "to register it under its new name.");
        connect();
        return;
      }
      if (err) hostMissing(err.message);
      teardown(err ? "Relay unavailable" : "Relay stopped");
    });
    return nativePort;
  }

  function teardown(statusMsg) {
    stopPolling();
    linkUp = false;
    if (pending) { clearTimeout(pending.timer); pending.resolve(null); pending = null; }
    while (queue.length) queue.shift().resolve(null);
    rxBuf = "";
    applyMute(false);
    rigTx = false; txKnown = false; rigHz = null; rigMode = null; rigName = "";
    paintFreq();
    $("modeRead").textContent = "—";
    setConnected(false, statusMsg);
  }

  function connect() {
    const p = openNativePort();
    if (!p) return;
    setConnected(false, "Connecting…");
    log("[rig] connecting to " + rigHost() + ":" + rigPort(), "var(--muted)");
    try {
      p.postMessage({ op: "ping" });
      p.postMessage({ op: "connect", host: rigHost(), port: rigPort() });
    } catch (e) {
      hostMissing(e.message || String(e));
    }
  }

  function disconnect() {
    try { if (nativePort) nativePort.postMessage({ op: "disconnect" }); } catch (e) {}
    teardown("Not connected");
    log("[rig] disconnected", "var(--muted)");
    try { if (nativePort) nativePort.disconnect(); } catch (e) {}
    nativePort = null;
  }

  $("btnConnect").addEventListener("click", connect);
  $("btnDisconnect").addEventListener("click", disconnect);
  window.addEventListener("beforeunload", () => {
    try { if (nativePort) nativePort.disconnect(); } catch (e) {}
  });

  /* =====================================================================
     WebSDR bridge
     ===================================================================== */
  const frame = $("sdrFrame");
  let currentSdrUrl = "";
  let lastTunedKHz = null;
  let blankedSrc = null;
  let weMuted = false;                   // true only while *we* hold the mute
  let urlRetuneTimer = null;
  let pillTimer = null;

  // --- link to bridge.js running inside the receiver -----------------------
  // The receiver is another origin, so we cannot touch its DOM. bridge.js is
  // injected into it by the extension and answers over postMessage; it pushes
  // its state twice a second, which is what syncSdr() compares against.
  let bridgeReady = false;
  let sdrState = null;                   // { kHz, mode, muted, ready }
  let sdrStateAt = 0;
  let helloTimer = null;
  let msgId = 0;
  let mutedWarned = false;

  function sdrOrigin() {
    try { return new URL(chosenSdr()).origin; } catch (e) { return null; }
  }
  function sdrSend(action, extra) {
    const origin = sdrOrigin();
    const win = frame.contentWindow;
    if (!origin || !win) return false;
    const msg = { __websdrsync: "__websdrsync_cmd", action: action, id: ++msgId };
    if (extra) for (const k in extra) msg[k] = extra[k];
    try { win.postMessage(msg, origin); return true; } catch (e) { return false; }
  }

  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.__websdrsync !== "__websdrsync_state") return;
    if (ev.source !== frame.contentWindow) return;
    if (ev.origin !== sdrOrigin()) return;

    sdrState = { kHz: d.kHz, mode: String(d.mode || "").toLowerCase(),
                 muted: !!d.muted, canMute: d.canMute !== false };
    if (sdrState.canMute === false && $("chkMuteTx").checked && !mutedWarned) {
      mutedWarned = true;
      log("[sdr] this receiver exposes no mute control — TX muting unavailable here",
          "var(--danger)");
      banner("This receiver has no mute control the bridge can reach, so TX muting will not work on it.");
    }
    sdrStateAt = Date.now();

    if (!bridgeReady && d.ready) {
      bridgeReady = true;
      if (helloTimer) { clearInterval(helloTimer); helloTimer = null; }
      if (pillTimer) { clearTimeout(pillTimer); pillTimer = null; }
      updateFallbackVisibility();
      banner("");
      log("[sdr] bridge connected — instant tuning and real Mute control", "var(--ok)");
      // Some receivers come up with squelch closed, which just sounds dead when
      // we are steering them. Open it once, per receiver.
      if (activeSdr && activeSdr.squelchOff) {
        if (sdrSend("squelch", { on: false })) {
          log("[sdr] squelch disabled on " + activeSdr.name, "var(--accent)");
        }
      }
      if ($("chkFollow").checked && rigHz != null) syncSdr(true);
    }
  });

  function startHandshake() {
    bridgeReady = false;
    sdrState = null;
    mutedWarned = false;
    if (helloTimer) clearInterval(helloTimer);
    let tries = 0;
    helloTimer = setInterval(() => {
      if (bridgeReady || ++tries > 40) { clearInterval(helloTimer); helloTimer = null; return; }
      sdrSend("hello");
    }, 400);
  }

  // No status pill: the receiver itself is on screen below, so a green "linked"
  // badge only repeated what you can already see. A missing bridge still speaks
  // up -- through the banner in loadSdr() and a line in the log -- which is
  // where a fault belongs. This just hides the URL-mode-only option while the
  // bridge is doing its job.
  function updateFallbackVisibility() {
    $("fallbackWrap").style.display = bridgeReady ? "none" : "";
  }

  // The receiver the UI asks for; "auto" resolves against the rig frequency.
  let activeSdr = null;                  // the SDRS entry actually loaded

  function resolveSdr() {
    const id = $("sdrSelect").value;
    const entry = SDRS.find((s) => s.id === id);
    if (!entry) return null;
    if (!entry.auto) return entry;

    // Auto: first receiver in the list that covers the rig frequency. The list
    // is ordered so a dedicated receiver wins over the wideband fallback.
    const kHz = targetKHz();
    const real = SDRS.filter((s) => s.url && !s.auto);
    if (kHz == null) return real[0] || null;
    return real.find((s) => covers(s, kHz)) || real.find((s) => !s.coverage) || null;
  }

  function chosenSdr() {
    const e = activeSdr || resolveSdr();
    return e ? e.url : "";
  }

  function modeForFreq(hz) {
    const sel = $("sdrMode").value;
    if (sel === "rig") {
      if (rigMode) return rigMode;
      return hz < 10000000 ? "lsb" : "usb";
    }
    if (sel === "band") return hz < 10000000 ? "lsb" : "usb";
    return sel;
  }
  function targetKHz() {
    if (rigHz == null) return null;
    const off = parseInt($("offsetHz").value, 10) || 0;
    return (rigHz + off) / 1000;
  }

  // ---- tuning ------------------------------------------------------------
  function scheduleSdrSync() {
    if (!$("chkFollow").checked) return;
    syncSdr(false);
  }

  // Re-assert once a second. Syncing only when the rig moves is not enough:
  // if the operator clicks the receiver's own waterfall it would stay there.
  // syncSdr() is a no-op while the receiver is already within tolerance, and
  // unchecking "Follow rig frequency" is how you park it somewhere else.
  setInterval(() => {
    if (!bridgeReady || !$("chkFollow").checked) return;
    if (rigHz == null || rigTx) return;      // don't chase the dial mid-transmission
    if (Date.now() - sdrStateAt > 3000) return;
    syncSdr(false);
  }, 1000);

  function syncSdr(force) {
    const kHz = targetKHz();
    if (kHz == null) return;
    const tol = Math.max(1, parseInt($("tolHz").value, 10) || 20) / 1000;   // kHz
    const mode = modeForFreq(rigHz);

    // Auto mode: if the rig has moved off this receiver's coverage, hand over to
    // one that has it. That means a reload, so only do it when the current
    // receiver genuinely cannot reach the frequency.
    if ($("sdrSelect").value === "auto") {
      const want = resolveSdr();
      if (!want || !want.url) {
        // e.g. 6 m or 23 cm: no receiver in the list reaches there. Say so and
        // leave the current one where it is rather than retuning it pointlessly.
        banner("No receiver in the list covers " + (kHz / 1000).toFixed(3) + " MHz" +
               (activeSdr ? " — staying on " + activeSdr.name : "") + ".");
        return;
      }
      if (want.url && (!activeSdr || want.id !== activeSdr.id)) {
        log("[sdr] " + kHz.toFixed(1) + " kHz is outside " +
            (activeSdr ? activeSdr.name : "the current receiver") +
            " — switching to " + want.name, "var(--accent)");
        loadSdr(true, kHz, mode, want);
        return;
      }
    }

    if (bridgeReady) {
      const cur = sdrState ? Number(sdrState.kHz) : null;
      const curMode = sdrState ? sdrState.mode : "";
      const freqOff = (cur == null || !isFinite(cur)) || Math.abs(cur - kHz) > tol;
      const modeOff = mode && curMode && curMode !== mode.toLowerCase();
      if (!force && !freqOff && !modeOff) return;

      if (activeSdr && !covers(activeSdr, kHz)) {
        banner(activeSdr.name + " does not cover " + (kHz / 1000).toFixed(3) +
               " MHz. Choose another receiver, or switch the list to Auto.");
      }
      if (!sdrSend("tune", { kHz: kHz, mode: mode })) {
        log("[sdr] tune command could not be sent", "var(--danger)");
        return;
      }
      lastTunedKHz = kHz;
      log("[sdr] tuned " + kHz.toFixed(3) + " kHz " + mode.toUpperCase(), "var(--accent)");

      // The bridge pushes state every 500 ms; check the next report rather than
      // trusting the command, so a band the receiver cannot reach is caught.
      const askedAt = Date.now();
      setTimeout(() => {
        if (!sdrState || sdrStateAt < askedAt) return;
        const back = Number(sdrState.kHz);
        if (isFinite(back) && Math.abs(back - kHz) > 1) {
          banner("This WebSDR cannot tune to " + kHz.toFixed(2) + " kHz — the receiver does not cover that band. Pick another receiver from the list.");
        } else banner("");
      }, 900);
      return;
    }

    // URL mode: reload the iframe, debounced so VFO spinning doesn't thrash it
    if (!force && lastTunedKHz != null && Math.abs(lastTunedKHz - kHz) <= tol) return;
    if (urlRetuneTimer) clearTimeout(urlRetuneTimer);
    urlRetuneTimer = setTimeout(() => {
      const k2 = targetKHz();
      if (k2 == null) return;
      lastTunedKHz = k2;
      loadSdr(false, k2, modeForFreq(rigHz));
    }, force ? 0 : 1200);
  }

  function loadSdr(reset, kHz, mode, entry) {
    const target = entry || resolveSdr();
    if (!target || !target.url) { log("[sdr] no receiver URL set", "var(--danger)"); return; }
    activeSdr = target;
    const base = target.url;
    let url = base;
    if (kHz != null) {
      const sep = url.indexOf("?") >= 0 ? "&" : (url.endsWith("/") ? "?" : "/?");
      url = url + sep + "tune=" + kHz.toFixed(2) + (mode || "usb");
    }
    if (reset) lastTunedKHz = kHz == null ? null : kHz;
    currentSdrUrl = url;
    blankedSrc = null;
    frame.src = url;
    log("[sdr] loading " + target.name + " — " + url, "var(--muted)");
    if (pillTimer) clearTimeout(pillTimer);
    pillTimer = setTimeout(() => {
      if (!bridgeReady) {
        updateFallbackVisibility();
        let host = "";
        try { host = new URL(base).host; } catch (e) {}
        banner("No bridge on " + (host || "this receiver") + " — falling back to URL mode " +
               "(each QSY reloads it, and TX cannot press Mute). Add " +
               (host ? "http://" + host + "/*" : "the receiver") +
               " to host_permissions and content_scripts in manifest.json, then reload the extension.");
      }
    }, 12000);
  }

  frame.addEventListener("load", () => {
    weMuted = false;
    updateFallbackVisibility();
    startHandshake();
  });

  // ---- muting ------------------------------------------------------------
  function applyMute(on) {
    // Never undo a mute the operator set themselves: only release our own.
    if (!on && !weMuted) return;
    if (bridgeReady) {
      if (sdrState && sdrState.canMute === false) return;
      // Already in the wanted state (the operator got there first)? Leave it,
      // and don't record it as ours to release.
      if (sdrState && sdrState.muted === !!on) { if (on) weMuted = false; return; }
      if (sdrSend("mute", { on: !!on })) {
        weMuted = on;
        log(on ? "[sdr] muted (TX)" : "[sdr] unmuted (RX)", on ? "var(--tx)" : "var(--ok)");
      } else {
        log("[sdr] mute command could not be sent", "var(--danger)");
      }
      return;
    }
    // URL-mode fallback: blank the receiver entirely
    if (!$("chkBlankTx").checked) return;
    if (on) {
      if (frame.src && frame.src !== "about:blank") {
        blankedSrc = frame.src; frame.src = "about:blank"; weMuted = true;
      }
    } else if (blankedSrc) {
      const s = blankedSrc; blankedSrc = null; weMuted = false; frame.src = s;
    }
  }
  $("chkMuteTx").addEventListener("change", () => {
    if (!$("chkMuteTx").checked) { applyMute(false); $("sdrOverlay").classList.remove("show"); }
    else if (rigTx) { applyMute(true); $("sdrOverlay").classList.add("show"); }
  });

  // ---- receiver selection ------------------------------------------------
  function switchSdr() {
    const entry = resolveSdr();
    if (!entry || !entry.url) return;
    banner("");
    const k = targetKHz();
    loadSdr(true, k, k == null ? null : modeForFreq(rigHz), entry);
  }
  $("sdrSelect").addEventListener("change", switchSdr);

  $("btnRetune").addEventListener("click", () => {
    if (rigHz == null) { banner("No frequency from the rig yet — connect it first."); return; }
    syncSdr(true);
  });
  $("btnReload").addEventListener("click", () => {
    const k = targetKHz();
    loadSdr(true, k, k == null ? null : modeForFreq(rigHz));
  });
  $("btnOpenTab").addEventListener("click", () => {
    const base = chosenSdr();
    const k = targetKHz();
    let url = base;
    if (k != null && base) {
      const sep = url.indexOf("?") >= 0 ? "&" : (url.endsWith("/") ? "?" : "/?");
      url += sep + "tune=" + k.toFixed(2) + modeForFreq(rigHz);
    }
    if (url) window.open(url, "_blank", "noopener");
  });

  /* =====================================================================
     Panel toggles
     ===================================================================== */
  // Which panels are open is remembered like any other setting -- loadSettings()
  // has already applied it, including the closed Log a fresh install starts with.
  function toggler(btnId, elId) {
    $(btnId).addEventListener("click", () => {
      $(elId).classList.toggle("hidden");
      saveSettings();
    });
  }
  toggler("btnToggleRig", "rigStrip");
  toggler("btnToggleSdr", "sdrStrip");
  toggler("btnToggleLog", "logWrap");

  /* =====================================================================
     Boot
     ===================================================================== */
  (function boot() {
    // Chrome insists on three parts; the package is versioned in two ("0.1"),
    // with the third always 0. Drop the trailing .0 for display so the top bar
    // shows the package version, not the manifest's padded form.
    const mv = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest().version : "";
    const shown = mv.replace(/^(\d+\.\d+)\.0$/, "$1");
    if (shown) $("brand").textContent = "WebSDR-Sync " + shown;
    log(("WebSDR-Sync " + shown).trim() + " ready.");
    log("Tip: click once inside the receiver below — Chrome needs a gesture in the frame before it will start audio.", "var(--muted)");
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.connectNative) {
      banner("This page must be opened from the extension (chrome-extension://…/console.html); " +
             "the native messaging relay is not reachable from here.");
    }

    updateFallbackVisibility();
    loadSdr(true, null, null);
  })();
})();