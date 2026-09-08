# CLAUDE.md - claude-stack repo

## What this repo is

The single source of truth for the **Claude Code** half of the house coding-agent setup -
not an application. It collects everything applied to *other* projects: the house-style
skills, the base instruction template those projects extend, the hook scripts and
convention rules, and the installer that wires skills / MCP servers / plugins into each
project. The **Cursor** twin stack was split out to its own repo,
[`cursor-stack`](https://github.com/envoydev/cursor-stack) - its installers git-clone THIS
repo for the shared skills, so the skill + MCP baseline stays single-sourced here, and a
baseline change is a TWO-REPO commit (the manifest lists are mirrored there in the same
sitting; each repo lints its own `.sh`/`.ps1` twins). Consuming projects pull from here -
they do not own their copy. Skills install via the installers' one-snapshot download (the
versioned release archive, git-clone fallback; or the claude-stack plugin's
`/claude-stack:setup`); the rest is laid down by the same installers. The durable change always lives in *this* repo's source; a
change made only inside a consuming project is throwaway (see Invariants).

## Layout - one home per concern

- `stack/skills/` - the house-style skills, each a `SKILL.md`. Auto-activate on their own
  keywords / file types in consuming projects. Distributed via the stack installers'
  snapshot-download-and-copy step (or the claude-stack plugin) - including `cursor-stack`'s
  installers, which clone this repo.
- `scripts/os/claude-stack.{sh,ps1}` - the installer twins (Unix / Windows); `docs/claude-stack.html` is the browser inventory.
- `stack/CLAUDE.template.md` - the stack-neutral per-project skeleton (an authoring outline in a stripped comment plus a rules table to trim) that each
  consuming project's `CLAUDE.md` is filled in from; the working conventions ship separately in
  the `stack/rules/baseline-*.md` set. Content shipped to projects, not this repo's own file.
- `stack/hooks/` - `guard-protected-force-push.js` + `guard-catastrophic-rm.js` (PreToolUse `Bash` - a recursive `rm`
  of an unrecoverable target, and the git verbs that destroy a working tree with no reflog to recover
  from: `checkout --` / `restore` / `reset --hard` / `clean -f`, blocked only when the tree is actually
  dirty, so a clean checkout passes; the guard had zero git coverage and a destructive `git checkout --`
  replayed exit 0 against every guard in the stack) +
  `guard-read-whole-file.js` (PreToolUse `Read` + `Bash` - the same dump routed through the shell) + `guard-secret-value.js` (PreToolUse `Read` + `Bash` - a credential is read for PRESENCE, never its value: blocks a Read or a dump verb on a JSON/dotenv file holding a `secret_key_pattern` key with a live value, judged by CONTENT since the path-based deny list leaves a project settings.json open and that is where the measured leak came from; an `echo $SECRET`, a bare `env`, and a credential-shaped literal in a command; its own `--presence <file> [KEY ...]` mode is the sanctioned read the guided commands call) + `guard-unapproved-dispatch.js` (PreToolUse
  `Task|Agent` - blocks an `*-implementer` dispatch without the `<docs-path>/flow/APPROVAL` gate
  file the flows write on explicit user approval or an explicit AUTO waiver, and blocks a generic `general-purpose`/`claude` dispatch while that stamp is live; stamps older than 8h or older than the session are absent; also blocks an `Explore`/generic dispatch whose brief asks a SYMBOL question - callers, declaration site, resolved type - since a grep-shaped seat answers those by name-match and the built-in `Explore` loads none of the project's rules) +
  `guard-ungated-commit.js` (PreToolUse `Bash` - the publish ceremony, both halves in one hook because
  they share the receipt machinery and the heredoc/quote masking: blocks a non-trivial `git commit` without the
  `<docs-path>/flow/COMMIT-GATE` receipt the pre-commit checkpoint writes on VERIFIED gates or an
  explicit user waiver (trivial diffs pass), and blocks `git push` / `gh pr merge` without the same-shaped
  `<docs-path>/flow/PUSH-GATE` receipt - nothing gated publishing before, and across four audited sessions
  every push and merge passed every guard, one putting 40 files on a shared `develop`. A dry run or a branch
  level with its upstream publishes nothing and is never gated; `CLAUDE_STACK_PUSH_GATE=0` turns that half
  off where the remote is already gated) +
  `guard-stop-contract.js` (dual-wired: a `Stop` hook that blocks a turn ending on a
  decision-shaped question in prose, or on a 'done, next step pending' close stated as fact - the blocking-ask mandate mechanized; a close that says the RUN has nothing pending ('Nothing is pending on this run - these are yours to run when you choose.', the line the four guided walks end their suggestion card with, pinned in shared-rules.json) is finished, not stalled - and, on a CLEAN close past 40% of the context window (`CLAUDE_STACK_FRESH_SESSION_PCT`, floored at the measured 150k on the 200k tier and CAPPED at 250k above it - 40% of a 1M window is 400k, above the ~390k the harness itself auto-compacts at, so the gate could never fire on a 1M account; the window itself resolves in three layers, `CLAUDE_STACK_CONTEXT_WINDOW` first, then the settings.json model id's own `[1m]`-style suffix (the transcript strips it; `cost-state.modelUsage` keys off the same id and is the second source), then what the session has already carried, latched once proven. The percentage is seeded absent-only; the window box is seeded with the sentinel `AUTO`, because the old `1000000` seed outranked every detection layer and killed the gate on every install that was not a 1M account, and the empty string that replaced it read as a variable nobody had filled in - anything that is not a window size detects, a number overrules), holds the turn ONCE so the user is asked whether to resume in a fresh session; it re-arms only when the context has grown 1.5x, and it fires after the work is finished, never mid-response - the PreToolUse `AskUserQuestion` wiring that used to deny the ask itself is gone - new installs do not wire it and a migration unwires it from old ones) +
  `guard-fresh-session-start.js` (three routes into one decision - a deliberate orchestration run
  (a capture, a loop, a solve flow, a review, one of the four guided plugin walks) must not start on another finished run's carried
  history past the same window-scaled trigger (the same three-layer window resolution). PreToolUse `Skill`
  BLOCKS it; `UserPromptSubmit` INJECTS the ask for the same run invoked as a slash command, which emits no
  Skill event at all (measured: 4 of 4 runs slash-injected, zero Skill events in 45 messages) and never denies,
  since a UserPromptSubmit denial erases the user's prompt; `SessionStart` matcher `compact` injects it at the
  auto-compaction, which proves the session hit the ~390k ceiling at a moment a Stop may never come. The
  capabilities rule's prose form lost in 4 of 4 audited sessions) +
  `guard-cross-project-write.js` (PreToolUse `Write`/`Edit`/`NotebookEdit`/`Bash` - one session
  belongs to ONE project: a write whose target resolves outside the project root is blocked, via
  the file tools or the shell routes around them (redirection, `tee`, in-place `sed`/`perl`, a `cp`/`mv`
  destination, `rm`/`mkdir`/`chmod`, `git -C <other>` with a mutating subcommand, or a `cd <other>`
  followed by one or by a relative write), and the change the other
  repo needs goes to a task card under `<docs-path>/cross-project-tasks/` instead. READING another
  repo stays open - that is what makes the card specific. The session's own scratch, the `~/.claude` /
  `~/.claude-<space>` account dirs and `/dev` stay writable; a `>` or verb inside a quoted string is
  prose; an allowance containing the project root is dropped, both
  sides are compared as REAL paths (macOS `/tmp` is a symlink) and a Git Bash mount path (`/c/...`,
  `/cygdrive/c/...`) is read as the Windows path it names before any resolution - node on win32
  resolves that spelling against the current drive, which blocked a session cleaning its own temp
  scratch (the read-whole-file and ungated-commit guards translate it too), an unexpanded variable is never
  judged, and `CLAUDE_STACK_ALLOW_WRITE_OUTSIDE` opens a second tree a project genuinely owns) +
  `guard-answer-length.js` (dual-wired: a `UserPromptSubmit` hook that appends the answer budget -
  3 sentences plus points, ~900 chars of prose, code/tables exempt - to every turn's context, and a
  `Stop` hook that blocks an answer past the 1800-char prose cap when the user's own message asked
  for no depth; the short-answer contract mechanized after it failed as prose), all wired; plus `instrument-tool-usage.js`,
  wired env-gated (per-run tool/skill/MCP stats; a sh gate skips the node spawn unless the
  settings-env switch CLAUDE_STACK_INSTRUMENT - seeded "0" - is flipped to "1" for a measured run).
  Every wired hook carries `"timeout": 10` in settings.json: they run in 22-25ms (measured, almost
  all of it the node spawn), while a `command` hook with no timeout takes Claude Code's 600s default -
  one stalled `git rev-parse` would freeze a session for ten minutes. Each guard also appends one row
  per BLOCK to `<docs-path>/hook-blocks/<session>.jsonl` (`analyze-usage.js --hook-blocks` tallies it):
  a block costs its denial text plus the retried turn, so the block RATE is the number that says a
  gate earns its keep, and the transcript alone records only which TOOL was denied, never which hook.
  Copied from the run's clone into a project's `.claude/hooks/` (wired with the placeholder quoted - `"$CLAUDE_PROJECT_DIR/.claude/hooks/<file>"` - so a project path with a space works; an update rewrites the older unquoted text in place); a hooks layer in the guided walk
  makes them selectable per install (a selection with no `hook` lines installs all eleven).
- `stack/agents/` - the Claude-contract subagents, 43 total: the four build/test resolvers - .NET
    (`dotnet-build-error-resolver`, `dotnet-test-failure-resolver`) + Angular (`ng-build-error-resolver`,
    `angular-test-resolver`) - plus four cross-cutting agents (`ci-failure-diagnoser`, `runtime-failure-diagnoser`, `security-auditor` - a read-only
    cross-stack security posture audit that routes an OWASP/CWE punch-list to the implementers, complementing
    `/security-review` - and `integration-reviewer`, the mandatory read-only cross-domain final gate that
    checks the assembled feature against the frozen contract before commit) - plus
    30 per-domain seats, the same 3-agent vertical repeated across 10 stacks (ASP.NET, web Angular, WPF, WinForms,
    console, Windows Service, Ionic Angular, data, DevOps, browser extension - the five C# verticals split by surface: ASP.NET web/API,
    WPF desktop, WinForms desktop LOB, console the headless Generic-Host worker/bot/daemon/CLI, windows-service the SCM-hosted
    worker; the three TypeScript verticals by runtime surface: Angular web, Ionic/Capacitor mobile, MV3 browser extension): `<stack>-solution-designer` (decomposes into parallel tasks) → `<stack>-implementer`
    (builds one task, code + tests) → `<stack>-verifier` (gates the assembled build vs plan + quality,
    punch-list loop) - plus five read-only sonnet support seats: `evidence-gatherer` (sonnet/low - the two
    diagnosers dispatch it to reproduce and pull logs), `test-coverage-analyzer` (sonnet/medium - the read-only
    per-surface coverage characterizer the `project-test-coverage-analyzer` skill fans out over the raw
    instrumented output; the suite run itself stays in the main session), `architecture-analyzer` (sonnet/low - the
    `project-architecture-analyzer` capture fans it out to characterize modules) and `code-style-analyzer` (sonnet/medium - the read-only
    per-language style characterizer the `project-code-style-analyzer` skill fans out and merges into
    `<docs-path>/PROJECT-CODE-STYLE.md` + the generated path-scoped project-code-style rule) and `related-project-analyzer` (sonnet/medium -
    characterizes one sibling repo, the `project-related-context` skill fans it out and merges
    `<docs-path>/related-context/PROJECT-RELATED-CONTEXT.md`), each keeping read volume off the opus seat.
    the architecture capture is deliberate-only (the `project-architecture-analyzer` skill - dispatches
    `architecture-analyzer` per module, reasons in the main session, writes `<docs-path>/architecture/ARCHITECTURE.md` +
    the pros/cons `<docs-path>/architecture/ASSESSMENT.md` + the generated always-on awareness rule
    `baseline-project-architecture.md`; never in a build flow); the per-change fit
    verdict moved to the domain solution-designers. The `project-solve-cross-task` skill is the single
    entry-point orchestrator - it picks the execution mode, runs a single stack's vertical per its
    `references/domain-trio-protocol.md` (main-stack-agents-flow was folded into that reference),
    and for cross-domain work freezes the shared contract and drives the parallel
    per-stack runs through the `integration-reviewer` final gate. All 43 carry
    frontmatter model/effort pins (resolvers `sonnet`/`high`, designers `opus`/`xhigh`, verifiers
    `sonnet`/`xhigh`, implementers `sonnet`/`medium`, the five support seats `sonnet`). Copied from
    the run's clone into a project's `.claude/agents/`. The `cursor-stack` repo ships adapted twins of all 43 - a
    protocol change to an agent here usually needs the same edit to its twin there (the deliberate
    divergences are only the platform gaps, listed in that repo's CLAUDE.md: `model: inherit`, no
    per-tool `tools:` allowlist, `superpowers` optional, no auto-delegation hard-disable).
- `stack/rules/` - eighteen rules, fetched into a project's `.claude/rules/`, each doing ONE job. Six
    are the always-on `baseline-*.md` set (no `paths:` - the cross-project working conventions grouped
    by exclusion affinity: interaction (communication + proposal review + planning), quality-gates
    (code quality + definition of done), security, git + pre-commit, navigation, docs-root (the
    generated-docs root - `CLAUDE_STACK_DOCS_PATH` resolution, what lives under `<docs-path>`; the env var
    is the ONLY lever, no CLAUDE.md restatement - the installers stamp the resolved value over the
    rule's `__DOCS_ROOT__` placeholder on every install/update, and setup/configure re-stamp after
    an env change) - loaded every session and
    subagent like `CLAUDE.md` but refreshed on `update`, individually excludable via the manifest;
    the skill/agent usage policy + per-project MCP routing live in the GENERATED
    baseline-project-agent-capabilities.md, written by the `project-agent-capabilities` skill).
    The other twelve
    are path-scoped, lazy-loaded on a matching file touch: `markdown-docs.md`, the two repair-loop
    routers (`dotnet-repair-agents.md` / `angular-repair-agents.md`), and the nine convention rules
    (`javascript-conventions.md` / `typescript-conventions.md` / `angular-conventions.md` /
    `angular-styling-conventions.md` /
    `csharp-conventions.md` / `wpf-conventions.md` / `winforms-conventions.md` / `sql-conventions.md` / `devops-conventions.md`)
    each glob-attaching ONE file family to its house-style skill - single-job so a stack a project
    lacks is simply not installed; the soft replacement for the retired require-convention-skill
    hard gate.
- `setup-plugin/` - the claude-stack plugin: five guided COMMANDS, `/claude-stack:setup` (fresh install from scratch), `/claude-stack:update` (no-questions refresh + prune of upstream-removed artifacts, computed from the stamp compare; the script route prunes only the known renamed names in the installers' RETIRED_SKILLS / RETIRED_AGENTS / RETIRED_RULES / RETIRED_HOOKS / RETIRED_MCPS lists - extend both twins' lists when ANY of the five is renamed or removed, and note that a stamp compare only names what left AFTER the stamped commit, so an older leftover is caught by the lists alone; a retired rule is the costly one, since a pathless baseline-*.md loads into every session beside the rule that replaced it, and a retired hook keeps its settings.json wiring until the same run drops it; a retired MCP is the same shape one layer out - it stays registered and re-injects its tool schemas into every session, measured at 24 schemas for a browser server on a headless backend project. RETIRED_MCPS ships empty: the mechanism is what was missing. A server the stack still SHIPS but a project no longer needs is validate's whole-stack-absent pass, not a retirement), `/claude-stack:configure` (adjust an existing install - add or drop), `/claude-stack:status` (read-only per-area tables of the install - skills/agents/rules/hooks/MCPs/plugins/env/generated docs with capture dates) and `/claude-stack:validate` (reconcile an install against THIS project - prune what its frameworks do not use (whole-stack-absent) AND add the detected stacks' missing artifacts, the project-relative two-way audit configure does not do; project mode only, a per-layer walk like setup/configure driven by `stack-select.js --redundant` / `--missing` / `--evidence-gaps`, plus an ENVIRONMENT layer - the settings.json `env` block reconciled against `environment.json`: keys a release introduced, an old spelling still present, a value failing its shape), their data catalogs in repo `meta/` (`environment.json` - the ONE list of the settings.json `env` values this stack owns, read by setup / configure / validate and lint-checked against both installer twins' seeds, so ADDING a variable is one row plus the two seeds, never three command edits; its `_comment` carries the row shape; `recommendations.json` - the seeds + the never-flag `general` list, which also holds the project-conditional opt-ins no stack owns and no manifest signal can prove: the `project-related-context` / `related-project-analyzer` pair applies only where the project has sibling repos, so it is addable-not-seeded and never re-added by validate - and `evidence.json`, the need-signal catalog `scripts/scan-evidence.js` matches the project's package manifests against: evidence rows arrive pre-selected with the matched signal as the reason, absence is advisory-only, and evidence never creates a `required` lock), plus the `/claude-stack` router SKILL (answers with the right command). The split is display-driven, empirically proven: plugin commands list namespaced-only (`/claude-stack:setup`, like claude-hud's), plugin skills list bare - so workers-as-commands kills the generic bare `/setup`-`/update`-`/configure`-`/validate` entries, and router-as-skill (named exactly like the plugin) lists as bare `/claude-stack` instead of the `/claude-stack:claude-stack` stutter a router command produces. Do not convert either back.
- `meta/` - the repo's own registries, never installed into a project: `shared-rules.json` pins
  every deliberate multi-home rule (one canonical owner + its inline restatement sites, each copy
  marker-pinned; no prose cross-mentions in the bodies) - the lint goes red when any copy's marker
  breaks, so a multi-home edit syncs all copies mechanically; the generated `stack-graph.json`
  (the dependency graph `stack-graph.js` builds and `stack-select.js` reads at guided-install
  time - regenerate with `npm run graph`, the lint fails when stale); and the guided commands'
  catalogs (`recommendations.json`, `evidence.json`, `plugin-settings.json` - the recommended
  settings the stack offers for an INSTALLED plugin's own config file (today claude-hud's
  account-level `plugins/claude-hud/config.json` plus the `statusLine.refreshInterval` its setup's
  block takes), applied by `scripts/plugin-settings.js`: the walks REPORT the delta and ask
  inside the plugins layer's own turn (setup step 8 / configure step 8) and apply the answer once
  the installer has put the plugin on disk (10a / 11a), the same ask-early-apply-after shape the
  environment choices use. Add-only by default so a value the user already chose is reported
  and kept, `--replace` is the explicit overwrite, a target whose gate block is absent skips
  itself, and every row names the plugin VERSION its keys were read from - lint check 28 rejects a
  row for an uninstalled plugin, a missing `verified` version or a key group with no `why` -,
  `judgment.json`, and `migrations.json` -
  existence-detected retirements of GENERATED per-project artifacts, applied by update / flagged
  by validate, since the upstream file compare can never name generated output; it also carries the
  settings.json `env` RENAMES (`detect.settings_env_key` + `rename_settings_env`) the installers'
  env pass applies on every run - the order and its reason live in that file's `_comment`, pinned
  as `env-pass-order` in shared-rules.json. Every consumer of a renamed key reads the old spelling
  as a fallback until the rename has reached every install - `CLAUDE_STACK_DOCS_PATH` is the first
  of these, ex-`CLAUDE_DOCS_PATH`). Commands reach ALL of
  these through the run's snapshot (`$TMP/repo/meta/`), never `${CLAUDE_PLUGIN_ROOT}` - the
  installed plugin package is `setup-plugin/` only, so nothing in `meta/` exists inside it.
- `scripts/lint-skills.js` - the parity lint (below). `scripts/analyze-usage.js` - offline
  token/tool consumption report over a session's transcript JSONL (+ its `subagents/`), the token
  side of the flow instrumentation (`instrument-tool-usage.js` is the identity side - hooks never
  see tokens). `scripts/scan-evidence.js` - the deterministic evidence scan the guided commands
  run against a project (manifests only, no restore/network; conclusions computed per run, the
  catalog ships only signal definitions). `README.md` - deliberately compact: what the repo is, technologies, the two install routes (plugin / script), headline counts (lint-checked), and the usage-analysis pointer - no per-surface inventories (those live in `docs/claude-stack.html`) and no deep operational docs (env vars, troubleshooting - the guided plugin flow covers prerequisites interactively; history has the old text).

The **Cursor** delivery - installers, the 43 agent twins, `.mdc` rules, hooks,
`AGENTS.template.md` - lives in the `cursor-stack` repo (its own CLAUDE.md documents the
platform gaps and the twin-maintenance rule).

## The stack's delivery surfaces (and the Cursor twin repo)

The Claude Code delivery, per surface. Skills, hooks, agents, rules and the CLAUDE.md template all
come from the SAME one-per-run source snapshot (the newest release archive, or the shallow-clone
fallback), so an install is a single revision - the one `claude-stack.stamp` records:

| Surface | Delivery |
|---|---|
| Skills | installer snapshot-download + copy → `.claude/skills` (or plugin `/claude-stack`) |
| MCP | `claude mcp add` → `<repo>/.mcp.json` |
| Plugins | 7 via `claude plugin install` (superpowers, claude-md-management, the `*-lsp` pair, security-guidance, claude-hud, ponytail) |
| Hooks | copied from the snapshot → `.claude/hooks/`, wired into `.claude/settings.json` (all eleven; instrumentation env-gated off via CLAUDE_STACK_INSTRUMENT=0) |
| Agents | `.claude/agents/` - the 43 model/effort-pinned subagents described under Layout. Copied like hooks; per-tool `tools:` allowlist |
| Install stamp | `claude-stack.stamp` (project `.claude/`, or the account dir when scope=global) - the source commit this install came from; `/claude-stack:configure` diffs it against `main`. Machine-local (covered by the `.claude/*` gitignore line) |
| Convention gate | nine path-scoped convention rules in `.claude/rules/` (soft, glob auto-attach - each points a file type at its house-style skill; replaced the `require-convention-skill` hard gate) |
| Security review | `/security-review` (diff/PR) + `security-guidance` hooks (commit-time) + the `security-auditor` agent (opus/xhigh, read-only posture audit routing an OWASP/CWE punch-list to the implementers) |
| Project instructions | `CLAUDE.md` (seeded to `.claude/CLAUDE.md`) |
| LSP | `csharp-lsp` / `typescript-lsp` plugins |

The Cursor deliveries of the same surfaces (`.cursor/skills`, `.cursor/mcp.json` with tokens
pre-resolved, no plugins, `.cursor/hooks.json`, `.cursor/agents/` twins, `.mdc` rules, Bugbot
`/review`, `AGENTS.md`) live in the `cursor-stack` repo - `SKILLS` and `MCPS` stay identical
across the two repos' installers by the two-repo-commit discipline; the platform gaps are
documented there.

## The model these templates encode

- **MCP servers are per-project, never global.** Two are LOCKED into every install by an always-on
  rule's backticked mention - `serena` (baseline-navigation) and `context7` (baseline-quality-gates) -
  so artifacts may name them; every other server is recommended or stack-seeded and droppable, so a
  body describes it. Only three are STACK-NEUTRAL enough to seed into every project - `context7`
  (docs), `serena` (symbol nav + edits + per-project memory) and `memory` (cross-project recall);
  the rest reach a project by proof, never by assumption: a stack whose surface always has them,
  or an evidence signal in the project's own manifests. Catalog (8): those three plus
  `playwright` (browser - seeded for the web-angular / ionic / extension stacks, evidence-proven
  by `Microsoft.Playwright` / `@playwright/*` anywhere else; it used to sit in the always-baseline
  and shipped a browser driver to every WinForms and console install), `angular-cli`
  (framework-specific - comment out where not
  applicable), `chrome-devtools` (browser/extension debug), `appium-mcp` (native mobile E2E -
  Capacitor/Ionic, needs Xcode/Android SDK + Java) and `sentry` (error monitoring - the hosted
  remote MCP, registered as the CONSTANT `https://mcp.sentry.dev/mcp/${SENTRY_SLUG}` with the header
  `Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}`; both placeholders stay LITERAL in the
  registration and expand at launch from the ACCOUNT settings.json `env` (`~/.claude/settings.json`,
  or the space's - the one file measured to reach `.mcp.json` expansion; a project-level
  `.claude/settings.json` does not; `${env:VAR}` + OS env on Cursor). The guided commands make the
  user fill both in whenever sentry is present: `SENTRY_SLUG` = the org, or `org/project` (Sentry's
  recommended scoping; the installers' `--sentry-slug` seeds it), `SENTRY_ACCESS_TOKEN` = a
  personal/org API token the user adds by hand, never through the chat. `Sentry-Bearer` is the scheme
  for an API token; plain `Bearer` is the server's OAuth-issued token scheme and rejects an API token
  as `invalid_token`; `--sentry-auth oauth` registers no header instead, so Claude Code runs the
  browser consent flow on first connect (a set-but-wrong header disables that fallback, so the modes
  never mix). Unset, `${SENTRY_SLUG}` stays literal: the server accepts the path on tools/list and
  fails every call naming the variable, and `claude mcp list` warns - diagnosable, unlike
  `${SENTRY_SLUG:-}`, whose trailing slash the server 404s (both measured). `update` keeps the
  registration's auth mode; an old plain-`Bearer` registration migrates to the fixed header.
  `SENTRY_AUTH_TOKEN` is a different credential - sentry-cli's release/symbol upload, needing
  `project:releases`. Comment out where the project has no Sentry). The heavy two (`chrome-devtools`,
  `appium-mcp`) fail at launch without their native deps - comment them out where not applicable. The `memory` MCP (one shared
  SQLite DB under `$HOME`) is the cross-project store - the per-project transient handoff runs
  on serena's local memory (durable orientation is the committed architecture docs), so comment
  `memory` out in a standalone project.
- **serena self-activates via `--project-from-cwd`**, not a hook: it finds `.serena/project.yml`
  in its cwd (the project root) and binds on process start, zero model involvement. That flag only
  RESOLVES the root, though: the config serena AUTO-GENERATES for a root without one is not a
  substitute (read in serena 1.7.0, `serena/config/serena_config.py`) - `ProjectConfigAutoGenerationMode.ASYNCHRONOUS`
  writes the language list EMPTY and fills it from a background thread, and
  `_determine_project_language_servers` enables only the single TOP language by file count when it
  is not interactive, so a C#+Angular repo gets one server and a lookup racing the background pass
  gets none. The installers therefore SEED `.serena/project.yml` on install and update - project
  name, the `language_servers` their own narrow file scan detects (C#, TypeScript/JS), and
  `ignored_paths` for `.serena` / `.claude` / `.playwright`, without which the indexer walks
  serena's own ~327MB language-server tree (measured: 126 files attempted, 112 failed). A key that
  already carries entries is never rewritten, and neither is ever appended twice - serena's own
  generated file ships both keys EMPTY, and a duplicate YAML key is an error, not an override. The
  key was renamed from `languages` in 1.7.0 (`ProjectConfig.RENAMED_FIELDS`, which still migrates
  the old spelling), and the C# Roslyn server needs .NET 10+, which serena installs itself into
  `SERENA_HOME` when it is missing. Two approaches
  that look right but FAIL - do not retry: (1) an `mcp_tool` `SessionStart` hook calling
  `activate_project` never fires before serena connects; (2) `--project ${CLAUDE_PROJECT_DIR}` is the
  wrong lever - use `--project-from-cwd` (above). Current Claude Code *does* expand `${VAR}` /
  `${VAR:-default}` in `.mcp.json` (command/args/env/url/headers), so the blanket 'no `${...}`
  expansion' was too broad; the catches are that `CLAUDE_PROJECT_DIR` isn't reliably in scope at
  `.mcp.json` parse time for a non-plugin config, and that the expansion reads the SHELL
  environment Claude Code starts in plus the ACCOUNT settings.json `env` (`~/.claude/settings.json`
  or the space's) - a PROJECT-level `.claude/settings.json` / `settings.local.json` `env` value stays
  literal in the config (measured in a trusted project: it reaches the MCP child process environment,
  not the config expansion; an unset `${VAR}` stays literal with a `claude mcp list` warning,
  `${VAR:-}` expands to empty). So a value a remote server's header or URL must read belongs in the
  account file, which is also where the installers' next-steps point. Cursor runs
  serena with `--context ide-assistant`; Claude with `claude-code`.
- **serena state is isolated per project** via `-e SERENA_HOME=.serena/home` (relative, resolved
  from cwd): registry, logs, and language servers live in-project under `.serena/home`, and serena's
  project memories live alongside in `.serena/memories/` - so nothing pools across projects or
  accounts (default `~/.serena` keys off `$HOME`, merging every repo across both Claude config dirs).
  Cost: the LSP is re-downloaded per same-language project (~327MB for C# Roslyn); the whole `.serena/`
  must be gitignored (it holds the LSP cache and the memories).
- **serena holds local memory; the `memory` MCP is the cross-project store.** Three stores,
  don't conflate: the file-based auto-memory (`MEMORY.md` + `memory/*.md`, harness-injected);
  **serena's per-project memory** (`.serena/memories/`, name-addressed, local to the repo and
  gitignored - the store for the transient per-feature subagent handoff, not durable orientation); and the `memory`
  MCP (one SQLite DB under `$HOME`, shared across projects *and* accounts - active in the baseline
  for cross-project recall; a space arg names its DB `memory_<space>.db` and, on Claude, selects
  the `~/.claude-<space>` account). Comment `memory` out in a standalone project. Cross-project
  *structure* - which repos are related and where they live - lives in each repo's generated
  awareness rule (`.claude/rules/baseline-project-related-context.md`, written by the
  `/project-related-context` skill), not in memory.
- **Two stores, split by durability** - the second hard rule (peer of the read-whole-file rule
  below). The committed architecture docs - a lean `<docs-path>/architecture/ARCHITECTURE.md` core map plus the deep-dive
  files under `<docs-path>/architecture/references/` it links to - are the DURABLE truth: every seat READS them at start
  to orient (the structure, patterns, boundaries and packages already in place) instead of re-deriving
  the project, and the `project-architecture-analyzer` skill owns them (plus a `<docs-path>/architecture/ASSESSMENT.md` pros/cons
  doc), reasoning in the main session over `architecture-analyzer` module digests - refreshed deliberately via that
  skill or the `project-architecture-quality-loop`, never after each change lands; the project's actual code style lives alongside in `<docs-path>/PROJECT-CODE-STYLE.md`, owned by the `project-code-style-analyzer` skill (fans out `code-style-analyzer` per language and generates the path-scoped `project-code-style.md` rule that attaches the style core on any matching file touch - main session and subagents; replaced the inject-code-style hook, whose injected context never reached subagent tool calls). serena's
  per-project memory (`write_memory` / `read_memory` / `list_memories`, named
  `<feature>__<contract_version>__<seat>`, never the shared `memory` MCP) is the EPHEMERAL inter-agent
  comms bus - the transient per-feature handoff between seats: a diagnoser's task cards to the
  implementer, the implementer's build summary to the verifier, a short 'what to do' context note -
  info that is not durable architecture. serena memory is local and disposable; a reference that must
  survive a fresh clone belongs in the committed docs, not memory.
- **Never `Read` a whole file to find a symbol** - the hard rule shipped to both stacks: locate via
  serena (`find_symbol` / `find_referencing_symbols`) or the LSP; `Read` is for code already located.

## Working in THIS repo - invariants

- **`develop` is where work lands; `main` is the release branch.** Commit to `develop` (or a
  branch off it); merging `develop` -> `main` IS the release act - the release workflow rebuilds
  the release archive from that merge, and that revision is what every install delivers. ONE
  version everywhere: the workflow tags each release `v<version>` from
  `setup-plugin/.claude-plugin/plugin.json` - the same manifest the marketplace serves from
  `main` - so bump it (plus `marketplace.json` metadata; the lint enforces they stay equal) on
  `develop` as part of any release-worthy change.
  Never commit feature work directly to `main`, and keep `main` the GitHub default branch (the
  README's raw installer bootstrap delivers the default branch; the installers' and skills'
  clone fallback is pinned `-b main` regardless). The lint + test workflows gate every push and
  PR, so a merge to `main` only ever promotes a green tree.
- **Public repo.** No private project names or absolute local paths in any tracked file - generic
  'consuming project' references only; real names / paths stay in untracked local files.
- **Parity / source-of-truth.** A change to skills / MCPs / hooks / rules / plugins lands in the
  SOURCE here, kept in parity: `SKILLS` + `MCPS` + `PLUGINS` identical across both `claude-stack`
  twins - **`npm run lint` enforces it** (and that the HTML agrees, and the skill count). A change
  to the shared `SKILLS`/`MCPS` baseline is additionally mirrored into the `cursor-stack` repo's
  manifests in the same sitting (cross-repo parity is discipline, not a networked lint). Never patch
  only a generated `.mcp.json` or a consuming project's copy - the installer
  regenerates and silently wipes it.
- **Select a skill by DESCRIPTION, not by name.** Naming works only for a skill guaranteed
  alongside its citer - a frontmatter preload, an own-stack skill. Everything else is per-project,
  in two absence classes: a skill no stack seeds (evidence-gated or opt-in), and one belonging to a
  DIFFERENT stack than the artifact citing it - an always-on agent naming `angular-security` breaks
  in every .NET-only install. So a brief says what the skill COVERS ('the skill covering Angular
  hardening - template injection, CSP, token storage'), which the model matches against the
  installed inventory and which still tells a seat without it what to do. A guard phrase beside the
  name is NOT the remedy - it makes absence safe but leaves the name as the invitation and teaches
  nothing. `npm run lint` checks 25 and 26 block a named cite that can be absent; a router hub opts
  out with an `**Availability**` callout, since a name -> area table IS its content. A pointer
  ('boundary rules live in `x`') is not a directive. And naming a skill NEVER puts it into an
  install: the `suggests:` frontmatter that carried those edges is removed (it offered
  `angular-security` on a WinForms install, `dotnet-aspire` on a project with no Aspire,
  `dotnet-authentication` on a browser extension), check 27 keeps it out, and the graph emits no
  edge from a body mention either. An install need is PROVEN, never inferred: `meta/evidence.json`
  matched against the project's own manifests, or a per-stack seed in `meta/recommendations.json`.
  What a seat loads at runtime stays a body matter, by description.
- **One home per piece, no duplication.** A deterministic gate at a discrete event → a hook
  (`hooks/`). A per-file-type convention → a path-scoped rule that glob-attaches
  its house-style skill (`.claude/rules/`). A keyword capability → the skill's own description.
  Cross-cutting guidance → the always-on `baseline-*.md` set (fleet-updatable): interaction,
  quality-gates, security, git, navigation - each with an `.mdc` twin in `cursor-stack` that a
  content change must be mirrored to. The base template (`stack/CLAUDE.template.md`)
  carries only per-project structure + platform routing, never the baseline conventions. Never state one
  trigger twice.
- **Prove a behavioral change, don't assert it.** A change to a model / effort pin, a routing rule, or a
  plugin set - any claim the flow got cheaper or still catches the same bugs - ships only with evidence:
  run the affected build + tests yourself and read the code (never a run's self-report), measure the cost /
  token delta when the claim is about cost, and commit that evidence (a benchmark note or branch) BEFORE any
  reset. An earlier reset destroyed an unverified 'green' claim - so evidence lands first. A claim about the outside world - a package, a version, an API shape, a CLI flag - is verified through context7 in the same sitting and the evidence cited; the build passing says nothing about whether the API is still the current one (measured: two audits found drifted version-coupled claims in shipped artifacts, both compiling fine).
- **House voice:** direct, lean, single dashes not em-dashes, single quotes in prose, recommend one
  option with a reason.

## Maintenance gotchas

- The installer regenerates `.mcp.json` on every run - fix the template, not the output.
- Editing a consuming project's installed copy is local-only; mirror the change into this repo's
  installer twins (both shells) or the next install wipes it - and into `cursor-stack`
  when the change touches the shared skills/MCP baseline or a twinned agent/rule.
- **Everything installs from ONE source snapshot** of this repo, taken once per run (`stack_src` /
  `Get-StackSrc`): the release archive that `.github/workflows/release.yml` republishes on every
  release merge to main - tagged `v<plugin version>`, always served by the
  `releases/latest/download` URL, with a `RELEASE-SOURCE` file inside naming the exact commit +
  version - falling back to a shallow git clone when no release is reachable. Skills, hooks, agents, rules
  and the CLAUDE.md template are all copied out of it, so a change ships only once merged to
  `main` (the release branch - the workflow rebuilds the archive from the merge); until then the
  per-file fail-soft keeps any existing copy. The snapshot replaced the per-file `…/main/…` raw fetches - the raw CDN is per-file and
  ~5 min stale after a push, so a run could mix revisions. One snapshot = one revision, which is
  what makes the stamp below true. Never reintroduce a raw fetch of a repo-owned file.
- **One download per RUN, not per layer.** The plugin skills (`/claude-stack:setup`, `:configure`)
  must download anyway - they need `stack-select.js`, the graph, the template and the stamp diff
  before the installer runs - so they pass that extracted snapshot to the installer with
  `--source` / `-Source` and it skips its own fetch. A borrowed source is never deleted by the
  script (`STACK_SRC_OWNED` / `$script:StackSrcOwned` gates the cleanup); the SKILLS own removing
  their `$TMP`, on every exit path. Standalone (no `--source`) still fetches and cleans up after
  itself - keep that path working, it is the no-plugin install documented in the README.
- **The install is versioned, not the file.** Claude Code has no per-artifact version: `version:` is
  in the plugin.json schema and NOWHERE else (a `version:` key on a skill/agent/rule parses but is
  ignored - don't add one). Instead each run writes `claude-stack.stamp` (project `.claude/`, or the
  account dir for a global install) naming the source commit and release version; `/claude-stack:configure` diffs it
  against the new snapshot's commit (the GitHub compare API - an archive has no local history) to
  report what an update would bring. A run whose source never resolved writes NO stamp - a wrong
  stamp is worse than none.
- Authoring or editing a house skill in stack/skills/? The superpowers writing-skills method is a useful
  reference - subordinate it to the parity lint, the HTML + skill-count sync, and the house
  voice; take its skill-testing discipline, not its own formatting or its push-to-fork deploy step.
- Skills are shared with Cursor: a skill body must stay platform-neutral (execution-mode
  conditionals like 'INLINE when no dispatch' handle the platform delta inside the skill - never
  fork a skill per platform).
