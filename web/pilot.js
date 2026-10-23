/* FlowMesh page pilot: drive the whole page by voice (or by anything that types a sentence).

   A small rule-based agent, no model. It understands view controls (zoom, volume, screenshot, full
   screen, scroll to a section, back, forward, reload) and any command-palette action named closely
   enough, using pilot-core.js, whose language is unit-tested. It only presses controls a person could
   press and it can never approve, confirm, delete or disconnect anything.

   Volume has two meanings and the pilot says which one it used: on the desktop app (Windows) "volume
   up" moves the real system volume; everywhere else it moves FlowMesh's own voice volume, which is
   what read-aloud summaries and the wake chime use. Screenshots use the desktop app's window capture
   when available (saved to your FlowMesh folder), otherwise the browser's own tab capture, which asks
   you first. Everything the runtime sends is untrusted text and is set with textContent. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  var Core = window.FlowMeshPilotCore;
  if (!UI || !Core) return;

  var KEY = 'flowmesh_pilot';
  var state = { zoom: 100, volume: 1, muted: false };
  var caps = { enabled: true, system_volume: false, screenshot: false };

  function load() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(KEY) || '{}');
      if (typeof saved.zoom === 'number') state.zoom = Math.max(Core.ZOOM_MIN, Math.min(Core.ZOOM_MAX, saved.zoom));
      if (typeof saved.volume === 'number') state.volume = Math.max(0, Math.min(1, saved.volume));
      if (typeof saved.muted === 'boolean') state.muted = saved.muted;
    } catch (err) { /* private mode: the settings last for this page only */ }
  }

  function save() {
    try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
  }

  function say(message) {
    if (window.FlowMeshVoice && window.FlowMeshVoice.announce) window.FlowMeshVoice.announce(message);
    else UI.toast(message);
  }

  /* ---------------------------------------------------------------- zoom */

  function applyZoom() {
    document.documentElement.style.zoom = state.zoom === 100 ? '' : String(state.zoom / 100);
  }

  function zoom(command) {
    var next = state.zoom;
    if (command.mode === 'in') next += Core.ZOOM_STEP;
    else if (command.mode === 'out') next -= Core.ZOOM_STEP;
    else if (command.mode === 'reset') next = 100;
    else if (command.mode === 'set') next = command.value;
    next = Math.max(Core.ZOOM_MIN, Math.min(Core.ZOOM_MAX, next));
    if (next === state.zoom && command.mode !== 'reset') { say('The page is already at ' + (next === Core.ZOOM_MAX ? 'its largest' : next === Core.ZOOM_MIN ? 'its smallest' : next + '%') + ' size.'); return; }
    state.zoom = next;
    applyZoom();
    save();
    say('Zoom ' + state.zoom + '%.');
  }

  /* ---------------------------------------------------------------- volume */

  function volume(command) {
    var system = UI.mode() === 'desktop' && caps.system_volume && command.op !== 'set' && command.op !== 'unmute';
    if (system) {
      var action = command.op;
      UI.api('/api/pilot/volume', { action: action }).then(function (res) { say(res.detail); })
        .catch(function (err) { say(UI.humanError(err.message)); });
      return;
    }
    if (command.op === 'up') { state.muted = false; state.volume = Math.min(1, state.volume + 0.2); }
    else if (command.op === 'down') state.volume = Math.max(0, state.volume - 0.2);
    else if (command.op === 'mute') { state.muted = true; if (window.speechSynthesis) window.speechSynthesis.cancel(); }
    else if (command.op === 'unmute') state.muted = false;
    else if (command.op === 'set') { state.muted = false; state.volume = command.value / 100; }
    save();
    var shown = state.muted ? 'muted' : Math.round(state.volume * 100) + '%';
    say('FlowMesh voice volume ' + shown + '. This is the voice and chime, not your computer’s volume' + (UI.mode() === 'desktop' && caps.system_volume && command.op === 'set' ? ' (the system volume can only be nudged up or down)' : '') + '.');
  }

  /* ---------------------------------------------------------------- screenshot */

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp() {
    return new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  }

  function captureTab() {
    var media = navigator.mediaDevices;
    if (!media || !media.getDisplayMedia) return Promise.reject(new Error('This browser cannot capture the tab.'));
    return media.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true }).then(function (stream) {
      var video = document.createElement('video');
      video.muted = true;
      video.srcObject = stream;
      return video.play().then(function () {
        return new Promise(function (resolve) { setTimeout(resolve, 350); });
      }).then(function () {
        var canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        stream.getTracks().forEach(function (t) { t.stop(); });
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('The capture was empty.')); }, 'image/png');
        });
      });
    });
  }

  function screenshot() {
    if (UI.mode() === 'desktop' && caps.screenshot) {
      UI.api('/api/pilot/screenshot', {}).then(function (res) {
        say('Saved ' + res.name + ' in your FlowMesh folder (' + Math.round(res.bytes / 1024) + ' KB, SHA-256 ' + res.sha256.slice(0, 12) + '…).');
      }).catch(function (err) { say(UI.humanError(err.message)); });
      return;
    }
    say('Your browser will ask which tab to share. Choose this one.');
    captureTab().then(function (blob) {
      download(blob, 'flowmesh-screenshot-' + stamp() + '.png');
      say('Screenshot downloaded.');
    }).catch(function (err) {
      say(err && err.name === 'NotAllowedError' ? 'Screenshot cancelled.' : 'Could not take a screenshot: ' + ((err && err.message) || 'unknown error') + '.');
    });
  }

  /* ---------------------------------------------------------------- movement */

  function headings() {
    var page = document.querySelector('.page:not([hidden])');
    if (!page) return [];
    var seen = [];
    var nodes = Array.prototype.slice.call(page.querySelectorAll('h1, h2, h3, .step, .group-title, .panel-head .step'));
    return nodes.filter(function (n) { return n.offsetParent !== null && n.textContent.trim() && seen.indexOf(n) === -1 && seen.push(n); });
  }

  function section(command) {
    var nodes = headings();
    var index = Core.matchSection(command.name, nodes.map(function (n) { return n.textContent; }));
    if (index < 0) { say('I could not find a single section called “' + command.name + '” on this page.'); return; }
    nodes[index].scrollIntoView({ behavior: UI.reduced() ? 'auto' : 'smooth', block: 'start' });
    say('Scrolled to ' + nodes[index].textContent.trim() + '.');
  }

  function fullscreen(command) {
    var request = command.on ? document.documentElement.requestFullscreen : document.exitFullscreen;
    if (!request) { say('This browser has no full screen mode.'); return; }
    var done = command.on ? request.call(document.documentElement) : (document.fullscreenElement ? request.call(document) : Promise.resolve());
    Promise.resolve(done).then(function () { say(command.on ? 'Full screen.' : 'Left full screen.'); })
      .catch(function () { say('Your browser wants a click or key press before it allows full screen. Press F11 once.'); });
  }

  function palette(command) {
    var items = (window.FlowMeshPalette && window.FlowMeshPalette.items()) || [];
    var item = items.filter(function (i) { return i.label === command.label; })[0];
    if (!item) { say('That action is not available right now.'); return; }
    say(item.label + '.');
    item.run();
  }

  /* ---------------------------------------------------------------- entry point */

  function labels() {
    return ((window.FlowMeshPalette && window.FlowMeshPalette.items()) || []).map(function (i) { return i.label; });
  }

  /** Runs a whole utterance if it is a pilot command. Returns true when it was one. */
  function handle(text) {
    if (!caps.enabled) return false;
    var command = Core.parse(text, { labels: labels() });
    if (!command) return false;
    if (command.type === 'zoom') zoom(command);
    else if (command.type === 'volume') volume(command);
    else if (command.type === 'screenshot') screenshot();
    else if (command.type === 'fullscreen') fullscreen(command);
    else if (command.type === 'history') { if (command.dir === 'back') window.history.back(); else window.history.forward(); }
    else if (command.type === 'reload') window.location.reload();
    else if (command.type === 'section') section(command);
    else if (command.type === 'palette') palette(command);
    else return false;
    return true;
  }

  function loadCaps() {
    if (UI.mode() !== 'desktop') return;
    UI.get('/api/pilot').then(function (data) { caps = data; }).catch(function () { /* keep the defaults */ });
  }

  function init() {
    load();
    applyZoom();
    document.addEventListener('flowmesh:mode', loadCaps);
    loadCaps();
  }

  window.FlowMeshPilot = {
    handle: handle,
    volume: function () { return state.muted ? 0 : state.volume; },
    zoom: function () { return state.zoom; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
