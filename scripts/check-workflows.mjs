/**
 * Parses every GitHub Actions workflow in `.github/workflows/` and fails if one would be rejected before a single job starts.
 *
 * Why this exists: an unquoted `: ` inside a step name ("variant plumbing: rooms") made backend/.github/workflows/ci.yml invalid YAML; GitHub then
 * "runs" the workflow with ZERO jobs and a red cross, and none of the local checks (typecheck, vitest, the backend scripts) ever reads a workflow
 * file, so only the CI run itself caught it - after the push. This is the local net for that class of mistake. Run by the `pre-push` hook
 * (`.githooks/pre-push`) and by hand: `npm run check:workflows`.
 *
 * What it checks, per file: it is valid YAML with no duplicate keys and no parser warnings; it has `on` and a non-empty `jobs`; every job has `runs-on`
 * (or `uses` for a reusable workflow) and a non-empty `steps` list unless it is a reusable-workflow call; every step has exactly one of `run` / `uses`.
 * It does NOT validate expressions, action inputs or the full workflow schema - GitHub does that; this only guarantees the file reaches GitHub readable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, '.github', 'workflows');

/** @returns {string[]} every problem found in one workflow's text (empty = fine) */
export function workflowProblems(text) {
  const doc = parseDocument(text, { uniqueKeys: true });
  const problems = [...doc.errors, ...doc.warnings].map((e) => {
    const first = e.message.split('\n')[0].replace(/:$/, '');
    return /line \d+/.test(first) || !e.linePos?.[0] ? first : `${first} (line ${e.linePos[0].line})`;
  });
  if (problems.length > 0) return problems;

  const data = doc.toJS();
  if (!data || typeof data !== 'object') return ['the file is empty or not a mapping'];
  // YAML 1.1 reads a bare `on` as the boolean true; the yaml package uses 1.2 so it stays "on", but accept both spellings.
  if (!('on' in data) && !('true' in data)) problems.push('no `on:` trigger');
  const jobs = data.jobs;
  if (!jobs || typeof jobs !== 'object' || Object.keys(jobs).length === 0) return [...problems, 'no `jobs:`'];
  for (const [id, job] of Object.entries(jobs)) {
    if (!job || typeof job !== 'object') {
      problems.push(`job "${id}" is not a mapping`);
      continue;
    }
    if (job.uses) continue; // a reusable-workflow call has no runs-on / steps of its own
    if (!job['runs-on']) problems.push(`job "${id}" has no runs-on`);
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      problems.push(`job "${id}" has no steps`);
      continue;
    }
    job.steps.forEach((step, i) => {
      const label = `job "${id}" step ${i + 1}${step && step.name ? ` ("${String(step.name).slice(0, 50)}")` : ''}`;
      if (!step || typeof step !== 'object') problems.push(`${label} is not a mapping`);
      else if (Boolean(step.run) === Boolean(step.uses)) problems.push(`${label} needs exactly one of run / uses`);
    });
  }
  return problems;
}

function main() {
  let files;
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    console.log('check-workflows: no .github/workflows directory, nothing to check.');
    return 0;
  }
  let failed = 0;
  for (const file of files) {
    const problems = workflowProblems(readFileSync(join(dir, file), 'utf8'));
    if (problems.length === 0) console.log(`  ok    ${file}`);
    else {
      failed++;
      console.log(`  FAIL  ${file}`);
      for (const p of problems) console.log(`          - ${p}`);
    }
  }
  if (failed > 0) console.log(`\ncheck-workflows: ${failed} of ${files.length} workflow file(s) would be rejected by GitHub. Fix them before pushing.`);
  else console.log(`check-workflows: ${files.length} workflow file(s) parse.`);
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
