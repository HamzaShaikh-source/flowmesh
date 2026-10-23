'use strict';
/** The Guide page: it exists, it is reachable by voice, and every phrase it offers to try really does something. */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const grammar = require('../../web/voice-grammar.js');
const pilot = require('../../web/pilot-core.js');

const WEB = path.join(__dirname, '..', '..', 'web');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const LABELS = ['Go to Home', 'Add an MCP server', 'Connect my Wispr account', 'Use my last Wispr dictation', 'Focus the command box'];

test('the guide page, its nav link, its script and the dock help button exist', () => {
  assert.match(html, /data-page="guide"/);
  assert.match(html, /data-route="guide"/);
  assert.match(html, /<script src="guide\.js"/);
  assert.match(html, /id="helpBtn"/);
  assert.match(html, /id="guideCommands"/);
  assert.match(html, /href="#\/guide"/);
  assert.match(fs.readFileSync(path.join(WEB, 'pages.js'), 'utf8'), /guide: 'Guide'/);
});

test('the guide is reachable by voice', () => {
  for (const said of ['go to guide', 'open the guide', 'show me the voice guide', 'take me to the guide page']) {
    assert.deepEqual(grammar.parseCommand(said), { type: 'go', page: 'guide' }, said);
  }
  assert.equal(grammar.parseCommand('open the guide to the building and send it to Rohan'), null);
  assert.deepEqual(grammar.parseCommand('open the proof page'), { type: 'go', page: 'about' });
  assert.deepEqual(grammar.parseCommand('take me to proof'), { type: 'go', page: 'about' });
});

test('every phrase the guide offers to try is understood by the grammar or the pilot', () => {
  const groups = [...grammar.HELP_LIST, ...pilot.HELP];
  assert.ok(groups.length >= 8);
  let tried = 0;
  for (const [, examples] of groups) {
    for (const example of examples) {
      if (/\(/.test(example)) continue; // a note, shown as plain text
      if (/^open the add an mcp|^connect my wispr/.test(example)) continue; // palette phrases depend on the labels offered
      const command = grammar.parseCommand(example, { builderOpen: true }) || pilot.parse(example, { labels: LABELS });
      assert.ok(command, `the guide offers "${example}", which does nothing`);
      tried += 1;
    }
  }
  assert.ok(tried >= 30, `only ${tried} phrases were checked`);
});

test('nothing the guide offers can approve, confirm or delete', () => {
  for (const [, examples] of [...grammar.HELP_LIST, ...pilot.HELP]) {
    for (const example of examples) {
      if (/\(/.test(example)) continue;
      const command = grammar.parseCommand(example, { builderOpen: true });
      assert.ok(!command || command.type !== 'approve', `"${example}" would approve`);
      assert.doesNotMatch(example, /\b(?:delete|remove|confirm|danger)\b/i);
    }
  }
});
