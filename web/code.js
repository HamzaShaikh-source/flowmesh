/* FlowMesh Code page: the coding agents installed on this computer (Claude Code, Codex,
   Antigravity, OpenCode, Gemini CLI, Aider), the project folders they may work in, and a task
   composer that makes an ordinary plan. Sign-in stays with each vendor's own CLI: this page
   only opens that CLI's login in a terminal. Nothing here runs anything; showPlan renders a
   plan the runtime produced and the person still approves it. Runtime text is untrusted and is
   written with textContent. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  if (!UI) return;
  var $ = function (id) { return document.getElementById(id); };
  var el = UI.el;

  var A = { catalog: [], config: { workspaces: [] }, detection: { agents: {}, checking: false }, enabled: true, loaded: false };
  var polls = 0;
  var live = { steps: [], timer: null, misses: 0, pinned: true, token: 0 };

  var AUTH = {
    signed_in: ['SIGNED IN', 'verified'],
    signed_out: ['SIGNED OUT', 'unknown'],
    unknown: ['INSTALLED', 'returned'],
  };

  /* ---------------------------------------------------------------- loading */

  function desktop() { return UI.mode() === 'desktop'; }

  function load() {
    if (!desktop()) return Promise.resolve();
    return UI.get('/api/agents').then(function (data) {
      A.catalog = data.catalog || [];
      A.config = data.config || { workspaces: [] };
      A.detection = data.detection || { agents: {}, checking: false };
      A.enabled = data.enabled !== false;
      A.loaded = true;
      render();
      // Detection runs in the background (it asks each CLI for its version and sign-in).
      if (A.detection.checking && polls < 20) { polls += 1; setTimeout(load, 1200); } else polls = 0;
      announce();
    }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
  }

  function announce() {
    var ready = A.catalog.filter(function (a) { var d = A.detection.agents[a.id]; return d && d.installed; }).length;
    document.dispatchEvent(new CustomEvent('flowmesh:agents', { detail: { installed: ready, folders: (A.config.workspaces || []).length } }));
  }

  function enter() {
    var on = desktop();
    $('codeHosted').hidden = on;
    $('codeDesktop').hidden = !on;
    if (on) load();
  }

  /* ---------------------------------------------------------------- agents */

  function detected(agent) { return A.detection.agents[agent.id] || null; }

  function renderAgents() {
    var list = $('agentList');
    list.replaceChildren();
    if (!A.enabled) {
      list.appendChild(el('li', 'empty small', 'Coding agents are switched off on this install (FLOWMESH_AGENTS=off).'));
      return;
    }
    A.catalog.forEach(function (agent, index) {
      var info = detected(agent);
      var installed = Boolean(info && info.installed);
      var card = el('li', 'agent-card');
      card.style.animationDelay = (index * 50) + 'ms';
      card.setAttribute('data-state', installed ? 'ready' : (A.detection.checking && !info ? 'checking' : 'missing'));
      var head = el('div', 'agent-head');
      head.appendChild(el('strong', null, agent.label));
      head.appendChild(el('span', 'agent-cmd', agent.command));
      var status;
      if (!info) status = el('span', 'status', 'CHECKING');
      else if (!installed) status = el('span', 'status', 'NOT INSTALLED');
      else {
        var pair = AUTH[info.auth && info.auth.state] || AUTH.unknown;
        status = el('span', 'status', pair[0]);
        status.setAttribute('data-s', pair[1]);
      }
      if (!info || !installed) status.setAttribute('data-s', info ? 'not_configured' : 'running');
      head.appendChild(status);
      card.appendChild(head);

      var meta = [];
      if (installed && info.version) meta.push(info.version);
      if (installed && info.auth && info.auth.detail) meta.push('via ' + info.auth.detail);
      if (installed && (!info.auth || info.auth.state === 'unknown') && !agent.has_status) meta.push('sign-in cannot be checked from here');
      meta.push(agent.modes.length + ' mode' + (agent.modes.length === 1 ? '' : 's'));
      card.appendChild(el('p', 'agent-meta', meta.join(' · ')));
      card.appendChild(el('p', 'agent-meta', agent.login_note));

      var actions = el('div', 'agent-actions');
      if (installed) {
        var signin = el('button', 'button small' + (info.auth && info.auth.state === 'signed_in' ? ' ghost' : ''),
          agent.can_login ? 'Sign in with your account' : 'Open it to sign in');
        signin.type = 'button';
        signin.addEventListener('click', function () { signIn(agent, signin); });
        actions.appendChild(signin);
        var use = el('button', 'button small ghost', 'Use for a task');
        use.type = 'button';
        use.addEventListener('click', function () { $('taskAgent').value = agent.id; paintModes(); $('taskPrompt').focus(); });
        actions.appendChild(use);
      }
      var docs = el('a', 'button small ghost', installed ? 'Docs' : 'Install');
      docs.href = agent.docs;
      docs.target = '_blank';
      docs.rel = 'noopener noreferrer';
      actions.appendChild(docs);
      card.appendChild(actions);
      list.appendChild(card);
    });
    $('agentsNote').textContent = A.detection.checking ? 'Checking each CLI…' : 'Detected from your PATH. FlowMesh never reads or stores the accounts.';
  }

  function signIn(agent, button) {
    button.setAttribute('aria-busy', 'true');
    UI.api('/api/agents/signin', { agent: agent.id }).then(function (data) {
      button.removeAttribute('aria-busy');
      if (data.opened) UI.toast('A terminal opened running "' + data.command + '". Finish the sign-in there, then press Check again.');
      else UI.toast('Could not open a terminal. Run this yourself: ' + data.command);
    }).catch(function (err) { button.removeAttribute('aria-busy'); UI.toast(UI.humanError(err.message)); });
  }

  /* ---------------------------------------------------------------- folders */

  function renderSpaces() {
    var spaces = A.config.workspaces || [];
    var list = $('spaceList');
    list.replaceChildren();
    $('spaceEmpty').hidden = spaces.length > 0;
    $('spaceCount').textContent = spaces.length + ' folder' + (spaces.length === 1 ? '' : 's');
    spaces.forEach(function (space) {
      var row = el('li', 'space-item');
      var pick = el('input');
      pick.type = 'radio';
      pick.name = 'defaultSpace';
      pick.checked = space.id === A.config.default_workspace;
      pick.setAttribute('aria-label', 'Use ' + space.label + ' by default');
      pick.addEventListener('change', function () {
        UI.api('/api/agents/defaults', { default_workspace: space.id }).then(function (data) {
          A.config = data.config; fillComposer();
        }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
      });
      row.appendChild(pick);
      var text = el('div');
      text.appendChild(el('strong', null, space.label));
      text.appendChild(el('span', 'path', space.path));
      row.appendChild(text);
      var remove = el('button', 'button small ghost', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', function () {
        UI.api('/api/agents/workspaces/remove', { id: space.id }).then(load).catch(function (err) { UI.toast(UI.humanError(err.message)); });
      });
      row.appendChild(remove);
      list.appendChild(row);
    });
  }

  function addSpace(event) {
    event.preventDefault();
    var path = $('spacePath').value.trim();
    if (!path) { UI.toast('Enter the full path of a project folder.'); return; }
    if (!$('spaceAck').checked) { UI.toast('Tick the box: a coding agent can read and change everything in that folder.'); return; }
    UI.api('/api/agents/workspaces', { path: path, label: $('spaceLabel').value.trim(), acknowledged: true }).then(function (data) {
      $('spacePath').value = '';
      $('spaceLabel').value = '';
      $('spaceAck').checked = false;
      UI.toast('Added ' + data.workspace.label + '.');
      return load();
    }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
  }

  /* ---------------------------------------------------------------- composer */

  function installedAgents() {
    return A.catalog.filter(function (a) { var d = detected(a); return d && d.installed; });
  }

  function fillComposer() {
    var agents = installedAgents();
    var select = $('taskAgent');
    var keep = select.value || A.config.default_agent;
    select.replaceChildren();
    agents.forEach(function (agent) {
      var option = el('option', null, agent.label);
      option.value = agent.id;
      select.appendChild(option);
    });
    if (agents.some(function (a) { return a.id === keep; })) select.value = keep;
    var spaceSelect = $('taskSpace');
    var wanted = spaceSelect.value || A.config.default_workspace;
    spaceSelect.replaceChildren();
    (A.config.workspaces || []).forEach(function (space) {
      var option = el('option', null, space.label);
      option.value = space.id;
      spaceSelect.appendChild(option);
    });
    if ((A.config.workspaces || []).some(function (s) { return s.id === wanted; })) spaceSelect.value = wanted;
    var ready = agents.length > 0 && (A.config.workspaces || []).length > 0;
    $('teamPick').hidden = agents.length < 2;
    if (agents.length < 2) $('teamKind').value = 'single';
    $('taskPlan').disabled = !ready;
    $('taskPrompt').disabled = !ready;
    $('taskPrompt').placeholder = ready ? 'Fix the failing test in tests/test_parser.py and explain what was wrong.'
      : (agents.length ? 'Add a project folder first.' : 'Install and sign in to a coding agent first.');
    paintTeam();
  }

  var TEAM = {
    review: { roles: ['Works', 'Reviews (read-only)'], hint: 'The second agent starts only if the first finished cleanly, and sees its output as untrusted text.' },
    chain: { roles: ['Plans (read-only)', 'Builds', 'Reviews (read-only)'], hint: 'Each step starts only if the one before it finished cleanly, and sees its output as untrusted text.' },
    compare: { roles: ['Answer 1', 'Answer 2', 'Answer 3'], hint: 'Every agent answers the same task read-only, one after the other. Nothing is handed over and nothing is changed.' },
  };

  function canRead(agent) { return agent.modes.some(function (m) { return m.risk === 'read'; }); }

  function teamKind() { return $('teamKind').value; }

  function paintTeam() {
    var kind = teamKind();
    var holder = $('teamAgents');
    var previous = Array.prototype.map.call(holder.querySelectorAll('select'), function (s) { return s.value; });
    holder.replaceChildren();
    var team = TEAM[kind];
    $('taskAgentLabel').hidden = Boolean(team);
    holder.hidden = !team;
    $('teamHint').textContent = team ? team.hint : '';
    $('modePick').hidden = kind === 'compare';
    $('modeLegend').textContent = team && kind !== 'compare' ? 'How much may the working agent do?' : 'How much may it do?';
    if (!team) { paintModes(); return; }
    var installed = installedAgents();
    var count = kind === 'compare' ? Math.min(3, Math.max(2, installed.length)) : team.roles.length;
    for (var i = 0; i < count; i += 1) {
      var role = team.roles[i];
      var readOnlyStep = kind === 'compare' || /read-only/.test(role);
      var options = installed.filter(function (a) { return !readOnlyStep || canRead(a); });
      var label = el('label', null, role);
      var select = el('select');
      select.setAttribute('data-step', String(i));
      options.forEach(function (agent) { var o = el('option', null, agent.label); o.value = agent.id; select.appendChild(o); });
      var want = previous[i] || (options[i % Math.max(options.length, 1)] || {}).id;
      if (options.some(function (a) { return a.id === want; })) select.value = want;
      else if (options[i % Math.max(options.length, 1)]) select.value = options[i % options.length].id;
      label.appendChild(select);
      holder.appendChild(label);
    }
    paintModes();
  }

  function teamAgents() {
    return Array.prototype.map.call($('teamAgents').querySelectorAll('select'), function (s) { return s.value; });
  }

  function paintModes() {
    var list = $('modeList');
    var kind = teamKind();
    var workIndex = kind === 'review' ? 0 : kind === 'chain' ? 1 : -1;
    var agentId = workIndex >= 0 ? (teamAgents()[workIndex] || '') : $('taskAgent').value;
    var agent = A.catalog.filter(function (a) { return a.id === agentId; })[0];
    var chosen = (document.querySelector('input[name="taskMode"]:checked') || {}).value || A.config.default_mode || 'edit';
    list.replaceChildren();
    if (!agent) return;
    var visible = agent.modes.filter(function (m) { return workIndex < 0 || m.risk !== 'read'; });
    if (!visible.some(function (m) { return m.id === chosen; })) chosen = visible.some(function (m) { return m.id === 'edit'; }) ? 'edit' : visible[0].id;
    visible.forEach(function (mode) {
      var label = el('label', 'mode-option');
      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'taskMode';
      radio.value = mode.id;
      radio.checked = mode.id === chosen;
      label.appendChild(radio);
      var top = el('span', 'top');
      top.appendChild(document.createTextNode(mode.label + ' '));
      var risk = el('span', 'risk', mode.risk.toUpperCase());
      risk.setAttribute('data-r', mode.risk);
      top.appendChild(risk);
      label.appendChild(top);
      label.appendChild(el('small', null, mode.about));
      list.appendChild(label);
    });
  }

  function createTaskPlan(event) {
    event.preventDefault();
    var mode = (document.querySelector('input[name="taskMode"]:checked') || {}).value;
    var kind = teamKind();
    var body = { agent: $('taskAgent').value, workspace: $('taskSpace').value, mode: mode, prompt: $('taskPrompt').value };
    if (!body.prompt.trim()) { UI.toast('Describe the task first.'); return; }
    var request;
    if (kind === 'single') request = UI.api('/api/agents/plan', body);
    else request = UI.api('/api/agents/relay', { kind: kind, workspace: body.workspace, prompt: body.prompt, agents: teamAgents(), mode: kind === 'compare' ? 'edit' : mode });
    var button = $('taskPlan');
    button.setAttribute('aria-busy', 'true');
    request.then(function (plan) {
      button.removeAttribute('aria-busy');
      // Remember the choice so a spoken "ask codex to ..." uses it. Never remember full access.
      var saved = { default_workspace: body.workspace };
      if (kind === 'single') saved.default_agent = body.agent;
      if (kind === 'single' && mode !== 'full') saved.default_mode = mode;
      UI.api('/api/agents/defaults', saved).then(function (data) { A.config = data.config; }).catch(function () { /* optional */ });
      UI.showPlan(plan);
    }).catch(function (err) { button.removeAttribute('aria-busy'); UI.toast(UI.humanError(err.message)); });
  }

  /* ---------------------------------------------------------------- live run */

  function stepsOf(plan) {
    return (plan.actions || []).filter(function (a) { return a.kind === 'agent_run'; }).map(function (a) {
      return { id: a.run_id, label: a.agent_label + (a.role && a.role !== 'work' ? ' \u00b7 ' + a.role : ''), view: null };
    });
  }

  function startLive(plan) {
    stopLive();
    live.steps = stepsOf(plan);
    live.token += 1;
    if (!live.steps.length) { $('liveRun').hidden = true; return; }
    live.misses = 0;
    live.pinned = true;
    $('liveRun').hidden = false;
    $('liveRun').setAttribute('data-state', 'running');
    $('liveOut').textContent = '';
    $('liveMeta').textContent = 'starting…';
    $('liveNote').textContent = 'This is the agent’s own text, shown as it arrives. It is untrusted and FlowMesh has not checked it.';
    $('liveCancel').hidden = false;
    $('liveCancel').disabled = false;
    tick();
  }

  function stopLive() {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
  }

  function tick() {
    var token = live.token;
    if (!live.steps.length) return;
    Promise.all(live.steps.map(function (step) {
      if (step.view && step.view.status !== 'running') return Promise.resolve(step.view);
      return UI.get('/api/agents/runs/' + encodeURIComponent(step.id)).catch(function () { return null; });
    })).then(function (views) {
      if (token !== live.token) return;
      views.forEach(function (view, i) { live.steps[i].view = view; });
      var any = views.some(Boolean);
      var open = views.some(function (v) { return v && v.status === 'running'; });
      // A later step has no run yet while an earlier one works; a skipped step never gets one.
      var waiting = any && views.some(function (v) { return !v; }) && views.every(function (v) { return !v || v.status === 'done'; });
      paintLive();
      if (!any) live.misses += 1;
      if (open || waiting || (!any && live.misses < 8)) live.timer = setTimeout(tick, open || waiting ? 1000 : 800);
      else if (!open) finishLive();
    });
  }

  function paintLive() {
    var out = $('liveOut');
    var atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    var many = live.steps.length > 1;
    var parts = [];
    live.steps.forEach(function (step, i) {
      var view = step.view;
      if (many) parts.push('\u2500\u2500 step ' + (i + 1) + ' of ' + live.steps.length + ' \u00b7 ' + step.label + ' \u00b7 ' + (view ? view.status : 'waiting') + ' \u2500\u2500');
      if (view && view.output) parts.push(view.output);
    });
    out.textContent = parts.join('\n');
    if (atEnd || live.pinned) out.scrollTop = out.scrollHeight;
    var views = live.steps.map(function (s) { return s.view; }).filter(Boolean);
    var running = views.some(function (v) { return v.status === 'running'; });
    var elapsed = views.reduce(function (sum, v) { return sum + (v.elapsed_s || 0); }, 0);
    var files = views.reduce(function (sum, v) {
      return sum + (v.changes && v.changes.observed ? v.changes.files.filter(function (f) { return f.indexOf('committed ') !== 0; }).length : 0);
    }, 0);
    var observed = views.some(function (v) { return v.changes && v.changes.observed; });
    $('liveRun').setAttribute('data-state', running ? 'running' : 'done');
    $('liveMeta').textContent = (running ? 'running' : 'finished') + ' \u00b7 ' + Math.round(elapsed * 10) / 10 + ' s' + (observed ? ' \u00b7 git saw ' + files + ' changed' : '');
    $('liveCancel').hidden = !running;
  }

  function finishLive() {
    $('liveRun').setAttribute('data-state', 'done');
    $('liveCancel').hidden = true;
    $('liveNote').textContent = 'Finished. The receipt below is what FlowMesh actually knows: it did not check the work.';
  }

  function cancelLive() {
    if (!live.steps.length) return;
    $('liveCancel').disabled = true;
    // Only the step that is running can be stopped; the ones after it are then skipped by the runtime.
    Promise.all(live.steps.map(function (step) {
      return UI.api('/api/agents/runs/' + encodeURIComponent(step.id) + '/cancel', {}).then(function () { return true; }, function () { return false; });
    })).then(function (results) {
      if (results.some(Boolean)) UI.toast('Stopping the agent and everything it started.');
      else $('liveCancel').disabled = false;
    });
  }
  /* ---------------------------------------------------------------- palette and boot */

  function paletteItems() {
    return [
      { label: 'Open the Code page', hint: 'page', run: function () { window.FlowMeshRouter.go('code'); } },
      { label: 'Add a project folder for coding agents', hint: 'code', run: function () {
        window.FlowMeshRouter.go('code');
        setTimeout(function () { $('spacePath').focus(); }, 80);
      } },
      { label: 'Write a coding task', hint: 'code', run: function () {
        window.FlowMeshRouter.go('code');
        setTimeout(function () { $('taskPrompt').focus(); }, 80);
      } },
    ];
  }

  function render() { renderAgents(); renderSpaces(); fillComposer(); }

  function init() {
    $('agentsRefresh').addEventListener('click', function () {
      UI.api('/api/agents/refresh', {}).then(function () { polls = 0; return load(); }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
    });
    $('spaceForm').addEventListener('submit', addSpace);
    $('taskForm').addEventListener('submit', createTaskPlan);
    $('taskAgent').addEventListener('change', paintModes);
    $('teamKind').addEventListener('change', paintTeam);
    $('teamAgents').addEventListener('change', paintModes);
    $('liveCancel').addEventListener('click', cancelLive);
    $('liveOut').addEventListener('scroll', function () {
      var out = $('liveOut');
      live.pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    });
    document.addEventListener('flowmesh:approved', function (event) { startLive(event.detail.plan); });
    document.addEventListener('flowmesh:run', function () {
      // One last read so the final lines are on screen even if the run ended between polls.
      if (live.steps.length) { stopLive(); tick(); }
    });
    document.addEventListener('flowmesh:mode', function () { if (window.FlowMeshRouter && window.FlowMeshRouter.current() === 'code') enter(); });
  }

  window.FlowMeshCode = { enter: enter, paletteItems: paletteItems, refresh: load };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
