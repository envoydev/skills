---
description: "ADJUST an existing claude-stack install - inventory what is actually installed, report what an update would bring (the stamp compare), pick WHICH areas to adjust, then walk the chosen areas in dependency order: each layer shows ONE numbered table of the whole catalog with what is installed and what is locked (the required-by reason shown), then an ADD round and a DROP round (quick options + typed numbers); an environment area adjusts the two settings.json env values (auto-compact trigger, generated-docs root) on the same consent. Drops cascade BOTH ways, always with consent: what a dropped item alone pulled in is offered for removal at its own layer, and dropping a required item offers the dependent rules/agents that hold it for removal with it - nothing is ever removed silently. Prerequisite check, the installer's update action, explicit removals, and an OFFERED (never forced) CLAUDE.md reconcile close the run. NOT for a first install - that is the sibling setup command; for a plain refresh (+ prune of upstream removals) the sibling update command is the shorter path."
disable-model-invocation: true
---

# Configure the Claude stack - adjust an existing install

You are adjusting a claude-stack install that already exists. Same discipline as `setup`: drive
it interactively, walk the selection one layer at a time, always show the prerequisite report
before running, never run past an unmet blocker. `stack-select.js` does the deterministic work;
you orchestrate. Two differences from `setup`: the baseline selection is what is INSTALLED, not
the recommendations - every layer is a straight modify, no recommended phase - and the action is
`update`, not `install`. (For a no-questions refresh that also prunes what upstream removed, the
sibling `update` command is the shorter path - this command is for CHOOSING what changes.)

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

**ONE release archive is the entire download** - the shared contract lives at
`${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md`; read it first and hold the whole run to
it: download + extract once into `$TMP/repo` (the reference owns the fallback), use every tool
from that snapshot, hand it back with `--source` in step 11, and remove `$TMP` per the 'Clean up'
section on every exit path. The protocol's 'Narrate, don't trace' section governs every tool
call: one quiet call per recompute, no pasted tool output, one narration line between steps.
This command's extra stake in the snapshot: its `RELEASE-SOURCE` commit is what step 1 compares
the stamp against to report what an update would bring.

**Every ask in this run goes through the AskUserQuestion tool** - concrete options, the recommended one
marked, free text via Other; a prose question or a bare stop-and-wait is invalid (measured: prose asks
were skipped in live runs while tool-shaped asks were answered every time). A plain-text option list is
the fallback only where the harness lacks the tool.

## The ladder - announce every step

Twelve user-facing steps; the machinery between them runs silently. Before EVERY question, one
banner line so the user always knows where they are, what is being decided, and what comes next:

```
[step 3/12 - rules] adjust the installed rules · next: agents
```

1 install status · 2 areas · 3 rules · 4 agents · 5 skills · 6 hooks · 7 MCPs · 8 plugins · 9 environment · 10 prerequisite check · 11 update · 12 CLAUDE.md (optional)

**The skeleton is INVARIANT - the stability contract.** Every run prints all 12 banners, in this
order, exactly once each. A step that does not apply THIS run still prints its banner followed by
ONE line naming why it is a no-op (`[step 7/12 - MCPs] skipped - area not selected`,
`[step 12/12 - CLAUDE.md] skipped - global mode`), then moves on - a step never silently
vanishes, and steps are never merged, reordered, renumbered, or invented. Two runs must be
comparable banner by banner; the content varies, the skeleton never does.

## 1. Install status - find it, inventory it, diff it

- **Find the install.** Project mode: cwd is a project root with a populated `.claude/`
  (skills/agents/rules dirs, or `.mcp.json`). Global mode: no project here, but the account
  (`~/.claude`, or `~/.claude-<space>`) carries installed skills. Nothing installed in either
  place -> stop and route to the sibling `/claude-stack:setup` command; there is nothing to
  configure yet. OS: on `darwin`/`linux` use the sh installer; on Windows the ps1 (via `pwsh`).
- **Inventory the installed set** from disk - never from memory or assumption: skills = the
  directory names under `.claude/skills/` (or the account's `skills/`); agents =
  `.claude/agents/*.md`; rules = `.claude/rules/*.md` (exclude the GENERATED
  `baseline-project-*.md` awareness rules and `project-code-style.md` - they are written by capture skills, never installed);
  hooks = `.claude/hooks/*.js` basenames WITHOUT the `.js` suffix - the graph catalog stores bare
  names, and `stack-select.js` also strips a stray suffix (exclude the GENERATED legacy
  `inject-code-style.js` - same reason);
  mcps = the server names in `<repo>/.mcp.json`; plugins = `claude plugin list` filtered to the
  entries enabled for THIS project (project scope at this path, or user scope) - the listing is
  machine-global, so an unfiltered read folds sibling repos' plugins into this project's selection
  (measured: two near-miss removals/updates of a sibling's plugin); fail-soft
  without the CLI. Show the inventory grouped by category, with counts. In project mode, also
  run the evidence scan quietly - `node "$TMP/repo/scripts/scan-evidence.js" --root . --catalog
  "$TMP/repo/meta/evidence.json" --out "$TMP/found.json"` - so the walk's
  tables can label what the project provably uses (`--found`); skip it in global mode (no
  project to scan).
- **Report what changed since the install.** `.claude/claude-stack.stamp` (or the account's)
  records the commit every artifact of the current install was copied from - the stack versions
  the INSTALL, not the file. Use it to tell the user what an update would actually bring, BEFORE
  they choose:

```bash
node "$TMP/repo/scripts/stamp-compare.js" --snapshot "$TMP/repo" --stamp .claude/claude-stack.stamp
```

(A fork install passes `--repo <owner/name>`; the script reads the snapshot's `RELEASE-SOURCE`,
falling back to the clone's git HEAD.) It prints the version delta first (`version: 0.1.0 ->
0.2.0` - the plugin/marketplace version; `unknown` when either side lacks one), then
`status<TAB>path` lines (`modified`/`added`/`removed`, and `renamed` with `<- old-path`)
filtered to stack-owned paths. Summarise by category, naming the items - that is the honest
answer to 'what does updating get me'. The diff is what has been RELEASED since the stamp
(merges to `main`, the release branch) - work still on `develop` is invisible here by design,
so never diff against or mention `develop`. Two signal lines to handle, neither an error:

- **`no-stamp`** (exit 2) - an install predating stamping, or one whose source never resolved.
  Say the baseline is unknown, so an update's effect cannot be previewed; the update itself is
  unaffected and will write a stamp.
- **`compare-unreachable`** (exit 3) - the commit is gone (history rewritten, or a
  fork/`STACK_SKILLS_REPO` source that never had it), or the API is unreachable. Report that the
  baseline is unreachable and move on; never guess a diff, and never treat this as a reason to
  skip the update.

A `TRUNCATED` line (the third, after the version and base lines) means the preview may be missing files - say so alongside the summary.

**This step's output has ONE fixed shape** - three blocks, nothing else: (1) the inventory table,
fixed columns `category | count | items`, six rows in the fixed order
rules/agents/skills/hooks/mcps/plugins (note excluded generated files in one trailing line, not
per-row prose); (2) the update-preview verdict - one line leading with the version delta or 'no
upstream changes', then the category summary only when there IS a diff; (3) the closing question.
Detection detail, tool notes, and narration beyond these three blocks is the chaos this shape
exists to prevent.

Close the step with one AskUserQuestion: **adjust the selection** (continue to the area pick at step 2), or
**refresh as-is** (nothing to change - skip straight to step 10; when upstream changed nothing
either, offer to stop rather than running a no-op, and note the sibling `update` command is the
no-questions path for plain refreshes).

## 2. Choose the areas

One multi-pick: which areas to adjust this run - rules, agents, skills, hooks, MCPs, plugins, environment (default: all). The AskUserQuestion tool caps a question at 4 options, so present exactly this fixed grouping rather than improvising one per run (measured: an ad hoc 5-option split errored once before self-healing): 'Rules + Agents + Skills', 'Hooks', 'MCPs + Plugins', 'Environment' - all selected by default, each option's description naming the areas it covers. Only the chosen areas are walked, in the fixed dependency order rules -> agents -> skills -> hooks -> MCPs -> plugins -> environment; every skipped layer keeps its installed set untouched and gets one narration line naming it. Cascades still cross area lines - the closure owns consistency, the picker only decides which tables you page through: a consent-drop's dependents are handled wherever they land, and orphans that fall in a SKIPPED layer are collected and presented in one combined drop round after the last walked layer, never silently kept or removed.

## The walk - steps 3-8, one layer at a time

Same dependency-ordered walk as `setup` (rules pull agents + skills, agents pull skills,
everything pulls MCPs and plugins, hooks stand alone - dependencies only point FORWARD), applied to
the installed set with no recommended phase. Hold TWO running files in the temp dir: `raw.json` -
the remaining selection (installed + adds - drops, every category incl. `hooks` and `mcps`) - and
`dropped.json` - everything dropped so far, per category. Seed BOTH before the first recompute -
`raw.json` from the step-1 inventory, `dropped.json` as `{}` - so no layer ever runs against a
file that does not exist yet.

Per layer, the SAME three-beat shape as setup:

1. **Recompute quietly** - one call:
   `node stack-select.js --selection raw.json --dropped dropped.json`,
   output redirected to `$TMP/select.out` and parsed from there, never pasted. Two line kinds drive the step:
   - `required: <category> <name> - <why>` naming a DROPPED item -> the drop is blocked: something
     kept still depends on it. Show the reason; the user keeps it, or also drops the dependents
     the reason names (their layer is reopened if already walked, and its own cascade re-runs).
   - `orphan: <category> <name> - <why> (dropped); nothing kept still needs it` -> the cascade:
     an installed item whose only dependents were dropped at an earlier layer. Offer this layer's
     orphans for removal - 'it was only there for what you dropped; remove it too, or keep it?' -
     never remove one silently, never re-offer one the user chose to keep.
2. **Show ONE numbered table of the layer's ENTIRE catalog** (installed and not-installed
   alike). The TOOL renders it, never you:
   `node stack-select.js --selection raw.json --table <layer> --installed installed.json --dropped dropped.json --found "$TMP/found.json"` - **never redirected to a file**: the table comes back in the tool result and you paste those exact lines. (Measured: the old redirect-then-paste-the-file form left the tool result empty and one real run showed no table for any of its six layers. A disk copy, if you want one, is `| tee "$TMP/table.txt"`.)
   (write the step-1 inventory to `installed.json` once; omit `--found` in global mode - no scan
   ran. A not-installed row whose reason column carries a matched signal is the project telling
   you it uses what the install lacks - an informed add candidate, never an auto-add) - then paste the tool output verbatim
   inside a fenced code block. **The layer turn has ONE fixed shape, in order: (1) the
   `[step n/12 - <layer>]` banner, (2) the fenced block holding the tool output byte-for-byte (self-check: your message must carry its `total: N <layer>` footer line - it is not there unless you pasted the table), (3) the
   ADD round question - a layer turn missing the fenced table is invalid: render the table and
   re-send.** A prose grouping that feels equivalent (`Installed (5): ...` / `Locked (3): ...`
   lines) is the exact failure this shape exists to prevent, and the run's narrate-don't-trace
   rule does not reach this paste - it is the rule's one sanctioned exception. The paste is
   pre-padded by the tool so it stays aligned at any length; a hand-written markdown table shears
   when the renderer flushes it in segments. The table ends in a `total: N <layer>` footer line - it is part of the paste and the
   user's truncation check: a display whose visible rows fall short of the footer's count (or that
   lacks the footer) was cut down and must be re-pasted in full; never summarize rows into prose,
   the user decides from the whole catalog, not from your shortlist. Rows are labeled `yes` / `orphaned` (with the cascade origin) / `-`, the lock
   reason rides the last column, and row numbers are stable across rounds. Columns: number, name, `installed` (`yes`, `orphaned` for the cascade
   offers, or `-`), `required by` (the lock reason for kept items something else kept needs, or
   `-`):

```
[step 5/12 - skills] adjust the installed skills · next: hooks
 # | skill      | installed | required by
---+------------+-----------+------------------------------------------
 1 | csharp     | yes       | rule csharp-conventions
 2 | dotnet-wpf | orphaned  | was: required by agent dotnet-build-error-resolver
 3 | postgres   | -         | -
```

3. **Two rounds - ADD, then DROP.** The add round first, quick options + numbers: **Keep as-is**
   (add nothing - the default), **All** (add every catalog row), or typed numbers (`3 7 12`).
   Then the drop round: **Nothing** (the default; orphaned rows are pre-suggested, each with its
   cascade origin), **All droppable** (keep only locked rows), or typed numbers. A drop naming a
   LOCKED row triggers the consent cascade, not a refusal: run
   `node stack-select.js --selection raw.json --dependents <category>:<name>`
   (output to `$TMP/select.out`) and present what holds it - 'csharp is required by rule
   csharp-conventions, rule dotnet-repair-agents + 4 agents; drop them ALL together, or keep it?'
   On consent, the item AND its dependents fold into `dropped.json` - dependents from
   already-walked layers are named right there, and the next recompute's orphan lines surface
   immediately. On refusal, the row stays. Restate the outcome in one line (added N, dropped M
   incl. dependents), fold into `raw.json` + `dropped.json`, narrate the handoff, move on. An `unknown:` line marks an installed name this release no
   longer ships (retired or renamed upstream) - it is excluded from the emitted selection
   automatically; surface it: adopt the replacement here if step 1 showed a rename, or let the
   sibling `update` command prune the leftover artifact.

## 3. Rules

Nothing depends on a rule, so every installed rule is freely droppable and every catalog rule
addable - and a rule drop is where cascades START: what it alone pulled in surfaces as orphan
offers in the layers ahead.

## 4. Agents

Locked = agents a kept rule requires. Orphans here trace back to rule drops in step 3.

## 5. Skills

Locked = skills the kept rules + agents require (rule attachments and `skills:` frontmatter
preloads). A skill an agent's body merely names as a conditional load ('load X when...') is NOT
an edge and never appears pre-selected: what a project needs is proven by the evidence scan
against its own manifests, or seeded per stack - never inferred from a body. Those installed rows
show `-` in required-by and drop freely, no cascade. Orphans trace back to the rule and agent
drops before them.

## 6. Hooks

Leaf picks - nothing requires a hook and a hook requires nothing, so every row is free and the
cascade never reaches here. Dropping a wired hook removes its `.claude/settings.json` wiring too
(step 11 shows that edit).

## 7. MCPs

Locked = the servers the kept selection pulls (`serena` via `baseline-navigation`, `context7` via `baseline-quality-gates`);
the rest of the installed servers are direct picks - droppable, and preserved across runs
(`raw.json` carries them). Addable from `catalog.mcps`; note next to `sentry` that it needs `SENTRY_SLUG` and
(token mode) `SENTRY_ACCESS_TOKEN` in the ACCOUNT settings.json env. Whenever sentry is PRESENT after
this round - kept or added - read the account `settings.json` (`~/.claude/settings.json`, or the
space's) and run the sentry environment plan for whatever is missing: ask the slug (`<org>` or
`<org>/<project>`; required) and pass it as `--sentry-slug` at step 11 (the installer seeds the env),
and tell the user to add `SENTRY_ACCESS_TOKEN` to that same file themselves - a personal/org API token,
never pasted into the chat, never a project-level `.claude/settings.json` (its env does not reach
`.mcp.json`) - or to pick `--sentry-auth oauth` instead. Both values already present: say so in one
line and ask nothing. An existing registration needs no auth flag: `update` reads it back and keeps
its mode (an old plain-`Bearer` header migrates to the fixed `Sentry-Bearer` one).

## 8. Plugins

Locked = the plugins the kept selection pulls (an LSP plugin rides its stack's closure;
`superpowers` and `ponytail` arrive via the skills and agents that cite them); the rest of the
installed plugins are direct picks. Addable from `catalog.plugins`.

**Plugin settings - part of this layer's turn.** After the selection question, for every kept
plugin the snapshot's `$TMP/repo/meta/plugin-settings.json` has a row for (today `claude-hud`,
whose config file is ACCOUNT-level whichever scope it is installed at), report the delta and ASK
here - the answer is applied at the install step, exactly like screen B's environment choices:

1. `node "$TMP/repo/scripts/plugin-settings.js" --catalog "$TMP/repo/meta/plugin-settings.json" --config-dir <account dir> --installed <kept plugins csv>` - paste its output verbatim in a fenced block. Each line reads `missing` (would be added), `differs` (the user already chose something else) or `match`; `--config-dir` is `~/.claude`, or `~/.claude-<space>` under a profile.
2. ONE AskUserQuestion carrying those counts: **Apply recommended** (Recommended - adds only the missing keys, every value already chosen is kept), **Apply and replace differing** (overwrite those too), **Skip** (change nothing).

No kept plugin with a row: skip this silently, ask nothing. A target that needs a block the
plugin's own setup owns (claude-hud's `statusLine`, which carries the refresh interval) reports
itself as `skipped` rather than inventing it - say so once, and point at `/claude-hud:setup`.

## 9. Environment - the stack env values (when picked)

The values come from the snapshot's `$TMP/repo/meta/environment.json` - the ONE list of what this
release owns in the scope's settings.json `env` (`.claude/settings.json`, or the account file for a
global install). Read each row's `key`, `default` and `what` FROM THAT FILE and put the `what` in
front of the user in its own words; do not carry a copy of the rows here, or the walk shows five
values on the day the catalog holds six. **Never print, echo back, or ask for a credential VALUE.** A key matching the catalog's `secret_key_pattern`, or a row flagged `secret: true`, is reported as `set (N chars)` or `absent` and nothing else - not as a shown default, not in a table, not in a question. A value that must be set is set by the user in the file itself, or with a copy-ready command they run in their own terminal; it never travels through the chat. Measured: seven credential exposures in one corpus. The installer seeds every row only when ABSENT, so this
step is the one place they change deliberately. A row whose key is missing from the file is one the
release INTRODUCED - offer it with the catalog's default; a row's `renamed_from` still present on
disk is the old spelling, and accepting it moves the value, never resets it.

Two behaviours live here rather than in the catalog, because they are about what this step DOES:

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` accepts a third answer beyond a percent - auto-compact off
  entirely, which is the `autoCompactEnabled: false` settings key with the pct override DELETED
  rather than left dead beside it.
- A docs-root change re-stamps the deployed rule (below) and moves no existing docs.

Show the CURRENT values read from the file - never assume the defaults - then one AskUserQuestion
keep-or-change consent covering every row (keep - recommended; change, the new values via Other) -
one question per row, and a row carrying `asked_with` rides along with the row it names rather than
spending its own question. On a
docs-root change, say plainly: existing generated docs do NOT move - they stay under the old root until
moved by hand or re-captured. Then re-stamp the deployed rule - run
`node $TMP/repo/scripts/stamp-docs-root.js <project root>` (global install: `--claude-dir <account dir>`): it rewrites the 'This install's root:'
line in `.claude/rules/baseline-docs-root.md` from the settings.json value just written, so the
always-on awareness matches the env (every install/update run re-stamps it too). Nothing else
needs editing. Apply on consent with a
merge touching ONLY the chosen keys - everything else in settings.json is preserved. Area
skipped, or nothing changed: one narration line, nothing written.

## 10. Prerequisite check

Run: `node stack-select.js --selection "$TMP/raw.json" --emit "$TMP/selection.txt" --check [--sentry-oauth] [--config-dir ~/.claude-<space>]`
(`--sentry-oauth` when sentry is kept under a headerless registration, so its token warning does not
fire falsely; `--config-dir` under a `--space` profile, so the env probe reads that account's
settings.json), output redirected to `$TMP/select.out` like every recompute. **Fixed shape, three blocks:** (1) one
verdict line - `blockers: N · warnings: N`; (2) the closed selection grouped by category - closure
adds marked with their reasons, the final drop list (incl. accepted orphans) named; (3) each
blocker with its fix, each warning listed. Never run past a blocker
(fix now, or reopen the owning layer and drop the affected items). Warnings are listed and
passed. **Convention-conflict warnings (project mode only):** when the project carries stated
conventions (a root or `.claude/` CLAUDE.md, `<docs-path>/architecture/` docs), check THIS RUN'S
typed adds (never locked rows or kept installed items) against them - a conflicting add gets one
warning line quoting the rule verbatim plus a keep-or-drop consent. No citable conflict, no
warning; no project docs, skip silently; a conflict warning never blocks the run. Also ask here,
through AskUserQuestion: keep local model/effort pins? (`--keep-pins`, yes recommended for a configure
run - an existing install often carries deliberate pin edits).

## 11. Update + removals

**First, is there anything to do?** This run already computed the closed selection and already has
the installed inventory. When the two are byte-identical AND no removals were accepted AND no env
or plugin-settings change was chosen, print ONE line - `unchanged - nothing to install, nothing to
remove` - and skip to step 12. Do not run the installer to prove it (measured: a run whose
selection it had itself proved identical spent 2 API messages and 351,777 re-sent tokens on an
installer pass whose only real effect was resetting the agent model/effort pins).

Otherwise, run the installer **from the snapshot**, passing it back with `--source` so the run
lands the same revision step 1 previewed:

- Unix: `bash "$TMP/repo/scripts/os/claude-stack.sh" update --source "$TMP/repo" --scope <scope> --selection "$TMP/selection.txt" [--space <name>] [--keep-pins] [--sentry-slug <slug>] [--sentry-auth token|oauth]`
- Windows: `pwsh -File "$TMP/repo/scripts/os/claude-stack.ps1" update -Source "$TMP/repo" -Scope <scope> -Selection "$TMP/selection.txt" [-Space <name>] [-KeepPins] [-SentrySlug <slug>] [-SentryAuth token|oauth]`
- Scope/space mirror how the install was laid down (project install -> `project`; account
  install -> `global`, with the space that owns it) - ask only when it is genuinely ambiguous.

`update --selection` refreshes the selected set - it does NOT uninstall what was dropped.
**Fixed order, three blocks:** (1) the installer run, summarized in ONE line (what landed, the
stamp action) - never paste its output; (2) removals - each dropped item (incl. accepted
orphans) with its command shown before running it: delete the skill directory / agent file /
rule file; a hook loses BOTH its `.claude/hooks/` file and its `.claude/settings.json` wiring
(show that edit too - step 6's promise); `claude mcp remove <name>` for an MCP;
`claude plugin uninstall <name>` for a plugin; 'removals: none' when nothing was dropped;
(3) the follow-through line - telling the USER to re-run `/project-agent-capabilities` (when
installed) so the generated awareness rule reflects the new inventory (the skill is manual-only,
`disable-model-invocation` - a Skill call from this run is blocked; the line is addressed to the
user, never acted on), and any environment writes from step 9.

### 11a. Plugin settings - apply the step-8 answer

Same as the setup walk, run after the installer block and before the follow-through line: re-run
`node "$TMP/repo/scripts/plugin-settings.js" --catalog "$TMP/repo/meta/plugin-settings.json" --config-dir <account dir> --installed <kept plugins csv> --apply` (plus `--replace` for the
overwrite answer) and paste the closing `applied:` line. A run that dropped the plugin asked
nothing at step 8 and applies nothing here.

## 12. CLAUDE.md - the user's call (project mode)

Not required - open with WHERE it lives and WHAT a yes changes, then AskUserQuestion (reconcile -
recommended / skip); a 'no' ends the run cleanly. The location: the project's own CLAUDE.md - `.claude/CLAUDE.md` where the installer
seeded it, or the root `CLAUDE.md` where the project already had one; name which one you found.
On a yes: reconcile it against the fetched `stack/CLAUDE.template.md` - add the sections the
template gained since the install, update the selection-tied parts (the rules table and any
capability mentions) for what this run added or dropped, and complete any still-unwritten
authoring-outline sections from what the inventory established. Reconcile ADDITIVELY: never
overwrite the project's own prose, and show the changes before writing. Never offer
skill/agent/MCP additions here - the walk owned the selection. Skip in global mode (no project
file to reconcile).

## Post-check

Report what changed per category (refreshed / added / dropped, orphans removed vs kept), the
CLAUDE.md decision and reconcile result, anything deferred, and remind that a restart picks up
MCP registration changes. The run rewrites `claude-stack.stamp` to the revision it installed, so
the next configure diffs from here.

**A next step that needs a USER ACTION in this session ends the turn in ONE AskUserQuestion.**
A listed next step is a directive, and three of them shipped as prose in one session and all
three were ignored. So: after the report, if any listed step is something the user must decide
or run now - re-index serena, run a manual-only capture skill, restart for an MCP change, rotate
a credential - put those steps through AskUserQuestion as the turn's last act, one option per
step plus 'nothing now'. Steps that are purely informational stay in the report and end nothing.
Recommendation FIRST, in the question text itself - the step and the one reason it matters
('Re-run `/project-agent-capabilities`? The selection changed, so the generated
rule still names what this project dropped'), never a contentless 'What now?' over a list. The report
already did the deciding; the ask only collects consent, so the recommended option comes first
and says it is recommended. The house form of this rule is the interaction baseline's.


## Clean up the temp dir - ALWAYS

Remove `$TMP` per `${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md`, on EVERY exit path of
THIS command: after a successful update, after an abort, after a blocker, and after the step-1
'nothing changed, stop here' case. Then confirm the project tree holds only installed artifacts.

## Do not

- Do not fall back to a full re-install - this is the update path; a from-scratch install is the
  sibling `setup` command. Never present a layer question without its
  `[step n/12 - <name>] ... · next: <name>` banner or without the full-catalog table.
- Never drop a locked row on the user's behalf, never remove an orphan silently, and never
  re-offer an orphan the user chose to keep - the reason column is the answer, the dependent's
  layer is the remedy.
- Do not paste tool output or run chatty per-file commands - the 'Narrate, don't trace' contract
  holds for the whole run.
- Do not skip the area pick, the walked layers, the add/drop rounds, the prerequisite gate, or the explicit-removal
  pass. Do not write the archive, the extracted repo, or the working files into the project
  tree, and do not leave `$TMP` behind on any exit path. Do not commit anything on the user's
  behalf.
