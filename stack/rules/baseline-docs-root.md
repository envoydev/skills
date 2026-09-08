---
description: House baseline - the generated-docs root. Always-on (no paths), installer-managed - update overwrites local edits.
---

# Generated docs root

- EVERY doc file the assistant creates lives under ONE root: the architecture map (`architecture/`),
  `PROJECT-CODE-STYLE.md`, the related-projects folder (`related-context/` - the orientation doc
  `related-context/PROJECT-RELATED-CONTEXT.md` plus every doc about or for a sibling repo:
  cross-repo plans, change requests, issue notes, run recipes), the quality-loop prompts
  (`loops/`), the coverage capture (`test-coverage/`), the usage-audit bundles
  (`claude-stack-usage-report/`), superpowers plans + specs, ADRs with no existing home (`decisions/`),
  the instrumentation ledgers (`tools-usage/`), the task cards handed to another repo
  (`cross-project-tasks/`), and any other generated artifact.
- Creating a doc OUTSIDE this root - a committed `docs/`, the repo root - happens only on the
  user's asked-first approval of that exact location (AskUserQuestion, per the interaction
  baseline); never silently, however conventional the spot looks. A sibling repo is never
  written from this session unless the user allows it in the cross-project write guard's own
  ask - its `<docs-path>/flow/CROSS-WRITE-ALLOW` receipt, this session only; by default a doc
  about it lives in `related-context/`, a change it must make is a task card in
  `cross-project-tasks/`. Editing an EXISTING first-class repo doc where it already lives (the top-level
  `README.md`, an established ADR home) is not a generated doc and needs no ask.
- Resolve the root ONCE per session, before the first generated-doc read or write: the
  `CLAUDE_STACK_DOCS_PATH` env value in `.claude/settings.json`; absent = `.claude/docs`. Wherever an
  instruction names a doc as `<docs-path>/<name>` - or as legacy shorthand `docs/<name>` - it means
  this root.
- **This install's root: `__DOCS_ROOT__`** - stamped from the env value by every install, update,
  and configure run, so the resolved path is already in front of you. If the env value disagrees
  (edited by hand since the last run), the env value wins.
- To move the docs, change that env value and nothing else - forward slashes on every OS (hooks
  read `process.env.CLAUDE_STACK_DOCS_PATH`, PowerShell `$env:CLAUDE_STACK_DOCS_PATH`). Existing docs do not
  move with it: they stay under the old root until moved by hand or re-captured.
- The key was `CLAUDE_DOCS_PATH` before 0.2.43 - a bare name that read like a Claude Code setting
  rather than one of this stack's. An install/update renames it in place and keeps the value; the
  old spelling is still read as a fallback, so a project that has not updated yet still resolves.
- The default root is machine-local (`.claude/*` is gitignored): nothing under it is committed or
  survives a fresh clone - re-run the captures after a re-clone. A committed root (e.g. `docs`)
  shares the generated docs with the team; then track `<docs-path>/superpowers/` (do not gitignore it).
- Superpowers writes its implementation plans and design specs under this same
  root - `<docs-path>/superpowers/plans/` and `<docs-path>/superpowers/specs/`, never its own
  default location.

## Generated-doc lifecycle (every capture doc under this root)

- Capture docs open with `Captured: <branch>@<short-sha>, <date>` (`+dirty` = the tree held
  uncommitted work). Machine-local docs do NOT switch with git branches - the stamp says which
  code a doc describes.
- Reading one: a stamp from another branch, or `+dirty`, means approximate at best - verify
  against the code before relying on it; never treat it as ground truth for HEAD.
- Refreshing one: the owning capture skill fans out agents on a FIRST capture (per the run's
  session-or-agents pick) and runs an UPDATE in-session, scoped to the drift since the stamp -
  escalating to agents on big drift, an unreachable stamp, a dirty one the run cannot prove
  unchanged, or the user's explicit ask. A doc that updates differently
  (per-entry upserts, always-re-measure) follows its owning skill's own mode rules.
- Nothing re-captures automatically: build flows may SUGGEST the right capture at close when
  something critical landed; the user decides.
