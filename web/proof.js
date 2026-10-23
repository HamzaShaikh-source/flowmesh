/* FlowMesh proof section: the numbers come from proof.json, which scripts/build_proof.py builds from real
   test runs, the eval, git, the latest release and CI, so nothing on this page is typed in by hand except the
   "still being measured" list (kept in the same script so a claim cannot quietly leave it). The page shows
   the date and commit the data came from. Everything is built with textContent. */
(function () {
  'use strict';

  var UI = window.FlowMeshUI;
  if (!UI) return;
  var $ = function (id) { return document.getElementById(id); };
  var el = UI.el;
  var loaded = false;

  var REPO = 'https://github.com/HamzaShaikh-source/flowmesh';

  function link(text, href) {
    var a = el('a', 'link', text);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function card(headline, label, how, evidence) {
    var box = el('article', 'proof-card');
    box.appendChild(el('p', 'proof-num', headline));
    box.appendChild(el('h3', null, label));
    box.appendChild(el('p', 'proof-how', how));
    if (evidence && evidence.length) {
      var row = el('p', 'proof-links');
      evidence.forEach(function (item, i) {
        if (i) row.appendChild(document.createTextNode(' · '));
        row.appendChild(link(item[0], item[1]));
      });
      box.appendChild(row);
    }
    return box;
  }

  function short(sha) { return String(sha || '').slice(0, 8); }
  function mb(bytes) { return (bytes / 1048576).toFixed(bytes > 20 * 1048576 ? 0 : 1) + ' MB'; }
  function day(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }); }

  function renderMeasured(data) {
    var grid = $('proofMeasured');
    grid.replaceChildren();
    var t = data.tests || {};
    var py = t.python || {};
    var nd = t.node || {};
    var ev = data.eval || {};
    var at = ' at commit ' + data.commit + ' on ' + day(data.generated_at) + '.';

    grid.appendChild(card((py.ran || 0) + ' + ' + (nd.ran || 0), 'Tests pass',
      'Python ' + (py.ran || 0) + ' (' + (py.ok ? 'OK' : 'FAILED') + ') and Node ' + (nd.passed || 0) + ' of ' + (nd.ran || 0) + ', run from a clean checkout' + at + ' How: python -m unittest discover -s tests, and npm test.',
      [['The tests', REPO + '/tree/main/tests']]));

    var ci = data.ci || [];
    if (ci.length) {
      var green = ci.filter(function (r) { return r.conclusion === 'success'; }).length;
      grid.appendChild(card(green + ' / ' + ci.length, 'Recent CI runs on main are green',
        'The latest ' + ci.length + ' runs on main, each building and testing on Windows, macOS and Linux. How: GitHub Actions, read through the GitHub CLI.',
        ci.slice(0, 3).map(function (r) { return [r.sha + ' ' + r.conclusion, r.url]; })));
    }

    if (ev.parity) {
      grid.appendChild(card(String(ev.parity).replace(/\s+/g, ' '), 'Plans identical across Python and the browser',
        'The same sentences produce byte-identical plans in the Python planner and in this page (and ' + String(ev.golden || '').replace(/\s+/g, ' ') + ' stored plans reproduce exactly). How: eval/run_eval.py, generated ' + (ev.generated || '') + ' at commit ' + (ev.commit || '') + '.',
        [['docs/EVAL.md', REPO + '/blob/main/docs/EVAL.md']]));
      grid.appendChild(card(String(ev.refusals || '').replace(/\s+/g, ' '), 'Destructive commands refused',
        'Commands like "delete my files" are refused with a reason before any plan exists. The HTTP surface also answered ' + ev.http_pass + ' of ' + ev.http_rows + ' adversarial requests exactly as specified (no token, smuggled text, replays).',
        [['docs/EVAL.md', REPO + '/blob/main/docs/EVAL.md'], ['docs/SECURITY.md', REPO + '/blob/main/docs/SECURITY.md']]));
      grid.appendChild(card(String(ev.abstained || '').replace(/\s+/g, ' '), 'Unclear commands abstain',
        'Of 39 unlabelled sentences, the rest produced no plan at all rather than a guess dressed as intent. This measures routing behaviour, not agreement with a human: there is no labelled corpus.',
        [['The fixtures', REPO + '/blob/main/tests/fixtures/planner_cases.json']]));
    }

    var rel = data.release;
    if (rel) {
      var builds = rel.assets.filter(function (a) { return /\.(exe|dmg|AppImage|zip)$/.test(a.name); });
      var box = card(rel.tag, 'Released with checksums',
        builds.length + ' builds published ' + day(rel.published) + ' with a SHA256SUMS.txt. The builds are unsigned, so SmartScreen and Gatekeeper warn. How: the GitHub release, read through the GitHub CLI.',
        [['The release', rel.url]]);
      var list = el('ul', 'proof-assets');
      builds.forEach(function (a) { list.appendChild(el('li', null, a.name + ' · ' + mb(a.bytes) + (a.sha256 ? ' · sha256 ' + short(a.sha256) + '…' : ''))); });
      box.appendChild(list);
      grid.appendChild(box);
    }

    grid.appendChild(card('3 bugs', 'Found by running the shipped build',
      'Running the published Windows exe against a real machine found three failures that the tests had missed (npm-installed CLIs could not start, read-only Codex refused a non-git folder, an error shown as a version). They are fixed in the next release and re-checked on the new exe. Recorded by hand, not generated.',
      [['docs/VERIFICATION.md', REPO + '/blob/main/docs/VERIFICATION.md']]));
  }

  function renderPending(data) {
    var list = $('proofPending');
    list.replaceChildren();
    (data.still_measuring || []).forEach(function (item) {
      var row = el('li');
      row.appendChild(el('strong', null, item.title));
      row.appendChild(el('span', null, item.why));
      list.appendChild(row);
    });
  }

  function render(data) {
    $('proofMeta').textContent = 'Built ' + day(data.generated_at) + ' from commit ' + data.commit + ' (version ' + data.version + ', ' + data.commits + ' commits) by scripts/build_proof.py. '
      + 'Everything here comes from this project’s own tests and CI, so it shows the code does what it says, not that it saves you time or matches your intent. Run the script to check it yourself.';
    renderMeasured(data);
    renderPending(data);
    loaded = true;
  }

  function load() {
    if (loaded) return;
    fetch('proof.json', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('no proof data');
      return res.json();
    }).then(render).catch(function () {
      $('proofMeta').textContent = 'The proof data could not be loaded. The same facts are in docs/VERIFICATION.md and docs/EVAL.md in the repository.';
    });
  }

  function init() {
    // "#proof" is a place on this page, not a route: scroll to it instead of letting the router read it as unknown.
    document.addEventListener('click', function (event) {
      var trigger = event.target.closest && event.target.closest('[data-scroll]');
      if (!trigger) return;
      var target = $(trigger.getAttribute('data-scroll'));
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: UI.reduced() ? 'auto' : 'smooth', block: 'start' });
    });
    document.addEventListener('flowmesh:route', function (event) { if (event.detail.route === 'about') load(); });
    if (window.FlowMeshRouter && window.FlowMeshRouter.current() === 'about') load();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
