/**
 * THE PERMANENT DEPENDENCY GUARD (command #31, CHECKLIST.md section 8): `npm audit` must report ZERO vulnerabilities, any severity, dev included, and a red `security-audit` check is the only
 * way a new advisory shows up without a commit of ours. This test pins the SHAPE of the guard so that it cannot be weakened quietly (a `--omit=dev`, an `--audit-level`, a `continue-on-error`,
 * a dropped schedule) and so that the server's security-relevant resolutions stay where the fix put them. It does not call the registry (a test never depends on the network or on today's
 * advisories): the audit itself is the CI job `security-audit`.
 *
 *   npm run test:securityAudit
 *
 * Literals on purpose: a test that reads a value from the file it checks could not fail.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

let passed = 0;
function ok(condition, message) {
  assert.ok(condition, message);
  passed++;
  console.log(`  ok  ${message}`);
}
/** [major, minor, patch] of a plain x.y.z version. */
const triple = (version) => version.split('.').map(Number);
const atLeast = (version, floor) => {
  const [a, b] = [triple(version), triple(floor)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
};

// --- the workflow -----------------------------------------------------------------------------------------------------------------------
const workflowText = read('.github/workflows/security-audit.yml');
const workflow = parse(workflowText);
const job = workflow.jobs['security-audit'];
ok(Object.keys(workflow.jobs).join(',') === 'security-audit', 'the workflow has ONE job and it is called security-audit (the required status check keeps its name)');
ok(job['runs-on'] === 'ubuntu-latest', 'it runs on ubuntu-latest');
const runs = job.steps.filter((s) => s.run).map((s) => s.run);
ok(JSON.stringify(runs) === JSON.stringify(['npm ci', 'npm audit']), 'it installs with npm ci and then runs a bare "npm audit": every severity, production and development');
ok(job['continue-on-error'] === undefined && job.steps.every((s) => s['continue-on-error'] === undefined && s.if === undefined), 'no continue-on-error and no condition on any step: the check cannot become a warning');
const code = workflowText
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
for (const forbidden of ['--omit', '--audit-level', '--production', '--only=prod', '|| true', 'continue-on-error', 'audit fix']) ok(!code.includes(forbidden), `the workflow never says "${forbidden}"`);
ok(JSON.stringify(workflow.on.push.branches) === JSON.stringify(['**']), 'it runs on a push to ANY branch');
ok(JSON.stringify(workflow.on.pull_request.branches) === JSON.stringify(['main']), 'it runs on pull requests to main');
ok(workflow.on.workflow_dispatch !== undefined, 'it can be started by hand');
ok(workflow.on.schedule.length === 1, 'it has ONE schedule');
const cron = workflow.on.schedule[0].cron.split(' ');
ok(cron.length === 5 && cron[2] === '*' && cron[3] === '*' && /^[0-6]$/.test(cron[4]), 'the schedule is WEEKLY (one weekday, every week): a new advisory needs no commit');

// --- Dependabot -------------------------------------------------------------------------------------------------------------------------
const dependabot = parse(read('.github/dependabot.yml'));
ok(dependabot.version === 2, 'dependabot.yml is version 2');
ok(dependabot.updates.map((u) => u['package-ecosystem']).sort().join(',') === 'github-actions,npm', 'Dependabot covers npm and the GitHub Actions');
for (const update of dependabot.updates) {
  const groups = Object.values(update.groups);
  ok(update.directory === '/' && update['open-pull-requests-limit'] === 0, `${update['package-ecosystem']}: version updates are off (security updates have their own limit)`);
  ok(groups.length === 1 && groups[0]['applies-to'] === 'security-updates' && JSON.stringify(groups[0].patterns) === JSON.stringify(['*']), `${update['package-ecosystem']}: ALL security updates are grouped into one pull request`);
}

// --- what the zero depends on -----------------------------------------------------------------------------------------------------------
const lock = JSON.parse(read('package-lock.json'));
const versionOf = (name) => lock.packages[`node_modules/${name}`]?.version;
const FLOORS = { 'body-parser': '2.4.0', qs: '6.17.1', 'ip-address': '10.7.5' }; // the first fixed versions of GHSA-27r3-jxmh-p828, GHSA-6pq8-jhm2-2vcw, GHSA-rxp7-6hxx-x8q5
for (const [name, floor] of Object.entries(FLOORS)) {
  const copies = Object.entries(lock.packages).filter(([p]) => p === `node_modules/${name}` || p.endsWith(`/node_modules/${name}`));
  ok(copies.length >= 1 && copies.every(([, entry]) => atLeast(entry.version, floor)), `the lock holds ${name} ${floor} or later in every copy (${copies.map(([, e]) => e.version).join(', ')})`);
  assert.ok(versionOf(name) !== undefined);
}

const pkg = JSON.parse(read('package.json'));
ok(Object.keys(pkg.allowScripts ?? {}).length > 0 && Object.values(pkg.allowScripts).every((v) => v === true), 'every install script the server needs is approved by name and version (allowScripts), none left to a warning');

for (const file of ['package.json', 'scripts/cloud-setup.sh', ...fs.readdirSync(path.join(root, '.github/workflows')).map((f) => `.github/workflows/${f}`)]) {
  if (!fs.existsSync(path.join(root, file))) continue;
  const noComments = read(file)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#')) // the workflow's own comment says what it forbids
    .join('\n');
  ok(!/audit\s+fix\s+--force|audit\s+--force/.test(noComments), `${file} never runs "audit fix --force" (it would upgrade across majors behind our back)`);
}

const checklist = read('CHECKLIST.md');
ok(checklist.includes('security-audit') && /## 8\. Zero known vulnerabilities/.test(checklist), 'CHECKLIST.md carries the rule: no report says "done" unless security-audit is green');
ok(pkg.scripts['test:securityAudit'] === 'node scripts/test-security-audit.mjs', 'it is an npm script');
ok(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').includes('npm run test:securityAudit'), 'and ci.yml runs it');

console.log(`\ntest-security-audit: ${passed} checks passed.`);
