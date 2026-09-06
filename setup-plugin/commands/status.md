---
description: "SHOW what is installed from the claude-stack in THIS project (or the global install) - read-only, no download, no changes: one table per area (skills, agents, rules, hooks, MCPs, plugins, environment, generated docs & data with their capture dates), the user picks which areas or all. NOT for changing anything - adding/dropping is configure, refreshing is update, project reconcile is validate."
disable-model-invocation: true
---

# Show the installed stack - read-only, per-area tables

You are showing what a claude-stack install holds, nothing else. This command touches the
network never and the disk read-only: no source download, no `$TMP`, no writes, no deltas
computed. Quiet machinery - read the files, render the tables, one narration line per area at
most. Anything the user wants CHANGED routes to the sibling commands (`configure` to add/drop,
`update` to refresh, `validate` to reconcile).

## 1. Find the install

Project mode when the working tree has a populated `.claude/` (skills or agents present);
otherwise global mode against the account's config dir (skills, plugins and user-scope MCPs live
there; agents/rules/hooks are project-level by construction - the installer lays them only into a git
repo's `.claude/` - so those areas read `none installed` at global scope). Nothing installed in either place ->
say so and route to `/claude-stack:setup`. Open with one line naming mode and root:
`status: project install at <root>/.claude` (or `global install at <path>`).

## 2. One question - what to show

One AskUserQuestion multi-select (the tool caps a question at four options, so the eight areas ship
in this FIXED grouping, all four marked Recommended): 'Skills + Agents + Rules', 'Hooks + MCPs +
Plugins', 'Environment', 'Generated docs & data' - single area numbers via Other. Render only the
chosen areas, in this fixed order:

```
 1 skills   2 agents   3 rules   4 hooks   5 mcps   6 plugins
 7 environment   8 generated docs & data
```

Where the harness lacks the tool, the same list as a plain-text prompt (`a` = all, numbers = just
those) is the stated fallback. Every chosen area prints its banner even when empty - an empty area
shows the banner + `none installed`, never silence.

## 3. The tables - fixed shapes, one per area

Collect first, render second: finish EVERY read for an area before its table starts, then emit
the whole table as one uninterrupted block - a table never spans tool calls and no prose
interleaves its rows (fragments render as broken, misaligned pieces). Every table ends with a
`total: N` line. Read everything from disk at render time - never from memory or a prior run's
output.

**Skills** - the directory names under `.claude/skills/` (global: the account skills dir):

| skill | kind |
|---|---|
| dotnet-testing | stack |
| my-team-notes | user-authored |

`kind`: `stack` when the name exists in the installed roster this repo ships (when unsure -
no stamp, heavily edited copy - say `unverified`, never guess); `user-authored` otherwise.

**Agents** - `.claude/agents/*.md`, with the frontmatter pins read from each file:

| agent | model | effort |
|---|---|---|
| web-angular-solution-designer | opus | xhigh |

**Rules** - `.claude/rules/*.md`:

| rule | scope | origin |
|---|---|---|
| baseline-git | always-on | stack |
| typescript-conventions | paths: `**/*.ts`, `**/*.tsx` | stack |
| baseline-project-architecture | always-on | GENERATED |
| project-code-style | paths: `**/*.js` | GENERATED |

`scope` comes from the `paths:` frontmatter (absent = always-on). `origin`: `GENERATED` for
the capture-written rules (`baseline-project-*.md`, `project-code-style.md`), `stack`
otherwise, `user-authored` when clearly neither.

**Hooks** - `.claude/hooks/*.js` joined against `settings.json`:

| hook | wired | matcher |
|---|---|---|
| guard-catastrophic-rm.js | yes | Bash |
| instrument-tool-usage.js | yes (env-gated, off) | .* |

**MCPs** - server entries from the repo's `.mcp.json` (project mode; global: the account's user-scope
registrations - the installer's `--scope global` registers them with `--scope user`, so read
`claude mcp list`, fail-soft without the CLI: banner + `claude CLI unavailable - skipped`):

| server | transport | target |
|---|---|---|
| serena | stdio | uvx ... --project-from-cwd |
| sentry | http | https://mcp.sentry.dev/mcp/${SENTRY_SLUG} |

`target` is the command or URL, middle-truncated to keep the row one line. Never print env
values embedded in a registration - show `${VAR}` literally as written.

**Plugins** - `claude plugin list` (fail-soft: without the CLI print the banner +
`plugin CLI unavailable - skipped`):

| plugin | version | status |
|---|---|---|

**Environment** - the install's knobs and identity, one row each:

| item | value |
|---|---|
| stack version (stamp) | 0.2.3 @ <short-sha> |
| scope | project (the stamp's `scope:` line; `user` there = global) |
| CLAUDE_STACK_DOCS_PATH | .claude/docs (default) |
| CLAUDE_AUTOCOMPACT_PCT_OVERRIDE | not set |
| CLAUDE_STACK_INSTRUMENT | 0 (default - off) |
| CLAUDE_STACK_FRESH_SESSION_PCT | 40 (default) - the fresh-session gate's share of the window; 0 = off |
| CLAUDE_STACK_CONTEXT_WINDOW | empty (default - auto: the model id's `[1m]`-style suffix, else what the session has carried); a stated `1000000` / `200000` overrules that |
| SENTRY_SLUG (account env) | set / not set - only when sentry is installed |
| SENTRY_ACCESS_TOKEN (account env) | set / not set - only when sentry is installed and its registration carries a header |
| CONTEXT7_API_KEY (account env) | set / not set - only when context7 is installed remote; not set = the keyless free tier |

Stamp from `claude-stack.stamp` (`no stamp - source never resolved at install time` when
absent); env values from `settings.json` `env`, marking `(default)` when the key is absent and
a house default applies. The sentry and context7 rows read the ACCOUNT `settings.json` (`~/.claude/settings.json`,
or the space's - the file `.mcp.json` expansion reads) and show presence only, never the value. That holds for ANY key, not just these three: a key matching the catalog's `secret_key_pattern` (`meta/environment.json`) or a row flagged `secret: true` is printed as `set (N chars)` or `absent`, never by value; a
sentry `not set` row ends with `-> add it there (or /claude-stack:configure)` (context7 unset is a
working free tier - no arrow, the registration sends an empty header). This table names values only - changing them is `configure`'s
environment area.

**Generated docs & data** - the capture output under `<docs-path>` (resolve the root exactly
as the docs-root rule states) plus serena's local memory:

| artifact | present | captured | file updated |
|---|---|---|---|
| architecture/ARCHITECTURE.md | yes | main@a1b2c3d, 2026-07-24 | 2026-07-24 |
| architecture/ASSESSMENT.md | yes | main@a1b2c3d, 2026-07-24 | 2026-07-24 |
| architecture/BRANCH-DELTA.md | no | - | - |
| PROJECT-CODE-STYLE.md | yes | master@9a68219, 2026-07-25 | 2026-07-25 |
| related-context/PROJECT-RELATED-CONTEXT.md | no | - | - |
| test-coverage/COVERAGE.md | yes | (bar 85%) | 2026-07-25 |
| loops/ | yes | 3 prompt files | 2026-07-24 |
| .serena/memories/ | yes | 4 notes | 2026-07-25 |

`captured` is the doc's own `Captured:` stamp line read from the file (the related-context doc
stamps per entry - show the newest); `file updated` is the file's mtime date. A `Captured:`
stamp older than the file mtime is normal (loops edit docs without re-capturing) - render
both, judge nothing. Rows are fixed - a capture never run shows `no`, so the user sees what is
MISSING as clearly as what exists. One row is conditional, not a gap: related-context/PROJECT-RELATED-CONTEXT.md
applies only to a project with sibling repos - a standalone repo reads `no` there permanently.

## 4. Close

One line, no summary prose: point unfinished captures at their skills (`architecture not
captured - /project-architecture-analyzer`) and changes at the sibling commands. Nothing else -
this command's output IS the tables.

## Do not

- Never download the source, compute an upstream delta, or name what an update would bring -
  that is `configure`'s opening. Never write or delete anything, including `$TMP`.
- Never render a chosen area without its banner, merge areas into one table, or reorder them.
- Never emit a table in fragments - all reads done, then the block in one piece.
- Never paste file bodies (a doc's stamp line is the exception) - tables only.
