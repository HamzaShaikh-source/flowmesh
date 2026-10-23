/* FlowMesh motion: the Home hero's wired-plan loop and a gentle stagger on stat cards.

   Everything here is decoration over content that is already complete without it. Under
   prefers-reduced-motion nothing animates: the hero shows its final frame, and no timer or
   observer is started. The loop also pauses whenever the hero is off screen, on another page,
   or the tab is hidden. */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };

  var SENTENCE = 'Message Rohan the revised quote, then open a pull request for the pricing fix.';
  var PHASES = [
    ['plan', 'reading the plan'],
    ['approve', 'approved once'],
    ['run', 'running'],
    ['done', 'receipts in'],
  ];

  function hero() {
    var root = $('specimen');
    if (!root) return;
    var say = $('specimenSay');
    var phase = $('specimenPhase');
    var stamp = $('specimenStamp');
    var rows = Array.prototype.slice.call(root.querySelectorAll('#specimenActions li'));
    var alive = false;
    var timers = [];

    function later(ms, fn) { timers.push(setTimeout(fn, ms)); }
    function clear() { timers.forEach(clearTimeout); timers = []; }
    function setPhase(index) {
      root.setAttribute('data-phase', PHASES[index][0]);
      phase.textContent = PHASES[index][1];
    }
    function showFinal() {
      clear();
      say.textContent = SENTENCE;
      root.setAttribute('data-phase', 'done');
      phase.textContent = 'receipts in';
      rows.forEach(function (row) { row.setAttribute('data-state', 'done'); });
    }

    if (reduced) { showFinal(); return; }

    function cycle() {
      if (!alive) return;
      rows.forEach(function (row) { row.setAttribute('data-state', 'idle'); });
      say.textContent = '';
      stamp.textContent = 'ONE USE · 05:00';
      setPhase(0);
      var i = 0;
      (function type() {
        if (!alive) return;
        say.textContent = SENTENCE.slice(0, ++i);
        if (i < SENTENCE.length) { later(24 + Math.random() * 28, type); return; }
        later(500, function () {
          rows.forEach(function (row, n) { later(n * 260, function () { row.setAttribute('data-state', 'planned'); }); });
          later(rows.length * 260 + 700, function () {
            setPhase(1);
            stamp.textContent = 'APPROVED · USED';
            later(700, function () {
              setPhase(2);
              rows.forEach(function (row, n) {
                later(n * 650, function () { row.setAttribute('data-state', 'running'); });
                later(n * 650 + 520, function () { row.setAttribute('data-state', 'done'); });
              });
              later(rows.length * 650 + 400, function () {
                setPhase(3);
                later(4200, cycle);
              });
            });
          });
        });
      })();
    }

    function start() { if (alive) return; alive = true; cycle(); }
    function stop() { alive = false; clear(); }

    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          // Off screen also covers "on another page": a hidden page has no box.
          if (entry.isIntersecting && !document.hidden) start(); else stop();
        });
      }, { threshold: 0.25 }).observe(root);
    } else {
      start();
    }
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
  }

  function stagger() {
    if (reduced || !('IntersectionObserver' in window)) return;
    var cards = Array.prototype.slice.call(document.querySelectorAll('.stat, .build-grid article, .trust-row > div'));
    cards.forEach(function (card, index) { card.classList.add('will-reveal'); card.style.transitionDelay = (index % 4) * 70 + 'ms'; });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.1 });
    cards.forEach(function (card) { observer.observe(card); });
  }

  /* Page titles rise word by word out of a mask, the way the best-crafted sites reveal a headline.
     Words are wrapped once (text nodes only, so <em> survives) and the animation replays on each
     route. Nothing is wrapped under reduced motion, and the text is never hidden without script. */
  function splitTitle(title) {
    if (title.getAttribute('data-split')) return;
    title.setAttribute('data-split', '1');
    var index = 0;
    (function walk(node) {
      Array.prototype.slice.call(node.childNodes).forEach(function (child) {
        if (child.nodeType === 3) {
          var parts = child.nodeValue.split(/(\s+)/);
          var frag = document.createDocumentFragment();
          parts.forEach(function (part) {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); return; }
            var mask = document.createElement('span');
            mask.className = 'split-word';
            var inner = document.createElement('span');
            inner.textContent = part;
            inner.style.setProperty('--i', String(index));
            index += 1;
            mask.appendChild(inner);
            frag.appendChild(mask);
          });
          node.replaceChild(frag, child);
        } else if (child.nodeType === 1) {
          walk(child);
        }
      });
    })(title);
  }

  function revealTitles(route) {
    if (reduced) return;
    var page = document.querySelector('[data-page="' + route + '"]');
    var title = page && page.querySelector('.page-head h1');
    if (!title) return;
    splitTitle(title);
    title.classList.remove('split-on');
    void title.offsetWidth;
    title.classList.add('split-on');
  }

  function init() {
    hero();
    stagger();
    document.addEventListener('flowmesh:route', function (event) { revealTitles(event.detail.route); });
    if (window.FlowMeshRouter && window.FlowMeshRouter.current()) revealTitles(window.FlowMeshRouter.current());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
