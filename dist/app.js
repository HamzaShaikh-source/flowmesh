const $ = (id) => document.getElementById(id);
const EXAMPLES = {
  focus: 'Start a 45 minute focus session. Open my project board and Notepad, notify my phone, dim the desk lamp to 30%, and start a timer.',
  meeting: 'I just finished a meeting. Open my project board, remind me on my phone to write the follow up, and turn my desk lamp to 70%.',
  research: 'Start a 25 minute research sprint. Open the documentation and Calculator, send a reading reminder to my phone, and set my desk lamp to 55%.'
};
const WORKFLOWS = {
  focus: { title: 'Deep focus', description: 'Clear the desk and begin one uninterrupted block.' },
  meeting: { title: 'Meeting reset', description: 'Capture the next step and return to your work.' },
  research: { title: 'Research sprint', description: 'Prepare references and start a timed reading block.' }
};
const state = { bridge: false, jev: false, plan: null, events: [], timerId: null, surfaces: { pc: null, phone: null, space: null } };

function timeLabel() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }
function numberNear(command, pattern, fallback, low, high) {
  const match = command.match(pattern);
  return match ? clamp(Number(match[1]), low, high) : fallback;
}
function localRoute(command) {
  const text = command.toLowerCase();
  if (containsForbiddenAction(text)) return null;
  if (/meeting|follow.?up|call ended/.test(text)) return 'meeting';
  if (/research|reading|documentation|study/.test(text)) return 'research';
  if (/focus|deep work|work session|timer|project board/.test(text)) return 'focus';
  return null;
}
function containsForbiddenAction(command) {
  return /\b(unlock|delete|purchase|buy|oven|alarm|password|door|security|medication|send email|send money|transfer funds)\b/i.test(command);
}
function createActions(route, command) {
  const minutes = numberNear(command, /\b(\d{1,3})\s*(?:minute|min)\b/i, route === 'research' ? 25 : 45, 1, 180);
  const brightness = numberNear(command, /\b(\d{1,3})\s*%/, route === 'meeting' ? 70 : route === 'research' ? 55 : 30, 1, 100);
  const actions = [];
  const add = (kind, target, label, detail, surface, extra = {}) => actions.push({ kind, target, label, detail, surface, ...extra });
  if (route === 'research') {
    add('open_url', 'documentation', 'Open documentation', 'Approved Python documentation page', 'pc');
    if (/calculator/i.test(command)) add('launch_app', 'calculator', 'Launch Calculator', 'Approved Windows application', 'pc');
  } else {
    add('open_url', 'project_board', 'Open project board', 'Approved GitHub issues page', 'pc');
    if (route === 'focus' && /notepad|editor/i.test(command)) add('launch_app', 'notepad', 'Launch Notepad', 'Approved Windows application', 'pc');
  }
  if (route === 'focus' || route === 'research') add('timer', 'focus_timer', `Start ${minutes} minute timer`, 'Runs in this command center', 'pc', { value: minutes });
  const messages = {
    focus: `Focus block started for ${minutes} minutes.`,
    meeting: 'Meeting finished. Write the follow up and capture action items.',
    research: `Research sprint started for ${minutes} minutes.`
  };
  add('notify', 'my_phone', 'Notify my phone', 'Home Assistant Companion when configured', 'phone', { message: messages[route] });
  add('light', 'desk_light', `Set desk lamp to ${brightness}%`, 'Home Assistant light when configured', 'space', { value: brightness });
  return actions;
}
function addEvent(title, detail, status = 'verified') {
  state.events.unshift({ time: timeLabel(), title, detail, status });
  state.events = state.events.slice(0, 40);
  $('emptyActivity').hidden = state.events.length > 0;
  const list = $('activityList'); list.replaceChildren();
  for (const event of state.events) {
    const row = document.createElement('li');
    const time = document.createElement('time'); time.textContent = event.time;
    const body = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = event.title;
    const small = document.createElement('small'); small.textContent = event.detail;
    body.append(strong, small);
    const receipt = document.createElement('span'); receipt.className = `receipt ${event.status}`; receipt.textContent = event.status.replace('_', ' ');
    row.append(time, body, receipt); list.append(row);
  }
}
function updateSurface(surface, title, detail) {
  state.surfaces[surface] = { title, detail };
  const prefix = { pc: 'pc', phone: 'phone', space: 'space' }[surface];
  $(`${prefix}State`).textContent = title;
  $(`${prefix}Detail`).textContent = detail;
  $(`${prefix}Surface`).classList.add('active');
}
function startTimer(minutes) {
  if (state.timerId) clearInterval(state.timerId);
  const end = Date.now() + minutes * 60_000;
  function tick() {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    updateSurface('pc', `${mm}:${ss} remaining`, 'Focus timer running in FlowMesh');
    if (left === 0) { clearInterval(state.timerId); state.timerId = null; addEvent('Focus timer complete', `${minutes} minute block finished`, 'verified'); }
  }
  tick(); state.timerId = setInterval(tick, 1000);
}
async function detectBridge() {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname)) return;
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(1300) });
    if (!response.ok) return;
    const data = await response.json();
    if (data.mode !== 'local_bridge') return;
    state.bridge = true; state.jev = data.jev;
    $('connectionBadge').innerHTML = '<span class="status-dot"></span> Desktop app';
    $('settingsSection').hidden = false;
    $('settingsShortcut').hidden = false;
    await loadSettings();
  } catch { /* Hosted version runs as a self-contained simulator. */ }
}
async function loadSettings() {
  const response = await fetch('/api/settings');
  if (!response.ok) return;
  const data = await response.json();
  for (const name of ['board_url', 'docs_url', 'ha_url', 'light_entity', 'phone_service']) {
    $('settingsForm').elements.namedItem(name).value = data[name] || '';
  }
  $('jevKeyState').textContent = data.jev_connected ? 'Connected' : 'Not connected';
  $('haTokenState').textContent = data.ha_token_connected ? 'Connected' : 'Not connected';
  state.jev = data.jev_connected;
}
async function saveSettings(event) {
  event.preventDefault();
  const form = $('settingsForm');
  const payload = {};
  for (const name of ['board_url', 'docs_url', 'ha_url', 'light_entity', 'phone_service']) payload[name] = form.elements.namedItem(name).value.trim();
  for (const name of ['jev_key', 'ha_token']) {
    const value = form.elements.namedItem(name).value.trim();
    if (value) payload[name] = value;
  }
  $('settingsMessage').textContent = 'Saving…';
  try {
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Could not save settings');
    form.elements.namedItem('jev_key').value = '';
    form.elements.namedItem('ha_token').value = '';
    $('settingsMessage').textContent = 'Connections saved on this PC.';
    await loadSettings();
  } catch (error) { $('settingsMessage').textContent = error.message; }
}
async function routeCommand(command) {
  if (containsForbiddenAction(command)) return null;
  if (state.bridge && state.jev) {
    try {
      const response = await fetch('/api/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, options: Object.keys(WORKFLOWS) }) });
      const choice = await response.json();
      if (choice.source === 'jev') {
        $('routingBadge').textContent = `Jev decision · ${Math.round((choice.confidence || 0) * 100)}%`;
        return choice.route;
      }
    } catch { /* Show local route in the trace. */ }
  }
  $('routingBadge').textContent = 'Local routing';
  return localRoute(command);
}
async function planCommand() {
  const command = $('commandInput').value.trim();
  if (!command) { $('commandInput').focus(); return; }
  $('planButton').disabled = true;
  const route = await routeCommand(command);
  $('planButton').disabled = false;
  if (!route) {
    state.plan = null; $('planSection').hidden = true;
    addEvent('Command needs clarification', 'Use focus, meeting reset, or research sprint. Sensitive actions are unavailable.', 'denied');
    return;
  }
  const actions = createActions(route, command);
  state.plan = { route, command, actions };
  $('intentTitle').textContent = WORKFLOWS[route].title;
  $('intentDescription').textContent = WORKFLOWS[route].description;
  const list = $('actionList'); list.replaceChildren();
  actions.forEach((action, index) => {
    const row = document.createElement('div'); row.className = 'action-row';
    const number = document.createElement('span'); number.className = 'action-index'; number.textContent = String(index + 1).padStart(2, '0');
    const body = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = action.label;
    const detail = document.createElement('small'); detail.textContent = action.detail;
    body.append(title, detail);
    const tag = document.createElement('span'); tag.className = 'action-tag'; tag.textContent = action.surface.toUpperCase();
    row.append(number, body, tag); list.append(row);
  });
  $('planSection').hidden = false;
  addEvent('Plan prepared', `${actions.length} registered actions await your approval`, 'verified');
  $('planSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function executeAction(action) {
  if (!state.bridge) return { status: 'verified', detail: 'Simulated state changed in this public demo' };
  try {
    const response = await fetch('/api/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
    if (!response.ok) throw Error('Bridge rejected request');
    return await response.json();
  } catch { return { status: 'failed', detail: 'Local bridge unavailable' }; }
}
async function runPlan() {
  if (!state.plan) return;
  const current = state.plan; state.plan = null;
  $('approveButton').disabled = true;
  addEvent('Plan approved', `${current.actions.length} actions authorized by you`, 'verified');
  for (const action of current.actions) {
    const result = await executeAction(action);
    addEvent(action.label, result.detail, result.status);
    if (result.status === 'verified' || result.status === 'sent') {
      const surfaceTitle = action.kind === 'light' ? `Lamp ${action.value}%` : action.kind === 'notify' ? (state.bridge ? 'Notification sent' : 'Phone simulated') : action.kind === 'timer' ? `${action.value} min timer` : action.kind === 'launch_app' ? (state.bridge ? 'App launch sent' : 'App simulated') : (state.bridge ? 'Browser open sent' : 'Browser simulated');
      updateSurface(action.surface, surfaceTitle, state.bridge ? result.detail : 'Verified in demo simulator');
      if (action.kind === 'timer') startTimer(action.value);
    }
    await new Promise(resolve => setTimeout(resolve, 190));
  }
  $('approveButton').disabled = false;
  $('planSection').hidden = true;
  $('activityList').scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function resetDemo() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
  state.plan = null; state.events = []; state.surfaces = { pc: null, phone: null, space: null };
  $('commandInput').value = ''; $('planSection').hidden = true; $('activityList').replaceChildren(); $('emptyActivity').hidden = false;
  [['pc', 'Standing by', 'Browser and Windows apps'], ['phone', 'Standing by', 'Companion notifications'], ['space', 'Desk lamp off', 'Home Assistant or simulator']].forEach(([id, title, detail]) => {
    $(`${id}State`).textContent = title; $(`${id}Detail`).textContent = detail; $(`${id}Surface`).classList.remove('active');
  });
  $('commandInput').focus();
}
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => { $('commandInput').value = EXAMPLES[button.dataset.example]; $('commandInput').focus(); }));
$('planButton').addEventListener('click', planCommand);
$('approveButton').addEventListener('click', runPlan);
$('cancelButton').addEventListener('click', () => { state.plan = null; $('planSection').hidden = true; addEvent('Plan cancelled', 'No actions were run', 'denied'); });
$('resetButton').addEventListener('click', resetDemo);
$('commandInput').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) planCommand(); });
$('settingsForm').addEventListener('submit', saveSettings);
detectBridge();
