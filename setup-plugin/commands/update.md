---
description: "FAST refresh of an existing claude-stack install - no selection questions: bring everything currently installed to the newest release, MCP runtimes and plugins included (pinned MCPs re-resolved and re-registered, `claude plugin update` per installed stack plugin) AND prune what the stack itself deleted or renamed upstream since the stamped install. The common case (upstream removed nothing) is one script-driven pass: the installer's --installed-only derives the selection from disk and refreshes it, nothing else loads. The prune list is computed from the GitHub compare between the stamp and the new snapshot, never guessed - plus the snapshot's meta/migrations.json entries for retired GENERATED artifacts (existence-detected, e.g. the legacy inject-code-style hook) that a file compare can never name. User-authored artifacts and the generated baseline-project-*.md / project-code-style.md rules can never be touched. One confirmation before anything is deleted. NOT for choosing items to add or drop - that is the sibling configure command; not a first install - that is setup."
disable-model-invocation: true
---

# Update the Claude stack - refresh everything, prune what upstream removed

You are refreshing an existing install to the newest release, unchanged in shape: the same
items, new content - including the MOVING parts: the installer re-resolves every pinned MCP
runtime to its newest published version and re-registers it, and runs `claude plugin update` on
each installed stack plugin after refreshing the marketplaces, so an update leaves no MCP or
plugin behind on an old version - plus removing the artifacts the STACK removed upstream, which a plain
refresh leaves orphaned forever. The deterministic work lives in scripts, not in this chat:
the installer's `--installed-only` derives the selection from disk and closes its dependencies
itself, and `stamp-compare.js` computes the upstream delta - you orchestrate and report.
Measured before this split, a model-driven walk grew the session ~40k tokens; keep the fast
path near 10k by never reading files or output the steps below do not name.

**This run needs NO conversation context.** When invoked inside a session already carrying real
work, say so in one line and put the choice through AskUserQuestion - run here anyway vs run in
a fresh session (recommended) - before anything downloads: the fast path itself is ~10k tokens,
but at a long tail every one of its messages re-sends the whole session (measured: the same
update cost 7.9M cache-read at a 518k-token tail, ~790x its own budget).

**ONE release archive is the entire download** - the shared contract lives at
`${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md`; read it first and hold the whole run to
it: download + extract once into `$TMP/repo`, use every tool from that snapshot, hand it back
with `--source` in the install step, and remove `$TMP` on EVERY exit path (fast, slow, blocker,
or a user 'no'). The protocol's 'Narrate, don't trace' section governs every tool call: quiet
machinery, no pasted output, one narration line between steps.

## 1. Preconditions
Project mode: cwd has a populated `.claude/` (skills/agents/rules/hooks present). Global mode:
the account dir holds the skills (the installer lays agents/rules/hooks only into a git repo's
`.claude/`, whatever the scope - a global refresh is skills-only). Nothing installed in either place -> stop and route to the
sibling `/claude-stack:setup` command. The user names items to add or drop -> that is the
sibling `/claude-stack:configure` command, not this one. OS: `darwin`/`linux` -> the sh
installer; Windows -> the ps1 (via `pwsh`).

## 2. Compute the delta since the stamp
One script call from the snapshot:

```bash
node "$TMP/repo/scripts/stamp-compare.js" --snapshot "$TMP/repo" --stamp .claude/claude-stack.stamp
```

(Global mode: the account dir's stamp. A fork install passes `--repo <owner/name>`.) It prints
the version delta, then `status<TAB>path` lines (`modified`/`added`/`removed`, `renamed` with
`<- old-path`) filtered to stack-owned paths; the diff is what has been RELEASED since the
stamp - work still on `develop` is invisible by design, never diff against it. Lead your
narration with the version delta.

Then read the snapshot's `$TMP/repo/meta/migrations.json` - the retirements of GENERATED
per-project artifacts a file compare can never name. For each entry, run its `detect` against
the install root (project mode: the `.claude/` parent; global mode: the account dir); a
detected entry joins the prune list labeled `(migration: <why>)`, together with its
`unwire_settings_hook` edit and its `then` follow-up for the report. Not detected -> silently
skip.

**Environment migrations are the exception: they never join the prune list.** An entry whose
`detect` is `settings_env_key` and whose action is `rename_settings_env` changes a KEY in the
scope's settings.json `env`, deletes nothing, and carries the user's value across - so it needs
no deletion consent. The installer's env pass applies it during the refresh in both step 3 and
step 4 (renames first, then the absent-only seeds, so a value set under the old name is never
overwritten by the new key's default). Your job is to detect it before the run and NAME it in the
report: `env: <old> renamed to <new> (value kept)`. New variables the release introduces need no
catalog entry at all - the same pass seeds them absent-only - but report those too, as
`env: <key> seeded (<value>)`, reading the file after the run rather than assuming.

**Build the prune list** from the compare's `removed` lines (a `stack/...` path gone entirely
maps to its installed artifact; a path still present in the snapshot is a move WITHIN the item,
not a removal), the `renamed` lines of installed items (both halves, automatically: old name
pruned, new name joins the refresh - a rename is the same item continuing, never an adoption
choice), and the detected migrations. Three outputs decide the path:

- **Prune list EMPTY** -> step 3, the fast path. This includes `no-stamp` (exit 2 - no baseline,
  pruning impossible, refreshing unaffected), `compare-unreachable` (exit 3 - same), and a
  `TRUNCATED` line, third after the version + base lines (the removal list cannot be trusted complete - never prune from a
  possibly-partial diff; route the reconcile to `configure` in the report). Say which applied.
- **Prune list NON-EMPTY** -> step 4, the pruning path.

## 3. Fast path - refresh in place (the common case)
Run the installer; it derives the selection from disk itself, closes new dependencies through
`stack-select.js`, and logs any `installed-only: required:` additions:

- Unix: `bash "$TMP/repo/scripts/os/claude-stack.sh" update --source "$TMP/repo" --scope <scope> --installed-only [--space <name>] --keep-pins`
- Windows: `pwsh -File "$TMP/repo/scripts/os/claude-stack.ps1" update -Source "$TMP/repo" -Scope <scope> -InstalledOnly [-Space <name>] -KeepPins`

Scope/space mirror how the install was laid down; `--keep-pins` is the default here - a fast
refresh must not flatten deliberate local model/effort pin edits. The refresh re-registers every MCP;
for sentry that means the constant `https://mcp.sentry.dev/mcp/${SENTRY_SLUG}` registration with
the `Sentry-Bearer` header (an old plain-`Bearer` header, the broken v0.2.33-and-earlier default,
migrates by itself; a deliberately headerless oauth registration is read back and kept). Sentry
environment plan, no question on this path: when sentry is installed, read the ACCOUNT
`settings.json` env (`~/.claude/settings.json`, or the space's) and report - as ONE line in the
close-out, with the file path - any of `SENTRY_SLUG` and (token mode) `SENTRY_ACCESS_TOKEN` still
missing: the user adds them there by hand (`{ "env": { "SENTRY_SLUG": "<org>[/<project>]",
"SENTRY_ACCESS_TOKEN": "<token>" } }`; never a project-level `.claude/settings.json`, its env does
not reach `.mcp.json`), or runs `/claude-stack:configure`, whose sentry plan asks the slug. The
slug is not a secret and can be typed anywhere; the TOKEN never travels through the chat - offer
this copy-ready command with that line, so the value goes from the user's clipboard into the file
without passing through a transcript (it is not echoed, and it is not a shell argument either):

```bash
python3 -c "import getpass,json,pathlib;f=pathlib.Path('~/.claude/settings.json').expanduser();d=json.loads(f.read_text() or '{}') if f.exists() else {};d.setdefault('env',{})['SENTRY_ACCESS_TOKEN']=getpass.getpass('token (not echoed): ');f.parent.mkdir(parents=True,exist_ok=True);f.write_text(json.dumps(d,indent=2))"
```

On Windows: `$t = Read-Host 'token' -AsSecureString`, then write the same key with
`ConvertFrom-SecureString -AsPlainText`. If the user pastes the token into the chat anyway, use it
for what they asked and END THE TURN on the rotation ask - it is in the transcript on disk now, and
that is their decision to make, not one to leave unsaid. Then:

- The compare showed `stack/CLAUDE.template.md` modified -> reconcile the project's CLAUDE.md
  additively (step 6). Otherwise skip it without reading either file.
- Report per step 7 - version delta, refreshed counts from the installer's log tail, the
  `required:` additions it named, and FYI `added` items from the compare (mapped to item names;
  never install them - route adoption to `configure`).
- EXCEPTION to FYI-only: when an `added` item is a `guard-*` ENFORCEMENT hook, a prose bullet
  is not enough - put adoption through AskUserQuestion (adopt now / skip for now, adopt
  recommended), and on 'adopt now' copy the hook from `$TMP/repo/stack/hooks/` into
  `.claude/hooks/` and wire its matcher entries into settings.json exactly as the installer's
  hook step does (measured: the v0.2.20 commit gate reached zero of three consuming projects -
  every update surfaced it as an FYI the user exited past, while the same updates refreshed the
  rule text the hook exists to enforce, leaving the discipline prose-only for a week).
- Clean up `$TMP` and stop. Steps 4-5 never run on this path.

## 4. Pruning path - confirm once, then refresh + prune
Inventory the CURRENT selection from disk exactly as the sibling `configure` command's step 1
(`${CLAUDE_PLUGIN_ROOT}/commands/configure.md` - read it only on THIS path; command bodies do
not co-load): skills dirs, `agents/*.md`, `rules/*.md` (excluding the GENERATED
`baseline-project-*.md` and `project-code-style.md`), hooks (bare basenames, excluding the
GENERATED legacy `inject-code-style.js`), mcps from `<repo>/.mcp.json`, plugins fail-soft and
filtered to entries enabled for THIS project (the listing is machine-global; an unfiltered read
re-submits a sibling repo's plugin to this project's refresh - measured) - never from memory.

Show the version delta, the refresh counts by category, and the NAMED prune list (migrations
included, with their why). Ask ONE question through AskUserQuestion: proceed with refresh +
prune (recommended), or refresh only. Nothing is ever deleted silently; 'refresh only' means
step 3's installer run instead, then the report. For example:

```
claude-stack 0.1.0 -> 0.2.0 - refresh: 12 skills, 9 agents, 6 rules, 3 hooks
prune: .claude/rules/web-conventions.md (renamed upstream; typescript-conventions.md carried over)
```

On 'proceed': selection = installed, minus the confirmed prune list, plus the new names of
renames; write `raw.json`, run `stack-select.js --selection raw.json --emit selection.txt
--check`. A `required:` line (a dependency the new release introduced) is auto-kept and
reported. An `unknown:` line is an upstream retirement the compare missed - already excluded
from the emitted selection; add it to the prune list (an MCP simply drops out of the
regenerated `.mcp.json`; name it in the report). Blockers stop the run with their fixes -
never update past one; warnings are listed and passed. Then run the installer as in step 3 but
with `--selection selection.txt` / `-Selection selection.txt` in place of the installed-only
flag.

## 5. Prune
Delete each item on the confirmed list, showing every command before running it. A deleted hook
also loses its `.claude/settings.json` wiring in the same pass - show that edit too (a
migration entry's `unwire_settings_hook` names exactly which entry goes - `<file>::<Matcher>`
scopes it to ONE matcher when the file stays wired for its other events, and a
`settings_hook_wired` detect matches on that wiring being present rather than on a file;
parse-edit-rewrite,
never regex, never touching other wiring). A migration's `then` line goes in the step-7 report
as a next step - run nothing on the user's behalf.

## 6. Reconcile the project's CLAUDE.md (project mode)
Against the snapshot's `stack/CLAUDE.template.md`, ADDITIVELY, exactly as the sibling
`configure` command's step 11: add sections the template gained, update the rules table for
what this run pruned, never overwrite the project's own prose, show changes before writing.
Skip in global mode - and on the fast path, skip unless the compare showed the template
changed.

## 7. Post-check
Report the version delta, refreshed / pruned counts by category (naming the pruned items), the
ENVIRONMENT line (every key the run seeded or renamed, read back from the scope's settings.json
`env` - `env: <old> renamed to <new> (value kept)` / `env: <key> seeded (<value>)`; nothing
changed -> say so in one clause, never a silent omission: an env key that moved under the user's
feet must be visible in the same place they read the counts), the
FYI additions routed to `configure`, and the MCP-restart reminder. The run rewrote
`claude-stack.stamp` - the next update or configure diffs from here. When the release refreshed
ANY installed skill or agent file, name `/project-agent-capabilities` (when installed) as the
USER's next step - never gated on roster adds/drops: the generated rule stamps each skill's
first sentence, which drifts with content-only updates (measured: a 'roster unchanged, rule
still accurate' skip left 7 of 10 stamped sentences stale and the user caught it manually).
When serena is installed, also name the one-off re-index as a next step whenever this run
re-seeded `.serena/project.yml` - an install predating the seeding has no `ignored_paths`, so its
cache was built over serena's own language-server directory: `SERENA_HOME=.serena/home uvx --from
serena-agent serena project index`. Never invoke it from this run - the skill is manual-only (`disable-model-invocation`), so a
Skill call is blocked (measured: an update run tried and the harness refused it); the report
line is the mechanism.

## 8. Clean up the temp dir - ALWAYS
Remove `$TMP` per `${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md`, on EVERY exit path:
after the fast path, after refresh + prune, after refresh-only, after a blocker, and after a
user 'no'. Then confirm the project tree holds only installed artifacts.

## Do not
- Never delete anything the upstream diff or the migrations catalog did not name - user-authored
  skills/agents/rules/hooks and the generated `baseline-project-*.md` / `project-code-style.md`
  rules appear in neither; if a candidate is in neither list, it stays.
- Never install additions and never remove an MCP or plugin the diff did not retire - adopting
  or dropping by choice is the sibling `configure` command.
- Never skip the step-4 confirm before deletions, never run past a blocker, and never leave
  `$TMP` behind. Do not commit anything on the user's behalf.
- Never re-derive in chat what a script already computed: no re-listing installed items on the
  fast path, no reading the compare's raw API JSON, no paging installer output beyond its
  summary tail.
