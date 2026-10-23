/* FlowMesh wake word: the card on the Wispr page and the "wake on" badge in the voice dock.

   Detection happens in the desktop runtime with the speech recogniser built into Windows, so no
   audio reaches this page and nothing is transcribed. The page only turns it on (after an
   explicit acknowledgement), shows its state, and reacts when the runtime reports a wake: a soft
   chime, a cue in the dock, and the Flow page. If a Wispr shortcut is saved, the runtime presses
   it, so Wispr takes over the dictation, and live pickup then plans what you say as usual.
   Everything the runtime sends is untrusted text and is set with textContent. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  if (!UI) return;
  var $ = function (id) { return document.getElementById(id); };

  var POLL_MS = 2000;
  var CUE_MS = 6000;
  var timer = null;
  var info = null;
  var seenWakes = null;
  var cueTimer = null;
  var busy = false;

  var STATES = {
    off: ['off', 'idle'],
    starting: ['starting', 'idle'],
    listening: ['listening', 'ready'],
    error: ['error', 'error'],
    unsupported: ['not available', 'idle'],
  };

  function desktop() { return UI.mode() === 'desktop'; }

  /* ---------------------------------------------------------------- chime */

  function chime() {
    try {
      var Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      var ctx = new Context();
      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, 0.12 * (window.FlowMeshPilot ? window.FlowMeshPilot.volume() : 1)), ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      gain.connect(ctx.destination);
      [660, 880].forEach(function (freq, i) {
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime + i * 0.12);
        osc.stop(ctx.currentTime + i * 0.12 + 0.18);
      });
      setTimeout(function () { ctx.close(); }, 800);
    } catch (err) { /* a chime is a convenience */ }
  }

  /* ---------------------------------------------------------------- paint */

  function paint() {
    var card = $('wakeCard');
    card.hidden = !desktop();
    if (!info) return;
    var pair = STATES[info.state] || STATES.off;
    $('wakeState').textContent = pair[0];
    $('wakeState').setAttribute('data-state', pair[1]);
    var on = info.state === 'listening' || info.state === 'starting';
    if (!busy) $('wakeToggle').checked = on;
    $('wakeToggle').disabled = info.state === 'unsupported' || info.enabled === false;
    $('wakeBadge').hidden = !on;
    var text = info.detail || '';
    if (info.enabled === false) text = 'The wake word is switched off on this install (FLOWMESH_WAKE=off).';
    else if (info.state === 'listening') text = 'Listening for “Hey FlowMesh”. Heard ' + info.wakes + ' time' + (info.wakes === 1 ? '' : 's') + (info.summoned ? ', pressed your Wispr shortcut ' + info.summoned + '.' : '.');
    $('wakeDetail').textContent = text;
    if (document.activeElement !== $('wakeShortcut')) $('wakeShortcut').value = info.summon || '';
    if (document.activeElement !== $('wakeHold')) $('wakeHold').value = String(info.hold_s || 0);
    $('wakeTest').disabled = !info.summon;
  }

  function poll() {
    if (!desktop() || document.hidden) return;
    UI.get('/api/wake').then(function (data) {
      info = data;
      if (seenWakes === null) seenWakes = data.wakes; // never react to a wake from before this page loaded
      else if (data.wakes > seenWakes) { seenWakes = data.wakes; onWake(); }
      paint();
    }).catch(function () { /* the session ended; the voice module already says so */ });
  }

  function onWake() {
    chime();
    window.FlowMeshRouter.go('flow');
    var dock = $('voiceDock');
    dock.setAttribute('data-state', 'listening');
    $('dockTitle').textContent = 'Heard “Hey FlowMesh”';
    $('dockHint').textContent = info && info.summon ? 'Wispr is listening. Say what you want done.' : 'Hold your Wispr key and say what you want done.';
    if (cueTimer) clearTimeout(cueTimer);
    cueTimer = setTimeout(function () { if (window.FlowMeshVoice && window.FlowMeshVoice.repaint) window.FlowMeshVoice.repaint(); }, CUE_MS);
  }

  /* ---------------------------------------------------------------- actions */

  function toggle() {
    var want = $('wakeToggle').checked;
    if (want && !window.confirm('Keep your microphone open and listen for “Hey FlowMesh”?\n\nThe Windows speech recogniser on this computer waits for that phrase. Nothing is recorded, transcribed or sent anywhere. It stays on until you switch it off or quit FlowMesh, and a badge shows while it is on.')) {
      $('wakeToggle').checked = false;
      return;
    }
    busy = true;
    UI.api('/api/wake', want ? { enabled: true, acknowledged: true } : { enabled: false }).then(function (data) {
      info = data;
      busy = false;
      paint();
      if (want) UI.toast('Starting the recogniser. Say “Hey FlowMesh”.');
    }).catch(function (err) { busy = false; $('wakeToggle').checked = !want; UI.toast(UI.humanError(err.message)); });
  }

  function save(event) {
    if (event) event.preventDefault();
    var hold = Number($('wakeHold').value || 0);
    UI.api('/api/wake', { summon: $('wakeShortcut').value.trim(), hold_s: hold }).then(function (data) {
      info = data;
      paint();
      UI.toast(data.summon ? 'Saved. FlowMesh will press ' + data.summon + ' when it hears you.' : 'Saved. FlowMesh will not press any key.');
    }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
  }

  function test() {
    UI.api('/api/wake', { summon: $('wakeShortcut').value.trim(), hold_s: Number($('wakeHold').value || 0) }).then(function () {
      return UI.api('/api/wake', { test_summon: true });
    }).then(function () {
      UI.toast('Click into the app that should receive it. FlowMesh presses the shortcut in 3 seconds.');
    }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
  }

  function init() {
    $('wakeToggle').addEventListener('change', toggle);
    $('wakeForm').addEventListener('submit', save);
    $('wakeTest').addEventListener('click', test);
    document.addEventListener('flowmesh:mode', function () {
      paint();
      if (desktop() && !timer) { poll(); timer = setInterval(poll, POLL_MS); }
    });
    if (desktop() && !timer) { poll(); timer = setInterval(poll, POLL_MS); }
  }

  window.FlowMeshWake = { poll: poll };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
