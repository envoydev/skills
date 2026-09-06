---
description: "House baseline - quality gates: code quality and the done-claim gate. Always-on (no paths), installer-managed - update overwrites local edits."
---

# Quality gates

## Code quality

- No dead code, commented-out blocks, or `TODO` without a ticket ref.
- Unit tests for new code; integration tests for DB / external service.
- Keep it simple: no speculative abstractions; touch only what the task requires.
- Inline comments explain *why*, not *what*.
- **A command's exit status is read immediately or it is gone.** Capture `$?` (or `${PIPESTATUS[0]}` when the command you care about is not the last in a pipe) on the very next line - one measured session used it correctly and then, 5h24m later, read a pipeline's status as the pager's. And never write `<cmd> || echo none`: the fallback launders a FAILURE into the same output an empty result gives (measured: a 17-file security scan reported `NONE` and the receipt asserted 'no secrets referenced' - the `grep` had been shadowed and never ran). A scan used as evidence of ABSENCE runs a must-match positive control in the same call, and resolves its tool absolutely or checks it with `type` first.
- Throwaway probe/scratch code (a diagnostic dump, a hypothesis check) is written OUTSIDE the tracked tree - the harness scratchpad (the OS temp dir - the outside tree the cross-project write guard keeps open for scratch) or a gitignored dir inside the repo - never into the project's source or test folders (measured: a probe class heredoc-landed in the tracked test tree). One known trap: an ESM scratch script cannot `import` the project's `node_modules` from outside the repo (NODE_PATH is ignored by ESM) - the fallback is a GITIGNORED dir inside the repo, never the tracked root (measured: three scratchpad failures, then a `.mjs` probe at the repo root and 7 edits to clean it up). And an interrupted compound write (heredoc, chained command) may have already executed before the interrupt - existence-check the target instead of trusting the rejection.

## Definition of done

Before typing 'done', 'fixed', 'passing', 'works', or 'ready' about your own change: STOP and
satisfy `superpowers:verification-before-completion` - build + relevant tests run, output quoted. Bound that output: a GREEN run needs the summary line, not `--verbose` (measured: 4.5k tokens to learn one spec passed) - tail long runs to the verdict; a RED run is the opposite case - its stack traces and parse errors are the diagnosis, earned cost, never trimmed to the verdict line (measured: genuine failure diagnostics flagged as waste by the summary-line rule read without this split). Satisfy the
gate honestly - fix the cause, never suppress a warning, weaken a test, or stub code to go green.
Report what changed and what deliberately did not. Cannot run it? Say so, never silently skip.
A green build proves the code COMPILES, never that the API it calls is current: any claim about a package, a version floor, an API shape, a config key or a deprecation is checked against `context7` (the docs-lookup MCP - this rule locks it into every install) at the moment you write it - the docs are the authority, recall is not, and a wrong version-coupled claim ships silently because the compiler has no opinion about it. Prefer the durable policy plus a fetch-at-use pointer over a pinned number, so the artifact keeps the judgment and the drifting fact is fetched live. context7 unreachable: say the claim is unverified rather than asserting it.
Partial work: state complete vs not vs why, then put continue / redirect / stop through the
AskUserQuestion tool - one option each, recommendation marked (a prose-only ask gets skipped).
A wait measured in MINUTES is not a foreground command. A CI run, a container build, a full suite,
an emulator boot: start it in the background and go on with work that does not depend on it, rather
than blocking the turn on it (measured: a 10m02s foreground CI wait that the harness then converted
by itself, and the same verb backgrounded correctly 15 minutes later - the run knew how).
Background work: a polling wait or a 'what is running' answer keys on a specific PID, marker
file, or output sentinel - never a bare process-name grep (`pgrep -f 'dotnet test'` matches a
sibling project's run; measured: one session nearly wrote a false coverage collapse and another
told the user nothing was running while its own orphaned waiter was live). Task lists track
created tasks only, never background shells - check the shell's own PID and listening ports
before claiming nothing runs.
Started infrastructure: anything the run started or seeded to build, test, or verify - a Docker
container or compose stack, an integration-test database and its seeded data, a dev server, an
emulator, a background watcher - never outlives the work silently. At close, list exactly what
is still up and put tear-down-vs-keep through AskUserQuestion (batched into the flow's existing
close ask where one fires), teardown recommended for the disposable. The teardown RUNS AFTER that
ask is answered, never before it - a run that tore down first and asked second paid a second
up-build-down cycle when the answer arrived 1h47m later and said keep it. Never stop or wipe what
you did not start - the ask covers only what this run brought up.
Generated files are the same contract with a different default: anything the run wrote only to
build, test or verify - a scratch script, a temp fixture or sandbox directory, a coverage or log
dump, a downloaded sample - is DELETED as soon as the check that needed it passes, no ask (it is
working state, not output; the ask covers only what is still running). Three exceptions survive:
the user asked for the file, a later step still needs it, or it is a real deliverable (a report
under `<docs-path>`, a committed fixture) - name those in the close. Never delete a file this run
did not create, and never leave the repo dirtier than you found it: `git status` at the close
shows only the intended change.
