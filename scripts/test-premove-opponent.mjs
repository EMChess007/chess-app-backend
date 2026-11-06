/**
 * The guards of scripts/premove-opponent.mjs, the scripted 2-player opponent of the Android end-to-end run (command #35b).
 *
 *   npm run test:premoveOpponent        (plain node, no server: every case ends before a socket is opened)
 *
 * It refuses: no code, a code that is not 6 characters of the invite alphabet, a delay outside 0..60000 ms, a hold outside 1..900 s, and a BACKEND_URL that is not a local server
 * (it must never talk to a deployed backend). Each refusal exits with status 2 and prints nothing but the usage / the reason (no environment value is echoed).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'premove-opponent.mjs');
let passed = 0;
const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, BACKEND_URL: '', ...env } });
function refused(name, args, env) {
  const r = run(args, env);
  assert.equal(r.status, 2, `${name}: exit status ${r.status}, stderr: ${r.stderr}`);
  passed++;
  console.log(`  ok  ${name}`);
  return r;
}

refused('no code', []);
refused('a code that is too short', ['K7M2P']);
refused('a code with a character outside the invite alphabet (0, O, 1, I, L)', ['K7M2P0']);
refused('a delay above 60 s', ['K7M2PQ', '--delay=60001']);
refused('a negative delay', ['K7M2PQ', '--delay=-1']);
refused('a delay that is not a number', ['K7M2PQ', '--delay=abc']);
refused('a hold below 1 s', ['K7M2PQ', '--hold=10']);
refused('a hold above 15 minutes', ['K7M2PQ', '--hold=900001']);
const deployed = refused('a deployed backend URL', ['K7M2PQ'], { BACKEND_URL: 'https://example.invalid' });
assert.ok(!deployed.stderr.includes('example.invalid') && !deployed.stdout.includes('example.invalid'), 'the refusal must not echo the URL');
passed++;
console.log('  ok  the refusal does not echo the URL');

console.log(`\npremove-opponent guards: ${passed} checks passed`);
