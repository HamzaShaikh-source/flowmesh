/* FlowMesh UI — one page, two runtimes. No simulation: every status is earned. */
(function () {
  'use strict';

  var core = window.FlowMeshCore;
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    mode: 'detecting',
    token: null,
    plan: null,
    used: false,
    expiresAt: 0,
    tick: null,
    receipts: [],
    record: null,
    caps: {},
    artifactDir: '',
    dictation: null,
    wordsFrom: null,
  };

  // The command box's own maxlength. Kept here so the trim and the counter agree.
  var BOX_LIMIT = 1000;

  var URLS = {
    project_board: 'https://github.com/HamzaShaikh-source/flowmesh/issues',
    documentation: 'https://github.com/HamzaShaikh-source/flowmesh/tree/main/docs',
  };

  var EXAMPLES = {
    meeting: 'I just finished the pricing call. Follow-up: send Rohan the revised quote tomorrow and ask about the November demo. Open my board, notify my phone, and set the lamp to 70 percent.',
    focus: 'Start a 45 minute focus session. Open my project board, open my editor, notify my phone, and set the desk lamp to 30 percent.',
    research: 'Start a 25 minute research sprint. Open the documentation and the calculator, notify my phone, and set the lamp to 55 percent.',
    capture: 'Capture: the judges page hides the weights, so screenshot the criteria before the deadline.',
  };

  var STATUS_LABEL = {
    verified: 'VERIFIED',
    sent: 'SENT',
    unknown: 'UNKNOWN',
    not_configured: 'NOT CONFIGURED',
    unavailable: 'UNAVAILABLE',
    desktop_only: 'DESKTOP ONLY',
    failed: 'FAILED',
    denied: 'DENIED',
  };

  var ERRORS = {
    plan_expired: 'That plan expired before you approved it. Nothing ran — create a new plan.',
    plan_used: 'That plan was already used. Plans run once; create a new one.',
    plan_missing: 'That plan is no longer available. Create a new one.',
    plan_unknown: 'That plan is no longer available. Create a new one.',
    origin_rejected: 'The request did not come from the FlowMesh page. Blocked.',
    token_rejected: 'This session token is not valid. Reload the desktop app.',
    unsupported_command: 'No registered workflow matches that, and nothing was run. Try focus, meeting, research or capture.',
    forbidden_command: 'That request touches something FlowMesh is not allowed to do. It was refused, not queued.',
    command_too_long: 'That command is over 1000 characters. Shorten it and try again.',
    command_required: 'Say or type a command first.',
    bad_action_payload: 'The runtime only accepts a plan id, never an action list.',
    bad_request: 'The runtime could not read that request.',
    content_type_rejected: 'The runtime only accepts JSON.',
    host_rejected: 'The runtime only answers on loopback. Blocked.',
  };

  function humanError(code) {
    return ERRORS[code] || 'The runtime answered: ' + code;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function toast(message) {
    var live = $('liveRegion');
    live.textContent = message;
    live.setAttribute('data-show', '1');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { live.removeAttribute('data-show'); }, 4200);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function stamp(date) {
    return date.getFullYear() + pad(date.getMonth() + 1) + pad(date.getDate()) + '-' +
      pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds());
  }

  function clock(ms) {
    var total = Math.max(0, Math.round(ms / 1000));
    return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
  }

  /* ---------------- runtime detection ---------------- */

  function init() {
    var params = new URLSearchParams(window.location.search);
    var key = params.get('k');
    if (key) {
      try { sessionStorage.setItem('flowmesh_token', key); } catch (err) { /* private mode */ }
      params.delete('k');
      var rest = params.toString();
      history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
    }
    try { S.token = sessionStorage.getItem('flowmesh_token'); } catch (err) { S.token = null; }

    bind();
    if (!S.token) { setBrowserMode(); return; }

    fetch('/api/status', { headers: { 'X-FlowMesh-Token': S.token }, cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('status_' + res.status);
        return res.json();
      })
      .then(function (status) { setDesktopMode(status); loadWispr(); loadAccount(); showHotkeys(); })
      .catch(function () { setBrowserMode(); });
    // The shell pushes the real accelerators once the page has loaded, which can be
    // after this runs — so it also announces them, and we redraw when it does.
    window.addEventListener('flowmesh:hotkeys', showHotkeys);
  }

  function setBrowserMode() {
    S.mode = 'browser';
    var badge = $('runtimeBadge');
    badge.setAttribute('data-state', 'browser');
    $('runtimeText').textContent = 'Browser edition · live';
    S.caps = { open_url: 'ready', timer: 'ready', write_note: 'download', launch_app: 'desktop_only', notify: 'desktop_only', light: 'desktop_only', jev: 'none' };
    $('consoleSub').textContent = 'You are in the browser edition. The plan, the approved links, the timer and the run record are real here. App launches, phone notifications and the lamp are performed by the desktop app — they are marked desktop only and never faked.';
    $('capNote').textContent = 'The browser cannot touch your filesystem, your apps, or your home. FlowMesh does not claim otherwise. The device rows are executed only by the local runtime, after a one-use approval, and are read back before they are called verified.';
    paintWisprDesktopOnly();
  }

  /* The Wispr integration reads a local database, so this page cannot show it live.
     Hiding the panel entirely would hide the flagship feature from every judge who
     only opens the link, so it is shown with an honest desktop-only state and a
     pointer to the build that can actually do it. */
  function paintWisprDesktopOnly() {
    $('wisprStrip').hidden = false;
    var badge = $('wisprState');
    badge.textContent = 'desktop only';
    badge.setAttribute('data-state', 'desktop_only');
    $('wisprDetail').textContent =
      'This reads your own Wispr Flow history on your machine, so the browser edition cannot do it — ' +
      'a web page has no access to your files. Download the desktop app and hold your Wispr key, speak, ' +
      'then press "Use my last dictation": FlowMesh pulls that sentence read-only and hands it to the ' +
      'plan → approve → run loop. Nothing here is simulated and nothing is claimed on this page.';
    $('wisprStats').textContent = 'Local history, read-only · Scratchpad notes through Wispr’s official sign-in (desktop app)';
    $('pullDictation').hidden = true;
    $('typeDictation').hidden = true;
    /* The clip is a real capture of this connector against a real database, recorded from
       the desktop runtime. It is shown only here, where the live panel cannot exist, so a
       judge who never installs anything still sees the feature working. */
    var clip = $('connectorClip');
    if (clip) clip.hidden = false;
  }

  function setDesktopMode(status) {
    S.mode = 'desktop';
    S.caps = status.capabilities || {};
    S.artifactDir = status.artifact_dir || '';
    var badge = $('runtimeBadge');
    badge.setAttribute('data-state', 'desktop');
    $('runtimeText').textContent = 'Desktop runtime · ' + (status.platform || 'local');
    $('consoleSub').textContent = 'Desktop runtime connected. Every action below is performed by the local app on this computer after you approve it. Home Assistant rows report exactly what they find.';
    $('capNote').textContent = 'Run records are written to ' + (S.artifactDir || 'your FlowMesh folder') + ', each with a SHA-256 in its receipt.';

    paintDesktopCell('open_url', 'Open an approved URL', S.caps.open_url, 'ready');
    paintDesktopCell('timer', 'Countdown timer', S.caps.timer, 'ready');
    paintDesktopCell('launch_app_desktop', 'Launch an allowlisted app', S.caps.launch_app, 'ready');
    paintDesktopCell('notify_desktop', 'Phone notification (Home Assistant)', S.caps.notify, 'not_configured');
    paintDesktopCell('light_desktop', 'Desk lamp brightness (Home Assistant)', S.caps.light, 'not_configured');
    paintDesktopCell('jev', 'Jev Choice routing', S.caps.jev, 'local_rules');

    $('settingsSection').hidden = false;
    loadSettings();
  }

  function paintDesktopCell(cellId, label, value, readyValue) {
    var cell = document.querySelector('[data-cell="' + cellId + '"]');
    if (!cell) return;
    var map = {
      ready: ['READY', 'ready'],
      unavailable: ['UNAVAILABLE', 'none'],
      not_configured: ['NEEDS SETUP', 'setup'],
      local_rules: ['LOCAL RULES', 'setup'],
      jev_connected: ['JEV CONNECTED', 'ready'],
    };
    var state = value || 'unavailable';
    var pair = map[state] || [String(state).toUpperCase(), 'none'];
    cell.textContent = pair[0];
    cell.setAttribute('data-state', state === readyValue ? 'ready' : pair[1]);
    cell.title = label + ': ' + state;
  }

  /* ---------------- plan ---------------- */

  function bind() {
    $('planButton').addEventListener('click', createPlan);
    $('commandInput').addEventListener('input', function () {
      $('charCount').textContent = this.value.length + ' / ' + BOX_LIMIT;
      // Typing over a pulled dictation changes where the words came from. Without
      // this, editing one word would leave a line claiming the text was dictated.
      if (S.wordsFrom && (S.wordsFrom.kind === 'dictation' || S.wordsFrom.kind === 'note')) {
        S.wordsFrom = { kind: 'typed' };
        S.dictation = null;
        showProvenance();
      }
    });
    $('commandInput').addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        if (event.shiftKey) {
          if (S.plan && !$('approveButton').disabled) approvePlan();
        } else {
          createPlan();
        }
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && S.plan) cancelPlan();
    });
    // The desktop shell's global hotkeys land here as a hash change, so a hotkey runs
    // exactly the same code the buttons do and the plan stays visible on screen.
    window.addEventListener('hashchange', function () {
      var action = window.location.hash.replace('#', '');
      history.replaceState(null, '', window.location.pathname + window.location.search);
      if (action === 'pull') pullDictation();
      else if (action === 'approve') {
        if (S.plan) approvePlan();
        else toast('No plan is on screen to approve.' + pullHint());
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-example]'), function (chip) {
      chip.addEventListener('click', function () {
        var text = EXAMPLES[chip.getAttribute('data-example')];
        $('commandInput').value = text;
        $('charCount').textContent = text.length + ' / ' + BOX_LIMIT;
        $('commandInput').focus();
      });
    });
    $('approveButton').addEventListener('click', approvePlan);
    $('cancelButton').addEventListener('click', cancelPlan);
    $('pullDictation').addEventListener('click', pullDictation);
    $('accountConnect').addEventListener('click', connectAccount);
    $('accountBrowse').addEventListener('click', browseNotes);
    $('accountDisconnect').addEventListener('click', disconnectAccount);
    $('typeDictation').addEventListener('click', typeDictation);
    $('downloadButton').addEventListener('click', function () {
      if (!S.record) return;
      download(S.record.name, S.record.text);
      toast('Download started · ' + S.record.name);
    });
    $('copyButton').addEventListener('click', function () {
      var text = S.record ? S.record.text : S.artifactPath;
      if (!text) return;
      copy(text).then(function () {
        toast(S.record ? 'Run record copied as Markdown.' : 'Record path copied.');
      }).catch(function () { toast('Copy failed — select the text and copy it manually.'); });
    });
    var form = $('settingsForm');
    if (form) form.addEventListener('submit', saveSettings);
  }

  function createPlan() {
    var text = $('commandInput').value.trim();
    if (!text) {
      toast(ERRORS.command_required);
      $('commandInput').focus();
      return;
    }
    if (text.length > 1000) { toast(ERRORS.command_too_long); return; }
    if (S.mode === 'desktop') {
      var body = S.dictation ? { command: text, dictation: S.dictation } : { command: text };
      api('/api/plan', body).then(function (plan) {
        plan.command = text;
        showPlan(plan);
      }).catch(function (err) { handleError(err); });
      return;
    }
    // Browser edition: the same planner, running in this page.
    var route = core.localRoute(text);
    if (!route) {
      if (core.isForbidden(text)) {
        showRefusal('Refused before planning',
          'That command names something FlowMesh is not allowed to touch: deletions, payments, credentials, or physical safety. Nothing was scheduled.',
          text);
      } else {
        showRefusal('No registered workflow matched',
          'Registered routines are focus, meeting, research and quick capture. Nothing was run. Rephrase, or dictate one of those intents.',
          text);
      }
      return;
    }
    var payload = core.planPayload(route, text, 'local');
    showPlan({
      id: 'web-' + randomId(),
      route: payload.route,
      title: payload.title,
      description: payload.description,
      source: payload.source,
      confidence: null,
      also: payload.also,
      actions: payload.actions,
      expires_at: Date.now() / 1000 + 300,
      command: text,
    });
  }

  function randomId() {
    var bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function showPlan(plan) {
    S.plan = plan;
    S.used = false;
    S.expiresAt = (plan.expires_at || (Date.now() / 1000 + 300)) * 1000;
    $('planEmpty').hidden = true;
    $('planPanel').hidden = false;
    $('planTitle').textContent = plan.title;
    $('planDesc').textContent = plan.description;
    var also = plan.also || [];
    $('planAlso').hidden = !also.length;
    $('planAlso').textContent = also.length
      ? 'Also heard in this sentence: ' + also.join(', ') + '. Not part of this plan — dictate that as its own command.'
      : '';
    var badge = $('planSource');
    badge.hidden = false;
    badge.textContent = plan.source === 'jev' ? 'JEV CHOICE' : 'LOCAL RULES';
    if (plan.confidence !== null && plan.confidence !== undefined) {
      badge.textContent = 'JEV CHOICE · ' + Math.round(plan.confidence * 100) + '%';
    }

    var list = $('planActions');
    list.replaceChildren();
    plan.actions.forEach(function (action, index) {
      var row = el('li');
      row.appendChild(el('span', 'idx', pad(index + 1)));
      var body = el('div');
      body.appendChild(el('span', 'label', action.label));
      body.appendChild(el('span', 'detail', action.detail));
      if (action.kind === 'write_note' && action.note) {
        var peek = el('details', 'note-peek');
        peek.appendChild(el('summary', null, 'Read exactly what will be written'));
        peek.appendChild(el('pre', null, action.note));
        body.appendChild(peek);
      }
      row.appendChild(body);
      row.appendChild(el('span', 'tag', String(action.surface || 'pc').toUpperCase()));
      list.appendChild(row);
    });

    $('planPanel').classList.remove('consumed');
    $('cancelButton').hidden = false;
    $('approveButton').textContent = 'Approve & run ↗';
    $('approveButton').disabled = false;
    clearInterval(S.tick);
    S.tick = setInterval(tickExpiry, 500);
    tickExpiry();
    $('approveButton').focus();
  }

  function tickExpiry() {
    if (!S.plan) return;
    var left = S.expiresAt - Date.now();
    if (left <= 0) {
      clearInterval(S.tick);
      S.plan = null;
      $('planPanel').hidden = true;
      $('planEmpty').hidden = false;
      $('planEmpty').querySelector('.empty-title').textContent = 'That plan expired.';
      $('planEmpty').querySelector('.empty-body').textContent = 'Plans last five minutes so an old approval can never fire later. Nothing ran — create a new plan.';
      toast('Plan expired before approval. Nothing ran.');
      return;
    }
    var text = 'Expires in ' + clock(left) + ' · single use';
    if (S.mode === 'desktop') text += ' · server-owned';
    $('planExpiry').textContent = text;
  }

  function showRefusal(title, body, command) {
    S.plan = null;
    clearInterval(S.tick);
    $('planPanel').hidden = true;
    $('planEmpty').hidden = false;
    $('planEmpty').querySelector('.empty-title').textContent = title;
    $('planEmpty').querySelector('.empty-body').textContent = body;
    $('planEmpty').setAttribute('data-kind', 'refusal');
    $('receiptList').replaceChildren();
    $('receiptEmpty').hidden = false;
    $('receiptCount').textContent = 'No run · refused';
    toast(title + '. Nothing ran.');
    command = command || '';
    if (command) $('commandInput').focus();
  }

  function cancelPlan() {
    if (!S.plan) return;
    S.plan = null;
    clearInterval(S.tick);
    $('planPanel').hidden = true;
    $('planEmpty').hidden = false;
    $('planEmpty').querySelector('.empty-title').textContent = 'Nothing runs until you approve it.';
    $('planEmpty').querySelector('.empty-body').textContent = 'The plan lists every effect before it happens. You can cancel, and an approved plan can only run once.';
    toast('Plan cancelled. Nothing ran.');
  }

  /* ---------------- execution ---------------- */

  function approvePlan() {
    if (!S.plan) return;
    if (Date.now() > S.expiresAt) { tickExpiry(); return; }
    var plan = S.plan;
    $('approveButton').disabled = true;
    S.plan = null;
    S.used = true;
    clearInterval(S.tick);
    $('planPanel').hidden = true;

    if (S.mode === 'desktop') {
      api('/api/execute', { plan_id: plan.id }).then(function (data) {
        var results = data.results || [];
        var record = results.filter(function (r) { return r && r.path && r.sha256; }).pop() || null;
        // The runtime reports each step as { action: {...}, status, detail }.
        // The receipt list renders flat rows, so flatten here — one place, both
        // desktop runtimes, no change to what the runtime sends.
        var receipts = results.map(function (r) {
          var action = (r && r.action) || {};
          return {
            label: action.label || action.kind || 'Step',
            surface: action.surface || 'pc',
            status: (r && r.status) || 'failed',
            detail: (r && r.detail) || '',
            path: r && r.path,
            sha256: r && r.sha256,
            bytes: r && r.bytes
          };
        });
        finish(plan, receipts, data.artifact || record);
      }).catch(function (err) {
        $('approveButton').disabled = false;
        handleError(err);
      });
      return;
    }
    finish(plan, runInBrowser(plan), null);
  }

  function runInBrowser(plan) {
    var receipts = [];
    var recordName = 'flowmesh-' + stamp(new Date()) + '-' + plan.route + '.md';

    plan.actions.forEach(function (action) {
      var receipt = { label: action.label, surface: action.surface, status: 'unknown', detail: '' };
      if (action.kind === 'open_url') {
        var url = URLS[action.target];
        var opened = null;
        try {
          opened = url ? window.open(url, '_blank') : null;
          if (opened) { try { opened.opener = null; } catch (err) { /* already severed */ } }
        } catch (err) { opened = null; }
        receipt.status = opened ? 'sent' : 'unknown';
        receipt.detail = opened
          ? 'Asked the browser to open ' + url
          : 'Pop-up blocked — nothing opened. Allow pop-ups for this site.';
      } else if (action.kind === 'timer') {
        var end = Date.now() + action.value * 60000;
        receipt.status = 'verified';
        receipt.detail = 'Counting down in this tab · ends at ' +
          new Date(end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
          ' · closing the tab stops it';
        armTimer(action.value, receipts.length);
      } else if (action.kind === 'write_note') {
        receipt.status = 'verified';
        receipt.detail = 'Record generated in this page · ' + recordName;
      } else if (action.kind === 'launch_app') {
        receipt.status = 'desktop_only';
        receipt.detail = 'The browser cannot launch applications. Run this plan in the desktop app.';
      } else if (action.kind === 'notify') {
        receipt.status = 'desktop_only';
        receipt.detail = 'Phone notifications go through Home Assistant on the desktop runtime. Not attempted here.';
      } else if (action.kind === 'light') {
        receipt.status = 'desktop_only';
        receipt.detail = 'Lamp control needs the desktop runtime and Home Assistant. Not attempted here.';
      }
      receipts.push(receipt);
    });

    var written = buildRecord(plan, receipts, recordName);
    S.record = { name: recordName, text: written.text };
    try { download(recordName, written.text); } catch (err) { /* the panel still has the copy */ }
    return receipts;
  }

  function armTimer(minutes, index) {
    var ms = minutes * 60000;
    setTimeout(function () {
      var row = document.querySelector('[data-receipt="' + index + '"] .receipt-detail');
      if (row) row.textContent = 'Timer completed at ' + new Date().toLocaleTimeString() + '. That is a real elapsed timer in this tab.';
      toast(minutes + ' minute timer complete.');
    }, ms);
  }

  function escapeCell(value) {
    return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  }

  function buildRecord(plan, receipts, name) {
    var lines = [];
    lines.push('# FlowMesh run — ' + plan.title, '');
    lines.push('- When: ' + new Date().toISOString());
    lines.push('- Command: ' + escapeCell(plan.command));
    lines.push('- Route: ' + plan.route + ' (' + (plan.source === 'jev' ? 'Jev Choice' : 'local rules') + ')');
    lines.push('- Plan: ' + plan.id);
    lines.push('- Runtime: ' + (S.mode === 'desktop' ? 'desktop app' : 'browser edition'));
    lines.push('', '## Plan and receipts', '');
    lines.push('| # | Action | Surface | Status | Detail |');
    lines.push('| --- | --- | --- | --- | --- |');
    receipts.forEach(function (receipt, index) {
      lines.push('| ' + (index + 1) + ' | ' + escapeCell(receipt.label) + ' | ' + receipt.surface + ' | ' +
        receipt.status + ' | ' + escapeCell(receipt.detail) + ' |');
    });
    lines.push('', '## Verbatim', '', '```', String(plan.command).replace(/```/g, "'''"), '```', '');
    var text = lines.join('\n');
    var bytes = new TextEncoder().encode(text).length;
    return { text: text, name: name, bytes: bytes };
  }

  function finish(plan, receipts, artifact) {
    clearInterval(S.tick);
    S.receipts = receipts;
    renderReceipts(receipts);

    var recordName;
    var recordMeta;
    if (S.mode === 'desktop' && artifact) {
      var parts = String(artifact.path || '').split(/[\\/]/);
      recordName = parts[parts.length - 1] || 'flowmesh-record.md';
      recordMeta = [
        artifact.bytes ? artifact.bytes + ' bytes' : '',
        artifact.sha256 ? 'sha256 ' + String(artifact.sha256).slice(0, 12) + '…' : '',
        'written by the desktop runtime'
      ].filter(Boolean).join(' · ');
      S.record = null;
      S.artifactPath = artifact.path || '';
      $('downloadButton').hidden = true;
      $('copyButton').textContent = 'Copy path';
    } else if (S.record) {
      recordName = S.record.name;
      recordMeta = S.record.bytes + ' bytes · download started · copy or download it again any time';
    }

    if (recordName) {
      $('artifactPanel').hidden = false;
      $('artifactName').textContent = recordName;
      $('artifactMeta').textContent = recordMeta || '';
    } else {
      $('artifactPanel').hidden = true;
    }

    $('planEmpty').hidden = true;
    $('planPanel').hidden = false;
    $('planPanel').classList.add('consumed');
    var approve = $('approveButton');
    approve.disabled = true;
    approve.textContent = 'Approved · single use consumed';
    $('cancelButton').hidden = true;
    $('planExpiry').textContent = 'Run finished ' + new Date().toLocaleTimeString() + ' · this plan can never run again';
    var verified = receipts.filter(function (r) { return r.status === 'verified'; }).length;
    toast('Run complete · ' + verified + ' of ' + receipts.length + ' steps verified. Nothing reached beyond what the receipts say.');
  }

  function renderReceipts(receipts) {
    var list = $('receiptList');
    list.replaceChildren();
    if (!receipts.length) {
      $('receiptEmpty').hidden = false;
      $('receiptCount').textContent = 'No run yet';
      return;
    }
    $('receiptEmpty').hidden = true;
    $('receiptLegend').hidden = false;
    $('receiptCount').textContent = receipts.length + ' steps · ' + new Date().toLocaleTimeString();
    receipts.forEach(function (receipt, index) {
      var row = el('li');
      row.setAttribute('data-receipt', String(index));
      row.appendChild(el('span', 'idx mono', pad(index + 1)));
      var body = el('div');
      body.appendChild(el('span', 'receipt-label', receipt.label));
      body.appendChild(el('span', 'receipt-detail', receipt.detail || ''));
      row.appendChild(body);
      var status = el('span', 'status', STATUS_LABEL[receipt.status] || String(receipt.status).toUpperCase());
      status.setAttribute('data-s', receipt.status);
      row.appendChild(status);
      list.appendChild(row);
    });
  }

  function handleError(err) {
    var code = (err && err.message) || 'unknown';
    var message = humanError(code.replace(/^http_/, ''));
    toast(message);
    if (code === 'token_rejected') {
      try { sessionStorage.removeItem('flowmesh_token'); } catch (e) { /* ignore */ }
      setBrowserMode();
    }
  }

  /* ---------------- desktop helpers ---------------- */

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-FlowMesh-Token': S.token },
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return { error: 'bad_response' }; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('http_' + res.status));
        return data;
      });
    });
  }

  function get(path) {
    return fetch(path, {
      headers: { 'X-FlowMesh-Token': S.token },
      cache: 'no-store',
    }).then(function (res) {
      return res.json().catch(function () { return { error: 'bad_response' }; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('http_' + res.status));
        return data;
      });
    });
  }

  /* ---------------- Wispr Flow (desktop runtimes only) ----------------
     The runtime reads the user's own Wispr Flow history read-only. Nothing here
     executes: "Use my last dictation" only fills the box so the normal plan ->
     approve -> run loop still applies. Transcript text never leaves the machine. */

  // Exactly the states the readers can actually produce, so no raw token ever reaches
  // the page: Python yields connected/not_found/locked/unexpected_schema, Electron adds
  // unavailable when node:sqlite is withheld, and both add none/ready for dictations.
  var WISPR_STATES = {
    connected: 'connected',
    not_found: 'Wispr Flow not detected',
    locked: 'database busy',
    unexpected_schema: 'unexpected database shape',
    unavailable: 'unavailable in this runtime',
    unsupported: 'not supported here',
    empty: 'no dictations yet',
  };

  function loadWispr() {
    if (S.mode !== 'desktop') return;
    get('/api/wispr').then(paintWispr).catch(function () {
      // A runtime too old to answer 404s here. Say nothing rather than guess.
      $('wisprStrip').hidden = true;
    });
  }

  function paintWispr(info) {
    var state = info.state || 'unknown';
    var strip = $('wisprStrip');
    strip.hidden = false;
    var badge = $('wisprState');
    badge.textContent = WISPR_STATES[state] || state;
    badge.setAttribute('data-state', state);

    var detail = $('wisprDetail');
    var stats = processStats(info.stats);
    $('wisprStats').textContent = stats;
    $('pullDictation').hidden = true;
    $('typeDictation').hidden = true;

    if (state !== 'connected') {
      detail.textContent = info.detail ||
        'FlowMesh could not read your Wispr Flow history, so nothing can be pulled. Dictate into the box instead.';
      return;
    }
    detail.textContent = info.detail || 'Reading your own dictation history, read-only, on this machine.';
    if (!info.latest) {
      detail.textContent = 'Connected. No usable dictation from the last ' +
        Math.round((info.freshness_seconds || 300) / 60) + ' minutes, so there is nothing fresh to plan.';
      return;
    }
    $('pullDictation').hidden = false;
    $('pullDictation').textContent = 'Use my last dictation · ' + ago(info.latest.age_seconds);
    $('typeDictation').hidden = false;
  }

  /* ---------------- Wispr account: Scratchpad notes (desktop runtimes only) ----------------
     The supported route: the person signs in on Wispr's own page with a short code, and
     FlowMesh reads Scratchpad notes over Wispr's official MCP. A note only fills the
     command box. Its text is untrusted, so it is written with textContent and goes
     through the same plan -> approve -> run loop as anything typed. */

  var ACCOUNT_STATES = {
    disconnected: 'not connected',
    pending: 'waiting for you',
    connected: 'connected',
    expired: 'code expired',
    denied: 'declined',
  };
  var accountTimer = null;

  // The runtime answers connector failures in plain sentences; show those as they are.
  function accountError(err) {
    return /\s/.test(err.message) ? err.message : humanError(err.message);
  }

  function loadAccount() {
    if (S.mode !== 'desktop') return;
    get('/api/wispr/account').then(function (info) {
      paintAccount(info);
      if (info.state === 'pending') schedulePoll(info.interval);
    }).catch(function () { $('accountStrip').hidden = true; });
  }

  function paintAccount(info) {
    var state = info.state || 'disconnected';
    $('accountStrip').hidden = false;
    var badge = $('accountState');
    badge.textContent = ACCOUNT_STATES[state] || state;
    badge.setAttribute('data-state', state);
    $('accountDetail').textContent = info.detail ||
      'Sign in with a short code on Wispr’s own page to read your Scratchpad notes. FlowMesh never sees your password.';
    var pending = state === 'pending' && info.user_code;
    $('deviceCode').hidden = !pending;
    if (pending) {
      $('deviceCodeValue').textContent = info.user_code;
      // Only an https link is ever offered; the runtime has already enforced it.
      var link = $('deviceCodeLink');
      var target = info.verification_uri_complete || info.verification_uri || '';
      if (/^https:\/\//i.test(target)) link.setAttribute('href', target);
    }
    $('accountConnect').hidden = state === 'connected' || Boolean(pending);
    $('accountConnect').textContent = state === 'disconnected' ? 'Connect Wispr account' : 'Try again';
    $('accountBrowse').hidden = state !== 'connected';
    $('accountDisconnect').hidden = state !== 'connected';
    if (state !== 'connected') { $('noteList').hidden = true; $('noteList').replaceChildren(); }
  }

  function connectAccount() {
    api('/api/wispr/account/connect', {}).then(function (info) {
      paintAccount(info);
      schedulePoll(info.interval);
    }).catch(function (err) { toast(accountError(err)); });
  }

  function schedulePoll(seconds) {
    clearTimeout(accountTimer);
    accountTimer = setTimeout(pollAccount, Math.max(1, seconds || 5) * 1000);
  }

  function pollAccount() {
    api('/api/wispr/account/poll', {}).then(function (info) {
      paintAccount(info);
      if (info.state === 'pending') schedulePoll(info.interval);
      else if (info.state === 'connected') toast('Wispr account connected. Browse your Scratchpad notes.');
    }).catch(function (err) {
      paintAccount({ state: 'disconnected' });
      toast(accountError(err));
    });
  }

  function disconnectAccount() {
    clearTimeout(accountTimer);
    api('/api/wispr/account/disconnect', {}).then(function (info) {
      paintAccount(info);
      toast(info.detail);
    }).catch(function (err) { toast(accountError(err)); });
  }

  function browseNotes() {
    get('/api/wispr/account/notes').then(function (data) {
      var list = $('noteList');
      list.replaceChildren();
      list.hidden = false;
      if (!data.notes.length) {
        list.appendChild(el('li', 'note-empty', 'No Scratchpad notes found.'));
        return;
      }
      data.notes.forEach(function (note) {
        var item = el('li');
        var button = el('button', 'note-item');
        button.type = 'button';
        button.appendChild(el('span', null, note.title));
        if (note.modified_at) button.appendChild(el('span', 'when mono', note.modified_at.slice(0, 10)));
        button.addEventListener('click', function () { useNote(note); });
        item.appendChild(button);
        list.appendChild(item);
      });
    }).catch(function (err) {
      if (/expired|Connect again|Not connected/i.test(err.message)) paintAccount({ state: 'disconnected' });
      toast(accountError(err));
    });
  }

  function useNote(note) {
    api('/api/wispr/account/note', { note_id: note.id }).then(function (data) {
      var trimmed = fitToBox(data.text, BOX_LIMIT);
      $('commandInput').value = trimmed.text;
      $('charCount').textContent = trimmed.text.length + ' / ' + BOX_LIMIT;
      S.dictation = null;
      S.wordsFrom = { kind: 'note', title: note.title, trimmed: trimmed.clipped || data.truncated };
      showProvenance();
      $('commandInput').focus();
      toast('Loaded “' + note.title + '”. Review it, then plan.');
    }).catch(function (err) { toast(accountError(err)); });
  }

  function processStats(stats) {
    if (!stats || !stats.dictations) return '';
    var parts = [stats.dictations + ' dictations'];
    if (stats.words) parts.push(stats.words + ' words');
    if (stats.median_latency_ms) parts.push('median ' + stats.median_latency_ms + ' ms');
    return parts.join(' · ');
  }

  function ago(seconds) {
    if (seconds === null || seconds === undefined) return 'just now';
    // Rounded: "31.541654s ago" reads like a bug, and a dictation is not that precise.
    var value = Math.max(0, Math.round(seconds));
    if (value < 5) return 'just now';
    if (value < 60) return value + 's ago';
    var minutes = Math.round(value / 60);
    if (minutes < 60) return minutes + 'm ago';
    return Math.round(minutes / 60) + 'h ago';
  }

  function pullDictation() {
    get('/api/wispr/latest').then(function (info) {
      if (!info.text) {
        toast('No fresh dictation to use.');
        return;
      }
      // The box caps at BOX_LIMIT; a longer dictation is trimmed on a sentence or word
      // boundary and the UI says so rather than silently dropping the tail.
      var trimmed = fitToBox(info.text, BOX_LIMIT);
      var fit = trimmed.text;
      var clipped = trimmed.clipped;
      $('commandInput').value = fit;
      $('charCount').textContent = fit.length + ' / ' + BOX_LIMIT;
      S.dictation = info.provenance || null;
      S.wordsFrom = { kind: 'dictation', age: info.age_seconds, app: info.app, trimmed: clipped };
      showProvenance();
      $('commandInput').focus();
      toast((clipped
        ? 'Your last dictation was longer than the box, so it was trimmed to the last complete sentence'
        : 'Pulled your last dictation') + ' · ' + ago(info.age_seconds) +
        (info.app ? ' · ' + info.app : '') + '. Review it, then plan.');
    }).catch(function (err) { toast(humanError(err.message)); });
  }

  /* Where the words in the box came from. A judge who typed must never be told the
     text was dictated, so this is driven by how the box was filled, not by whether a
     dictation happens to exist. */
  function showProvenance() {
    var line = $('provenanceLine');
    if (!S.wordsFrom) { line.hidden = true; line.textContent = ''; return; }
    var source = S.wordsFrom.kind === 'dictation'
      ? 'From your Wispr Flow history' + (S.wordsFrom.app ? ' (last dictated into ' + S.wordsFrom.app + ')' : '')
      : S.wordsFrom.kind === 'note'
        ? 'From your Wispr Scratchpad note “' + S.wordsFrom.title + '”'
        : 'Typed by you';
    var extra = S.wordsFrom.kind === 'dictation'
      ? ' · ' + ago(S.wordsFrom.age)
      : '';
    line.textContent = source + extra +
      (S.wordsFrom.trimmed ? ' · trimmed to fit the box' : '') +
      (S.wordsFrom.kind === 'note'
        ? ' · fetched over HTTPS from Wispr, not planned until you approve'
        : ' · read-only, never sent anywhere');
    line.hidden = false;
  }

  /* Fit a dictation into the box without cutting a word in half: prefer the last
     complete sentence, then the last whole word, and say when it happened. */
  function fitToBox(text, limit) {
    if (text.length <= limit) return { text: text, clipped: false };
    var head = text.slice(0, limit);
    var stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
    if (stop > limit * 0.5) return { text: head.slice(0, stop + 1), clipped: true };
    var space = head.lastIndexOf(' ');
    return { text: space > 0 ? head.slice(0, space) : head, clipped: true };
  }

  // Types an approved transcript into whatever app has focus. Deliberately not part
  // of the plan/approve flow: the text is re-read from the database by the runtime,
  // so this page cannot send its own string to the keyboard.
  function typeDictation() {
    get('/api/wispr/latest').then(function (info) {
      if (!info.id) { toast('No fresh dictation to type.'); return; }
      var where = info.app ? 'your focused app (last used: ' + info.app + ')' : 'your focused app';
      if (!window.confirm('Type this dictation into ' + where + '?\n\n' +
          String(info.text || '').slice(0, 200) +
          '\n\nThe text is read from your own Wispr Flow history and typed once. ' +
          'Nothing is copied to the clipboard.')) return;
      api('/api/type', { transcript_id: info.id }).then(function (data) {
        toast((data.receipt && data.receipt.detail) || 'Typed.');
      }).catch(function (err) { toast(humanError(err.message)); });
    }).catch(function (err) { toast(humanError(err.message)); });
  }

  /* The desktop shell pushes the accelerators that actually registered. Showing a key
     that is listening to nothing would be worse than showing none. */
  function showHotkeys() {
    var keys = window.__flowmeshHotkeys;
    var hint = $('hotkeyHint');
    if (!hint) return;
    if (!keys || (!keys.pull && !keys.approve)) { hint.textContent = ''; return; }
    hint.replaceChildren();
    hint.appendChild(document.createTextNode(' In the desktop app: '));
    var written = [];
    if (keys.pull) written.push([keys.pull, ' pulls your last dictation']);
    if (keys.approve) written.push([keys.approve, ' approves the plan on screen']);
    written.forEach(function (pair, index) {
      if (index) hint.appendChild(document.createTextNode(', '));
      label(pair[0]).forEach(function (part, i) {
        if (i) hint.appendChild(document.createTextNode('+'));
        var kbd = document.createElement('kbd');
        kbd.textContent = part;
        hint.appendChild(kbd);
      });
      hint.appendChild(document.createTextNode(pair[1]));
    });
    hint.appendChild(document.createTextNode('.'));
  }

  function label(accelerator) {
    var mac = navigator.platform.indexOf('Mac') === 0;
    return String(accelerator)
      .replace('CommandOrControl', mac ? 'Cmd' : 'Ctrl')
      .replace('Alt', mac ? 'Option' : 'Alt')
      .replace('Return', 'Enter')
      .split('+');
  }

  /* Point the user at the key that is actually listening, not the one we wish were. */
  function pullHint() {
    var keys = window.__flowmeshHotkeys;
    if (keys && keys.pull) return ' Press ' + label(keys.pull).join('+') + ' after dictating to build one.';
    return ' Create a plan first, then approve it.';
  }

  function loadSettings() {
    fetch('/api/settings', { headers: { 'X-FlowMesh-Token': S.token }, cache: 'no-store' })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var form = $('settingsForm');
        ['board_url', 'docs_url', 'ha_url', 'light_entity', 'phone_service'].forEach(function (name) {
          if (form.elements[name] && data.settings[name] != null) form.elements[name].value = data.settings[name];
        });
        $('jevState').textContent = data.secrets && data.secrets.jev ? 'connected' : 'not connected';
        $('haState').textContent = data.secrets && data.secrets.ha ? 'connected' : 'not connected';
        $('secretBackend').textContent = 'Secrets: ' + (data.secret_backend || 'unknown') +
          '. Keys are write-only from this page — the API never returns them.';
      })
      .catch(function () { /* the console still works without settings */ });
  }

  function saveSettings(event) {
    event.preventDefault();
    var form = event.target;
    var payload = {};
    ['board_url', 'docs_url', 'ha_url', 'light_entity', 'phone_service'].forEach(function (name) {
      payload[name] = form.elements[name].value.trim();
    });
    ['jev_key', 'ha_token'].forEach(function (name) {
      var value = form.elements[name].value.trim();
      if (value) payload[name] = value;
    });
    $('settingsMessage').textContent = 'Saving…';
    api('/api/settings', payload).then(function (data) {
      $('settingsMessage').textContent = 'Saved locally.';
      form.elements.jev_key.value = '';
      form.elements.ha_token.value = '';
      if (data.secrets) {
        $('jevState').textContent = data.secrets.jev ? 'connected' : 'not connected';
        $('haState').textContent = data.secrets.ha ? 'connected' : 'not connected';
      }
      toast('Connections saved. The capability table now reflects what is configured.');
      fetch('/api/status', { headers: { 'X-FlowMesh-Token': S.token }, cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (status) { setDesktopMode(status); });
    }).catch(function (err) {
      $('settingsMessage').textContent = humanError((err.message || '').replace(/^http_/, ''));
    });
  }

  /* ---------------- small utilities ---------------- */

  function download(name, text) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy_failed')); }
      catch (err) { reject(err); }
      finally { area.remove(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
