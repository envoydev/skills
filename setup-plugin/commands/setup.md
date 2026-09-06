---
description: "FRESH install of the claude-stack, from scratch - ask scope + profile up front, then detect the OS + analyse the project and walk the selection in six dependency-ordered layers (rules -> agents -> skills -> hooks -> MCPs -> plugins): each layer shows ONE numbered table of the whole catalog (recommended pre-selected, locked rows carrying the required-by reason), then one selection round - Recommended / All / None, or typed numbers to add and drop. Prerequisite check, install, an OFFERED (never forced) CLAUDE.md fill-in, and a next-steps card (git-hygiene suggestions, the capture sequence in order, a per-language serena note) close the run. In a project, the selection is decided FROM the project (detected stacks seed the recommendations); outside any project it falls back to a global install seeded from the recommended set, stacks chosen by the user. NOT for an existing install - a plain refresh is the sibling update command, choosing what to add or drop is configure."
disable-model-invocation: true
---

# Set up the Claude stack - fresh install

You are bootstrapping the claude-stack FROM SCRATCH. If the stack is already installed here (a populated `.claude/skills` + `.claude/agents`, or the global account equivalents in no-project mode), stop and route to a sibling command: `/claude-stack:update` for a plain refresh, `/claude-stack:configure` to adjust the selection - updates are their job. Work the ladder in order and drive it interactively; the deterministic work is done by `stack-select.js`, you orchestrate. Two modes, detected silently before the first question: **project mode** (the normal case - cwd is a project root in a git repo; the selection is decided from the project itself) and **no-project mode** (anything else - a global install seeded from the recommended set).

**This run needs NO conversation context - so it is worth MOVING, but only out of a session that
is actually loaded.** Measure before you ask: this session's own per-message context is `input +
cache_read + cache_creation` off the last assistant message in the transcript. Ask ONLY when that
figure is past the same trigger `guard-fresh-session-start.js` uses - `CLAUDE_STACK_FRESH_SESSION_PCT`
percent (default 40) of the resolved context window - `CLAUDE_STACK_CONTEXT_WINDOW`, else the
settings.json model id's own `[1m]`-style suffix, else what the session has already carried, else
200,000 - floored at 150,000 on a 200k window and capped at 250,000 above it, so a default install
triggers at 150,000 tokens per message - or when that hook has already injected the ask into this turn. Below the
trigger, or when the figure cannot be read at all, SKIP the ask silently and start step 1: an ask
with no measurement behind it is the failure this replaced (measured: it fired on the FIRST message
of a brand-new session, twice in one run, and could quote no number when the user challenged it).
Never author the decision in prose either way.

When it does fire, put it through AskUserQuestion: run here anyway, or run in a fresh session
(recommended), quoting the figure you measured - never one measured in some other session. Every
answer names its next action: fresh session -> give the paste-ready one-liner and end the turn;
run here -> start step 1 now; not now -> say what is owed and end the turn. If a redirect displaces
the ask, re-offer it ONCE. Measured: this command's siblings entered at 131,345 and 168,516 tokens
per message with no ask at all, and one of them authored its own prose decision that was never put
to the user.

**ONE release archive is the entire download** - read `${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md` before step 1 and hold the whole run to it: download + extract once into `$TMP/repo` (the reference owns the fallback), use every tool from that snapshot, hand it to the installer with `--source` in step 10, and remove `$TMP` per the 'Clean up' section on every exit path. The protocol's 'Narrate, don't trace' section governs every tool call in this run: one quiet call per recompute, no pasted tool output, one narration line between steps.

**Every ask in this run goes through the AskUserQuestion tool** - concrete options, the recommended one marked, free text via Other; a prose question or a bare stop-and-wait is invalid (measured: prose asks were skipped in live runs while tool-shaped asks were answered every time). A plain-text option list is the fallback only where the harness lacks the tool.

## The ladder - announce every step

Eleven user-facing steps; the machinery between them runs silently. Before EVERY question, one banner line so the user always knows where they are, what is being decided, and what comes next:

```
[step 3/11 - rules] choose the rule set · next: agents
```

1 install choices · 2 project analysis · 3 rules · 4 agents · 5 skills · 6 hooks · 7 MCPs · 8 plugins · 9 prerequisite check · 10 install · 11 CLAUDE.md (optional)

**The skeleton is INVARIANT - the stability contract.** Every run prints all 11 banners, in this
order, exactly once each. A step that does not apply THIS run still prints its banner followed by
ONE line naming why it is a no-op (`[step 2/11 - project analysis] skipped - no-project mode,
stacks chosen by hand`, `[step 11/11 - CLAUDE.md] skipped - global install, no project file`),
then moves on - a step never silently vanishes, and steps are never merged, reordered,
renumbered, or invented. Two runs must be comparable banner by banner; the content varies, the
skeleton never does. The closing next-steps card (Post-check below) is part of the skeleton too -
every run ends with it.

## 1. Install choices

Detect silently first - the OS (`darwin`/`linux` -> `claude-stack.sh`; Windows -> `claude-stack.ps1` via `pwsh`) and the mode (project root in a git repo -> project mode; anything else -> no-project mode) - then ask TWO AskUserQuestion screens (the tool caps four questions per call; each default marked Recommended). **Screen A - the install itself:** scope (`project` default / `global`; in no-project mode this question becomes the no-project-mode confirmation instead - a `global` install into the account `~/.claude` - since there is no project to scope to), profile (the optional `--space` account name, default none), and the one conditional extra: 'install the GitHub CLI?', asked ONLY when `gh` is not already on PATH and skipped entirely when it is. **Screen B - the environment:** one question per `ask: true` row of the snapshot's `$TMP/repo/meta/environment.json`, which is the ONE list of the values the install writes into the scope's settings.json `env` - never a list typed from memory here, or a variable a release adds would silently stop being asked. Each question shows the row's `default` and its `what` in plain words; free text via Other. **Never print, echo back, or ask for a credential VALUE.** A key matching the catalog's `secret_key_pattern`, or a row flagged `secret: true`, is reported as `set (N chars)` or `absent` and nothing else - not as a shown default, not in a table, not in a question. A value that must be set is set by the user in the file itself, or with a copy-ready command they run in their own terminal; it never travels through the chat. Measured: seven credential exposures in one corpus. The only per-row behaviour that is not in the catalog: `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` takes a third answer beyond a percent - 'off', which is the `autoCompactEnabled: false` key with the pct override deleted rather than left dead beside it. Brownfield: when the target settings.json already carries a value, present THAT as the default - never silently override a pinned choice. Everything else moved to where it belongs: the context7 transport is asked at step 7 only if context7 ends up selected, and `--keep-pins` is a configure/update question - a fresh install has no local pin edits to keep, so never ask it here.

## 2. Project analysis - the stacks

Project mode - detect stacks by artifact and record which apply (this detection IS the recommendation input; decide from the project, not from a generic default):

- `*.csproj` / `*.sln` -> .NET. Split by content, per project: a `Microsoft.NET.Sdk.Web` project -> `aspnet`; `<UseWPF>true` -> `wpf`; `<UseWindowsForms>true` -> `winforms`; a `Microsoft.Extensions.Hosting.WindowsServices` reference (or a `ServiceBase` inheritor) -> `windows-service`; an EXECUTABLE carrying none of those markers (`<OutputType>Exe</OutputType>`, or `Microsoft.NET.Sdk.Worker`) -> `console`. A class LIBRARY is never its own stack: `Microsoft.NET.Sdk` with no `OutputType` (library is the default) - and a test project - is a surface of the app that references it, so a WPF solution's own libraries stay `wpf` and add NO `console` (measured mis-detection: libraries inside a WPF app pulled in the console agents + skills). When every .NET project in the repo is a library, ask which surface they serve instead of defaulting to `console`.
- `angular.json` -> `web-angular`; `ionic.config.json` / `capacitor.config.*` -> `ionic-angular`. An Ionic app matches `angular.json` too - when `ionic-angular` detects, do NOT also report `web-angular` for the same app; report both only when the workspace holds a second, distinct Angular app with no Ionic shell.
- a `manifest.json` carrying `"manifest_version"` (or a wxt/crxjs config) -> `browser-extension`.
- `Dockerfile` / `.github/workflows/` -> `devops`; `*.sql` / a migrations folder -> `data`.
- `tsconfig.json` / `jsconfig.json` -> `typescript` (the language-level seed - conventions rules + LSP plugin + ts-js-testing). A TS framework stack claims its own surface: when `web-angular` / `ionic-angular` / `browser-extension` detects, do NOT also report `typescript` for the same app - the framework seeds already carry the rules + LSP, and testing is `angular-testing`'s there (browser-extension seeds ts-js-testing itself); report both only when the repo holds a genuine non-framework TS surface too (Node tooling, a published library, scripts with their own tests).
- `package.json` with `.js` sources and NO `tsconfig.json`/`jsconfig.json` -> `javascript` (the plain-JS seed - the javascript-conventions rule + typescript-lsp, which serves JS too, + ts-js-testing, the shared TS/JS testing hub). One-way suppression: when `typescript` detects it covers JS as well - do NOT also report `javascript`; the framework stacks suppress it the same way (they carry javascript-conventions themselves).

Alongside the stack scan, run the EVIDENCE scan quietly - one call, one narration line:
`node "$TMP/repo/scripts/scan-evidence.js" --root . --catalog "$TMP/repo/meta/evidence.json" --out "$TMP/found.json"` - a deterministic read of the project's package manifests (csproj / Directory.Packages.props / package.json) against the signal catalog. Its `found` map feeds the walk's tables via `--found` and pre-selects what the project provably uses; the conclusions are computed from THIS project's files, never assumed.

A project can match several. Report the detected stacks and put the confirmation through AskUserQuestion (confirm as detected - recommended; adjust via Other, naming stacks to add or drop) - the walk starts IMMEDIATELY after this answer, no other question in between:

```
[step 2/11 - project analysis] confirm the detected stacks · next: rules
Detected: aspnet (src/Api/Api.csproj - Microsoft.NET.Sdk.Web), web-angular (angular.json), devops (Dockerfile + .github/workflows/)
```

Stack names are the catalog keys of `$TMP/repo/meta/recommendations.json` (`web-angular`, never `angular`) - `--stacks` takes exactly those, and the tool names an unknown one on stderr (`unknown-stack`) instead of silently seeding nothing.

No-project mode, and a repo with NO recognizable artifacts (greenfield): skip the artifact detection and instead present the stacks available in `$TMP/repo/meta/recommendations.json` as a multi-pick ('which stacks do you work with?' / 'what will this project be?'); picking none installs just the `always` baseline. Every later step applies unchanged.

## The walk - steps 3-8, one layer at a time

The layer order follows the dependency graph's arrows: rules pull agents + skills, agents pull skills, everything pulls MCPs and plugins, and hooks stand alone - dependencies only point FORWARD through the walk, so an earlier answer is never invalidated by a later one. Hold ONE running `raw.json` (in the temp dir) of the user's DIRECT picks per category (`rules`, `agents`, `skills`, `hooks`, `mcps`, `plugins`); locked items never enter it - the closure re-adds them at emit time.

Per layer, the SAME three-beat shape:

1. **Recompute quietly** - one call: fold the previous layer's picks into `raw.json`, run `node stack-select.js --selection raw.json`, parse the category-tagged `required: <category> <name> - <why>` lines yourself. The current layer's lines are its **locked** set.
2. **Show ONE numbered table of the layer's ENTIRE catalog** - every item the release ships, so nothing is ever offered later or out-of-band. The TOOL renders it, never you: `node stack-select.js --selection raw.json --table <layer> --recs <recommendations.json> --stacks <confirmed,csv> --found "$TMP/found.json"` - **never redirect that to a file**. The table comes back IN the tool result; paste those exact lines into your message inside a fenced code block. (Measured: the old form redirected to `$TMP/table.txt` and told you to paste the file - the tool result was then empty, the read-back was a step nobody took, and one real run asked all six layer questions with no table shown at all. If you want a copy on disk, `| tee "$TMP/table.txt"` - the pipe keeps the output visible.) **The layer turn has ONE fixed shape, in order: (1) the `[step n/11 - <layer>]` banner, (2) the fenced block holding the tool output byte-for-byte, (3) the step-3 selection question - a layer turn missing the fenced table is invalid: render the table and re-send.** Self-check before you send the question: your own message must carry the `total: N <layer>` footer line. It is not there unless you pasted the table. A prose grouping that feels equivalent (`Locked (5): ...` / `Recommended (12): ...` lines) is the exact failure this shape exists to prevent, and the run's narrate-don't-trace rule does not reach this paste - it is the rule's one sanctioned exception (the step-1 recompute already honored the quiet part). The paste is pre-padded by the tool, so it stays aligned at any length; a hand-written markdown table shears when the renderer flushes it in segments. The table ends in a `total: N <layer>` footer - part of the paste and the user's truncation check: fewer visible rows than the footer names (or a missing footer) means the display was cut down - re-paste in full, and never summarize rows into prose; the user decides from the whole catalog, not from a shortlist. Row numbers come from the tool and are stable across rounds. The tool labels each row: `required` (closure-locked, reason in the last column), `evidence` (the scan matched a signal - PRE-SELECTED, the matched signal shown as the reason, droppable like any seed), `recommended` / `stack:<name>` (seeded, droppable), `added` (the user's own pick), `-` (not selected). Recommended = the union of `always` + each confirmed stack in `$TMP/repo/meta/recommendations.json`, pre-selected:

```
[step 4/11 - agents] adjust the agent roster · next: skills
 # | agent                       | selected     | required by
---+-----------------------------+--------------+---------------------------
 1 | ci-failure-diagnoser        | recommended  | -
 2 | dotnet-build-error-resolver | stack:aspnet | rule dotnet-repair-agents
 3 | wpf-implementer             | -            | -
```

3. **One selection round - quick options + numbers.** Ask with the question tool, options in this order: **Recommended** (keep the table exactly as shown - the default), **All** (select every row in the layer's catalog), **None** (keep only the locked rows), and typed adjustments through the free-text answer - `add 3 7 12`, `drop 5`, or both (bare numbers mean add). A drop naming a LOCKED row is refused with its reason shown ('#2 stays - required by rule dotnet-repair-agents; drop that rule first (reopening step 3) or keep it'), never silently honored or silently ignored. Restate the outcome in one line (added N, dropped M), fold it into `raw.json`, and narrate the handoff to the next layer. An `unknown:` line from the recompute is a typo or a retired name - surface it, never pass it through.

## 3. Rules

Nothing in the graph depends on a rule, so this layer never has locked rows - it is the one fully free pick, which is why it goes first: the rules chosen here decide what later layers must keep.

## 4. Agents

Locked = agents the kept rules require (the repair-loop rules pin their resolvers, e.g. `required by rule dotnet-repair-agents`).

## 5. Skills

The full release catalog in one table - the generator `project-*` skills and every other house skill included, so THIS is the only place skills are ever chosen; later steps (CLAUDE.md included) never offer skill additions. Locked = every skill the kept rules and agents REQUIRE (rule attachments and `skills:` frontmatter preloads), each with the reason naming its dependent. A skill an agent's body merely names as a conditional load ('load X when...') gets NO row of its own: an artifact naming a skill must never put it into an install - a need is proven, not suggested. Rows the step-2 evidence scan backed arrive labeled `evidence` and PRE-SELECTED, the matched signal in the reason column ('MassTransit in src/Api/Api.csproj') - droppable like any seed. The scan IS the evidence mechanism: never hand-propose add-candidates beyond what the table already shows. The user adds or drops by number. The only skills seed is `always.skills` - the house METHOD set: the cross-task orchestrator plus the manual `project-*` method skills (the inline execution twins, the capture/loop generators, the upgrade planner), all pre-selected `recommended` and droppable; their need is 'the stack is installed', not anything a project manifest could prove, which is why they are seeded rather than evidence-scanned. The ONE deliberate exception is `project-build-from-scratch` - greenfield-only by its own description, dead weight on an existing project, so it is never seeded; offer it as an unselected row like any other, and only in a greenfield/no-project run is picking it natural. Beyond the seed set, selected = locked + whatever the user adds.

## 6. Hooks

Hooks are leaf picks - nothing requires them, they require nothing, so every row is free. Recommended = all ten: the nine always-on guards plus the env-gated `instrument-tool-usage` (wired like the guards, but inert until `CLAUDE_STACK_INSTRUMENT` flips to `1` - so keeping it costs nothing idle, and dropping it leaves the install unable to record a measured run without a manual re-wire). The installer wires the selected hooks into `.claude/settings.json` on install.

## 7. MCPs

Locked = the servers the kept selection pulls (`serena` via `baseline-navigation`, `context7` via `baseline-quality-gates`); recommended = the other two of the core four (`memory`, `playwright`) plus the confirmed stacks' seeds (browser/mobile servers). Everything else - `sentry` included - is a free add for projects that actually use it; note next to `sentry` that it needs two values in the ACCOUNT settings.json env (below). After the round, and only if context7 stayed selected, ask its transport here (`remote` default / `local`); and only if sentry stayed selected, run the **sentry environment plan** - ONE question asking the slug (`SENTRY_SLUG`: `<org>` or `<org>/<project>`, Sentry's recommended form; an EU-region org - its DSN reads `ingest.de.sentry.io` - must name it; required, re-ask on empty) together with the auth mode (`token`, default and recommended, vs `oauth` - browser consent, no key), and in the same screen TELL the user to add `SENTRY_ACCESS_TOKEN` (a personal or org API token: Sentry -> Settings -> Account -> API -> Personal Tokens) to the ACCOUNT `settings.json` `env` themselves - the file is `~/.claude/settings.json`, or `~/.claude-<space>/settings.json` under a space - never paste the token into the chat, and never a project-level `.claude/settings.json` (its env does not reach `.mcp.json` - measured). Show the exact snippet:

```json
{ "env": { "SENTRY_SLUG": "<org>[/<project>]", "SENTRY_ACCESS_TOKEN": "<token>" } }
```

The slug is passed to the installer as `--sentry-slug` at step 10 (it seeds the account env); the token is the user's to add, and step 9's prereq check reads that file, so a still-missing token or slug shows as a warning there and in the next-steps card. Skipping sentry asks none of this and writes nothing.

## 8. Plugins

Locked = the plugins the kept selection pulls (an LSP plugin rides its stack's closure; `superpowers` and `ponytail` arrive via the skills and agents that cite them); recommended = the confirmed stacks' plugin seeds. The rest of `catalog.plugins` is freely addable.

**Plugin settings - part of this layer's turn.** After the selection question, for every kept
plugin the snapshot's `$TMP/repo/meta/plugin-settings.json` has a row for (today `claude-hud`,
whose config file is ACCOUNT-level whichever scope it is installed at), report the delta and ASK
here - the answer is applied at the install step, exactly like screen B's environment choices:

1. `node "$TMP/repo/scripts/plugin-settings.js" --catalog "$TMP/repo/meta/plugin-settings.json" --config-dir <account dir> --installed <kept plugins csv>` - paste its output verbatim in a fenced block. Each line reads `missing` (would be added), `differs` (the user already chose something else) or `match`; `--config-dir` is `~/.claude`, or `~/.claude-<space>` under a profile.
2. ONE AskUserQuestion carrying those counts: **Apply recommended** (Recommended - adds only the missing keys, every value already chosen is kept), **Apply and replace differing** (overwrite those too), **Skip** (change nothing).

No kept plugin with a row: skip this silently, ask nothing. A target that needs a block the
plugin's own setup owns (claude-hud's `statusLine`, which carries the refresh interval) reports
itself as `skipped` rather than inventing it - say so once, and point at `/claude-hud:setup`.

## 9. Prerequisite check

Run: `node stack-select.js --selection "$TMP/raw.json" --emit "$TMP/selection.txt" --check [--context7-local] [--sentry-oauth] [--github-cli] [--config-dir ~/.claude-<space>]` (`--config-dir` only under a `--space` profile, so the env probe reads THAT account's settings.json instead of `~/.claude`; `--context7-local` only when the user chose context7 `local`; `--sentry-oauth` only when they chose sentry `oauth` at step 7 - it drops the token warning that mode never needs (the slug warning stays: the URL needs it in both modes; the check reads the account settings.json env as well as the shell); `--github-cli` only when they opted in at step 1). Redirect its output to `$TMP/select.out` like every recompute. It writes `selection.txt` - the closed installer selection. **Fixed shape, three blocks:** (1) one verdict line - `blockers: N · warnings: N`; (2) the closed selection grouped by category, closure adds marked with their reasons; (3) the lists:

- Blockers: list each with its fix, then AskUserQuestion: fix them now and continue (recommended), or drop the affected items (reopen the owning layer's table, re-run, re-emit). Never install past a blocker.
- Warnings: list them and proceed.
- **Convention-conflict warnings (brownfield only).** When the project already carries stated conventions - a root or `.claude/` CLAUDE.md, `<docs-path>/architecture/` docs - check the user's TYPED ADDS from the walk (never the closure-locked rows, never the stack/evidence seeds - those are signal-backed) against them: an add whose PURPOSE conflicts with a stated convention gets ONE warning line quoting the rule verbatim (`warning: skill dotnet-architecture conflicts with CLAUDE.md: 'NOT Clean Architecture / DDD / VSA'`) and one keep-or-drop consent. No citable conflict, no warning - unused-looking is not a conflict; no project docs, skip silently. A conflict warning never blocks the install - the user's keep is final.

## 10. Install

Run the installer **from the snapshot**, and pass it back with `--source` so it installs from what you already downloaded instead of fetching again:

- Unix: `bash "$TMP/repo/scripts/os/claude-stack.sh" install --source "$TMP/repo" --scope <scope> --selection "$TMP/selection.txt" [--space <name>] [--context7 local|remote] [--sentry-slug <slug>] [--sentry-auth token|oauth] [--github-cli]`
- Windows: `pwsh -File "$TMP/repo/scripts/os/claude-stack.ps1" install -Source "$TMP/repo" -Scope <scope> -Selection "$TMP/selection.txt" [-Space <name>] [-Context7 local|remote] [-SentrySlug <slug>] [-SentryAuth token|oauth] [-GitHubCli]` - the ps1 handles the serena/TypeScript-on-Windows patch itself.

`--source` is what makes the guided run take ONE download. The installer owns nothing here: it copies out of `$TMP/repo` and leaves it for you to remove at cleanup. It writes `.claude/claude-stack.stamp` recording the commit it installed (read from the snapshot's `RELEASE-SOURCE`) - that is what a later `/claude-stack:configure` diffs against.

The sentry values are ACCOUNT-level, not project-level: `--sentry-slug` writes `SENTRY_SLUG` into the account `settings.json` env itself, and the token is never written by this command - after the run, re-read that file and, when `SENTRY_ACCESS_TOKEN` (token mode) or `SENTRY_SLUG` is still absent, say so in the next-steps card with the file path and the snippet from step 7.

Then apply the step-1 environment choices where they differ from what the installer left: a merge on the scope's settings.json touching ONLY the chosen keys - every key screen B asked about (the catalog's rows, `env.` prefixed) (plus `autoCompactEnabled: false` when the user chose 'off'; delete the pct override in that case rather than writing a dead value) - everything else in the file preserved. The installer seeds these only when absent, so the values written here are the user's and survive every later update untouched. Accepted defaults on a fresh install need no write - the installer's seed already matches.

When the applied `CLAUDE_STACK_DOCS_PATH` differs from what the installer stamped (the installer ran before this merge), re-stamp the deployed rule - run `node $TMP/repo/scripts/stamp-docs-root.js <project root>` (a global install: `--claude-dir <account dir>` instead - the dir holding `rules/` + `settings.json`): it rewrites the 'This install's root:' line in `.claude/rules/baseline-docs-root.md` from settings.json, so the always-on awareness matches the env; every later update re-stamps it too.

### 10a. Plugin settings - apply the step-8 answer

The plugin is on disk only now, so this is where the answer lands: re-run the tool with `--apply`
(plus `--replace` when they chose to overwrite differing values) and paste the closing `applied:`
line. 'Skip' writes nothing and is not re-asked. Never hand-edit either file - the tool merges, so
keys outside the catalog and the plugin's own settings survive.

## 11. CLAUDE.md - the user's call (project mode)

Not required - open with WHERE it lives and WHAT a yes changes, then AskUserQuestion (fill it in - recommended / skip); a 'no' ends the run cleanly (a later `/claude-stack:configure` can always reconcile it). The location: the installer seeded `.claude/CLAUDE.md` from the snapshot's `stack/CLAUDE.template.md` when the project had none - that file, in this project, is the target; a pre-existing CLAUDE.md (root or `.claude/`) is NEVER overwritten - the offer becomes a reconcile against the fetched template instead (add the sections it lacks, leave the project's own prose untouched), with the changes shown before writing. On a yes: follow the template's own authoring-outline comment - write the project top (what the project is, structure, the real build/test commands), cover the outline's inventories (stack, commands, secrets/config globs), and trim its rules table to the rules this selection actually installed. Never offer skill/agent/MCP additions here - the walk owned the selection. Skip in no-project mode (a global install seeds no project file).

## Post-check + next steps - close every run with this card

**A next step that needs a USER ACTION in this session ends the turn in ONE AskUserQuestion.**
A listed next step is a directive, and three of them shipped as prose in one session and all three
were ignored. So after the card, put the steps the user must decide or run NOW - the session
reload, the gitignore write, the account-file credential line, a manual-only capture skill -
through AskUserQuestion as the turn's last act, one option per step plus 'nothing now'. Purely
informational steps stay in the card and end nothing.
Recommendation FIRST, in the question text itself - the step and the one reason it matters
('Reload the session now? Nothing installed this run is live until the MCPs
connect and the rules inject at launch'), never a contentless 'What now?' over a list. The report
already did the deciding; the ask only collects consent, so the recommended option comes first
and says it is recommended. The house form of this rule is the interaction baseline's.

Report what still needs a hand: LSP tools (`csharp-ls` via `dotnet tool install -g csharp-ls` on a .NET setup), the `/claude-hud:setup` statusline step, and that the first `claude plugin install` may prompt to trust. Then, AFTER the summary, print the next-steps card - built from what THIS run actually installed, never naming a command whose skill is absent. The card opens with the one step everything else depends on - reload the session (MCPs connect and skills/agents/rules inject at launch; nothing installed this run is live until then) - and closes by naming `${CLAUDE_PLUGIN_ROOT}/references/post-install.md` as the durable copy the user can re-read later (it adds the serena setup prompt and the gitignore semantics):

1. **Git hygiene (project mode).** Suggest ignoring the machine-local artifacts this install creates - only entries that apply to the selection and are not already covered by the project's ignore rules: `.claude/` (the install + stamp + the default docs root), `.serena/` (LSP cache + project memories - when serena is selected), `.mcp.json` (installer-regenerated on every run - fix the template, never this file), plus runtime dirs when present in the tree (`.playwright/`, `.slopwatch/`). Show the exact lines first, then one AskUserQuestion with BOTH homes as options: the committed `.gitignore` (recommended), `.git/info/exclude` for a local-only ignore that touches no committed file, or skip; write only on consent.

2. **The capture sequence** - the deliberate captures that turn a fresh install into an oriented one, in dependency order. Every one of them is the USER's to type: all but `project-architecture-analyzer` are manual-only (`disable-model-invocation`), so a Skill call from this run is blocked - name them, never attempt one and never narrate that you cannot. List each ONLY when its skill is installed; a missing one gets a single line ('project-code-style-analyzer not installed - add via `/claude-stack:configure`') instead of a dead command:
   1. `/project-architecture-analyzer` - writes the durable architecture docs every seat reads to orient.
   2. `/project-code-style-analyzer` - captures the project's real code style and generates the path-scoped project-code-style rule.
   3. `/project-related-context <sibling> ...` - OPTIONAL, and only when this project actually has sibling repos: sibling-repo awareness, args only (local paths or git URLs, e.g. `frontend - ../client`, `backend - ../server`); it never scans on its own. A standalone repo skips it - not a gap. The skill is opt-in, so when it is absent say so in one conditional line ('sibling repos? add `project-related-context` via `/claude-stack:configure`') rather than the flat not-installed line the other captures get.
   4. `/project-agent-capabilities` - LAST, so the generated usage-policy rule reflects the final inventory including anything the captures above added.

3. **serena - one index step, then the honesty note.** The installer already seeded
`.serena/project.yml` (detected `language_servers`, plus `ignored_paths` for `.serena` / `.claude` / `.playwright` -
without which serena's own 327MB language-server directory gets indexed as if it were source:
measured 126 files attempted, 112 failed, all inside `.serena/home`). Tell the user to build the
index ONCE - `SERENA_HOME=.serena/home uvx --from serena-agent serena project index` - and that it
is worth re-running after a large refactor or a branch switch that moves many files. Then state
which case THIS project is, in one line: on TypeScript / Angular / mixed web, serena IS the nav
tool; on C#, nav depends on the Roslyn server starting (the seeded language_servers entry is what
makes it start at all), and where it still stalls on a large solution the `csharp-lsp` plugin owns
navigation - serena stays either way as the per-project memory bus.

## Clean up the temp dir - ALWAYS

Remove `$TMP` per `${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md`, on EVERY exit path of THIS command: after a successful install, after an abort, and after a blocker or a user 'no' that stops the run early. Then confirm the project tree holds only installed artifacts.

## Do not

- Do not install the full set - always go through the walk, and never present a layer question without its `[step n/11 - <name>] ... · next: <name>` banner or without the full-catalog table (a partial table hides choices; a later 'want these too?' question is the failure this shape exists to prevent).
- Do not deselect a locked row on the user's behalf, and never drop one silently - the reason column is the answer, the reopen offer is the remedy.
- Do not paste tool output or run chatty per-file commands - the 'Narrate, don't trace' contract holds for the whole run.
- Do not skip a layer, the selection round, or the prerequisite gate. Do not write the archive, the extracted repo, or the working files into the project tree, and do not leave `$TMP` behind on any exit path. Do not commit anything on the user's behalf.
