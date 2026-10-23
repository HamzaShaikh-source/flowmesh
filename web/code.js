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
  var live = { id: '', timer: null, misses: 0, pinned: true };

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
    $('taskPlan').disabled = !ready;
    $('taskPrompt').disabled = !ready;
    $('taskPrompt').placeholder = ready ? 'Fix the failing test in tests/test_parser.py and explain what was wrong.'
      : (agents.length ? 'Add a project folder first.' : 'Install and sign in to a coding agent first.');
    paintModes();
  }

  function paintModes() {
    var list = $('modeList');
    var agent = A.catalog.filter(function (a) { return a.id === $('taskAgent').value; })[0];
    var chosen = (document.querySelector('input[name="taskMode"]:checked') || {}).value || A.config.default_mode || 'edit';
    list.replaceChildren();
    if (!agent) return;
    if (!agent.modes.some(function (m) { return m.id === chosen; })) chosen = agent.modes.some(function (m) { return m.id === 'edit'; }) ? 'edit' : agent.modes[0].id;
    agent.modes.forEach(function (mode) {
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
    var body = { agent: $('taskAgent').value, workspace: $('taskSpace').value, mode: mode, prompt: $('taskPrompt').value };
    if (!body.prompt.trim()) { UI.toast('Describe the task first.'); return; }
    var button = $('taskPlan');
    button.setAttribute('aria-busy', 'true');
    UI.api('/api/agents/plan', body).then(function (plan) {
      button.removeAttribute('aria-busy');
      // Remember the choice so a spoken "ask codex to ..." uses it. Never remember full access.
      var saved = { default_agent: body.agent, default_workspace: body.workspace };
      if (mode !== 'full') saved.default_mode = mode;
      UI.api('/api/agents/defaults', saved).then(function (data) { A.config = data.config; }).catch(function () { /* optional */ });
      UI.showPlan(plan);
    }).catch(function (err) { button.removeAttribute('aria-busy'); UI.toast(UI.humanError(err.message)); });
  }

  /* ---------------------------------------------------------------- live run */

  function runIdOf(plan) {
    var step = (plan.actions || []).filter(function (a) { return a.kind === 'agent_run'; })[0];
    return step ? step.run_id : '';
  }

  function startLive(plan) {
    var id = runIdOf(plan);
    stopLive();
    if (!id) { $('liveRun').hidden = true; return; }
    live.id = id;
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
    var id = live.id;
    if (!id) return;
    UI.get('/api/agents/runs/' + encodeURIComponent(id)).then(function (view) {
      if (id !== live.id) return;
      paintLive(view);
      if (view.status === 'running') live.timer = setTimeout(tick, 1000);
    }).catch(function () {
      if (id !== live.id) return;
      live.misses += 1;
      // The run is registered a moment after approval; give it a few seconds, then give up quietly.
      if (live.misses < 8) live.timer = setTimeout(tick, 800);
    });
  }

  function paintLive(view) {
    var out = $('liveOut');
    var atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.textContent = view.output || '';
    if (atEnd || live.pinned) out.scrollTop = out.scrollHeight;
    $('liveRun').setAttribute('data-state', view.status);
    var running = view.status === 'running';
    var changed = view.changes && view.changes.observed ? ' · git saw ' + view.changes.files.filter(function (f) { return f.indexOf('committed ') !== 0; }).length + ' changed' : '';
    $('liveMeta').textContent = (running ? 'running' : view.status) + ' · ' + view.elapsed_s + ' s' + changed;
    $('liveCancel').hidden = !running;
    if (!running) $('liveNote').textContent = 'Finished. The receipt below is what FlowMesh actually knows: it did not check the work.';
  }

  function cancelLive() {
    if (!live.id) return;
    $('liveCancel').disabled = true;
    UI.api('/api/agents/runs/' + encodeURIComponent(live.id) + '/cancel', {}).then(function () {
      UI.toast('Stopping the agent and everything it started.');
    }).catch(function (err) { $('liveCancel').disabled = false; UI.toast(UI.humanError(err.message)); });
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
    $('liveCancel').addEventListener('click', cancelLive);
    $('liveOut').addEventListener('scroll', function () {
      var out = $('liveOut');
      live.pinned = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    });
    document.addEventListener('flowmesh:approved', function (event) { startLive(event.detail.plan); });
    document.addEventListener('flowmesh:run', function () {
      // One last read so the final lines are on screen even if the run ended between polls.
      if (live.id) { stopLive(); tick(); }
    });
    document.addEventListener('flowmesh:mode', function () { if (window.FlowMeshRouter && window.FlowMeshRouter.current() === 'code') enter(); });
  }

  window.FlowMeshCode = { enter: enter, paletteItems: paletteItems, refresh: load };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
