/* FlowMesh pages: a tiny hash router, the Home dashboard and the History page.

   Seven real pages share one document so a plan in progress, the voice dock and the session
   survive navigation, and the hosted static site needs no server routing. Routes are
   `#/`, `#/flow`, `#/tools`, `#/code`, `#/guide`, `#/wispr`, `#/history`, `#/settings`, `#/about`. The shell's global
   hotkeys use the bare hashes `#pull` and `#approve`, which are actions, not routes, and are
   ignored here. Everything the runtime sends is untrusted text and is set with textContent. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  if (!UI) return;
  var $ = function (id) { return document.getElementById(id); };
  var el = UI.el;

  var ROUTES = { home: 'Home', flow: 'Flow', tools: 'Tools', code: 'Code', guide: 'Guide', wispr: 'Wispr', history: 'History', settings: 'Settings', about: 'How it works' };
  var current = '';
  var pendingOpen = null;

  /* ---------------------------------------------------------------- router */

  function routeFromHash() {
    var hash = window.location.hash;
    if (hash === '#pull' || hash === '#approve') return null;
    var name = hash.replace(/^#\/?/, '').split('?')[0];
    return Object.prototype.hasOwnProperty.call(ROUTES, name) ? name : 'home';
  }

  function show(route) {
    if (!route || route === current) return;
    var animate = document.startViewTransition && current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (animate) { document.startViewTransition(function () { swap(route); }); return; }
    swap(route);
  }

  function swap(route) {
    current = route;
    Array.prototype.forEach.call(document.querySelectorAll('[data-page]'), function (page) {
      var on = page.getAttribute('data-page') === route;
      page.hidden = !on;
      if (on) {
        // Replay the page-in animation: clear it, force a reflow, restore it.
        page.style.animation = 'none';
        void page.offsetWidth;
        page.style.animation = '';
      }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-route]'), function (link) {
      if (link.getAttribute('data-route') === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.title = (route === 'home' ? '' : ROUTES[route] + ' · ') + 'FlowMesh';
    window.scrollTo(0, 0);
    $('main').focus({ preventScroll: true });
    onEnter(route);
    document.dispatchEvent(new CustomEvent('flowmesh:route', { detail: { route: route } }));
  }

  function go(route) {
    if (!Object.prototype.hasOwnProperty.call(ROUTES, route)) return;
    var target = route === 'home' ? '#/' : '#/' + route;
    if (window.location.hash === target) show(route);
    else window.location.hash = target;
  }

  function onEnter(route) {
    if (route === 'history') loadRuns();
    if (route === 'home') refreshHome();
    if (route === 'code' && window.FlowMeshCode) window.FlowMeshCode.enter();
  }

  window.FlowMeshRouter = { go: go, current: function () { return current; }, routes: ROUTES };

  /* ---------------------------------------------------------------- history */

  var runs = [];
  var openName = '';
  var openText = '';

  function loadRuns() {
    if (UI.mode() === 'desktop') {
      return UI.get('/api/runs').then(function (data) {
        runs = data.runs || [];
        renderRuns();
        refreshHome();
        if (pendingOpen) { var name = pendingOpen; pendingOpen = null; openRun(runs.filter(function (r) { return r.name === name; })[0]); }
      }).catch(function () { runs = []; renderRuns(); });
    }
    runs = UI.sessionRuns().slice();
    renderRuns();
    refreshHome();
    return Promise.resolve();
  }

  function renderRuns() {
    var list = $('runsList');
    list.replaceChildren();
    $('runsEmpty').hidden = runs.length > 0;
    runs.forEach(function (run) {
      var item = el('li');
      var button = el('button', 'run');
      button.type = 'button';
      if (run.name === openName) button.setAttribute('aria-current', 'true');
      var text = el('span');
      text.appendChild(el('span', 't', run.title || run.name));
      text.appendChild(document.createElement('br'));
      text.appendChild(el('span', 'm', run.name));
      button.appendChild(text);
      button.appendChild(el('span', 'm', when(run.modified) + (run.bytes ? ' · ' + run.bytes + ' B' : '')));
      button.addEventListener('click', function () { openRun(run); });
      item.appendChild(button);
      list.appendChild(item);
    });
    $('historyLede').textContent = UI.mode() === 'desktop'
      ? 'Each approved plan writes a Markdown record with the exact words, the plan and every receipt, with a SHA-256. Open one to read it.'
      : 'This hosted page cannot save to disk, so these are the records from this session. They live in memory until you close the tab; use Download to keep one.';
  }

  function when(iso) {
    var date = new Date(iso);
    return isNaN(date) ? '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function openRun(run) {
    if (!run) return;
    openName = run.name;
    renderRuns();
    if (UI.mode() === 'desktop') {
      UI.get('/api/runs/' + encodeURIComponent(run.name)).then(function (record) {
        showRecord(record.name, record.text + (record.truncated ? '\n\n[truncated]' : ''));
      }).catch(function (err) { UI.toast(UI.humanError(err.message)); });
    } else {
      showRecord(run.name, run.text);
    }
  }

  function showRecord(name, text) {
    openName = name;
    openText = text;
    $('recordName').textContent = name;
    $('recordEmpty').hidden = true;
    $('recordView').hidden = false;
    $('recordView').textContent = text;
    $('recordActions').hidden = false;
  }

  function bindHistory() {
    $('runsRefresh').addEventListener('click', loadRuns);
    $('recordCopy').addEventListener('click', function () {
      UI.copy(openText).then(function () { UI.toast('Record copied as Markdown.'); }).catch(function () { UI.toast('Copy failed.'); });
    });
    $('recordDownload').addEventListener('click', function () { UI.download(openName || 'flowmesh-record.md', openText); });
  }

  /* ---------------------------------------------------------------- home */

  function setStat(id, value, sub, tone) {
    $('stat' + id + 'V').textContent = value;
    $('stat' + id + 'S').textContent = sub;
    var card = $('stat' + id);
    if (tone) card.setAttribute('data-tone', tone); else card.removeAttribute('data-tone');
  }

  function greeting() {
    var hour = new Date().getHours();
    $('greeting').textContent = hour < 5 ? 'Still up?' : hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  }

  function refreshHome() {
    greeting();
    var count = runs.length;
    setStat('Runs', String(count), count ? 'latest: ' + (runs[0].title || runs[0].name) : 'none yet', count ? 'good' : '');
    var list = $('homeRecent');
    list.replaceChildren();
    $('homeRecentEmpty').hidden = count > 0;
    runs.slice(0, 4).forEach(function (run) {
      var item = el('li');
      var link = el('a', null, run.title || run.name);
      link.href = '#/history';
      link.addEventListener('click', function () { pendingOpen = run.name; if (UI.mode() !== 'desktop') openName = run.name; });
      item.appendChild(link);
      item.appendChild(el('small', null, when(run.modified)));
      list.appendChild(item);
    });
  }

  function onMode(event) {
    var desktop = event.detail.mode === 'desktop';
    var caps = UI.caps() || {};
    if (!desktop) {
      setStat('Wispr', 'Desktop only', 'type or dictate into the box', '');
      setStat('Tools', '5', 'demo tools, run in this page', 'good');
      setStat('Model', 'Rules', 'local, deterministic', '');
    } else {
      setStat('Model', caps.model === 'ready' ? 'Model' : 'Rules', caps.model === 'ready' ? 'a model proposes, you approve' : 'local, deterministic', caps.model === 'ready' ? 'good' : '');
    }
    loadRuns();
  }

  function onWispr(event) {
    var info = event.detail || {};
    var stats = info.stats || {};
    var labels = { connected: 'Connected', not_found: 'Not found', locked: 'Busy', empty: 'No history', unexpected_schema: 'Unreadable' };
    setStat('Wispr', labels[info.state] || 'Unknown',
      info.state === 'connected' ? (stats.dictations || 0) + ' dictations · ' + (stats.words || 0) + ' words' : (info.detail || '').slice(0, 60),
      info.state === 'connected' ? 'good' : '');
  }

  function onTools(event) {
    var detail = event.detail || {};
    var tools = detail.tools || 0;
    var servers = detail.servers || 0;
    if (UI.mode() === 'desktop') {
      setStat('Tools', String(tools), servers ? servers + ' server' + (servers === 1 ? '' : 's') + ' connected' : 'none connected', tools ? 'good' : '');
    }
    var badge = $('navToolCount');
    badge.hidden = !tools;
    badge.textContent = String(tools);
  }

  /* ---------------------------------------------------------------- boot */

  function init() {
    bindHistory();
    document.addEventListener('flowmesh:mode', onMode);
    document.addEventListener('flowmesh:wispr', onWispr);
    document.addEventListener('flowmesh:tools', onTools);
    document.addEventListener('flowmesh:run', function () { setTimeout(loadRuns, 250); });
    window.addEventListener('hashchange', function () { show(routeFromHash()); });
    // Old deep links (#console, #capabilities, ...) and an empty hash land on Home.
    var first = routeFromHash() || 'home';
    show(first);
    if (window.location.hash === '') history.replaceState(null, '', window.location.pathname + window.location.search + '#/');
    if (UI.mode() === 'browser') onMode({ detail: { mode: 'browser', status: null } });
    refreshHome();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
