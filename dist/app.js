const $ = (id) => document.getElementById(id);
const EXAMPLES = {
  focus: 'Start a 45 minute focus session. Open my project board and Notepad, notify my phone, dim the desk lamp to 30%, and start a timer.',
  meeting: 'I just finished a meeting. Open my project board, remind me on my phone to write the follow up, and turn my desk lamp to 70%.',
  research: 'Start a 25 minute research sprint. Open the documentation and Calculator, send a reading reminder to my phone, and set my desk lamp to 55%.'
};
const state = { connected: false, plan: null, events: [], timerId: null };

function timeLabel() { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function addEvent(title, detail, status = 'sent', at = timeLabel()) {
  state.events.unshift({ time: at, title, detail, status });
  state.events = state.events.slice(0, 50);
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
  const prefix = { pc: 'pc', phone: 'phone', space: 'space' }[surface];
  if (!prefix) return;
  $(`${prefix}State`).textContent = title;
  $(`${prefix}Detail`).textContent = detail;
  $(`${prefix}Surface`).classList.add('active');
}
function startTimer(minutes, endMillis = Date.now() + minutes * 60_000) {
  if (state.timerId) clearInterval(state.timerId);
  function tick() {
    const left = Math.max(0, Math.ceil((endMillis - Date.now()) / 1000));
    const mm = String(Math.floor(left / 60)).padStart(2, '0');
    const ss = String(left % 60).padStart(2, '0');
    updateSurface('pc', `${mm}:${ss} remaining`, 'Timer running in FlowMesh');
    if (left === 0) {
      clearInterval(state.timerId); state.timerId = null;
      addEvent('Focus timer complete', `${minutes} minute block finished`, 'verified');
    }
  }
  tick(); state.timerId = setInterval(tick, 1000);
}
async function api(path, payload) {
  const response = await fetch(path, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function detectRuntime() {
  try {
    const data = await api('/api/status');
    if (data.mode !== 'desktop_app') throw Error('Not the desktop runtime');
    state.connected = true;
    $('connectionBadge').innerHTML = '<span class="status-dot"></span> Desktop connected';
    $('settingsSection').hidden = false;
    $('settingsShortcut').hidden = false;
    await loadSettings();
    const history = await api('/api/events');
    for (const event of history.events || []) addEvent(event.action?.label || event.action?.kind || 'Action', event.detail, event.status, new Date(event.at).toLocaleTimeString());
    if (data.timer_end && data.timer_end * 1000 > Date.now()) startTimer(Math.ceil((data.timer_end * 1000 - Date.now()) / 60000), data.timer_end * 1000);
  } catch {
    $('connectionBadge').textContent = 'Runtime disconnected';
    $('planButton').disabled = true;
    addEvent('Runtime unavailable', 'Restart the FlowMesh desktop app to use real actions.', 'failed');
  }
}
async function loadSettings() {
  const data = await api('/api/settings');
  for (const name of ['board_url', 'docs_url', 'ha_url', 'light_entity', 'phone_service']) $('settingsForm').elements.namedItem(name).value = data[name] || '';
  $('jevKeyState').textContent = data.jev_connected ? 'Connected' : 'Not connected';
  $('haTokenState').textContent = data.ha_token_connected ? 'Connected' : 'Not connected';
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
    await api('/api/settings', payload);
    form.elements.namedItem('jev_key').value = '';
    form.elements.namedItem('ha_token').value = '';
    $('settingsMessage').textContent = 'Connections saved on this PC.';
    await loadSettings();
  } catch (error) { $('settingsMessage').textContent = error.message; }
}
async function planCommand() {
  const command = $('commandInput').value.trim();
  if (!command || !state.connected) { $('commandInput').focus(); return; }
  $('planButton').disabled = true;
  try {
    if (state.plan) await api('/api/cancel', { plan_id: state.plan.id });
    const plan = await api('/api/plan', { command });
    state.plan = plan;
    $('intentTitle').textContent = plan.title;
    $('intentDescription').textContent = plan.description;
    $('routingBadge').textContent = plan.source === 'jev' ? `Jev decision · ${Math.round(plan.confidence * 100)}%` : plan.source === 'jev_unavailable' ? 'Jev unavailable · local rules' : 'Local rules';
    const list = $('actionList'); list.replaceChildren();
    plan.actions.forEach((action, index) => {
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
    addEvent('Plan prepared', `${plan.actions.length} registered actions await your approval`, 'sent');
    $('planSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    state.plan = null; $('planSection').hidden = true;
    addEvent('Plan rejected', error.message, 'denied');
  } finally { $('planButton').disabled = false; }
}
async function runPlan() {
  if (!state.plan) return;
  const plan = state.plan; state.plan = null;
  $('approveButton').disabled = true;
  try {
    const response = await api('/api/execute', { plan_id: plan.id });
    addEvent('Plan approved', `${response.results.length} actions attempted by the local runtime; check each receipt`, 'sent');
    for (const [index, result] of response.results.entries()) {
      const action = plan.actions[index];
      addEvent(action.label, result.detail, result.status);
      if (result.status === 'verified' || result.status === 'sent') {
        const title = action.kind === 'light' ? `Lamp ${action.value}%` : action.kind === 'notify' ? 'Notification sent' : action.kind === 'timer' ? `${action.value} min timer` : action.kind === 'launch_app' ? 'App launch sent' : 'Browser open sent';
        updateSurface(action.surface, title, result.detail);
        if (action.kind === 'timer') startTimer(action.value, result.timer_end * 1000);
      }
    }
    $('planSection').hidden = true;
    $('activityList').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) { addEvent('Execution failed', error.message, 'failed'); }
  finally { $('approveButton').disabled = false; }
}
async function cancelPlan() {
  if (!state.plan) return;
  const id = state.plan.id; state.plan = null;
  try { await api('/api/cancel', { plan_id: id }); } catch { /* Expired plans cannot run. */ }
  $('planSection').hidden = true;
  addEvent('Plan cancelled', 'No actions were run', 'denied');
}
function clearView() {
  state.events = [];
  $('activityList').replaceChildren(); $('emptyActivity').hidden = false;
  $('commandInput').focus();
}
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => { $('commandInput').value = EXAMPLES[button.dataset.example]; $('commandInput').focus(); }));
$('planButton').addEventListener('click', planCommand);
$('approveButton').addEventListener('click', runPlan);
$('cancelButton').addEventListener('click', cancelPlan);
$('resetButton').addEventListener('click', clearView);
$('commandInput').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) planCommand(); });
$('settingsForm').addEventListener('submit', saveSettings);
detectRuntime();
