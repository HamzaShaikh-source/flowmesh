/* The voice command grammar, as a pure module so it can be tested without a browser.

   A spoken sentence is untrusted input. Only a *whole utterance* that exactly matches one of a
   few short commands acts as a command; "cancel my subscription" or "go to tools and delete
   everything" are ordinary sentences and become a normal plan that a person approves. There is
   no fuzzy matching and nothing here can name a tool, a path or an argument. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowMeshGrammar = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGES = { home: 'home', dashboard: 'home', flow: 'flow', tools: 'tools', wispr: 'wispr', history: 'history', runs: 'history', settings: 'settings', about: 'about', 'how it works': 'about' };
  var NAV = /^(?:go to|open|show|take me to)(?: me)?(?: the)? (home|dashboard|flow|tools|wispr|history|runs|settings|about|how it works)(?: page)?$/;
  var CANCEL = /^(?:cancel|never mind|nevermind|stop|dismiss)(?: that| it| the plan| this)?$/;
  var APPROVE = /^(?:approve|approve and run|approve it|run it|do it|go ahead)$/;
  var READ = /^(?:read(?: it| that| the plan)?(?: back| out| aloud| again)?|what(?:'s| is) the plan|say (?:it|that|the plan) again)$/;
  var CLEAR = /^(?:new plan|clear|start over|clear the box)$/;
  var ADD_TOOL = /^(?:connect|add) (?:a )?(?:tool|server)s?$/;

  function normalize(text) {
    return String(text).toLowerCase().replace(/[.,!?;:"]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(?:hey )?flowmesh /, '').replace(/ please$/, '');
  }

  /** The command a whole utterance means, or null when it is just a sentence to plan. */
  function parseCommand(text) {
    var t = normalize(text);
    var m = NAV.exec(t);
    if (m) return { type: 'go', page: PAGES[m[1]] };
    if (CANCEL.test(t)) return { type: 'cancel' };
    if (APPROVE.test(t)) return { type: 'approve' };
    if (READ.test(t)) return { type: 'read' };
    if (CLEAR.test(t)) return { type: 'clear' };
    if (ADD_TOOL.test(t)) return { type: 'go', page: 'tools' };
    return null;
  }

  return { parseCommand: parseCommand, normalize: normalize, PAGES: PAGES };
});
