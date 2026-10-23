/* The voice command grammar, as a pure module so it can be tested without a browser.

   A spoken sentence is untrusted input. Only a *whole utterance* that exactly matches one of a
   fixed set of short commands acts as a command; "cancel my subscription" or "go to tools and
   delete everything" are ordinary sentences and become a normal plan that a person approves.
   There is no fuzzy matching, a command carries only a type and an item from a fixed list (a page,
   an example, a tool), and nothing here can name a path, a program or an argument.

   The one exception is `fill`, which sets a field of the tool builder to the words you said. It
   exists only while a builder form is open (the caller passes `builderOpen`), it can only write
   into that visible form, and the result is still a plan someone approves. Nothing can switch on
   approval-by-voice: that setting is deliberately not reachable by speech. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowMeshGrammar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGES = { home: 'home', dashboard: 'home', flow: 'flow', tools: 'tools', code: 'code', coding: 'code', wispr: 'wispr', history: 'history', runs: 'history', settings: 'settings', about: 'about', 'how it works': 'about' };
  var NAV = /^(?:go to|open|show|take me to)(?: me)?(?: the)? (home|dashboard|flow|tools|code|coding|wispr|history|runs|settings|about|how it works)(?: page)?$/;
  var CANCEL = /^(?:cancel|never mind|nevermind|stop|dismiss)(?: that| it| the plan| this)?$/;
  var APPROVE = /^(?:approve|approve and run|approve it|run it|do it|go ahead)$/;
  var READ = /^(?:read(?: it| that| the plan)?(?: back| out| aloud| again)?|what(?:'s| is) the plan|say (?:it|that|the plan) again)$/;
  var CLEAR = /^(?:new plan|clear|start over|clear the box)$/;
  var ADD_TOOL = /^(?:connect|add) (?:a )?(?:tool|server)s?$/;

  var PLAN = /^(?:create|make|build|generate)(?: the| a)? plan$|^plan it$/;
  var FOCUS = /^(?:focus|select)(?: the)?(?: command)? (?:box|field|input)$|^let me type$/;
  var EXAMPLES = { 'meeting reset': 'meeting', meeting: 'meeting', 'deep focus': 'focus', focus: 'focus', 'research sprint': 'research', research: 'research', 'quick capture': 'capture', capture: 'capture' };
  var EXAMPLE = /^(?:try|use|run|load) the (meeting reset|meeting|deep focus|focus|research sprint|research|quick capture|capture) example$/;
  var LATEST = /^(?:open|show)(?: me)?(?: the)? (?:latest|last|most recent) (?:run|record)$/;
  var RECORD = /^(copy|download)(?: the| this)? (?:run )?(?:record|markdown)$/;
  var NEXT = /^plan the next step$/;
  var PALETTE = /^(?:open|show)(?: the)? (?:command )?palette$/;
  var SCROLL = /^scroll (down|up)$|^(?:go to|scroll to|back to) the (top|bottom)$/;
  var SPEAK = /^(?:(start|stop) reading(?: it| plans)?(?: aloud)?|reading aloud (on|off)|read aloud (on|off))$/;
  var HELP = /^(?:what can i say|voice help|show (?:the )?(?:voice )?commands|help)$/;
  var TOOLS = { calculator: 'calc', timer: 'timer_start', 'notes list': 'notes_list', 'add note': 'notes_add', 'delete notes': 'notes_clear' };
  var TOOL = /^(?:use|open|select) the (calculator|timer|notes list|add note|delete notes) tool$/;
  var BUILDER = {
    'add to the chain': 'add', 'add it to the chain': 'add', 'plan this call': 'call', 'plan the call': 'call',
    'plan the chain': 'chain', 'clear the chain': 'clear',
  };
  var FILL = /^(?:set|fill|enter|type)(?: in)?(?: the)? ([a-z][a-z ]{0,29}?) (?:to|with|as) (.{1,300})$/i;

  /** The commands, as data: the help sheet is generated from this so it can never drift from the code. */
  var HELP_LIST = [
    ['Go anywhere', ['go to tools', 'open history', 'show the code page', 'take me to settings']],
    ['Plan', ['create the plan', 'focus the box', 'new plan', 'try the research sprint example']],
    ['Approve safely', ['read it back', 'cancel', 'approve (only if you turned it on, and never for danger plans)']],
    ['Results', ['open the latest run', 'copy the record', 'download the record', 'plan the next step']],
    ['Tools', ['use the calculator tool', 'set expression to 12 times 3', 'add to the chain', 'plan this call']],
    ['The page', ['open the palette', 'scroll down', 'go to the top', 'start reading aloud', 'what can I say']],
  ];

  function normalize(text) {
    return String(text).toLowerCase().replace(/[.,!?;:"]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(?:hey )?flowmesh /, '').replace(/ please$/, '');
  }

  /** The command a whole utterance means, or null when it is just a sentence to plan. */
  function parseCommand(text, context) {
    var t = normalize(text);
    var ctx = context || {};
    var m = NAV.exec(t);
    if (m) return { type: 'go', page: PAGES[m[1]] };
    if (CANCEL.test(t)) return { type: 'cancel' };
    if (APPROVE.test(t)) return { type: 'approve' };
    if (READ.test(t)) return { type: 'read' };
    if (CLEAR.test(t)) return { type: 'clear' };
    if (ADD_TOOL.test(t)) return { type: 'go', page: 'tools' };
    if (PLAN.test(t)) return { type: 'plan' };
    if (FOCUS.test(t)) return { type: 'focus' };
    if ((m = EXAMPLE.exec(t))) return { type: 'example', name: EXAMPLES[m[1]] };
    if (LATEST.test(t)) return { type: 'latest' };
    if ((m = RECORD.exec(t))) return { type: m[1] };
    if (NEXT.test(t)) return { type: 'next' };
    if (PALETTE.test(t)) return { type: 'palette' };
    if ((m = SCROLL.exec(t))) return { type: 'scroll', to: m[1] || m[2] };
    if ((m = SPEAK.exec(t))) return { type: 'speak', on: (m[1] || m[2] || m[3]) === 'start' || (m[2] || m[3]) === 'on' };
    if (HELP.test(t)) return { type: 'help' };
    if ((m = TOOL.exec(t))) return { type: 'tool', tool: TOOLS[m[1]] };
    if (Object.prototype.hasOwnProperty.call(BUILDER, t)) return { type: 'builder', action: BUILDER[t] };
    if (ctx.builderOpen === true) {
      // The value keeps the words as spoken (case and punctuation); only the wake word and the final full stop go.
      var spoken = String(text).replace(/\s+/g, ' ').trim().replace(/^(?:hey )?flowmesh[ ,]+/i, '').replace(/[.!?]+$/, '');
      if (FILL.test(t) && (m = FILL.exec(spoken))) return { type: 'fill', field: m[1].toLowerCase(), text: m[2].trim() };
    }
    return null;
  }

  return { parseCommand: parseCommand, normalize: normalize, PAGES: PAGES, HELP_LIST: HELP_LIST, EXAMPLES: EXAMPLES, TOOLS: TOOLS };
});
