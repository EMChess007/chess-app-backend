Before implementing or reviewing ANY change to this app — not just a new game variant — read CHECKLIST.md and follow it.

# Never edit or write files through shell one-liners

Never create or change a file with a shell one-liner that contains backticks, template literals (`${...}`), escaped newlines or any multi-line string: `node -e "..."`, `sed -i` with a long program, `python -c`, `echo`/`printf`/heredocs that embed code. The shell expands backticks and `$`, collapses backslashes and rewrites `\n`, which silently corrupts the file (it has happened repeatedly: garbled docs, a test file that no longer parsed, a stray run of a test script).
Use the Edit / Write tools for every file change. If a change really needs a program (a bulk transform), write the program to a script FILE with the Write tool and run that file. A shell one-liner is fine for read-only commands and for plain single-line edits with no quotes, backticks or `$` in them.
