'use strict';
/**
 * Cross-language planner parity. `planner_golden.json` is written by
 * scripts/export_planner_golden.py from planner.py; this test proves web/core.js
 * still answers the same way the Python runtime does, so the Electron app and
 * the packaged app cannot drift apart on routing, actions, or disclosures.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const core = require('../../web/core.js');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'planner_golden.json'), 'utf8'));

test('every golden case resolves to the same route and plan', () => {
  assert.ok(golden.cases.length >= 10, 'golden file looks truncated');
  for (const entry of golden.cases) {
    const { command, plan } = entry;
    const usable = core.commandIsUsable(command) && !core.isForbidden(command.trim());
    const route = usable ? core.localRoute(command) : null;
    if (plan === null) {
      assert.ok(route === null || !(route in core.WORKFLOWS), `expected no plan for: ${command}`);
      continue;
    }
    assert.equal(route, plan.route, `route for: ${command}`);
    assert.deepEqual(core.planPayload(route, command, 'local', null), plan, `payload for: ${command}`);
  }
});

test('forbidden intents never produce a route in either runtime', () => {
  for (const command of ['Delete the entire repo', 'buy the domain now', 'unlock the front door']) {
    assert.equal(core.commandIsUsable(command) && !core.isForbidden(command), false, command);
  }
});

test('second intents are disclosed rather than dropped', () => {
  const also = core.otherIntents('capture', 'Capture the release link. Start a 20 minute research sprint.');
  assert.deepEqual(also, ['Research sprint']);
});
