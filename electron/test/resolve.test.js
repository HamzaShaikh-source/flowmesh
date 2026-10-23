'use strict';
/** Windows command resolution: a bare name must resolve through PATHEXT, never to npm's extensionless shell script. */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { resolveCommand, launchPlan } = require('../mcp_client.js');
const { versionLine, CATALOG } = require('../agents.js');

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowmesh-rc-'));
  for (const name of files) fs.writeFileSync(path.join(dir, name), 'x');
  return dir;
}

test('windows: a bare name resolves through PATHEXT, not to the extensionless npm shell script', () => {
  const dir = fixture(['codex', 'codex.cmd', 'codex.ps1', 'gemini', 'gemini.cmd', 'gemini.exe', 'plain', 'real.exe']);
  try {
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const at = (name) => resolveCommand(name, { platform: 'win32', env });
    assert.equal(path.basename(at('codex')).toLowerCase(), 'codex.cmd', 'the shim, not the sh script');
    assert.equal(path.basename(at('gemini')).toLowerCase(), 'gemini.exe', 'PATHEXT order: .exe before .cmd');
    assert.equal(path.basename(at('real')).toLowerCase(), 'real.exe');
    assert.equal(at('plain'), null, 'an extensionless file alone is not executable on Windows');
    assert.equal(path.basename(at('codex.cmd')).toLowerCase(), 'codex.cmd', 'a name that already has an executable extension is used as written');
    assert.equal(at('codex.ps1'), null, 'PowerShell scripts are not launched directly');
    assert.equal(at('missing'), null);
    assert.equal(at(path.join(dir, 'codex')).toLowerCase(), path.join(dir, 'codex.cmd').toLowerCase(), 'a full path without an extension follows the same rule');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('other platforms still take the file as named', () => {
  const dir = fixture(['plain', 'tool']);
  try {
    const env = { PATH: dir };
    assert.equal(resolveCommand('plain', { platform: 'linux', env }), path.join(dir, 'plain'));
    assert.equal(resolveCommand('nothing', { platform: 'darwin', env }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a resolved .cmd shim is launched through cmd.exe with every argument quoted', () => {
  const plan = launchPlan('C:\\tools\\codex.CMD', ['--version'], 'win32', { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' });
  assert.equal(plan.file, 'C:\\WINDOWS\\system32\\cmd.exe');
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(plan.args[3], /"C:\\tools\\codex\.CMD" "--version"/);
  assert.equal(plan.options.windowsVerbatimArguments, true);
});

test('a CLI error is never shown as a version', () => {
  assert.equal(versionLine('codex-cli 0.162.1\n'), 'codex-cli 0.162.1');
  assert.equal(versionLine('0.58.0'), '0.58.0');
  assert.equal(versionLine('aider.EXE 0.86.2'), 'aider.EXE 0.86.2');
  assert.equal(versionLine("'D:\\Tools\\npm-global\\gemini.cmd\" \"--version' is not recognized as an internal or external command,\r\noperable program or batch file."), '');
  assert.equal(versionLine(''), '');
  assert.equal(versionLine(null), '');
  assert.equal(versionLine(undefined), '');
  assert.equal(versionLine('banner\nmock-agent 1.2.3 (test)'), 'mock-agent 1.2.3 (test)', 'the first line that looks like a version wins');
});

test('Codex read-only mode works in a folder that is not a git repository; editing modes do not skip the check', () => {
  const codex = CATALOG.find((a) => a.id === 'codex');
  const byId = Object.fromEntries(codex.modes.map((m) => [m.id, m]));
  assert.ok(byId.plan.args.includes('--skip-git-repo-check'));
  assert.equal(byId.plan.risk, 'read');
  assert.ok(!byId.edit.args.includes('--skip-git-repo-check'));
  assert.ok(!byId.full.args.includes('--skip-git-repo-check'));
  assert.ok(byId.plan.args.includes('read-only'));
});
