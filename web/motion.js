/* FlowMesh motion: the hero's wired-plan loop, scroll reveals, panel spotlight.

   Everything here is decoration over content that is already complete without it.
   Under prefers-reduced-motion nothing animates: the hero shows its final frame, reveals
   are immediate, and no timer or rAF loop is started. Loops also pause whenever the
   element is off screen or the tab is hidden. */
(function () {
  'use strict';

  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------------------------------------------------------- hero loop */

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
        entries.forEach(function (entry) { if (entry.isIntersecting && !document.hidden) start(); else stop(); });
      }, { threshold: 0.25 }).observe(root);
    } else {
      start();
    }
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
  }

  /* ---------------------------------------------------------------- scroll reveal */

  function reveal() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-reveal], .capabilities, .build, .console .section-head, .tools .section-head'));
    if (reduced || !('IntersectionObserver' in window)) {
      nodes.forEach(function (n) { n.classList.add('in'); });
      return;
    }
    nodes.forEach(function (n) { n.classList.add('will-reveal'); });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -6% 0px' });
    nodes.forEach(function (n) { observer.observe(n); });
  }

  /* ---------------------------------------------------------------- spotlight + topbar */

  function spotlight() {
    if (reduced) return;
    document.addEventListener('pointermove', function (event) {
      var panel = event.target.closest && event.target.closest('.panel, .specimen, .server-card, .preset');
      if (!panel) return;
      var box = panel.getBoundingClientRect();
      panel.style.setProperty('--mx', (event.clientX - box.left) + 'px');
      panel.style.setProperty('--my', (event.clientY - box.top) + 'px');
    }, { passive: true });
  }

  function topbar() {
    var bar = document.querySelector('.topbar');
    if (!bar) return;
    var last = false;
    function update() {
      var scrolled = window.scrollY > 8;
      if (scrolled !== last) { last = scrolled; bar.classList.toggle('scrolled', scrolled); }
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  function init() {
    hero();
    reveal();
    spotlight();
    topbar();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
