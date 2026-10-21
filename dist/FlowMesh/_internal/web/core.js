/* FlowMesh planner — exact port of planner.py. tests/test_parity.py enforces it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowMeshCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WORKFLOWS = {
    focus: ['Deep focus', 'One uninterrupted block, with the usual distractions handled.'],
    meeting: ['Meeting reset', 'Capture the follow-up while it is still fresh.'],
    research: ['Research sprint', 'References open, reading time bounded.'],
    capture: ['Quick capture', 'File the thought before it disappears.'],
  };
  const DEFAULTS = { focus: 45, research: 25 };
  const BRIGHTNESS = { focus: 30, meeting: 70, research: 55 };
  const MAX_COMMAND = 1000;

  const FORBIDDEN = /\b(delete|erase|wipe|unlock|purchase|buy|pay|refund|transfer|password|credentials|medication|oven|door|alarm|format disk)\b/i;
  const CAPTURE_PREFIX = /^\s*(?:capture|note down|remember(?: that)?|jot(?: down)?|make a note|save a note|add a note|note that)\b[\s:,.\-]*/i;
  const MEETING = /\b(meeting|follow.?up|call ended|standup|debrief|sync)\b/i;
  const RESEARCH = /\b(research|reading|documentation|docs|study|paper|spec)\b/i;
  const FOCUS = /\b(focus|deep work|work session|timer|project board|start working|block)\b/i;
  const MINUTES = /\b(\d{1,3})[\s-]*(?:minutes?|mins?)\b/i;
  const PERCENT = /\b(\d{1,3})\s*(?:%|percent\b)/i;

  const INTENT_PATTERNS = [['meeting', MEETING], ['research', RESEARCH], ['focus', FOCUS]];

  function commandIsUsable(command) {
    return typeof command === 'string' && command.trim().length >= 1 && command.trim().length <= MAX_COMMAND;
  }
  function isForbidden(command) { return FORBIDDEN.test(command); }

  function localRoute(command) {
    if (!commandIsUsable(command)) return null;
    const text = command.trim();
    if (isForbidden(text)) return null;
    if (CAPTURE_PREFIX.test(text)) return 'capture';
    if (MEETING.test(text)) return 'meeting';
    if (RESEARCH.test(text)) return 'research';
    if (FOCUS.test(text)) return 'focus';
    return null;
  }

  function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }

  function numberNear(text, pattern, fallback, low, high) {
    const match = text.match(pattern);
    return match ? clamp(parseInt(match[1], 10), low, high) : fallback;
  }

  function actionsFor(route, command) {
    if (!Object.prototype.hasOwnProperty.call(WORKFLOWS, route)) throw new Error('Unsupported routine');
    const text = command.trim();
    const minutes = numberNear(text, MINUTES, DEFAULTS[route] || 0, 1, 180);
    const brightness = numberNear(text, PERCENT, BRIGHTNESS[route] || 50, 1, 100);
    const actions = [];
    const add = (kind, target, label, detail, surface, extra) => {
      actions.push(Object.assign({ kind, target, label, detail, surface }, extra || {}));
    };

    if (route === 'capture') {
      const body = text.replace(CAPTURE_PREFIX, '') || text;
      add('write_note', 'run_record', 'Save the note', 'Markdown file in your FlowMesh folder', 'pc', { note: body });
      return actions;
    }

    if (route === 'research') {
      if (/(board|backlog|issue)/i.test(text)) {
        add('open_url', 'project_board', 'Open project board', 'Approved board URL in your browser', 'pc');
      } else {
        add('open_url', 'documentation', 'Open documentation', 'Approved docs URL in your browser', 'pc');
      }
      if (/calculator/i.test(text)) add('launch_app', 'calculator', 'Open calculator', 'Allowlisted app on this computer', 'pc');
    } else {
      add('open_url', 'project_board', 'Open project board', 'Approved board URL in your browser', 'pc');
      if (route === 'focus' && /notepad|editor|text file/i.test(text)) add('launch_app', 'notepad', 'Open text editor', 'Allowlisted app on this computer', 'pc');
    }

    if (route === 'focus' || route === 'research') {
      add('timer', 'focus_timer', `Start ${minutes} minute timer`, 'Runs while FlowMesh is open', 'pc', { value: minutes });
    }

    let message;
    if (route === 'meeting') message = 'Meeting finished. Write the follow-up while it is fresh.';
    else if (route === 'focus') message = `Focus block started for ${minutes} minutes.`;
    else message = `Research sprint started for ${minutes} minutes.`;
    add('notify', 'my_phone', 'Notify my phone', 'Home Assistant Companion notification', 'phone', { message });
    add('light', 'desk_light', `Set desk lamp to ${brightness}%`, 'Home Assistant light with read-back', 'space', { value: brightness });
    add('write_note', 'run_record', 'Save run record', 'Markdown file in your FlowMesh folder', 'pc', { note: text });
    return actions;
  }

  function otherIntents(route, command) {
    let text = command.trim();
    if (CAPTURE_PREFIX.test(text)) text = text.replace(CAPTURE_PREFIX, '') || text;
    return INTENT_PATTERNS.filter(([name, pattern]) => name !== route && pattern.test(text)).map(([name]) => WORKFLOWS[name][0]);
  }

  function planPayload(route, command, source, confidence) {
    const entry = WORKFLOWS[route];
    return {
      route,
      title: entry[0],
      description: entry[1],
      source: source || 'local',
      confidence: confidence === undefined ? null : confidence,
      also: otherIntents(route, command),
      actions: actionsFor(route, command),
    };
  }

  return { WORKFLOWS, DEFAULTS, BRIGHTNESS, MAX_COMMAND, commandIsUsable, isForbidden, localRoute, actionsFor, otherIntents, planPayload };
});
