'use strict';
// Usage: npm run hash            (prompts; input is not echoed to shell history)
//    or: npm run hash -- "pass"  (convenient, but the password lands in shell history)
// Prints a line to paste into your environment as ADMIN_PASSWORD_HASH.

const readline = require('readline');
const { makeHash } = require('../server/auth');

function done(pw) {
  if (!pw || pw.length < 8) {
    console.error('Please use a password of at least 8 characters.');
    process.exit(1);
  }
  console.log('\nSet this in your environment (keep it private):\n');
  console.log(`ADMIN_PASSWORD_HASH=${makeHash(pw)}\n`);
}

if (process.argv[2]) {
  done(process.argv[2]);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = function (s) { if (s.includes('Admin password')) rl.output.write(s); };
  rl.question('Admin password: ', (pw) => { rl.close(); console.log(); done(pw); });
}
