'use strict';
/** The page pilot's language: whole utterances only, view controls plus strictly matched palette actions. */
const assert = require('node:assert');
const { test } = require('node:test');

const pilot = require('../../web/pilot-core.js');

const LABELS = [
  'Focus the command box', 'Create a plan from the command box', 'Approve the plan on screen', 'Cancel the plan on screen',
  'Go to Home', 'Go to Tools', 'Add an MCP server', 'Use my last Wispr dictation', 'Connect my Wispr account',
  'Open connections and model settings', 'Try the example: Meeting reset', 'Try the example: Deep focus', 'Listen with the microphone',
  'Read plans and results aloud', 'Stop reading aloud', 'Delete all notes', 'Disconnect my Wispr account', 'Open the Code page',
];

test('zoom, volume, screenshot and movement commands are recognised', () => {
  const cases = {
    'Zoom in.': { type: 'zoom', mode: 'in' }, 'make it bigger': { type: 'zoom', mode: 'in' }, 'bigger': { type: 'zoom', mode: 'in' },
    'zoom out': { type: 'zoom', mode: 'out' }, 'make the page smaller please': { type: 'zoom', mode: 'out' },
    'reset zoom': { type: 'zoom', mode: 'reset' }, 'normal size': { type: 'zoom', mode: 'reset' },
    'zoom to 150 percent': { type: 'zoom', mode: 'set', value: 150 }, 'Set zoom to 125%': { type: 'zoom', mode: 'set', value: 125 },
    'zoom to 900': { type: 'zoom', mode: 'set', value: 300 }, 'zoom 20 percent': { type: 'zoom', mode: 'set', value: 50 },
    'volume up': { type: 'volume', op: 'up' }, 'turn it down': { type: 'volume', op: 'down' }, 'louder': { type: 'volume', op: 'up' },
    'mute': { type: 'volume', op: 'mute' }, 'be quiet': { type: 'volume', op: 'mute' }, 'unmute the sound': { type: 'volume', op: 'unmute' },
    'set volume to 40 percent': { type: 'volume', op: 'set', value: 40 }, 'max volume': { type: 'volume', op: 'set', value: 100 },
    'set the volume to 500': { type: 'volume', op: 'set', value: 100 },
    'Take a screenshot.': { type: 'screenshot' }, 'screenshot': { type: 'screenshot' }, 'grab a screenshot of this page': { type: 'screenshot' },
    'go back': { type: 'history', dir: 'back' }, 'go forward': { type: 'history', dir: 'forward' }, 'reload the page': { type: 'reload' },
    'full screen': { type: 'fullscreen', on: true }, 'exit full screen': { type: 'fullscreen', on: false },
    'scroll to the receipts section': { type: 'section', name: 'receipts' }, 'jump to the review panel': { type: 'section', name: 'review' },
    'Hey FlowMesh, zoom in please': { type: 'zoom', mode: 'in' },
  };
  for (const [said, expected] of Object.entries(cases)) assert.deepEqual(pilot.parse(said, { labels: LABELS }), expected, said);
});

test('a command inside a longer sentence is just a sentence', () => {
  for (const said of [
    'zoom in on the pricing table and send it to Rohan', 'bigger is not always better', 'mute the notifications on my phone',
    'take a screenshot of the quote and email it', 'go back to the budget and fix row three', 'reload the page after you deploy it',
    'volume up the speakers in the conference room', 'make it bigger and bolder in the deck', 'full screen the video then play it',
    'set the volume to 40 percent on the lamp', 'screenshot the error and attach it to the ticket',
  ]) assert.equal(pilot.parse(said, { labels: LABELS }), null, said);
});

test('palette actions need every content word to appear in exactly one label', () => {
  const ok = {
    'use my last wispr dictation': 'Use my last Wispr dictation', 'use my wispr': 'Use my last Wispr dictation', 'connect my wispr account': 'Connect my Wispr account',
    'add an mcp server': 'Add an MCP server', 'open the code page': 'Open the Code page', 'try the deep focus example': 'Try the example: Deep focus',
    'focus the command box': 'Focus the command box', 'go to tools': 'Go to Tools', 'open connections and model settings': 'Open connections and model settings',
    'listen with the microphone': 'Listen with the microphone', 'stop reading aloud': 'Stop reading aloud',
  };
  for (const [said, label] of Object.entries(ok)) assert.equal(pilot.matchPalette(said, LABELS), label, said);
  for (const said of [
    'add a note to the board', 'add an mcp server and delete everything', 'use my last invoice', 'open the pricing page', 'start a timer',
    'try the example', 'connect', 'open', 'go to', 'read it back to me tomorrow', 'show me the wispr',
  ]) assert.equal(pilot.matchPalette(said, LABELS), '', said);
});

test('approval, confirmation, deletion and disconnection can never be reached through the palette', () => {
  for (const said of [
    'approve the plan on screen', 'approve the plan', 'cancel the plan on screen', 'delete all notes', 'disconnect my wispr account',
    'confirm danger', 'remove the server', 'go ahead', 'run it',
  ]) {
    const command = pilot.parse(said, { labels: LABELS });
    assert.ok(command === null || command.type !== 'palette', `${said}: ${JSON.stringify(command)}`);
  }
  assert.equal(pilot.matchPalette('delete all notes', ['Delete all notes']), '');
  assert.equal(pilot.matchPalette('approve the plan on screen', ['Approve the plan on screen']), '');
  for (const label of ['Approve and run', 'Confirm the danger gate', 'Remove a server', 'Sign out', 'Clear all data', 'Cancel the plan on screen']) {
    assert.match(label, pilot.BLOCKED, label);
  }
});

test('an ambiguous phrase matches nothing rather than guessing', () => {
  assert.equal(pilot.matchPalette('open the page', ['Open the Code page', 'Open the Tools page']), '');
  assert.equal(pilot.matchPalette('open the code page', ['Open the Code page', 'Open the Code page']), '', 'two identical labels are ambiguous');
  assert.equal(pilot.matchPalette('open the code page', ['Open the Code page', 'Open the Code page and the History page']), 'Open the Code page', 'the tightest label wins when it is unique');
});

test('sections match by words and only when exactly one heading fits', () => {
  const headings = ['Say it', 'Review the plan', 'Receipts', 'Run record', 'Run history'];
  assert.equal(pilot.matchSection('receipts', headings), 2);
  assert.equal(pilot.matchSection('review', headings), 1);
  assert.equal(pilot.matchSection('run', headings), -1, 'run is in two headings, so it is ambiguous');
  assert.equal(pilot.matchSection('pricing', headings), -1);
  assert.equal(pilot.matchSection('', headings), -1);
});

test('every command has a fixed shape and nothing carries a path, program or setting name', () => {
  const shapes = {
    zoom: ['mode', 'type', 'value'], volume: ['op', 'type', 'value'], screenshot: ['type'], fullscreen: ['on', 'type'],
    history: ['dir', 'type'], reload: ['type'], section: ['name', 'type'], palette: ['label', 'type'],
  };
  for (const said of ['zoom in', 'zoom to 150', 'volume up', 'set volume to 3', 'screenshot', 'full screen', 'go back', 'reload', 'scroll to the receipts section', 'go to tools']) {
    const command = pilot.parse(said, { labels: LABELS });
    assert.ok(command, said);
    for (const key of Object.keys(command)) assert.ok(shapes[command.type].includes(key), `${said}: ${key}`);
  }
  for (const said of ['open C:\\Windows\\System32\\cmd.exe', 'zoom to ../../x', 'run rm -rf', 'go to ../../etc/passwd', 'take a screenshot and upload it to http://evil.example']) {
    assert.equal(pilot.parse(said, { labels: LABELS }), null, said);
  }
});

test('the help list only names things that work, and odd input never throws', () => {
  for (const [, examples] of pilot.HELP) {
    for (const example of examples) {
      if (/^open the add an mcp|^connect my wispr/.test(example)) continue; // palette examples depend on the labels offered
      assert.ok(pilot.parse(example, { labels: LABELS }), `help lists "${example}", which does nothing`);
    }
  }
  for (const said of ['', null, undefined, 7, {}, [], '\u0000', 'x'.repeat(5000)]) assert.doesNotThrow(() => pilot.parse(said, { labels: LABELS }));
  assert.doesNotThrow(() => pilot.parse('zoom in'));
  assert.doesNotThrow(() => pilot.matchPalette('open the code page', null));
});
