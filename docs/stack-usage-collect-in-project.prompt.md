# Stack Usage Collection - Run Inside One Project

Audit one project's claude-stack usage from that project's own directory and move the results into
the claude-stack repo's local collection point. Collection only - the cross-project sweep
(`docs/stack-usage-collect-in-project-and-sessions-audit.prompt.md`) is what also runs the audit.

Run in a FRESH session started in the audited project's own directory. The audit reads that
project's session transcripts, and it must not run from the tail of a session it is auditing.

## 1. Audit

Invoke: `/project-stack-usage-analyzer all matching sessions except this one`

It writes one bundle per session to `.claude/docs/claude-stack-usage-report/<session-id>/`, plus a
`SUMMARY.md` when more than one session is audited.

Two things that cost time on a previous run:

- Redirect the analyzer output to files, never print it. Reading full reports into the chat is
  what drives context per message into the hundreds of thousands.
- Use ABSOLUTE paths for every copy and staging step. A `cd` persists across commands, so a later
  relative path silently resolves under it - one run wrote its whole bundle tree into a nested
  `.claude/docs/tools-usage/.claude/docs/...` and it looked like deleted data.

## 2. Move the artifacts

Destination (the claude-stack clone on this machine - substitute its real path, it is
machine-local and never committed):

    <claude-stack repo>/docs/session-investigation/<project-name>/

Copy the WHOLE bundle set - the audit that consumes this collection treats the transcripts as
its ground truth, and a report-only copy leaves it unable to verify anything:

- `SUMMARY.md`
- `_rollup.txt`, renamed to `rollup.txt`
- every per-session folder entire: `report-usage.md`, `analyzer-full.txt`, `analyzer.json`,
  `session.jsonl`, `tool-usage-*.jsonl`, and the whole `subagents/` directory

Expect real volume - a session transcript runs to tens of MB, so a project's collection is
hundreds of MB. Copy, never move: the audited project keeps its own bundles.

`session.jsonl` and the subagent transcripts carry full conversation content - code, file
contents, possibly secrets. The containment is the gitignore, so verify it BEFORE the copy and
again after, and never quote their content into a tracked file:

    git -C <claude-stack repo> check-ignore -q docs/session-investigation && echo IGNORED   # expect IGNORED
    git -C <claude-stack repo> status --porcelain docs/session-investigation | wc -l         # expect 0

A destination that is not ignored is a stop condition: fix the gitignore first, copy second.

## 3. Report back

State: sessions audited, files and size copied, and the gitignore check result. The per-session
`report-usage.md` arrives AUTHORED here - the analyzer skill fills its judgment sections while the
machine-written tables stay untouched - which is the difference from the cross-project sweep, whose
bundles carry the skeleton only. What is still outstanding after this run is the AUDIT of the
collection (`docs/stack-usage-sessions-audit.prompt.md`), a separate fresh session.

## Notes

- `docs/session-investigation/` is gitignored in the claude-stack repo, so nothing collected there
  is committed or pushed. It is a local cross-project collection point, and that gitignore is the
  only thing keeping transcript content out of a public repo - never relax it, and never lift a
  quote from a bundle into a tracked file without genericizing it to 'a consuming project'.
- A project with no folder under `~/.claude/projects/` has no Claude Code history on this machine
  and nothing to audit - say so and stop rather than producing an empty bundle.
