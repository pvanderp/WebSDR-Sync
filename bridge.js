/* ---------------------------------------------------------------------------
   bridge.js — runs INSIDE the WebSDR page, in its own JavaScript world.

   This is the whole reason the extension exists. A web page may not reach into
   a frame from another origin, so the console cannot call the receiver's
   setfreqif() / set_mode() / Mute directly. A content script declared with
   "world": "MAIN" does run in that page's own context, and postMessage is
   allowed across origins — so the console asks, and this answers.

   Privacy: it stays silent until the console messages it, then only ever
   replies to that exact origin. Opening the receiver normally, without the
   console, leaves it completely inert.
   --------------------------------------------------------------------------- */
(function () {
  "use strict";

  const CMD = "__websdrsync_cmd";
  const STATE = "__websdrsync_state";

  let peer = null;          // the window that talked to us
  let peerOrigin = null;    // ...and the origin we are allowed to answer

  const ready = () =>
    typeof window.setfreqif === "function" &&
    typeof window.set_mode === "function";

  // Two WebSDR flavours in the wild:
  //   - PA0SIM's fork (Maasbree): is_mute + MakeCheckbox('Mute') + toggle_mute
  //   - stock PA3FWM (Twente):    setmute() + a #mutecheckbox element, none of the above
  // Read state from whichever exists, and never assume the fork's globals.
  function muteCheckbox() {
    try { return document.getElementById("mutecheckbox"); } catch (e) { return null; }
  }
  function muteState() {
    try { if (typeof window.is_mute !== "undefined") return Number(window.is_mute) ? 1 : 0; } catch (e) {}
    const cb = muteCheckbox();
    if (cb) return cb.checked ? 1 : 0;
    return null;                               // no way to tell
  }
  function canMute() {
    try {
      if (typeof window.setmute === "function") return true;
      if (typeof window.toggle_mute === "function") return true;
      if (window.soundapplet && typeof window.soundapplet.mute === "function") return true;
    } catch (e) {}
    return false;
  }

  function currentState() {
    let kHz = null, mode = "";
    try {
      kHz = (typeof window.nominalfreq === "function")
        ? Number(window.nominalfreq())
        : Number(window.freq);
    } catch (e) {}
    try { mode = String(window.mode || "").toLowerCase(); } catch (e) {}
    return {
      __websdrsync: STATE,
      kHz: (kHz != null && isFinite(kHz)) ? kHz : null,
      mode: mode,
      muted: muteState() === 1,
      canMute: canMute(),
      band: (typeof window.band !== 'undefined') ? window.band : null,
      ready: ready(),
    };
  }

  // Which of the receiver's bands contains this frequency? Uses the receiver's
  // own band table and the same +/-4 kHz slack its setfreqb() uses.
  function bandForFreq(kHz) {
    try {
      var t = (typeof bi !== 'undefined' && bi && bi.length) ? bi
            : (typeof bandinfo !== 'undefined' ? bandinfo : null);
      if (!t || !t.length) return -1;
      var n = (typeof nvbands === 'number' && nvbands > 0) ? nvbands : t.length;
      for (var i = 0; i < n && i < t.length; i++) {
        var e = t[i];
        if (!e || typeof e.centerfreq !== 'number') continue;
        var w = e.samplerate / 2 + 4;
        if (kHz > e.centerfreq - w && kHz < e.centerfreq + w) return i;
      }
    } catch (e) {}
    return -1;
  }

  function tune(kHz, mode) {
    if (!ready()) return false;
    var f = Number(kHz);
    try {
      // Switch band first when the target is outside the current one. The
      // receiver's own setfreqb() does this only when it is NOT in "one band"
      // view -- in that view it silently tunes within the current band, so a
      // cross-band QSY appears to do nothing. Doing it explicitly is correct in
      // every view. Seed the band's remembered VFO first, exactly as setfreqb
      // does, so the band does not briefly land on its last frequency.
      var want = bandForFreq(f);
      if (want >= 0 && typeof window.setband === 'function' &&
          typeof window.band !== 'undefined' && want !== window.band) {
        try {
          var t = (typeof bi !== 'undefined' && bi) ? bi : null;
          if (t && t[want]) t[want].vfo = f;
        } catch (e) {}
        window.setband(want);
        // Some builds keep the band-button highlight in a separate function.
        if (typeof window.bandeButton === 'function') {
          try { window.bandeButton(want); } catch (e) {}
        }
      }

      if (mode) window.set_mode(String(mode).toUpperCase());
      window.setfreqif(f.toFixed(3));
      // set_mode can move the passband; re-assert so mode wins over the band default
      if (mode) window.set_mode(String(mode).toUpperCase());
      return true;
    } catch (e) { return false; }
  }

  // Squelch closed on a receiver we are steering just makes it sound dead, so
  // the console can ask for it off. Bordeaux ships with it on by default.
  function setSquelch(on) {
    var want = on ? 1 : 0;
    try {
      if (typeof window.setsquelch === 'function') {
        window.setsquelch(!!on);
        var cb = document.getElementById('squelchcheckbox');
        if (cb) cb.checked = !!on;
        return true;
      }
      // PA0SIM fork: a styled button plus a Squelch global, toggled together.
      if (typeof window.Squelch !== 'undefined' && typeof window.MakeCheckbox === 'function') {
        if ((Number(window.Squelch) ? 1 : 0) !== want) window.MakeCheckbox('Squelch');
        return (Number(window.Squelch) ? 1 : 0) === want;
      }
    } catch (e) {}
    return false;
  }

  function setMute(on) {
    const want = on ? 1 : 0;
    if (muteState() === want) return true;

    // 1. PA0SIM fork — drive its own button so the receiver's UI stays honest.
    try {
      if (typeof window.MakeCheckbox === "function" && typeof window.is_mute !== "undefined") {
        window.MakeCheckbox("Mute");
        if (muteState() === want) return true;
      }
    } catch (e) {}

    // 2. Stock PA3FWM — setmute() is what its own checkbox calls; tick the box
    //    too, otherwise the receiver's UI disagrees with its audio.
    try {
      if (typeof window.setmute === "function") {
        window.setmute(want);
        const cb = muteCheckbox();
        if (cb) cb.checked = !!want;
        if (muteState() === want) return true;
      }
    } catch (e) {}

    // 3. Blind toggles, last resort.
    try {
      if (typeof window.toggle_mute === "function") {
        window.toggle_mute();
        if (muteState() === want) return true;
      }
    } catch (e) {}
    try {
      if (window.soundapplet && typeof window.soundapplet.mute === "function") {
        window.soundapplet.mute();          // no readable state; assume it took
        return true;
      }
    } catch (e) {}

    return false;
  }

  function reply(extra) {
    if (!peer || !peerOrigin) return;
    const msg = currentState();
    if (extra) for (const k in extra) msg[k] = extra[k];
    try { peer.postMessage(msg, peerOrigin); } catch (e) {}
  }

  window.addEventListener("message", function (ev) {
    const d = ev.data;
    if (!d || typeof d !== "object" || d.__websdrsync !== CMD) return;

    // Only the console may drive us, and only chrome-extension pages qualify.
    if (String(ev.origin || "").indexOf("chrome-extension://") !== 0) return;
    peer = ev.source;
    peerOrigin = ev.origin;

    let ok = null;
    if (d.action === "tune") ok = tune(d.kHz, d.mode);
    else if (d.action === "mute") ok = setMute(!!d.on);
    else if (d.action === "squelch") ok = setSquelch(!!d.on);
    // "hello" needs no action — the state reply is the handshake

    reply({ id: d.id || null, ok: ok });
  }, false);

  // Push state so the console always knows the real dial frequency, including
  // when the operator tunes the receiver by hand.
  setInterval(function () { if (peer) reply(null); }, 500);
})();
