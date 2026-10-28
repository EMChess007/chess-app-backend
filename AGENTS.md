Before implementing or reviewing ANY change to this app — not just a new game variant — read CHECKLIST.md and follow it.

# Never edit or write files through shell one-liners

Never create or change a file with a shell one-liner that contains backticks, template literals (`${...}`), escaped newlines or any multi-line string: `node -e "..."`, `sed -i` with a long program, `python -c`, `echo`/`printf`/heredocs that embed code. The shell expands backticks and `$`, collapses backslashes and rewrites `\n`, which silently corrupts the file (it has happened repeatedly: garbled docs, a test file that no longer parsed, a stray run of a test script).
Use the Edit / Write tools for every file change. If a change really needs a program (a bulk transform), write the program to a script FILE with the Write tool and run that file. A shell one-liner is fine for read-only commands and for plain single-line edits with no quotes, backticks or `$` in them.

# Rules learned building Chaturaji (W2-W5): they apply to every later change

- A test-only switch (an environment variable or an endpoint) follows CHECKLIST.md section 7: one small module, an opt-in name that says what it does, ignored when `NODE_ENV=production` with ONE startup warning that does not print the value, a finite validated value, set only by the e2e stack's own child process (never in a workflow, `.env.example` or a deployment config); `test-auth-rate-limit.mjs` and `test-four-test-switches.mjs` show the four tests it needs (default unchanged, ignored in production - also on a real production-mode process -, honoured outside it, no secret read or logged).
- The build must work with `NODE_ENV=production` in the environment: `tsc`, `prisma` and the `@types/*` it needs are `dependencies`, and `npm run check:productionInstall` (CI) proves it. Do not move a package the build needs back to `devDependencies`.
- A constant that a mutation-targeted test checks is written in the test as a LITERAL; mutation runs are on a copy, in chunks of at most ~20 minutes with a hard timeout per mutant, one at a time, results outside the repo, every survivor killed or proven equivalent with a test.
- A check whose count depends on what an unseeded server did is `checkConditional`, not `check`: the printed total of `test:fourplayerOnline` is the same on every run.
- The e2e and browser suites never touch :3000 / :8081 / :8082 or the deployed backend, use the local database only, delete the accounts they register, and kill only processes they started (prove the PID and the command line first). Playwright's `routeWebSocket` must be installed BEFORE the page's first load.
- `src/game/fourPlayer/*` is GENERATED from the app source (`npm run sync:fourplayer`): never edit it here.

# Cloud sessions (a Linux VM; the app repo's TESTING.md, "Cloud sessions")

- Work runs in Claude Code cloud sessions: this repo lives at `<app>/backend` (the layout the test scripts import through); start a session with `bash scripts/cloud-setup.sh` from the app repo (idempotent; it also starts the local PostgreSQL).
- The laptop-only rules above (never :3000 / :8081 / :8082) still apply when a session runs on the laptop; in the cloud use any free port, but never the deployed backend, Neon or Render.
- Never commit the VM's `.env` (test-only values, git-ignored); a real `.env` is never asked for, read or printed. The browser end-to-end there runs with `E2E_BROWSER_PATH` (Playwright's Chromium; no system Chrome).
