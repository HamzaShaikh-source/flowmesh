/* The page pilot's language, as a pure module so it can be tested without a browser.

   The pilot is a small rule-based agent that lets you drive the whole page by voice: zoom, volume,
   screenshots, scrolling to a section, back and forward, and any action the command palette lists.
   It uses no model. Like the voice grammar it only acts on a *whole utterance*, and it can only do
   things a person could do with the page's own controls:

   * view controls (zoom, voice volume, full screen, screenshot, scroll, history);
   * palette actions, matched strictly: every content word you said must appear in the action's
     label, so "add a note to the board" can never fire "Add an MCP server";
   * never an approval, a confirmation, a deletion or a disconnection. Those labels are refused
     here even if the palette lists them. Approval by voice stays a checkbox you set yourself.

   It returns a small object ({ type, ... }) or null. null means "this is just a sentence": the
   caller plans it as a normal command. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FlowMeshPilotCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ZOOM_MIN = 50;
  var ZOOM_MAX = 300;
  var ZOOM_STEP = 10;

  var ZOOM_IN = /^(?:zoom in|make (?:it|the page|everything|the text|the text and the page) (?:bigger|larger)|bigger|larger|increase (?:the )?(?:zoom|size|page size)|magnify)$/;
  var ZOOM_OUT = /^(?:zoom out|make (?:it|the page|everything|the text) (?:smaller|tinier)|smaller|decrease (?:the )?(?:zoom|size|page size)|shrink(?: the page)?)$/;
  var ZOOM_RESET = /^(?:reset(?: the)? zoom|zoom reset|normal size|actual size|default zoom|zoom (?:to )?(?:default|normal))$/;
  var ZOOM_SET = /^(?:set (?:the )?zoom (?:to|at)|zoom (?:to|at)|zoom) (\d{2,3})(?: percent| %|%)?$/;

  var VOL_UP = /^(?:volume up|turn (?:the )?volume up|turn it up|louder|increase (?:the )?volume|raise (?:the )?volume|make it louder)$/;
  var VOL_DOWN = /^(?:volume down|turn (?:the )?volume down|turn it down|quieter|softer|lower (?:the )?volume|decrease (?:the )?volume|make it quieter)$/;
  var VOL_MUTE = /^(?:mute|mute (?:the )?(?:volume|sound|voice)|silence|be quiet|stop talking)$/;
  var VOL_UNMUTE = /^(?:unmute|unmute (?:the )?(?:volume|sound|voice))$/;
  var VOL_SET = /^(?:set (?:the )?volume (?:to|at)|volume (?:to|at)?) ?(\d{1,3})(?: percent| %|%)?$/;
  var VOL_MAX = /^(?:max(?:imum)? volume|full volume|volume (?:max|full))$/;

  var SHOT = /^(?:take|grab|capture|save|make)(?: me)?(?: a| the)? screenshot(?: of (?:this|the) (?:page|screen|tab|window))?$|^screenshot(?: (?:this|the) (?:page|screen|tab))?$/;
  var BACK = /^(?:go back|back|previous page)$/;
  var FORWARD = /^(?:go forward|forward|next page)$/;
  var RELOAD = /^(?:reload|refresh)(?: the)?(?: page)?$/;
  var FULL = /^(?:full ?screen|go full ?screen|enter full ?screen|make it full ?screen)$/;
  var EXIT_FULL = /^(?:exit full ?screen|leave full ?screen|close full ?screen|stop full ?screen)$/;
  var SECTION = /^(?:scroll to|jump to|go to|show me|take me to)(?: the)? (.{2,40}?)(?: section| panel| card| area)$/;

  /** Words that carry no meaning when matching a spoken phrase to a palette label. */
  var STOP = { the: 1, a: 1, an: 1, my: 1, me: 1, please: 1, to: 1, of: 1, for: 1, up: 0, it: 1, this: 1, that: 1, now: 1, can: 1, you: 1, could: 1 };
  var VERBS = /^(?:open|go|show|use|try|add|connect|start|stop|turn|toggle|read|copy|download|create|write|focus|listen|pull|type|plan|set)\b/;
  /** A palette action that must never be reachable through fuzzy matching, whatever the palette says. */
  var BLOCKED = /approve|confirm|danger|delete|remove|forget|disconnect|sign out|log out|clear (?:all|everything|data)|cancel the plan|run it|do it/i;

  var HELP = [
    ['Zoom', ['zoom in', 'zoom out', 'zoom to 150 percent', 'reset zoom']],
    ['Volume', ['volume up', 'volume down', 'mute', 'set volume to 40 percent']],
    ['Capture', ['take a screenshot']],
    ['Move around', ['scroll to the tools section', 'go back', 'full screen', 'reload the page']],
    ['Anything in the palette', ['open the add an mcp server dialog', 'connect my wispr account']],
  ];

  function normalize(text) {
    return String(text).toLowerCase().replace(/[.,!?;:"]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/^(?:hey )?flowmesh /, '').replace(/ please$/, '');
  }

  function tokens(text) {
    return normalize(text).replace(/[^a-z0-9% ]+/g, ' ').split(' ').filter(function (w) { return w && !STOP[w]; });
  }

  function clamp(n, low, high) { return Math.max(low, Math.min(high, n)); }

  /** The palette label a whole utterance asks for, or '' when it does not clearly ask for exactly one. */
  function matchPalette(text, labels) {
    var t = normalize(text);
    if (!VERBS.test(t)) return '';
    var spoken = tokens(t);
    if (spoken.length < 2) return '';
    var best = '';
    var bestSize = Infinity;
    var ties = 0;
    (labels || []).forEach(function (label) {
      if (typeof label !== 'string' || BLOCKED.test(label)) return;
      var have = {};
      tokens(label).forEach(function (w) { have[w] = true; });
      // Every content word the person said must be in the label: a longer sentence never matches.
      if (!spoken.every(function (w) { return have[w]; })) return;
      var size = Object.keys(have).length;
      if (size < bestSize) { best = label; bestSize = size; ties = 1; } else if (size === bestSize) ties += 1;
    });
    return ties === 1 ? best : '';
  }

  /** The pilot command a whole utterance means, or null. `context.labels` are the palette labels on offer. */
  function parse(text, context) {
    var t = normalize(text);
    var ctx = context || {};
    var m;
    if (!t) return null;
    if (ZOOM_RESET.test(t)) return { type: 'zoom', mode: 'reset' };
    if (ZOOM_IN.test(t)) return { type: 'zoom', mode: 'in' };
    if (ZOOM_OUT.test(t)) return { type: 'zoom', mode: 'out' };
    if ((m = ZOOM_SET.exec(t))) return { type: 'zoom', mode: 'set', value: clamp(Number(m[1]), ZOOM_MIN, ZOOM_MAX) };
    if (VOL_UNMUTE.test(t)) return { type: 'volume', op: 'unmute' };
    if (VOL_MUTE.test(t)) return { type: 'volume', op: 'mute' };
    if (VOL_UP.test(t)) return { type: 'volume', op: 'up' };
    if (VOL_DOWN.test(t)) return { type: 'volume', op: 'down' };
    if (VOL_MAX.test(t)) return { type: 'volume', op: 'set', value: 100 };
    if ((m = VOL_SET.exec(t))) return { type: 'volume', op: 'set', value: clamp(Number(m[1]), 0, 100) };
    if (SHOT.test(t)) return { type: 'screenshot' };
    if (EXIT_FULL.test(t)) return { type: 'fullscreen', on: false };
    if (FULL.test(t)) return { type: 'fullscreen', on: true };
    if (BACK.test(t)) return { type: 'history', dir: 'back' };
    if (FORWARD.test(t)) return { type: 'history', dir: 'forward' };
    if (RELOAD.test(t)) return { type: 'reload' };
    if ((m = SECTION.exec(t))) return { type: 'section', name: m[1] };
    var label = matchPalette(t, ctx.labels);
    if (label) return { type: 'palette', label: label };
    return null;
  }

  /** The section heading a spoken name asks for: all its words appear in exactly one heading. */
  function matchSection(name, headings) {
    var spoken = tokens(name);
    if (!spoken.length) return -1;
    var found = -1;
    var count = 0;
    (headings || []).forEach(function (heading, index) {
      var have = {};
      tokens(heading).forEach(function (w) { have[w] = true; });
      if (spoken.every(function (w) { return have[w]; })) { found = index; count += 1; }
    });
    return count === 1 ? found : -1;
  }

  return {
    parse: parse, matchPalette: matchPalette, matchSection: matchSection, normalize: normalize, HELP: HELP, BLOCKED: BLOCKED,
    ZOOM_MIN: ZOOM_MIN, ZOOM_MAX: ZOOM_MAX, ZOOM_STEP: ZOOM_STEP,
  };
});
