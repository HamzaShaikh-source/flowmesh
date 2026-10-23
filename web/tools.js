/* FlowMesh tools workbench: MCP servers, tool browser, schema-driven builder, command palette.

   Desktop runtimes talk to /api/mcp/*. The hosted browser edition has no way to start a
   program or hold a secret, so it gets a small set of *demo tools that run inside this
   page*, labelled as such, to show the same plan -> risk -> approval -> receipt flow.
   Everything the runtime sends is untrusted text and is written with textContent. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  if (!UI) return;
  var $ = function (id) { return document.getElementById(id); };
  var el = UI.el;

  var T = { servers: [], tools: [], errors: {}, chain: [], selected: null, presets: [], demo: false, mode: 'detecting' };
  var RISK = { read: 'READ', write: 'WRITE', danger: 'DANGER' };

  /* ---------------------------------------------------------------- demo tools */

  var DEMO_NOTES = [];
  var DEMO_SERVER = {
    id: 'demo', label: 'FlowMesh demo tools', transport: 'in-page', enabled: true, auto_read: false, connected: true,
  };
  var DEMO_TOOLS = [
    { server: 'demo', name: 'notes_add', title: 'Add a note', risk: 'write',
      description: 'Save a note in this page. Nothing leaves your browser.',
      input_schema: { type: 'object', required: ['title'], properties: {
        title: { type: 'string', description: 'Short title', maxLength: 80 },
        body: { type: 'string', description: 'Optional body', maxLength: 500 } } } },
    { server: 'demo', name: 'notes_list', title: 'List notes', risk: 'read',
      description: 'Read back the notes saved in this page.', input_schema: { type: 'object', properties: {} } },
    { server: 'demo', name: 'notes_clear', title: 'Delete all notes', risk: 'danger',
      description: 'Remove every demo note. Needs the second confirmation.', input_schema: { type: 'object', properties: {} } },
    { server: 'demo', name: 'calc', title: 'Calculate', risk: 'read',
      description: 'Evaluate + - * / ( ) arithmetic with a small safe parser (no eval).',
      input_schema: { type: 'object', required: ['expression'], properties: {
        expression: { type: 'string', description: 'For example (12.5 + 7) * 3', maxLength: 120 } } } },
    { server: 'demo', name: 'timer_start', title: 'Start a timer', risk: 'write',
      description: 'A real countdown in this tab, announced when it ends.',
      input_schema: { type: 'object', required: ['minutes'], properties: {
        minutes: { type: 'integer', description: '1 to 60', minimum: 1, maximum: 60 } } } },
  ];

  /* A tiny recursive-descent parser. Deliberately not eval(): the page's CSP forbids it
     and a calculator must never be a code-execution surface. */
  function calc(expression) {
    var tokens = String(expression).match(/\d+\.?\d*|\.\d+|[()+\-*/]/g);
    if (!tokens || tokens.join('') !== String(expression).replace(/\s+/g, '')) throw new Error('Only numbers, + - * / and parentheses are allowed.');
    var pos = 0;
    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function factor() {
      var token = next();
      if (token === '(') { var inner = sum(); if (next() !== ')') throw new Error('Unbalanced parentheses.'); return inner; }
      if (token === '-') return -factor();
      if (token === '+') return factor();
      if (token === undefined || !/^[\d.]/.test(token)) throw new Error('Unexpected input.');
      return parseFloat(token);
    }
    function product() {
      var value = factor();
      while (peek() === '*' || peek() === '/') {
        var op = next();
        var right = factor();
        if (op === '/' && right === 0) throw new Error('Division by zero.');
        value = op === '*' ? value * right : value / right;
      }
      return value;
    }
    function sum() {
      var value = product();
      while (peek() === '+' || peek() === '-') value = next() === '+' ? value + product() : value - product();
      return value;
    }
    var result = sum();
    if (pos !== tokens.length) throw new Error('Unexpected input.');
    return result;
  }

  var DEMO_RUN = {
    notes_add: function (args) {
      DEMO_NOTES.push({ title: String(args.title), body: String(args.body || '') });
      return 'Saved note #' + DEMO_NOTES.length + ': ' + args.title;
    },
    notes_list: function () {
      return DEMO_NOTES.length ? DEMO_NOTES.map(function (n, i) { return '#' + (i + 1) + ' ' + n.title + (n.body ? ' — ' + n.body : ''); }).join('\n') : '(no notes yet)';
    },
    notes_clear: function () { var n = DEMO_NOTES.length; DEMO_NOTES.length = 0; return 'Deleted ' + n + ' note' + (n === 1 ? '' : 's') + '.'; },
    calc: function (args) { return String(args.expression) + ' = ' + String(Math.round(calc(args.expression) * 1e9) / 1e9); },
    timer_start: function (args) {
      var minutes = args.minutes;
      setTimeout(function () { UI.toast('Demo timer finished: ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '.'); }, minutes * 60000);
      return 'Timer set for ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '. Closing this tab stops it.';
    },
  };

  function runDemo(action, receipt) {
    var run = DEMO_RUN[action.tool];
    receipt.risk = action.risk;
    receipt.surface = 'tools';
    if (!run || action.server !== 'demo') {
      receipt.status = 'denied';
      receipt.detail = 'No such demo tool.';
      return receipt;
    }
    try {
      receipt.output = run(action.arguments || {});
      receipt.status = 'returned';
      receipt.detail = 'Ran inside this page. A returned result is not a verified effect outside it.';
    } catch (err) {
      receipt.status = 'failed';
      receipt.detail = 'The demo tool reported an error.';
      receipt.output = String(err && err.message || err);
    }
    return receipt;
  }

  /* A minimal client-side check for the demo only; desktop runtimes validate on the server
     against each tool's own JSON schema. */
  function demoValidate(tool, args) {
    var schema = tool.input_schema || {};
    var props = schema.properties || {};
    var errors = [];
    (schema.required || []).forEach(function (name) {
      if (args[name] === undefined || args[name] === '') errors.push(name + ' is required');
    });
    Object.keys(args).forEach(function (name) {
      var spec = props[name];
      if (!spec) { errors.push(name + ' is not an accepted field'); return; }
      var value = args[name];
      if (spec.type === 'string' && typeof value !== 'string') errors.push(name + ' must be text');
      if (spec.type === 'integer' && !Number.isInteger(value)) errors.push(name + ' must be a whole number');
      if (typeof spec.maxLength === 'number' && typeof value === 'string' && value.length > spec.maxLength) errors.push(name + ' is too long');
      if (typeof spec.minimum === 'number' && typeof value === 'number' && value < spec.minimum) errors.push(name + ' is below ' + spec.minimum);
      if (typeof spec.maximum === 'number' && typeof value === 'number' && value > spec.maximum) errors.push(name + ' is above ' + spec.maximum);
    });
    return errors;
  }

  function summarize(args) {
    var keys = Object.keys(args);
    if (!keys.length) return 'no arguments';
    return keys.slice(0, 4).map(function (key) {
      var text = typeof args[key] === 'string' ? args[key] : JSON.stringify(args[key]);
      text = text.replace(/\s+/g, ' ');
      return key + ': ' + text.slice(0, 60) + (text.length > 60 ? '…' : '');
    }).join('; ');
  }

  function demoPlan(calls) {
    var actions = [];
    for (var i = 0; i < calls.length; i += 1) {
      var tool = DEMO_TOOLS.filter(function (t) { return t.name === calls[i].tool; })[0];
      if (!tool) throw new Error('No such demo tool.');
      var errors = demoValidate(tool, calls[i].arguments);
      if (errors.length) throw new Error(tool.title + ': ' + errors.join('; '));
      actions.push({ kind: 'mcp_call', target: 'demo/' + tool.name, label: tool.title, detail: summarize(calls[i].arguments),
        surface: 'tools', server: 'demo', server_label: 'DEMO', tool: tool.name, risk: tool.risk, arguments: calls[i].arguments });
    }
    var danger = actions.some(function (a) { return a.risk === 'danger'; });
    var worst = danger ? 'danger' : actions.some(function (a) { return a.risk === 'write'; }) ? 'write' : 'read';
    actions.push({ kind: 'write_note', target: 'run_record', label: 'Save run record',
      detail: 'Markdown generated in this page, including each tool’s output', surface: 'pc', note: '(built in the tool builder, not dictated)' });
    return {
      id: 'web-' + Math.random().toString(16).slice(2, 10), route: 'tools', title: actions.length > 2 ? 'Tool run' : 'Tool call',
      description: (actions.length - 1) + ' demo call' + (actions.length > 2 ? 's' : '') + ', highest risk: ' + worst + '. These run inside this page.',
      source: 'builder', also: [], actions: actions, risk: worst, needs_confirm: danger, auto_run: false,
      expires_at: Date.now() / 1000 + 300, command: '(built in the tool builder, not dictated)',
    };
  }

  /* ---------------------------------------------------------------- server list */

  function loadAll() {
    if (T.demo) {
      T.servers = [DEMO_SERVER];
      T.tools = DEMO_TOOLS.slice();
      T.errors = {};
      renderServers();
      renderTools();
      return;
    }
    setLoading(true);
    UI.get('/api/mcp/servers').then(function (data) {
      T.servers = data.servers || [];
      renderServers();
      return UI.get('/api/mcp/tools');
    }).then(function (data) {
      if (!data) return;
      T.tools = data.tools || [];
      T.errors = data.errors || {};
      setLoading(false);
      renderServers();
      renderTools();
    }).catch(function (err) { setLoading(false); UI.toast(UI.humanError(err.message)); });
  }

  /* Starting a server can take a while (a downloaded one fetches packages on first run), so
     say so instead of showing an empty panel. */
  function setLoading(on) {
    var enabled = T.servers.filter(function (s) { return s.enabled; }).length;
    $('serversPanel').setAttribute('aria-busy', on ? 'true' : 'false');
    if (!on) { $('serverEmpty').classList.remove('server-empty-busy'); return; }
    if (!enabled && T.servers.length) return;
    $('serverEmpty').hidden = false;
    $('serverEmpty').classList.add('server-empty-busy');
    $('serverEmpty').textContent = 'Starting your servers… the first run of a downloaded server can take a minute.';
    $('toolEmpty').textContent = 'Waiting for servers to list their tools…';
  }

  function toolCount(serverId) {
    return T.tools.filter(function (t) { return t.server === serverId; }).length;
  }

  function renderServers() {
    var list = $('serverList');
    list.replaceChildren();
    $('serverEmpty').hidden = T.servers.length > 0;
    if (!T.servers.length) $('serverEmpty').textContent = 'No servers connected yet. Pick a template or add your own.';
    T.servers.forEach(function (server, index) {
      var item = el('li', 'server-card');
      item.style.animationDelay = (index * 60) + 'ms';
      var error = T.errors[server.id];
      var state = !server.enabled ? 'off' : error ? 'error' : (server.connected || T.demo || toolCount(server.id)) ? 'on' : 'idle';
      item.setAttribute('data-state', state);
      var head = el('div', 'server-head');
      head.appendChild(el('span', 'pulse'));
      head.appendChild(el('strong', null, server.label || server.id));
      head.appendChild(el('span', 'tag', String(server.transport).toUpperCase()));
      item.appendChild(head);
      var meta = T.demo
        ? 'Runs inside this page · nothing leaves your browser'
        : error ? error
        : server.enabled ? toolCount(server.id) + ' tool' + (toolCount(server.id) === 1 ? '' : 's') + (server.auto_read ? ' · read-only tools auto-run' : ' · every call asks')
        : 'Switched off';
      item.appendChild(el('p', 'server-meta', meta));
      if (!T.demo) {
        var actions = el('div', 'server-actions');
        actions.appendChild(button('Test', function () { testServer(server); }));
        actions.appendChild(button(server.enabled ? 'Switch off' : 'Switch on', function () { updateServer(server, { enabled: !server.enabled }); }));
        actions.appendChild(button(server.auto_read ? 'Ask for reads too' : 'Trust reads', function () { toggleAuto(server); }));
        actions.appendChild(button('Remove', function () { removeServer(server); }, 'danger'));
        item.appendChild(actions);
      }
      list.appendChild(item);
    });
  }

  function button(label, handler, kind) {
    var node = el('button', 'mini' + (kind ? ' ' + kind : ''), label);
    node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }

  function testServer(server) {
    UI.toast('Testing ' + server.label + '…');
    UI.api('/api/mcp/servers/test', { id: server.id }).then(function (data) {
      UI.toast(server.label + ' answered: ' + data.tools + ' tool' + (data.tools === 1 ? '' : 's') + '.');
      loadAll();
    }).catch(function (err) { UI.toast(UI.humanError(err.message)); loadAll(); });
  }

  function updateServer(server, changes, acknowledged) {
    var body = { server: Object.assign({}, server, changes) };
    delete body.server.connected;
    if (acknowledged) body.acknowledged = true;
    UI.api('/api/mcp/servers', body).then(function () { loadAll(); })
      .catch(function (err) { UI.toast(UI.humanError(err.message)); });
  }

  function toggleAuto(server) {
    if (!server.auto_read && !window.confirm('Let read-only tools on "' + server.label + '" run without asking?\n\nFlowMesh decides what counts as read-only itself and never trusts a server’s own claim on a destructive-looking name. Writes, sends and deletes will still ask every time.')) return;
    updateServer(server, { auto_read: !server.auto_read });
  }

  function removeServer(server) {
    if (!window.confirm('Remove "' + server.label + '"? Its saved environment and headers are deleted from this computer.')) return;
    UI.api('/api/mcp/servers/remove', { id: server.id }).then(function () { UI.toast('Removed ' + server.label + '.'); loadAll(); })
      .catch(function (err) { UI.toast(UI.humanError(err.message)); });
  }

  /* ---------------------------------------------------------------- tool list + builder */

  function renderTools() {
    var query = $('toolSearch').value.trim().toLowerCase();
    var list = $('toolList');
    list.replaceChildren();
    var shown = T.tools.filter(function (tool) {
      return !query || (tool.server + '/' + tool.name + ' ' + tool.title + ' ' + tool.description + ' ' + tool.risk).toLowerCase().indexOf(query) !== -1;
    });
    $('toolCount').textContent = T.tools.length + ' tool' + (T.tools.length === 1 ? '' : 's');
    $('toolEmpty').hidden = shown.length > 0;
    $('toolEmpty').textContent = T.tools.length ? 'No tool matches that filter.' : 'Connect a server to see its tools here.';
    shown.slice(0, 120).forEach(function (tool, index) {
      var item = el('li');
      var open = el('button', 'tool-item');
      open.type = 'button';
      open.style.animationDelay = Math.min(index, 12) * 30 + 'ms';
      if (T.selected && T.selected.server === tool.server && T.selected.name === tool.name) open.setAttribute('aria-current', 'true');
      var risk = el('span', 'risk', RISK[tool.risk] || tool.risk);
      risk.setAttribute('data-r', tool.risk);
      open.appendChild(risk);
      var text = el('span', 'tool-text');
      text.appendChild(el('span', 'tool-name', tool.server + ' / ' + tool.name));
      text.appendChild(el('span', 'tool-desc', tool.description || tool.title));
      open.appendChild(text);
      open.addEventListener('click', function () { selectTool(tool); });
      item.appendChild(open);
      list.appendChild(item);
    });
  }

  function selectTool(tool) {
    T.selected = tool;
    renderTools();
    $('builderEmpty').hidden = true;
    $('builderForm').hidden = false;
    $('builderTitle').textContent = tool.title || tool.name;
    $('builderDesc').textContent = tool.description || '';
    var badge = $('builderRisk');
    badge.hidden = false;
    badge.textContent = RISK[tool.risk] || tool.risk;
    badge.setAttribute('data-r', tool.risk);
    var fields = $('builderFields');
    fields.replaceChildren();
    var schema = tool.input_schema || {};
    var props = schema.properties || {};
    var required = schema.required || [];
    var names = Object.keys(props).sort(function (a, b) { return (required.indexOf(b) !== -1) - (required.indexOf(a) !== -1); });
    if (!names.length) fields.appendChild(el('p', 'quiet', 'This tool takes no arguments.'));
    names.forEach(function (name) { fields.appendChild(field(name, props[name] || {}, required.indexOf(name) !== -1)); });
    var first = fields.querySelector('input, select, textarea');
    if (first) first.focus();
  }

  function field(name, spec, isRequired) {
    var label = el('label', 'bfield');
    var caption = el('span', 'bcap');
    caption.appendChild(el('b', null, name));
    if (isRequired) caption.appendChild(el('i', null, ' required'));
    var kind = Array.isArray(spec.type) ? spec.type[0] : spec.type;
    caption.appendChild(el('small', null, ' ' + (spec.enum ? 'choice' : kind || 'any')));
    label.appendChild(caption);
    var input;
    if (spec.enum) {
      input = el('select');
      if (!isRequired) input.appendChild(el('option', null, ''));
      spec.enum.forEach(function (option) {
        var node = el('option', null, String(option));
        node.value = JSON.stringify(option);
        input.appendChild(node);
      });
    } else if (kind === 'boolean') {
      input = el('input');
      input.type = 'checkbox';
    } else if (kind === 'integer' || kind === 'number') {
      input = el('input');
      input.type = 'number';
      if (kind === 'integer') input.step = '1';
      else input.step = 'any';
      if (typeof spec.minimum === 'number') input.min = String(spec.minimum);
      if (typeof spec.maximum === 'number') input.max = String(spec.maximum);
    } else if (kind === 'array' || kind === 'object') {
      input = el('textarea');
      input.rows = 3;
      input.placeholder = kind === 'array' ? '["a", "b"]' : '{"key": "value"}';
      input.spellcheck = false;
    } else if (typeof spec.maxLength === 'number' && spec.maxLength > 200 || !spec.maxLength && /body|content|text|message|description/i.test(name)) {
      input = el('textarea');
      input.rows = 3;
    } else {
      input = el('input');
      input.type = 'text';
    }
    input.name = name;
    input.setAttribute('data-kind', kind || 'any');
    input.setAttribute('data-enum', spec.enum ? '1' : '');
    if (isRequired && kind !== 'boolean') input.required = true;
    if (spec.description) label.title = spec.description;
    label.appendChild(input);
    if (spec.description) label.appendChild(el('small', 'bhelp', spec.description));
    return label;
  }

  /* Read the form into an arguments object. Empty optional fields are omitted rather than
     sent as empty strings, which many servers reject. */
  function readArguments() {
    var args = {};
    var form = $('builderForm');
    var problem = null;
    Array.prototype.forEach.call(form.querySelectorAll('[name]'), function (input) {
      var kind = input.getAttribute('data-kind');
      var value = input.type === 'checkbox' ? input.checked : input.value;
      if (input.type === 'checkbox') { if (value) args[input.name] = true; return; }
      if (value === '' && !input.required) return;
      if (input.getAttribute('data-enum')) { try { args[input.name] = JSON.parse(value); } catch (e) { args[input.name] = value; } return; }
      if (kind === 'integer' || kind === 'number') { args[input.name] = Number(value); return; }
      if (kind === 'array' || kind === 'object') {
        try { args[input.name] = JSON.parse(value); } catch (e) { problem = input.name + ' must be valid JSON'; }
        return;
      }
      args[input.name] = value;
    });
    if (problem) throw new Error(problem);
    return args;
  }

  function currentCall() {
    if (!T.selected) throw new Error('Pick a tool first.');
    return { server: T.selected.server, tool: T.selected.name, arguments: readArguments(), title: T.selected.title || T.selected.name, risk: T.selected.risk };
  }

  function requestPlan(calls) {
    var clean = calls.map(function (c) { return { server: c.server, tool: c.tool, arguments: c.arguments }; });
    if (T.demo) {
      try { UI.showPlan(demoPlan(clean)); } catch (err) { UI.toast(err.message); }
      return;
    }
    UI.api('/api/mcp/plan', { calls: clean }).then(function (plan) {
      plan.command = '';
      UI.showPlan(plan);
    }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
  }

  function renderChain() {
    $('chainTray').hidden = T.chain.length === 0;
    var list = $('chainList');
    list.replaceChildren();
    T.chain.forEach(function (call, index) {
      var item = el('li');
      var risk = el('span', 'risk', RISK[call.risk] || call.risk);
      risk.setAttribute('data-r', call.risk);
      item.appendChild(risk);
      item.appendChild(el('span', 'chain-name', call.server + ' / ' + call.tool));
      item.appendChild(el('span', 'chain-args', summarize(call.arguments)));
      item.appendChild(button('×', function () { T.chain.splice(index, 1); renderChain(); }, 'icon'));
      list.appendChild(item);
    });
  }

  function bindBuilder() {
    $('toolSearch').addEventListener('input', renderTools);
    $('builderForm').addEventListener('submit', function (event) {
      event.preventDefault();
      try {
        if (T.chain.length >= 8) { UI.toast('A plan holds at most 8 calls.'); return; }
        T.chain.push(currentCall());
        renderChain();
        UI.toast('Added to the chain (' + T.chain.length + ').');
      } catch (err) { UI.toast(err.message); }
    });
    $('builderPlan').addEventListener('click', function () {
      var form = $('builderForm');
      if (!form.reportValidity()) return;
      try { requestPlan([currentCall()]); } catch (err) { UI.toast(err.message); }
    });
    $('chainPlan').addEventListener('click', function () { requestPlan(T.chain); });
    $('chainClear').addEventListener('click', function () { T.chain = []; renderChain(); });
  }

  /* ---------------------------------------------------------------- add-server dialog */

  var activePreset = null;

  function openServerDialog() {
    var dialog = $('serverDialog');
    resetServerForm();
    UI.get('/api/mcp/presets').then(function (data) {
      T.presets = data.presets || [];
      renderPresets();
    }).catch(function () { /* custom form still works */ });
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }

  function renderPresets() {
    var grid = $('presetGrid');
    grid.replaceChildren();
    var groups = {};
    T.presets.forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
    Object.keys(groups).forEach(function (group) {
      grid.appendChild(el('p', 'mono quiet group-label', group.toUpperCase()));
      var row = el('div', 'preset-row');
      groups[group].forEach(function (preset) {
        var card = el('button', 'preset');
        card.type = 'button';
        card.appendChild(el('strong', null, preset.label));
        card.appendChild(el('span', null, preset.description));
        card.appendChild(el('small', 'mono', preset.transport === 'stdio' ? 'RUNS A PROGRAM' : 'REMOTE'));
        card.addEventListener('click', function () { applyPreset(preset); });
        row.appendChild(card);
      });
      grid.appendChild(row);
    });
  }

  function serverForm() { return $('serverForm'); }

  function setTransport(value) {
    Array.prototype.forEach.call(serverForm().querySelectorAll('[data-t]'), function (node) { node.hidden = node.getAttribute('data-t') !== value; });
    serverForm().elements.transport.value = value;
  }

  function resetServerForm() {
    activePreset = null;
    serverForm().reset();
    setTransport('stdio');
    $('serverFormMsg').textContent = '';
    $('serverFormTitle').textContent = 'CUSTOM SERVER';
    var old = serverForm().querySelector('.preset-inputs');
    if (old) old.remove();
  }

  function applyPreset(preset) {
    resetServerForm();
    activePreset = preset;
    var form = serverForm();
    $('serverFormTitle').textContent = 'TEMPLATE · ' + preset.label.toUpperCase();
    setTransport(preset.transport);
    form.elements.id.value = preset.id;
    form.elements.label.value = preset.label;
    if (preset.transport === 'stdio') {
      form.elements.command.value = preset.command;
      form.elements.args.value = preset.args.join('\n');
    } else {
      form.elements.url.value = preset.url;
      form.elements.headers.value = Object.keys(preset.headers || {}).map(function (k) { return k + ': ' + preset.headers[k]; }).join('\n');
    }
    if (preset.inputs.length) {
      var holder = el('div', 'preset-inputs');
      preset.inputs.forEach(function (input) {
        var label = el('label', null, input.label);
        var box = el('input');
        box.name = 'preset_' + input.key;
        box.type = input.secret ? 'password' : 'text';
        box.placeholder = input.placeholder || '';
        box.required = true;
        label.appendChild(box);
        holder.appendChild(label);
      });
      $('serverFormTitle').insertAdjacentElement('afterend', holder);
      holder.querySelector('input').focus();
    }
  }

  function fill(text, values) {
    return String(text).replace(/\{(\w+)\}/g, function (m, key) { return key in values ? values[key] : m; });
  }

  function lines(text) {
    return String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ''); }).filter(Boolean);
  }

  function readServer() {
    var form = serverForm();
    var values = {};
    Array.prototype.forEach.call(form.querySelectorAll('[name^="preset_"]'), function (input) { values[input.name.slice(7)] = input.value; });
    var transport = form.elements.transport.value;
    var server = { id: form.elements.id.value.trim(), label: form.elements.label.value.trim() || form.elements.id.value.trim(),
      transport: transport, enabled: true, auto_read: form.elements.auto_read.checked };
    if (transport === 'stdio') {
      server.command = fill(form.elements.command.value.trim(), values);
      server.args = lines(form.elements.args.value).map(function (l) { return fill(l, values); });
      var env = {};
      lines(form.elements.env.value).forEach(function (line) {
        var at = line.indexOf('=');
        if (at < 1) throw new Error('Environment lines look like NAME=value.');
        env[line.slice(0, at).trim()] = line.slice(at + 1);
      });
      if (Object.keys(env).length) server.env = env;
    } else {
      server.url = fill(form.elements.url.value.trim(), values);
      var headers = {};
      lines(form.elements.headers.value).forEach(function (line) {
        var at = line.indexOf(':');
        if (at < 1) throw new Error('Header lines look like Name: value.');
        headers[line.slice(0, at).trim()] = fill(line.slice(at + 1).trim(), values);
      });
      if (Object.keys(headers).length) server.headers = headers;
    }
    return server;
  }

  function submitServer(event) {
    event.preventDefault();
    var message = $('serverFormMsg');
    var server;
    try { server = readServer(); } catch (err) { message.textContent = err.message; return; }
    var acknowledged = serverForm().elements.ack.checked;
    if (server.transport === 'stdio' && !acknowledged) {
      message.textContent = 'Tick the box: a local server runs a program on this computer.';
      return;
    }
    message.textContent = 'Saving and testing…';
    UI.api('/api/mcp/servers', { server: server, acknowledged: acknowledged }).then(function () {
      return UI.api('/api/mcp/servers/test', { id: server.id });
    }).then(function (result) {
      message.textContent = '';
      $('serverDialog').close();
      UI.toast(server.label + ' connected: ' + result.tools + ' tool' + (result.tools === 1 ? '' : 's') + '.');
      loadAll();
    }).catch(function (err) {
      message.textContent = UI.humanError(err.message) + ' The server was saved; fix it and use Test.';
      loadAll();
    });
  }

  /* ---------------------------------------------------------------- command palette */

  function paletteItems() {
    var items = [
      { label: 'Focus the command box', hint: 'say or type', run: UI.focusCommand },
      { label: 'Create a plan from the command box', hint: 'Ctrl Enter', run: UI.createPlan },
    ];
    if (UI.hasPlan()) {
      items.push({ label: 'Approve the plan on screen', hint: 'Ctrl Shift Enter', run: UI.approvePlan });
      items.push({ label: 'Cancel the plan on screen', hint: 'Esc', run: UI.clearPlan });
    }
    items.push({ label: 'Go to the console', hint: 'section', run: function () { jump('console'); } });
    items.push({ label: 'Go to tools', hint: 'section', run: function () { jump('tools'); } });
    items.push({ label: 'Go to what runs where', hint: 'section', run: function () { jump('capabilities'); } });
    if (UI.mode() === 'desktop') {
      items.push({ label: 'Add an MCP server', hint: 'tools', run: openServerDialog });
      items.push({ label: 'Use my last Wispr dictation', hint: 'desktop', run: UI.pullDictation });
      items.push({ label: 'Connect my Wispr account', hint: 'desktop', run: UI.connectAccount });
      items.push({ label: 'Open connections and model settings', hint: 'settings', run: function () { jump('settingsSection'); } });
    }
    [['Meeting reset', 'meeting'], ['Deep focus', 'focus'], ['Research sprint', 'research'], ['Quick capture', 'capture']].forEach(function (pair) {
      items.push({ label: 'Try the example: ' + pair[0], hint: 'example', run: function () {
        var chip = document.querySelector('[data-example="' + pair[1] + '"]');
        if (chip) chip.click();
      } });
    });
    return items;
  }

  function jump(id) {
    var node = $(id);
    if (node) node.scrollIntoView({ behavior: UI.reduced() ? 'auto' : 'smooth', block: 'start' });
  }

  var paletteIndex = 0;
  var paletteShown = [];

  function renderPalette() {
    var query = $('paletteInput').value.trim().toLowerCase();
    paletteShown = paletteItems().filter(function (item) { return !query || item.label.toLowerCase().indexOf(query) !== -1; });
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteShown.length - 1));
    var list = $('paletteList');
    list.replaceChildren();
    paletteShown.forEach(function (item, index) {
      var row = el('li');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === paletteIndex ? 'true' : 'false');
      row.appendChild(el('span', null, item.label));
      row.appendChild(el('small', 'mono quiet', item.hint));
      row.addEventListener('click', function () { runPalette(index); });
      list.appendChild(row);
    });
    if (!paletteShown.length) list.appendChild(el('li', 'palette-empty', 'No action matches.'));
  }

  function runPalette(index) {
    var item = paletteShown[index];
    if (!item) return;
    $('palette').close();
    setTimeout(item.run, 30);
  }

  function togglePalette() {
    var dialog = $('palette');
    if (dialog.open) { dialog.close(); return; }
    $('paletteInput').value = '';
    paletteIndex = 0;
    renderPalette();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    $('paletteInput').focus();
  }

  function bindPalette() {
    document.addEventListener('keydown', function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); togglePalette(); }
    });
    $('paletteTrigger').addEventListener('click', togglePalette);
    $('paletteInput').addEventListener('input', function () { paletteIndex = 0; renderPalette(); });
    $('paletteInput').addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') { event.preventDefault(); paletteIndex = Math.min(paletteIndex + 1, paletteShown.length - 1); renderPalette(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = Math.max(paletteIndex - 1, 0); renderPalette(); }
      else if (event.key === 'Enter') { event.preventDefault(); runPalette(paletteIndex); }
    });
    $('palette').addEventListener('click', function (event) { if (event.target === $('palette')) $('palette').close(); });
  }

  /* ---------------------------------------------------------------- boot */

  function onMode(event) {
    T.mode = event.detail.mode;
    T.demo = T.mode !== 'desktop';
    $('addServer').hidden = T.demo;
    $('modelStatus').textContent = '';
    if (T.demo) {
      $('toolsLede').textContent = 'This hosted page cannot start programs or hold secrets, so it ships five demo tools that run inside the page. The desktop app connects real MCP servers: files, git, GitHub, browsers, messaging.';
      var rowCell = document.querySelector('[data-cell="tools"]');
      if (rowCell) rowCell.textContent = 'DEMO TOOLS ONLY';
    } else {
      var caps = (event.detail.status && event.detail.status.capabilities) || {};
      $('modelStatus').textContent = caps.model === 'ready'
        ? 'MODEL PLANNER · ON — sentences can become tool plans. You still approve every call.'
        : 'MODEL PLANNER · OFF — add a key under Connections to plan tools from a sentence. The builder works without one.';
    }
    loadAll();
  }

  function init() {
    bindBuilder();
    bindPalette();
    $('addServer').addEventListener('click', openServerDialog);
    serverForm().addEventListener('submit', submitServer);
    Array.prototype.forEach.call(serverForm().querySelectorAll('[name="transport"]'), function (radio) {
      radio.addEventListener('change', function () { setTransport(radio.value); });
    });
    document.addEventListener('flowmesh:mode', onMode);
    renderChain();
    // ui.js decides the browser edition synchronously, before this script is listening.
    if (UI.mode() === 'browser') onMode({ detail: { mode: 'browser', status: null } });
  }

  window.FlowMeshTools = { runDemo: runDemo, demoPlan: demoPlan, calc: calc };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
