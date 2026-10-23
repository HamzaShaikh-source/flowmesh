'use strict';
/** The voice grammar is a security boundary: only whole utterances may act as commands. */
const assert = require('node:assert');
const { test } = require('node:test');

const { parseCommand, normalize } = require('../../web/voice-grammar.js');

test('whole-utterance commands are recognised, whatever the punctuation or politeness', () => {
  const cases = {
    'Cancel.': { type: 'cancel' }, 'never mind': { type: 'cancel' }, 'Stop it!': { type: 'cancel' }, 'cancel the plan, please': { type: 'cancel' },
    'Approve': { type: 'approve' }, 'approve and run.': { type: 'approve' }, 'Go ahead': { type: 'approve' }, 'hey flowmesh approve': { type: 'approve' },
    'Read it back': { type: 'read' }, "What's the plan?": { type: 'read' }, 'say the plan again': { type: 'read' },
    'new plan': { type: 'clear' }, 'start over': { type: 'clear' },
    'Go to tools.': { type: 'go', page: 'tools' }, 'open the history page': { type: 'go', page: 'history' }, 'show me the settings': { type: 'go', page: 'settings' },
    'take me to how it works': { type: 'go', page: 'about' }, 'go to runs': { type: 'go', page: 'history' }, 'add a tool': { type: 'go', page: 'tools' },
    'connect a server': { type: 'go', page: 'tools' }, 'Open wispr': { type: 'go', page: 'wispr' },
  };
  for (const [said, expected] of Object.entries(cases)) assert.deepEqual(parseCommand(said), expected, said);
});

test('a command word inside a longer sentence is just a sentence', () => {
  for (const said of [
    'cancel my subscription to the newsletter', 'approve the quote and send it to Rohan', 'go to tools and delete everything',
    'please approve the pull request and merge it', 'stop the timer and start a new one', 'read the documentation and take notes',
    'open the history of the project board', 'do it tomorrow', 'run it past Rohan first', 'clear my calendar for friday',
    'approve everything', 'go ahead and delete the old notes', 'cancel and approve', 'approve cancel',
  ]) assert.equal(parseCommand(said), null, said);
});

test('nothing can name a tool, path, program or argument', () => {
  for (const said of ['go to ../../etc/passwd', 'open C:\\Windows\\System32\\cmd.exe', 'go to settings; rm -rf /', 'connect a server npx evil',
    'open the tools page now', 'approve it and confirm danger', 'run it with sudo']) {
    const command = parseCommand(said);
    assert.ok(command === null || ['go', 'cancel', 'approve', 'read', 'clear'].includes(command.type));
    if (command) assert.deepEqual(Object.keys(command).sort(), command.type === 'go' ? ['page', 'type'] : ['type'], said);
  }
});

test('empty, non-string and odd input never throws and never acts', () => {
  for (const said of ['', '   ', null, undefined, 42, {}, '...', '\n\t']) assert.equal(parseCommand(said), null, String(said));
});

test('normalisation only strips punctuation, case and a leading wake word', () => {
  assert.equal(normalize('  Hey FlowMesh,  Go   to Tools!  '), 'go to tools');
  assert.equal(normalize('Approve, please.'), 'approve');
});
