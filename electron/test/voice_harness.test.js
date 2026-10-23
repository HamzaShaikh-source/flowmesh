'use strict';
/** The extended voice grammar: more of the site by voice, still only for whole, fixed utterances. */
const assert = require('node:assert');
const { test } = require('node:test');

const { parseCommand, HELP_LIST, EXAMPLES, TOOLS, PAGES } = require('../../web/voice-grammar.js');

test('the new commands are recognised as whole utterances', () => {
  const cases = {
    'Create the plan.': { type: 'plan' }, 'make a plan': { type: 'plan' }, 'plan it': { type: 'plan' },
    'focus the box': { type: 'focus' }, 'Select the command field': { type: 'focus' }, 'let me type': { type: 'focus' },
    'Try the research sprint example': { type: 'example', name: 'research' }, 'use the meeting example': { type: 'example', name: 'meeting' },
    'run the deep focus example.': { type: 'example', name: 'focus' }, 'load the quick capture example': { type: 'example', name: 'capture' },
    'open the latest run': { type: 'latest' }, 'show me the last record': { type: 'latest' },
    'copy the record': { type: 'copy' }, 'download this run record': { type: 'download' }, 'Download the markdown': { type: 'download' },
    'plan the next step': { type: 'next' },
    'open the palette': { type: 'palette' }, 'show the command palette': { type: 'palette' },
    'scroll down': { type: 'scroll', to: 'down' }, 'scroll up': { type: 'scroll', to: 'up' },
    'go to the top': { type: 'scroll', to: 'top' }, 'scroll to the bottom': { type: 'scroll', to: 'bottom' },
    'start reading aloud': { type: 'speak', on: true }, 'stop reading aloud': { type: 'speak', on: false }, 'reading aloud off': { type: 'speak', on: false },
    'read aloud on': { type: 'speak', on: true },
    'what can I say?': { type: 'help' }, 'help': { type: 'help' }, 'show voice commands': { type: 'help' },
    'use the calculator tool': { type: 'tool', tool: 'calc' }, 'select the add note tool': { type: 'tool', tool: 'notes_add' },
    'open the timer tool': { type: 'tool', tool: 'timer_start' },
    'add to the chain': { type: 'builder', action: 'add' }, 'plan this call': { type: 'builder', action: 'call' },
    'plan the chain': { type: 'builder', action: 'chain' }, 'clear the chain': { type: 'builder', action: 'clear' },
    'show the code page': { type: 'go', page: 'code' }, 'go to coding': { type: 'go', page: 'code' },
    'Hey FlowMesh, open the palette please': { type: 'palette' },
  };
  for (const [said, expected] of Object.entries(cases)) assert.deepEqual(parseCommand(said), expected, said);
});

test('a command inside a longer sentence is still just a sentence to plan', () => {
  for (const said of [
    'create the plan for the quarterly review and send it to Rohan', 'copy the record to the shared drive', 'download the record and email it',
    'scroll down to the pricing section and screenshot it', 'help me write a follow up to Rohan', 'help the team with the release',
    'open the palette of colours for the deck', 'plan the next step of the migration', 'use the calculator tool to total my invoices',
    'try the research sprint example and then delete it', 'start reading aloud the contract', 'focus the box on the left',
    'plan it for tomorrow morning', 'let me type that later', 'go to the top of the leaderboard and screenshot it',
  ]) {
    const command = parseCommand(said);
    // "plan the next step of the migration" starts like a command but carries more words, so it must not match.
    assert.equal(command, null, said);
  }
});

test('free text is accepted only by fill, and only while a builder form is open', () => {
  assert.equal(parseCommand('set title to Call Rohan tomorrow'), null);
  assert.equal(parseCommand('set the desk lamp to 40 percent'), null, 'a routine sentence is never swallowed');
  assert.equal(parseCommand('set the desk lamp to 40 percent', { builderOpen: false }), null);
  assert.equal(parseCommand('set title to x', { builderOpen: 'yes' }), null, 'the flag must be exactly true');
  assert.deepEqual(parseCommand('Set title to Call Rohan tomorrow.', { builderOpen: true }), { type: 'fill', field: 'title', text: 'Call Rohan tomorrow' });
  assert.deepEqual(parseCommand('fill the body with Send Rohan the revised quote', { builderOpen: true }), { type: 'fill', field: 'body', text: 'Send Rohan the revised quote' });
  assert.deepEqual(parseCommand('hey flowmesh enter expression as 12 times 3', { builderOpen: true }), { type: 'fill', field: 'expression', text: '12 times 3' });
  assert.equal(parseCommand('set to 5', { builderOpen: true }), null);
  for (const said of ['go to tools and set title to x', 'cancel then set title to x']) assert.equal(parseCommand(said, { builderOpen: true }), null, said);
});

test('every command has a fixed shape: a type plus an item from a fixed list', () => {
  const shapes = {
    go: ['page', 'type'], cancel: ['type'], approve: ['type'], read: ['type'], clear: ['type'], plan: ['type'], focus: ['type'],
    example: ['name', 'type'], latest: ['type'], copy: ['type'], download: ['type'], next: ['type'], palette: ['type'],
    scroll: ['to', 'type'], speak: ['on', 'type'], help: ['type'], tool: ['tool', 'type'], builder: ['action', 'type'], fill: ['field', 'text', 'type'],
  };
  const samples = ['go to tools', 'cancel', 'approve', 'read it back', 'new plan', 'create the plan', 'focus the box', 'try the meeting example',
    'open the latest run', 'copy the record', 'download the record', 'plan the next step', 'open the palette', 'scroll down', 'start reading aloud',
    'help', 'use the timer tool', 'plan this call', 'set title to x'];
  for (const said of samples) {
    const command = parseCommand(said, { builderOpen: true });
    assert.ok(command, said);
    assert.deepEqual(Object.keys(command).sort(), shapes[command.type], said);
  }
  assert.ok(Object.values(EXAMPLES).every((v) => ['meeting', 'focus', 'research', 'capture'].includes(v)));
  assert.deepEqual(Object.values(TOOLS).sort(), ['calc', 'notes_add', 'notes_clear', 'notes_list', 'timer_start']);
  assert.ok(Object.values(PAGES).every((v) => ['home', 'flow', 'tools', 'code', 'wispr', 'history', 'settings', 'about'].includes(v)));
});

test('nothing in the grammar can switch approval by voice on, name a path, or run a program', () => {
  for (const said of ['allow approve by voice', 'turn on approve by voice', 'enable voice approve', 'set approve by voice to on', 'turn on voice approval',
    'open C:\\Windows\\System32\\cmd.exe', 'go to ../../etc/passwd', 'run rm -rf', 'use the shell tool', 'use the delete everything tool', 'confirm danger',
    'approve it and confirm danger', 'download http://evil.example/x.exe']) {
    for (const ctx of [undefined, { builderOpen: true }]) {
      const command = parseCommand(said, ctx);
      assert.ok(command === null || command.type === 'fill', `${said}: ${JSON.stringify(command)}`);
      // A `fill` may be parsed for any field name; voice.js only ever writes into the visible builder form, so a
      // setting such as approve-by-voice is unreachable (checked against the real page in docs/VOICE.md's test notes).
    }
  }
});

test('the help sheet only lists things that work', () => {
  assert.ok(HELP_LIST.length >= 5);
  for (const [, examples] of HELP_LIST) {
    for (const example of examples) {
      if (/\(/.test(example)) continue; // a note about approval, not a command
      assert.ok(parseCommand(example, { builderOpen: true }), `help lists "${example}", which does nothing`);
    }
  }
});

test('odd input never throws', () => {
  for (const said of ['', null, undefined, 7, {}, [], '\u0000', 'x'.repeat(5000)]) {
    assert.doesNotThrow(() => parseCommand(said, { builderOpen: true }));
  }
});
