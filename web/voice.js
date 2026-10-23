/* FlowMesh voice: Wispr Flow inside the app.

   What this is, honestly:
   - Wispr Flow has no public dictation API and FlowMesh contains no speech engine. The
     desktop app *watches Wispr's own local history* (read-only, via /api/wispr/latest) and
     picks up each new dictation as it lands, so you can hold Wispr's key anywhere in the
     window and talk. Text Wispr types into a field is already there and is not duplicated.
   - The optional microphone button uses the browser's own SpeechRecognition where it exists.
     That audio goes to the browser vendor's speech service, not to FlowMesh and not to Wispr,
     and Electron ships without such a service, so there it reports that and points to Wispr.
   - Reading results aloud uses the device's speech synthesis. Only FlowMesh's own summary is
     spoken, never raw tool output.

   Safety: a spoken sentence is untrusted input like any other. Voice commands match only
   whole utterances ("cancel", "go to tools"), never fragments of a longer sentence. "Approve"
   by voice is off by default, works only on a plan that is on screen, fresh, and free of danger
   calls, and never on a plan that needs the second confirmation. Everything else becomes a
   normal plan that a person approves. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  if (!UI) return;
  var $ = function (id) { return document.getElementById(id); };

  var STORAGE_KEY = 'flowmesh_voice';
  var DEFAULTS = { live: true, autoPlan: true, commands: true, voiceApprove: false, speak: false, capture: true };
  var POLL_MS = 1500;
  var MAX_FRESH_AGE_S = 30;
  var MAX_APPROVE_AGE_MS = 120000;

  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  var synth = window.speechSynthesis || null;
  var opt = loadOptions();
  var lastSeen = '';
  var baselined = false;
  var pollTimer = null;
  var latest = null;
  var recognizer = null;
  var listening = false;

  /* ---------------------------------------------------------------- options */

  function loadOptions() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      var out = {};
      Object.keys(DEFAULTS).forEach(function (key) { out[key] = typeof saved[key] === 'boolean' ? saved[key] : DEFAULTS[key]; });
      return out;
    } catch (err) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveOptions() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(opt)); } catch (err) { /* private mode: options last for this page only */ }
  }

  var OPTION_IDS = { live: 'optLive', autoPlan: 'optAutoPlan', commands: 'optCommands', voiceApprove: 'optVoiceApprove', speak: 'optSpeak' };

  function paintOptions() {
    Object.keys(OPTION_IDS).forEach(function (key) { $(OPTION_IDS[key]).checked = Boolean(opt[key]); });
    $('speakBtn').setAttribute('aria-pressed', opt.speak ? 'true' : 'false');
    paintDock();
    paintLive();
  }

  function bindOptions() {
    Object.keys(OPTION_IDS).forEach(function (key) {
      $(OPTION_IDS[key]).addEventListener('change', function () {
        if (key === 'voiceApprove' && this.checked && !window.confirm(
          'Allow "approve" by voice?\n\nAnyone or anything that says it near your microphone (a video, a call) could approve a plan on screen. Plans with delete, execute or other danger calls will still need a click. You can switch this off any time.')) {
          this.checked = false;
          return;
        }
        opt[key] = this.checked;
        saveOptions();
        paintOptions();
        if (key === 'speak' && !opt.speak && synth) synth.cancel();
      });
    });
    $('speakBtn').addEventListener('click', function () {
      if (!synth) { UI.toast('This device has no speech synthesis.'); return; }
      opt.speak = !opt.speak;
      saveOptions();
      paintOptions();
      if (opt.speak) speak('Reading plans and results aloud.'); else synth.cancel();
    });
  }

  /* ---------------------------------------------------------------- dock */

  function setDock(state, title, hint) {
    $('voiceDock').setAttribute('data-state', state);
    $('dockTitle').textContent = title;
    $('dockHint').textContent = hint;
  }

  function paintDock() {
    if (listening) return;
    var desktop = UI.mode() === 'desktop';
    if (desktop && opt.live) {
      setDock(document.hasFocus() ? 'waiting' : 'idle', 'Wispr live',
        document.hasFocus() ? 'Hold your Wispr key and talk. New dictations are picked up.' : 'Click this window, then talk.');
    } else if (desktop) {
      setDock('idle', 'Voice', 'Live pickup is off. Turn it on in Wispr.');
    } else {
      setDock('idle', 'Voice', opt.capture ? 'Hold your Wispr key and talk. It types here, and FlowMesh acts on it.' : (Recognition ? 'Tap the mic, or hold Wispr’s key and talk into the box.' : 'Hold Wispr’s key and talk into the box.'));
    }
    $('micBtn').hidden = !Recognition;
    $('speakBtn').hidden = !synth;
    paintMicNote();
  }

  function paintMicNote() {
    var note = $('micNote');
    if (!note) return;
    if (!Recognition) {
      note.textContent = 'This browser has no built-in speech recognition, so there is no microphone button. Wispr Flow works everywhere: hold its key and talk.';
    } else if (UI.mode() === 'desktop') {
      note.textContent = 'The microphone button uses the browser’s speech service. The desktop app’s engine has none, so it may report an error; Wispr Flow (hold its key) is the reliable voice path here.';
    } else {
      note.textContent = 'The microphone button sends audio to your browser’s speech service (not to FlowMesh and not to Wispr). Wispr Flow works too: hold its key and talk into the box.';
    }
  }

  /* ---------------------------------------------------------------- speech out */

  function speak(text) {
    if (!opt.speak || !synth || !text) return;
    try {
      synth.cancel();
      var utterance = new window.SpeechSynthesisUtterance(String(text).slice(0, 400));
      utterance.rate = 1.03;
      if (window.FlowMeshPilot) utterance.volume = window.FlowMeshPilot.volume();
      synth.speak(utterance);
    } catch (err) { /* speech is a convenience; never let it break a run */ }
  }

  function planSummary(plan) {
    var steps = plan.actions.filter(function (a) { return a.kind !== 'write_note'; }).length || plan.actions.length;
    var spoken = 'Plan: ' + plan.title + '. ' + steps + (steps === 1 ? ' step. ' : ' steps. ');
    if (plan.risk) spoken += 'Highest risk ' + plan.risk + '. ';
    if (plan.needs_confirm) spoken += 'This needs a second confirmation on screen.';
    else if (opt.voiceApprove && !plan.auto_run) spoken += 'Say approve to run, or cancel.';
    else spoken += 'Review it on screen.';
    return spoken;
  }

  /* ---------------------------------------------------------------- command grammar */

  // Pure and unit-tested in voice-grammar.js: only whole utterances ever act as commands.
  var parseCommand = window.FlowMeshGrammar.parseCommand;

  /* A few helpers for driving the page the way a person would: the same buttons, through the same
     handlers, so every safety check (plan gate, danger confirmation, single use) still applies. */
  function visible(id) { var n = $(id); return Boolean(n && !n.hidden && n.offsetParent !== null); }
  function press(id) { var n = $(id); if (n && !n.disabled && visible(id)) { n.click(); return true; } return false; }
  function later(fn, ms) { setTimeout(fn, ms); }
  var SPOKEN_OPERATORS = [[/\btimes\b|\bmultiplied by\b/g, '*'], [/\bplus\b/g, '+'], [/\bminus\b/g, '-'], [/\bdivided by\b|\bover\b/g, '/'], [/\bopen bracket\b/g, '('], [/\bclose bracket\b/g, ')']];

  function fillField(command) {
    var rows = Array.prototype.slice.call(document.querySelectorAll('#builderFields .bfield'));
    var want = command.field;
    var row = rows.filter(function (r) { var b = r.querySelector('.bcap b'); return b && b.textContent.toLowerCase() === want; })[0]
      || rows.filter(function (r) { var b = r.querySelector('.bcap b'); return b && b.textContent.toLowerCase().indexOf(want) !== -1; })[0];
    var control = row && row.querySelector('input, select, textarea');
    if (!control) return false; // not a field of the open form: it is an ordinary sentence, so it gets planned
    var text = command.text;
    if (want === 'expression') SPOKEN_OPERATORS.forEach(function (pair) { text = text.replace(pair[0], pair[1]); });
    if (control.type === 'checkbox') control.checked = /^(?:on|yes|true|enabled?)$/i.test(text);
    else if (control.tagName === 'SELECT') {
      var option = Array.prototype.filter.call(control.options, function (o) { return o.value.toLowerCase() === text.toLowerCase() || o.textContent.toLowerCase() === text.toLowerCase(); })[0];
      if (!option) return false;
      control.value = option.value;
    } else control.value = control.type === 'number' ? String(parseFloat(text)) : text;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    announce('Set ' + want + '.');
    return true;
  }

  function openHelp() {
    var body = $('voiceHelpBody');
    body.replaceChildren();
    window.FlowMeshGrammar.HELP_LIST.forEach(function (group) {
      var box = UI.el('div');
      box.appendChild(UI.el('h4', null, group[0]));
      var list = UI.el('ul');
      group[1].forEach(function (example) { list.appendChild(UI.el('li', null, '\u201c' + example + '\u201d')); });
      box.appendChild(list);
      body.appendChild(box);
    });
    if (window.FlowMeshPilotCore) {
      window.FlowMeshPilotCore.HELP.forEach(function (group) {
        var box = UI.el('div');
        box.appendChild(UI.el('h4', null, group[0]));
        var list = UI.el('ul');
        group[1].forEach(function (example) { list.appendChild(UI.el('li', null, '\u201c' + example + '\u201d')); });
        box.appendChild(list);
        body.appendChild(box);
      });
    }
    if (typeof $('voiceHelp').showModal === 'function' && !$('voiceHelp').open) $('voiceHelp').showModal();
  }

  /** Returns false only when a spoken `fill` named no field of the open form, so the sentence is planned instead. */
  function runCommand(command) {
    var router = window.FlowMeshRouter;
    if (command.type === 'plan') {
      router.go('flow');
      announce('Creating the plan.');
      later(UI.createPlan, 150);
    } else if (command.type === 'focus') {
      router.go('flow');
      UI.focusCommand();
      announce('Say or type your command.');
    } else if (command.type === 'example') {
      router.go('flow');
      var chip = document.querySelector('[data-example="' + command.name + '"]');
      if (chip) { chip.click(); announce('Loaded the example. Creating the plan.'); later(UI.createPlan, 250); }
    } else if (command.type === 'latest') {
      router.go('history');
      later(function () {
        var first = document.querySelector('#runsList .run');
        if (first) { first.click(); announce('Opened the latest run.'); } else announce('There are no runs yet.');
      }, 700);
    } else if (command.type === 'copy' || command.type === 'download') {
      var pairs = visible('artifactPanel') ? ['copyButton', 'downloadButton'] : visible('recordActions') ? ['recordCopy', 'recordDownload'] : null;
      if (pairs && press(pairs[command.type === 'copy' ? 0 : 1])) announce(command.type === 'copy' ? 'Copying the record.' : 'Downloading the record.');
      else announce('There is no run record on screen. Run a plan, or say "open the latest run".');
    } else if (command.type === 'next') {
      if (visible('nextStepBar') && press('nextStep')) announce('Planning the next step from that output.'); else announce('There is no output to build on yet.');
    } else if (command.type === 'palette') {
      var trigger = Array.prototype.filter.call(document.querySelectorAll('.js-palette'), function (n) { return n.offsetParent !== null; })[0];
      if (trigger) trigger.click();
    } else if (command.type === 'scroll') {
      var behavior = UI.reduced() ? 'auto' : 'smooth';
      if (command.to === 'top') window.scrollTo({ top: 0, behavior: behavior });
      else if (command.to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: behavior });
      else window.scrollBy({ top: (command.to === 'down' ? 1 : -1) * Math.round(window.innerHeight * 0.8), behavior: behavior });
    } else if (command.type === 'speak') {
      if (!synth) announce('This device has no speech synthesis.');
      else { if (command.on !== opt.speak) $('speakBtn').click(); announce(command.on ? 'Reading aloud is on.' : 'Reading aloud is off.'); }
    } else if (command.type === 'help') {
      openHelp();
    } else if (command.type === 'tool') {
      router.go('tools');
      later(function () {
        var item = Array.prototype.filter.call(document.querySelectorAll('#toolList .tool-item'), function (n) {
          var name = n.querySelector('.tool-name');
          return name && name.textContent.split(' / ').pop() === command.tool; // rows read "server / tool"
        })[0];
        if (item) { item.click(); announce('Opened that tool. Say "set" and a field name to fill it in.'); } else announce('That tool is not connected.');
      }, 200);
    } else if (command.type === 'builder') {
      var target = { add: 'builderAdd', call: 'builderPlan', chain: 'chainPlan', clear: 'chainClear' }[command.action];
      if (!press(target)) announce('Open a tool first, then fill in its fields.');
    } else if (command.type === 'fill') {
      return fillField(command);
    } else if (command.type === 'go') {
      router.go(command.page);
      announce('Opening ' + router.routes[command.page] + '.');
    } else if (command.type === 'cancel') {
      if (UI.hasPlan()) { UI.clearPlan(); announce('Cancelled. Nothing ran.'); } else announce('There is no plan to cancel.');
    } else if (command.type === 'read') {
      var plan = UI.plan();
      if (plan) announce(planSummary(plan), true); else announce('There is no plan on screen.');
    } else if (command.type === 'clear') {
      UI.setCommand('');
      router.go('flow');
      announce('Cleared. Say your next command.');
    } else if (command.type === 'approve') {
      voiceApprove();
    }
  }

  function voiceApprove() {
    var plan = UI.plan();
    var refusal = !opt.voiceApprove ? 'Approve by voice is off. Click Approve & run, or turn it on in Wispr.'
      : !plan ? 'There is no plan on screen to approve.'
      : plan.needs_confirm ? 'That plan can change or destroy things, so it needs a click and its confirmation.'
      : plan.auto_run ? 'That plan is already running.'
      : UI.planAge() > MAX_APPROVE_AGE_MS ? 'That plan has been on screen a while. Review it and click Approve & run.'
      : '';
    if (refusal) { announce(refusal); return; }
    announce('Approved. Running.');
    UI.approvePlan();
  }

  /* A spoken confirmation is shown on screen always, and read aloud when read-aloud is on. */
  function announce(message, alwaysSpeak) {
    UI.toast(message);
    if (listening) return;
    $('dockHint').textContent = message;
    if (alwaysSpeak) { var was = opt.speak; opt.speak = true; speak(message); opt.speak = was; } else speak(message);
  }

  /* ---------------------------------------------------------------- handling an utterance */

  function handleText(text, source, info) {
    var clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (opt.commands) {
      var command = parseCommand(clean, { builderOpen: visible('builderForm') });
      if (command && runCommand(command) !== false) return;
      // The page pilot: zoom, volume, screenshot, scroll to a section, palette actions. Whole utterances only.
      if (window.FlowMeshPilot && window.FlowMeshPilot.handle(clean)) return;
    }
    window.FlowMeshRouter.go('flow');
    if (source === 'wispr') UI.pullDictation();
    else UI.setCommand(clean);
    if (opt.autoPlan) {
      // Planning is harmless: nothing runs until the plan on screen is approved.
      setTimeout(UI.createPlan, 250);
    } else {
      UI.toast('Picked up your dictation. Review it, then create the plan.');
    }
  }

  /* ---------------------------------------------------------------- Wispr capture (hosted page)

     The hosted page cannot read Wispr Flow's local history, but Wispr types into whatever field has
     focus. This field keeps focus when nothing else is being edited, so holding Wispr's key and talking
     lands here; a pause (or Enter) sends the sentence through the same grammar and planner as a
     spoken one. It yields to any other field you click into, and Escape leaves it. */

  var CATCH_IDLE_MS = 1600;
  var catchTimer = null;

  function captureOn() { return UI.mode() === 'browser' && opt.capture; }

  function paintCapture() {
    var browser = UI.mode() === 'browser';
    $('catchBtn').hidden = !browser;
    $('catchBtn').setAttribute('aria-pressed', opt.capture ? 'true' : 'false');
    $('voiceCatch').hidden = !(browser && opt.capture);
    if (captureOn()) keepCatchFocus();
  }

  function keepCatchFocus() {
    if (!captureOn() || document.querySelector('dialog[open]')) return;
    var a = document.activeElement;
    var editing = a && a !== $('voiceCatch') && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.isContentEditable);
    if (editing) return;
    if (!a || a === document.body || a === document.documentElement || a.id === 'main' || a.tagName === 'A' || a.tagName === 'BUTTON') $('voiceCatch').focus({ preventScroll: true });
  }

  function submitCapture() {
    clearTimeout(catchTimer);
    var value = $('voiceCatch').value;
    $('voiceCatch').value = '';
    if (!value.trim()) return;
    if (!listening) $('dockHint').textContent = 'Heard: ' + value.trim().slice(0, 80);
    handleText(value, 'catch');
    // The typing is over: leave the "Listening" look but keep whatever the command just announced.
    $('voiceDock').setAttribute('data-state', 'waiting');
    $('dockTitle').textContent = 'Voice';
    // A command can move focus (opening a tool focuses its first field). In voice mode the next sentence should
    // still come here, so take focus back, except when the person asked for the command box.
    later(function () {
      var a = document.activeElement;
      if (captureOn() && !document.querySelector('dialog[open]') && !(a && a.id === 'commandInput')) $('voiceCatch').focus({ preventScroll: true });
    }, 700);
  }

  function bindCapture() {
    var field = $('voiceCatch');
    field.addEventListener('input', function () {
      clearTimeout(catchTimer);
      catchTimer = setTimeout(submitCapture, CATCH_IDLE_MS);
      if (!listening) setDock('listening', 'Listening\u2026', field.value.slice(-80));
    });
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); submitCapture(); }
      else if (event.key === 'Escape') { field.value = ''; clearTimeout(catchTimer); field.blur(); paintDock(); }
    });
    field.addEventListener('blur', function () { if (!field.value.trim()) paintDock(); });
    $('catchBtn').addEventListener('click', function () {
      opt.capture = !opt.capture;
      saveOptions();
      paintCapture();
      UI.toast(opt.capture ? 'Wispr capture is on. Hold your Wispr key and talk.' : 'Wispr capture is off.');
    });
    document.addEventListener('click', function (event) {
      var t = event.target;
      if (t && t.closest && t.closest('textarea, input, select, a, button, summary, label, dialog')) return;
      later(keepCatchFocus, 0);
    });
    ['flowmesh:route', 'flowmesh:plan', 'flowmesh:run'].forEach(function (name) { document.addEventListener(name, function () { later(keepCatchFocus, 300); }); });
    window.addEventListener('focus', function () { later(keepCatchFocus, 100); });
  }

  /* ---------------------------------------------------------------- live pickup (desktop) */

  function paintLive() {
    var desktop = UI.mode() === 'desktop';
    var pill = $('liveState');
    if (!pill) return;
    if (!desktop) return;
    var watching = opt.live;
    pill.textContent = watching ? 'watching' : 'paused';
    pill.setAttribute('data-state', watching ? 'ready' : 'idle');
    $('liveHint').textContent = watching
      ? 'Watching your Wispr Flow history for new dictations while this window is focused.'
      : 'Paused. Turn on "Pick up new dictations" to use Wispr from anywhere in this window.';
    var box = $('liveLatest');
    if (latest && latest.text) {
      box.classList.remove('empty-live');
      box.textContent = latest.text;
      $('liveUse').disabled = false;
      $('liveAge').textContent = latest.age_seconds == null ? '' : Math.round(latest.age_seconds) + 's ago' + (latest.app ? ' · into ' + latest.app : '');
    } else {
      box.classList.add('empty-live');
      box.textContent = 'Nothing dictated in the last few minutes. Hold your Wispr key and say something.';
      $('liveUse').disabled = true;
      $('liveAge').textContent = '';
    }
  }

  function pollLatest() {
    if (UI.mode() !== 'desktop' || document.hidden) return;
    UI.get('/api/wispr/latest').then(function (info) {
      latest = info.state === 'ready' ? info : null;
      paintLive();
      var id = info.state === 'ready' ? info.id : '';
      if (!baselined) { baselined = true; lastSeen = id || ''; return; } // never act on history older than this page
      if (!id || id === lastSeen) return;
      lastSeen = id;
      if (!opt.live || !document.hasFocus() || info.already_executed) return;
      if (typeof info.age_seconds === 'number' && info.age_seconds > MAX_FRESH_AGE_S) return;
      // Dictated into a field FlowMesh owns: the text is already there, do not duplicate it.
      if (UI.isTyping()) return;
      handleText(info.text, 'wispr', info);
    }).catch(function (err) {
      // A rejected session token will never recover by retrying; stop instead of hammering the runtime.
      if (/session token/i.test((err && err.message) || '') && pollTimer) { clearInterval(pollTimer); pollTimer = null; setDock('idle', 'Voice', 'Session ended. Reload FlowMesh to reconnect.'); }
    });
  }

  function startPolling() {
    if (pollTimer) return;
    pollLatest();
    pollTimer = setInterval(pollLatest, POLL_MS);
  }

  /* ---------------------------------------------------------------- microphone */

  var MIC_ERRORS = {
    'not-allowed': 'The microphone is blocked. Allow it for this page, or use Wispr Flow (hold its key).',
    'service-not-allowed': 'Speech recognition is not allowed here. Use Wispr Flow (hold its key).',
    'network': 'This runtime has no speech service to send audio to. Use Wispr Flow (hold its key) instead.',
    'no-speech': 'No speech heard. Tap the mic and try again.',
    'audio-capture': 'No microphone was found.',
    'language-not-supported': 'That language is not supported by this speech service.',
  };

  function stopMic() {
    if (recognizer) { try { recognizer.stop(); } catch (err) { /* already stopped */ } }
  }

  function startMic() {
    if (!Recognition) return;
    if (listening) { stopMic(); return; }
    recognizer = new Recognition();
    recognizer.lang = navigator.language || 'en-US';
    recognizer.interimResults = true;
    recognizer.continuous = false;
    var finalText = '';
    recognizer.onstart = function () {
      listening = true;
      $('micBtn').setAttribute('aria-pressed', 'true');
      setDock('listening', 'Listening…', 'Say a sentence, or a command like "go to tools".');
    };
    recognizer.onresult = function (event) {
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i += 1) {
        var part = event.results[i][0].transcript;
        if (event.results[i].isFinal) finalText += part; else interim += part;
      }
      $('dockHint').textContent = (finalText + interim).slice(-90);
    };
    recognizer.onerror = function (event) {
      UI.toast(MIC_ERRORS[event.error] || 'The microphone stopped: ' + event.error);
    };
    recognizer.onend = function () {
      listening = false;
      $('micBtn').setAttribute('aria-pressed', 'false');
      paintDock();
      if (finalText.trim()) handleText(finalText, 'mic');
    };
    try { recognizer.start(); } catch (err) { UI.toast('Could not start the microphone.'); }
  }

  /* ---------------------------------------------------------------- boot */

  function paletteItems() {
    var items = [];
    if (Recognition) items.push({ label: listening ? 'Stop listening' : 'Listen with the microphone', hint: 'voice', run: startMic });
    items.push({ label: opt.speak ? 'Stop reading aloud' : 'Read plans and results aloud', hint: 'voice', run: function () { $('speakBtn').click(); } });
    if (UI.plan()) items.push({ label: 'Read the plan aloud', hint: 'voice', run: function () { runCommand({ type: 'read' }); } });
    return items;
  }

  function init() {
    bindOptions();
    bindCapture();
    $('micBtn').addEventListener('click', startMic);
    $('liveUse').addEventListener('click', function () { window.FlowMeshRouter.go('flow'); UI.pullDictation(); });
    document.addEventListener('flowmesh:mode', function () { paintOptions(); paintCapture(); if (UI.mode() === 'desktop') startPolling(); });
    document.addEventListener('flowmesh:plan', function (event) {
      var plan = event.detail.plan;
      if (!listening) $('dockHint').textContent = 'Plan ready: ' + plan.title;
      speak(planSummary(plan));
    });
    document.addEventListener('flowmesh:run', function (event) {
      var d = event.detail;
      var parts = [];
      if (d.verified) parts.push(d.verified + ' verified');
      if (d.returned) parts.push(d.returned + ' returned');
      if (d.failed) parts.push(d.failed + ' failed');
      var message = 'Run complete' + (parts.length ? ': ' + parts.join(', ') : '') + '.';
      if (!listening) $('dockHint').textContent = message;
      speak(message);
    });
    window.addEventListener('focus', paintDock);
    window.addEventListener('blur', paintDock);
    document.addEventListener('visibilitychange', paintDock);
    paintOptions();
    paintCapture();
    if (UI.mode() === 'desktop') startPolling();
  }

  window.FlowMeshVoice = { announce: announce, repaint: paintDock, parseCommand: parseCommand, paletteItems: paletteItems, speak: speak, options: function () { return Object.assign({}, opt); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
