/* Prints the JS planner's output for every fixture, for tests/test_parity.py. */
const fs = require('fs');
const path = require('path');
const core = require(path.join(__dirname, '..', 'web', 'core.js'));

const file = process.argv[2];
const { cases } = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = cases.map((command) => {
  const route = core.localRoute(command);
  if (!route) return { route: null };
  return core.planPayload(route, command);
});
process.stdout.write(JSON.stringify(out));
