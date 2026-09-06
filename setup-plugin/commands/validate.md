---
description: "RECONCILE an existing claude-stack install to THIS project - detect the project's real stacks by artifact (the setup step-2 scan), inventory what is installed, then walk the selection one layer at a time (rules -> agents -> skills -> hooks -> MCPs -> plugins) showing, per layer, what is REDUNDANT (installed but its whole owning stack is absent - remove?) and what is MISSING (the detected stacks' + baseline closure not installed here - add?), each pre-marked with its reason and taken on per-item consent. Shared items, deliberate non-stack extras, and the always-baseline already installed are never touched. Detection evidence for every absent stack is shown BEFORE the walk so a mis-detection is vetoable. After the mechanical walk, a JUDGMENT step corroborates the advisory items' non-use in the code (named greps for the skill's domain, its own do-not-load exclusions, the docs' own citations of it) reviews the remainder against the project's stated conventions incl. version pins (a latest-major guidance tool fights a project pinned older - a citable conflict), mirrors gate 1 for ADDS (an uninstalled skill whose domain the code provably touches though no manifest signal covers it - only from trails the run itself surfaced, never a speculative catalog sweep), and hunts functional OVERLAP among kept items (two items covering one capability, the project docs citing only one - proposed only with the survivor's unique gap named) - drops and adds proposed only with gate evidence, each RANKED (MATERIAL/MINOR) and readable as what-it-does / why-marginal-here / the-keep-exception / recommendation, visibly labeled as judgment, never mixed with the signal tiers; plus a plain-text DORMANT advisory naming installed occasion-bound items (their own descriptions mark them release-/upgrade-/audit-time) with each one's honest idle cost and off lever - informational, acted on only by explicit request. Adds run the installer for the accepted set; removes delete explicitly - the same paths setup/configure use. Project mode only. This is the project-relative two-way audit that setup (fresh), update (refresh), and configure (manual add/drop) do not do."
disable-model-invocation: true
---

# Validate the Claude stack - reconcile the install to this project

You are reconciling a claude-stack install against the project it sits in: removing artifacts whose
framework is absent and offering the detected stacks' artifacts that are not yet installed. Same
discipline as the sibling commands - drive it interactively, walk one layer at a time, show the
evidence/prerequisite before acting, never add or remove without consent. `stack-select.js` does
the deterministic work; you orchestrate.

**ONE release archive is the entire download** - read `${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md`
before step 1 and hold the whole run to it: download + extract once into `$TMP/repo`, use
`stack-select.js` / the graph / `recommendations.json` / the installer from that snapshot, hand
the installer `--source "$TMP/repo"` in step 11, and remove `$TMP` per the 'Clean up' section on
EVERY exit path. Its 'Narrate, don't trace' section governs every tool call: one quiet call per
recompute, no pasted tool output, one narration line between steps.

**Project mode only.** This command needs a project to reconcile against. If cwd is not a project
root with a populated `.claude/` (or the install lives in an account dir), stop and say so - a
global adjust is the sibling `/claude-stack:configure`. Detect the OS too (`darwin`/`linux` -> the
sh installer; Windows -> ps1 via `pwsh`).

**Every ask in this run goes through the AskUserQuestion tool** - concrete options, the recommended one
marked, free text via Other; a prose question or a bare stop-and-wait is invalid (measured: prose asks
were skipped in live runs while tool-shaped asks were answered every time). A plain-text option list is
the fallback only where the harness lacks the tool.

## The ladder - announce every step

Twelve user-facing steps; the machinery between them runs silently. One banner line before each:

```
[step 3/12 - rules] reconcile the rule layer · next: agents
```

1 find + inventory · 2 detect stacks · 3 rules · 4 agents · 5 skills · 6 hooks · 7 MCPs · 8 plugins · 9 environment · 10 judgment review · 11 apply · 12 post-check

## 1. Find the install and inventory it

Confirm the install (project mode, above), then **inventory the installed set from disk** - never
from memory - exactly as configure does: skills = the directory names under `.claude/skills/`;
agents = `.claude/agents/*.md`; rules = `.claude/rules/*.md` EXCLUDING the generated
`baseline-project-*.md` awareness rules and `project-code-style.md`; hooks = `.claude/hooks/*.js` EXCLUDING the generated legacy
`inject-code-style.js` (bare basenames, no `.js` suffix - the catalog stores them bare); mcps = the server names in `<repo>/.mcp.json`; plugins = `claude plugin
list` filtered to the entries enabled for THIS project (project scope at this path, or user
scope) - the listing is machine-global, and an unfiltered read proposes sibling repos' plugins as
REDUNDANT here (measured near-miss uninstall); fail-soft without the CLI. Write it as one inventory JSON in `$TMP`
(`{rules,agents,skills,hooks,mcps,plugins}` arrays) - the `--installed` input for the walk.

## 2. Detect the project's stacks - and show the evidence

The setup step-2 artifact scan:

- `*.csproj` / `*.sln` -> .NET, split by content, per project: `Microsoft.NET.Sdk.Web` -> `aspnet`;
  `<UseWPF>true` -> `wpf`; `<UseWindowsForms>true` -> `winforms`; a
  `Microsoft.Extensions.Hosting.WindowsServices` reference (or a `ServiceBase` inheritor) ->
  `windows-service`; an EXECUTABLE carrying none of those markers (`<OutputType>Exe</OutputType>`, or
  `Microsoft.NET.Sdk.Worker`) -> `console`. A class LIBRARY is never its own stack: `Microsoft.NET.Sdk`
  with no `OutputType` (library is the default) - and a test project - is a surface of the app that
  references it, so a WPF solution's own libraries stay `wpf` and add NO `console` (measured
  mis-detection). With every .NET project a library, ask which surface they serve; never default to
  `console`.
- `angular.json` -> `web-angular`; `ionic.config.json` / `capacitor.config.*` -> `ionic-angular`.
  An Ionic app matches `angular.json` too - when `ionic-angular` detects, do NOT also report
  `web-angular` for the same app; both only when a second, distinct non-Ionic Angular app exists.
- a `manifest.json` carrying `"manifest_version"` (or a wxt/crxjs config) -> `browser-extension`.
- `Dockerfile` / `.github/workflows/` -> `devops`; `*.sql` / a migrations folder -> `data`.
- `tsconfig.json` / `jsconfig.json` -> `typescript` (language-level - keeps the TS rule/skill/LSP
  plugin owned in a plain TS/Node repo with no framework marker). A TS framework stack claims its own
  surface: when `web-angular` / `ionic-angular` / `browser-extension` detects, do NOT also report
  `typescript` for the same app - the framework seeds carry the rules + LSP, and reporting both flags
  `ts-js-testing` MISSING on every Angular app where testing is `angular-testing`'s (measured); both only
  when the repo holds a genuine non-framework TS surface too (Node tooling, a published library).
- `package.json` with `.js` sources and NO `tsconfig.json`/`jsconfig.json` -> `javascript` (the plain-JS
  seed). One-way suppression: `typescript` and the framework stacks cover JS - never report `javascript`
  beside them. Without this bullet a plain-JS install reads as REDUNDANT wholesale (measured: `javascript`,
  `ts-js-testing`, `javascript-conventions` and `typescript-lsp` all flagged for removal).

Report the detected set AND, for every stack you will treat as ABSENT, the exact signal you looked
for and did not find (`wpf -> *.csproj <UseWPF>: none`). **This is the veto point** - a
mis-detection (a WPF app on a non-standard SDK, SQL in an odd path) is corrected HERE, before the
walk removes anything on it. Detecting nothing is valid; confirm through AskUserQuestion (detection
correct - recommended; dispute, naming the stack via Other), then walk. Stack names are the catalog keys of
`$TMP/repo/meta/recommendations.json` (`web-angular`, never `angular`) - the tool names an unknown one on
stderr (`unknown-stack`) instead of silently flagging nothing.

Compute the audits once against the current inventory, quietly - the two stack-level passes,
the evidence scan (with the judgment catalog), the evidence gaps, and the judgment lines:

```
node "$TMP/repo/scripts/stack-select.js" --redundant --installed "$TMP/installed.json" \
  --recs "$TMP/repo/meta/recommendations.json" --graph "$TMP/repo/meta/stack-graph.json" \
  --stacks "<detected,csv>" > "$TMP/redundant.out"
node "$TMP/repo/scripts/stack-select.js" --missing   --installed "$TMP/installed.json" \
  --recs "$TMP/repo/meta/recommendations.json" --graph "$TMP/repo/meta/stack-graph.json" \
  --stacks "<detected,csv>" > "$TMP/missing.out"
node "$TMP/repo/scripts/scan-evidence.js" --root . --catalog "$TMP/repo/meta/evidence.json" \
  --judgment "$TMP/repo/meta/judgment.json" --out "$TMP/found.json"
node "$TMP/repo/scripts/stack-select.js" --evidence-gaps --found "$TMP/found.json" \
  --catalog "$TMP/repo/meta/evidence.json" --installed "$TMP/installed.json" \
  --recs "$TMP/repo/meta/recommendations.json" --graph "$TMP/repo/meta/stack-graph.json" \
  --stacks "<detected,csv>" > "$TMP/evidence.out"
node "$TMP/repo/scripts/stack-select.js" --judgment "$TMP/repo/meta/judgment.json" \
  --installed "$TMP/installed.json" > "$TMP/judgment.out"
```

`redundant:` lines = installed, whole owning stack absent (remove candidates). `missing:` lines =
detected-stack + baseline closure not installed (add candidates), each with `needed by <stack|baseline>`.
`evidence-missing:` lines = the scan found a signal for an artifact that is not installed (add
candidates, the signal as the reason - already deduped against the `missing:` lines by the tool).
`no-evidence:` lines = installed, catalog-listed, no signal found - ADVISORY ONLY, never an action.
`overlap:` / `dormant:` lines (judgment.out) + the scan's `judgment.versionConflicts` rows
(found.json) = step 10's precomputed candidates - carried there, never acted on in the walk.
The tool already excludes shared items, deliberate non-stack extras, already-installed baseline,
and the curated `general` set in recommendations.json (artifacts no stack owns: cross-stack skills a
narrow seat happens to preload - e.g. dotnet-data-access - and the project-conditional opt-ins whose
applicability no manifest can prove, e.g. the `project-related-context` / `related-project-analyzer`
pair, which apply only where the project has sibling repos) - you present its output, you do not
re-derive it.

One addition of your own: run the snapshot's `$TMP/repo/meta/migrations.json` detects against the
project (retired GENERATED artifacts - e.g. the legacy inject-code-style hook - which the
stack-ownership model cannot flag because generated output belongs to no stack). Each detected
entry joins the matching layer's REDUNDANT rows labeled `(migration: <why>)`; removing one also
applies its `unwire_settings_hook` edit and puts its `then` follow-up in the report.

## The walk - steps 3-8, one layer at a time

The layer order is the dependency order rules -> agents -> skills -> hooks -> MCPs -> plugins. Per
layer, slice `redundant.out` + `missing.out` to that layer and run the SAME shape:

1. **Show one table** of this layer's actionable rows - REDUNDANT (installed, remove?) and MISSING
   (not installed, add?; `evidence-missing:` lines join as MISSING with the signal as the reason),
   each with its reason. Under the table, this layer's `no-evidence:` lines as PLAIN TEXT - no row
   numbers, no consent: 'advisory: dotnet-messaging installed, no messaging package found - kept,
   your call'. A line carrying `held by <cat> <name>` is NOT your-call: the kept closure requires
   it, so present it as locked-by-holder info - its real drop path is dropping the holder via the
   sibling configure, never a promise this walk can keep. The walk itself never acts on an
   advisory - step 10 revisits each one with code corroboration and may propose the drop there. A layer with none of the three gets a single line ('rules: nothing to reconcile')
   and you move straight on - do not invent rows.

```
[step 4/12 - agents] reconcile the agent layer · next: skills
 # | agent                  | state     | reason
---+------------------------+-----------+-----------------------------------
 1 | wpf-implementer        | REDUNDANT | owned by wpf, not detected
 2 | aspnet-verifier        | MISSING   | needed by aspnet
 3 | ci-failure-diagnoser   | MISSING   | needed by baseline
```

2. **One consent round through AskUserQuestion** - four options (the tool's cap), typed numbers via
   Other: **Accept all** (add every MISSING, remove every REDUNDANT in this layer), **Add only**,
   **Remove only**, **Skip** (touch nothing), or typed numbers (`add 2 3`, `remove 1`). Never bulk-act without an explicit choice; a REDUNDANT removal the user
   declines is simply kept. Restate the outcome in one line and carry this layer's accepted adds +
   removes forward.

## 3-8 per-layer notes

- **Rules** first - a rule's closure pulls agents/skills, so accepting a MISSING rule here means
  its pulled agents/skills already appear as MISSING in their own later layers; the apply step
  re-closes the union, so you never double-add.
- **Hooks** are leaf - REDUNDANT never appears (hooks are always-baseline or deliberate); MISSING
  only if a baseline hook is absent - a removed guard, or the env-gated `instrument-tool-usage`
  on an install predating its catalog entry (measured: a v0.1.23-era install upgraded to
  v0.2.17 had no guided route to the instrument hook until this entry existed).
- **MCPs / plugins** - an LSP plugin shows MISSING when its stack is detected but it was dropped.

## 9. Environment - the settings.json env block against this release

The one layer that is not an artifact: the values this stack owns in the scope's settings.json
`env`. Read the rows from the snapshot's `$TMP/repo/meta/environment.json` and the current block
from the file (project mode: `.claude/settings.json`; global: the account file), then show one
table of the actionable rows only - an install whose env already matches gets the single line
`environment: nothing to reconcile` and you move on. **Never print, echo back, or ask for a credential VALUE.** A key matching the catalog's `secret_key_pattern`, or a row flagged `secret: true`, is reported as `set (N chars)` or `absent` and nothing else - not as a shown default, not in a table, not in a question. A value that must be set is set by the user in the file itself, or with a copy-ready command they run in their own terminal; it never travels through the chat. Measured: seven credential exposures in one corpus.



- **MISSING** - a catalog row with no key in the file. This is the release-introduced case: a
  variable added upstream after this install was made, which no artifact diff can surface because
  it was never a file. Reason column: `not set - introduced after this install`. The catalog carries no version per row, so never print one.
- **OLD NAME** - a row's `renamed_from` still present in the file. Accepting MOVES the value to the
  new key and drops the old one; nothing is deleted and no default is written over it. The
  installers apply the same rename on their next run, so an unaccepted row is not lost, only later.
- **INVALID** - a key whose value fails the row's `validate` shape (a percent outside `min`..`max`
  and not its `off` value, a window under `min`, an instrumentation switch that is neither `0` nor
  `1`). Show the value and the expected shape; the fix is the catalog default unless the user types
  another. The shape is the ONLY test - a value that differs from the default is a deliberate pin,
  never a finding.

Consent exactly like the artifact layers: one AskUserQuestion round - **Accept all**, **Add
missing only**, **Skip**, or typed numbers - then restate the outcome in one line. Accepted rows
are written in step 11 as a merge touching ONLY those keys, everything else in the file preserved.

## 10. Judgment review - corroborated non-use, convention conflicts, corroborated need

The mechanical tiers stop at what signals can prove; this step carries the judgment they cannot -
a skill whose PURPOSE conflicts with the project's stated conventions, whose domain the code
provably never touches, or whose domain the code provably DOES touch without any catalog signal,
is invisible to every scanner. Drop scope: installed artifacts still untouched
this run that nothing kept requires (probe first - `node "$TMP/repo/scripts/stack-select.js" --selection
"$TMP/installed.json" --graph "$TMP/repo/meta/stack-graph.json" --dependents <skill|agent|mcp|plugin>:<name>`,
the inventory being the remaining selection - a closure-held item is NOT in scope; at most note the
finding and name the holder, its drop path is the sibling configure).
Add scope: release-shipped artifacts the walk left unproposed. Four inputs, four gates:

1. **The advisory list FIRST - corroborate non-use in the code.** Every `no-evidence:` item is a
   prime drop candidate the package scan alone cannot judge. For each: derive the skill's domain
   markers from its own description (for `dotnet-realtime`: SignalR, hubs, a web host) and grep
   the code for them - bounded, NAMED greps, mindful of substring noise (`SignalRedraw` is not
   SignalR); check the skill's own do-NOT-load exclusions against what the code actually does (an
   outbound `ClientWebSocket` bot is the realtime skill's own exclusion case); and check whether
   the project docs cite the skill - a load-by-artifact table naming it is a KEEP corroboration,
   never propose against the project's documented intent. Zero code hits + no doc citation ->
   propose JUDGMENT-DROP with the trail as the citation: the greps run, their zero results, the
   matching exclusion.
2. **The rest vs the project's stated conventions - version pins included.** Review the remaining
   scope against the project's OWN docs - the project CLAUDE.md, `<docs-path>/architecture/ARCHITECTURE.md` /
   `ASSESSMENT.md`, `PROJECT-CODE-STYLE.md`, where they exist - and propose a drop on a cited
   conflict: quote the conflicting rule verbatim and name its source. Version pins count as
   conventions, and the scan PRECOMPUTES the known cases: the `judgment.versionConflicts` rows in
   found.json arrive with the package, the found version, the threshold, the conflict text, and
   the item's surviving half - present them as-is, adding the project-doc side where one exists.
   A version conflict the catalog misses may still be proposed by hand with the full citation
   (the pin next to the item's conflicting guidance) - and is worth an entry in
   `meta/judgment.json` upstream. No project docs -> the prose-conventions path
   is skipped (say so); path 1 and the precomputed rows still run - they read code and manifests,
   not conventions.
3. **Corroborated need - the uninstalled mirror of gate 1.** An uninstalled skill whose domain the
   code provably touches but no manifest signal covers (BCL-only cryptography, a hand-rolled
   background-job loop) is gate 1's blind spot in reverse. Work ONLY from trails this run already
   surfaced - a domain the detection or gate-1 greps tripped over, a topic the project's own docs
   name - never a speculative sweep of the whole catalog. For each candidate: confirm with bounded
   NAMED greps (quote the positive hits and their files), and check the skill's own do-NOT-load
   exclusions do not match this project (an exclusion hit kills the proposal). Propose
   JUDGMENT-ADD with the trail as the citation: the greps run, the quoted hits, the exclusion
   check. No surfaced trail, no proposal - 'the project might grow into it' passes no gate.
4. **Functional overlap among kept items.** The candidates are the tool's `overlap:` lines
   (judgment.out) - pairs from the shipped catalog where BOTH sides are installed, each side's
   unique gap precomputed on the line. Your judgment adds the third part: which one the
   project's own docs or config actually cite - and the proposal drops the uncited one, its
   precomputed gap stated so the user keeps it by needing exactly that. An overlapping pair the
   catalog misses may still be proposed by hand, but then the citation carries all three parts
   yourself (the overlap, the cited preference, the survivor's gap) - and it is worth an
   upstream `judgment.json` entry. No gap named = the analysis is not finished.

No gate evidence, no proposal: unused-looking, stale-feeling, or 'probably never needed' passes
no gate. Present the findings RANKED, each verdict carrying its severity - MATERIAL (a real
per-session cost, or guidance that actively fights the project) above MINOR (marginal value at
near-zero cost - trim only if the user wants lean) - and each proposal readable as four parts:
what the item does, why it is marginal or wrong in THIS project (the citation), the exception
that would justify keeping it, and the recommendation. Close the step with one 'correct as-is'
line naming what the review cleared and why in a clause - the user must see the reasoning
covered everything, not only the cuts. One table, VISIBLY separate from the signal tiers, then
the usual per-item consent round:

```
[step 10/12 - judgment] corroborated non-use + conflicts + corroborated need + overlap · next: apply
 # | artifact                   | verdict                  | citation
---+----------------------------+--------------------------+--------------------------------------------------
 1 | mcp chrome-devtools        | JUDGMENT-DROP · MATERIAL | overlap: playwright also drives a browser and is the only one the project docs cite; unique gap - live console/network debug of an already-open Chrome; keep only if that is real here
 2 | skill dotnet-architecture  | JUDGMENT-DROP · MATERIAL | CLAUDE.md: 'keep the layered factory pattern; it is NOT Clean Architecture / DDD / VSA'
 3 | skill dotnet-realtime      | JUDGMENT-DROP · MINOR    | advisory, corroborated: 0 hits for SignalR/hub/web-host across src/ (3 greps); outbound ClientWebSocket is the skill's own do-not-load case
 4 | skill dotnet-cryptography  | JUDGMENT-ADD             | corroborated: AesGcm in src/Vault/Sealer.cs, Rfc2898DeriveBytes in src/Auth/Hasher.cs (2 greps, hits quoted); no crypto package = no scanner signal; no exclusion match
```

This step is model judgment, not a signal: it is non-deterministic and can be confidently wrong,
which is exactly why every row carries its quotation and nothing here ever auto-applies. A
decline is final for this run - never re-litigate it. Accepted judgment drops join step 11's
removal set and accepted judgment adds its install set, both reported there under their
JUDGMENT label.

**The dormant advisory - fine to keep, fires rarely, by requirement.** Under the judgment table,
as PLAIN TEXT (no row numbers, no consent - like the walk's `no-evidence:` lines), print the
tool's `dormant:` lines (judgment.out) - the installed occasion-bound items from the shipped
catalog, each line's cadence text being the citation. The list is the catalog's, not yours:
never re-derive dormancy from descriptions or claim a frequency you cannot observe; an
occasion-bound item the catalog misses is an upstream `judgment.json` entry, not an ad-hoc
advisory. Name each item's idle cost and off lever honestly, per layer:
agents and manual `/`-skills cost nothing installed (explicit dispatch only - say so, so working
machinery is not pruned for phantom savings); an auto-firing skill costs its description line per
session (lever: remove, or accept it); an MCP costs its server launch + tools every session
(lever: `claude mcp remove`, cheap to re-add via configure); a plugin can be switched off in place
(`claude plugin disable <name>`). Act on a lever only on an explicit user request in this run -
dormancy alone is never a removal argument.

## 11. Apply - the same paths setup/configure use

Build the final selection = the installed set, PLUS every accepted add, MINUS every accepted
remove, written to `$TMP/final.json` in the inventory's shape. Step 9's accepted environment rows
are applied here too, as a merge on the scope's settings.json touching ONLY those keys - seeds and
renames included - and named in the post-check the same way an added artifact is. Emit + prereq-check it -
`node "$TMP/repo/scripts/stack-select.js" --selection "$TMP/final.json" --graph "$TMP/repo/meta/stack-graph.json" --emit "$TMP/selection.txt" --check [--sentry-oauth] [--config-dir ~/.claude-<space>]`
(`--sentry-oauth` for a kept headerless sentry registration; `--config-dir` under a `--space`
profile), output to `$TMP/select.out` - then:

- **Adds**: run the installer from the snapshot for the kept+added set -
  `bash "$TMP/repo/scripts/os/claude-stack.sh" install --source "$TMP/repo" --scope <scope> --selection selection.txt [--space <name>] [--sentry-slug <slug>] [--sentry-auth token|oauth]`
  (ps1 on Windows). Sentry environment plan: whenever sentry is installed or among the adds, read the
  ACCOUNT `settings.json` env (`~/.claude/settings.json`, or the space's) - `SENTRY_SLUG` missing -> ask
  it (`<org>` or `<org>/<project>`) and pass `--sentry-slug`; `SENTRY_ACCESS_TOKEN` missing in token
  mode -> tell the user to add it there by hand (a personal/org API token, never through the chat,
  never a project-level settings.json - its env does not reach `.mcp.json`) or to choose
  `--sentry-auth oauth`. Both present: one line, no question. The installer closes the selection and copies the added artifacts; already-installed
  ones are simply re-laid, harmless. Show the prereq report first; never install past a blocker.
- **Removes**: `install --selection` does NOT uninstall - delete each accepted removal explicitly,
  showing the command first: the skill directory / agent file / rule file; a hook loses BOTH its
  `.claude/hooks/` file and its `.claude/settings.json` wiring; `claude mcp remove <name>`;
  `claude plugin uninstall <name>`.
- Then name `/project-agent-capabilities` (when installed) in the post-check report as the
  USER's next step, so the generated awareness rule reflects the reconciled inventory - the
  skill is manual-only (`disable-model-invocation`), a Skill call from this run is blocked;
  never attempt it. The run rewrites `claude-stack.stamp` to the snapshot revision.

## 12. Post-check

Report per category what was added, removed - signal-backed and JUDGMENT-labeled separately -
and left as-is (disputed detections, deliberate extras, declined suggestions, declined
judgment proposals), plus one ENVIRONMENT line naming every key seeded, renamed or corrected (or
saying the block already matched). Remind that a restart picks up MCP registration changes, and surface
the installer's gitignore reminder. If a CLAUDE.md rules table names a rule you added or removed,
offer to reconcile that row (additive, shown before writing) - never rewrite the user's prose.

## Clean up the temp dir - ALWAYS

Remove `$TMP` per `${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md`, on EVERY exit path of
THIS command: after apply, after an abort, after a disputed-detection stop, and after a clean bill
(nothing redundant or missing). Then confirm the project tree holds only installed artifacts.

## Do not

- Do not add or remove on a detection the user disputes, and never act on a layer without its
  consent round - the evidence line and the per-layer consent are the whole safety model.
- Do not touch a deliberate non-stack extra, an always-baseline item already installed, or a shared
  item whose owning stack IS present - the tool already excludes these; never second-guess it.
- Do not act on a `no-evidence:` advisory - it is information, not a removal candidate; package
  absence is weak proof (vendored code, a preinstalled skill for planned work, a scan miss).
- Do not act on a DORMANT advisory without an explicit user request, and never present dormancy
  as a removal argument - occasion-bound machinery earns its place on the occasion; cite the
  item's own description, not an invented usage frequency.
- Do not propose a judgment drop or add without its gate evidence - the corroboration trail
  (named greps with their zero or quoted-positive hits, the skill's own exclusion check) or the
  verbatim-quoted conflicting rule with its source - and never put a JUDGMENT row in a signal-tier
  table - the two have different reliability and the user must always see which is which. A
  judgment add additionally needs a trail the run itself surfaced - never a speculative catalog
  sweep - and an overlap drop additionally needs the survivor's gap named: a 'redundant' claim
  that cannot say what the drop candidate uniquely does has not finished the analysis.
- Do not skip the prerequisite gate before an install, and never remove what a kept item still
  needs. Do not paste tool output or leave `$TMP` behind on any exit path. Do not commit anything.
