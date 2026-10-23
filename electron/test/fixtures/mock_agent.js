'use strict';
/** A stand-in coding-agent CLI for tests (twin of tests/mock_agent_cli.py). */
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const argv = process.argv.slice(2);

if (argv[0] === '--version') {
  console.log('mock-agent 1.2.3 (test)');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  console.log('Logged in using MockPlan');
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'login') {
  console.log('login flow would start here');
  process.exit(0);
}

let task = '';
if (argv.includes('--stdin')) task = fs.readFileSync(0, 'utf8');
else if (argv.includes('--prompt')) task = argv[argv.indexOf('--prompt') + 1];
else if (argv.includes('--file')) task = fs.readFileSync(argv[argv.indexOf('--file') + 1], 'utf8');

const leaked = Object.keys(process.env).filter((k) => /^(FLOWMESH_|TYPESAFE_)/i.test(k)).sort();
console.log(JSON.stringify({ argv, cwd: process.cwd(), task, leaked, no_color: process.env.NO_COLOR || null }));

if (task.includes('ANSI')) console.log('\x1b[31mred\x1b[0m plain');
if (task.includes('SPLIT')) {
  // one character delivered in two separate writes, with the rest of the script after them
  process.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xc3]));
  setTimeout(() => {
    process.stdout.write(Buffer.from([0xa9, 0x20, 0x6f, 0x6b, 0x0a]));
    console.log('done');
  }, 300);
  return;
}
const write = /WRITE:([\w.]+)/.exec(task);
if (write) fs.writeFileSync(write[1], 'created by the mock agent\n');
const sleep = /SLEEP:(\d+)/.exec(task);
const finish = () => {
  if (task.includes('FAIL')) {
    console.error('something went wrong');
    process.exit(3);
  }
  console.log('done');
};
if (sleep) {
  if (task.includes('SPAWN')) {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { stdio: 'ignore' });
    fs.writeFileSync('child.pid', String(child.pid));
  }
  console.log('sleeping');
  setTimeout(finish, Number(sleep[1]) * 1000);
} else {
  finish();
}
