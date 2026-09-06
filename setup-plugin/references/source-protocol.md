# The one-download protocol - shared by the setup, update, configure, and validate commands

The four downloading commands (`/claude-stack:setup` - fresh install, `/claude-stack:update` -
refresh + prune, `/claude-stack:configure` - adjust the selection, `/claude-stack:validate` -
reconcile to the project; `status` never downloads) drive their whole run from ONE
source snapshot. This file is the shared contract; each command's numbered steps say WHEN to
apply it, this file says WHAT holds. It lives at the plugin root's `references/` and the commands
cite it as `${CLAUDE_PLUGIN_ROOT}/references/source-protocol.md` - commands and references ship
together in the plugin.

## One release archive is the entire download

```bash
TMP=$(mktemp -d)
curl -fsSL https://github.com/envoydev/claude-stack/releases/latest/download/claude-stack.tar.gz -o "$TMP/claude-stack.tar.gz"
mkdir -p "$TMP/repo" && tar -xzf "$TMP/claude-stack.tar.gz" -C "$TMP/repo"
```

Windows (PowerShell):

```powershell
$TMP = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TMP -Force | Out-Null
Invoke-WebRequest -Uri https://github.com/envoydev/claude-stack/releases/latest/download/claude-stack.zip -OutFile "$TMP/claude-stack.zip"
Expand-Archive -LiteralPath "$TMP/claude-stack.zip" -DestinationPath "$TMP/repo"
```

**Carry `$TMP` in a MARKER FILE, and address every run artifact through it.** Each Bash call is its
own shell, so a `TMP=$(mktemp -d)` set in one call is gone by the next and every run invents its own
way of remembering it. The idiom, once, in both homes:

```bash
TMP=$(mktemp -d); printf '%s\n' "$TMP" > /tmp/claude-stack-run.path   # first call
TMP=$(cat /tmp/claude-stack-run.path)                                  # every later call
```

Every artifact this run writes or reads - `raw.json`, `selection.txt`, `select.out`, `final.json` -
is named as `"$TMP/<file>"`, never bare. A bare relative name resolves against whatever cwd the
shell drifted to, and the six sites that carried one were saved only by a model choosing an absolute
path on its own initiative. PowerShell keeps `$TMP` the same way, in the same marker file.

- The archive is the newest release - the repo's release workflow republishes it on every
  release merge to `main`, tagged `v<version>` from the plugin manifest, so the release version
  always equals the plugin/marketplace version; the `releases/latest/download/...` URLs above
  always resolve to the newest one. `main` is the RELEASE branch (development lands on
  `develop`, so an install never picks up unreleased work) - one self-consistent snapshot, whose
  `RELEASE-SOURCE` file names the exact commit and version it was built from. The `raw.githubusercontent.com` URLs are
  per-file and sit behind a CDN that serves a cached copy for ~5 min after a push, so raw can
  hand back a stale installer or a skewed mix of versions. Never fetch anything from a raw URL -
  not even as a fallback.
- **Fallback when the download fails** (no release reachable, a proxy, the moment the workflow
  is recreating the release): `git clone --depth 1 -b main https://github.com/envoydev/claude-stack
  "$TMP/repo"` - the same one-snapshot contract, just fetched with git. Keep the `-b main` pin:
  the fallback must deliver the release branch, never whatever the default branch happens to be.
  If both fail, say so and stop; never assemble a source from raw URLs.
- Never write the archive, the extracted repo, or your working files into the project tree.

## Check the plugin itself is current

The tooling always comes fresh from the snapshot, but YOUR numbered steps ship with the
installed plugin - so compare versions right after the download: the snapshot's is the
`version:` line in `$TMP/repo/RELEASE-SOURCE`; the running plugin's is in
`${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` (no `CLAUDE_PLUGIN_ROOT` in the environment ->
skip this check silently). When they differ, the plugin is behind the release: say so, recommend
`claude plugin marketplace update claude-stack` then `claude plugin update claude-stack`, and
offer to continue anyway - the snapshot tooling is current either way; the risk is only that
these instructions lag it. The plugin cache is keyed by version
(`~/.claude/plugins/cache/claude-stack/claude-stack/<version>/`), so after an update the old
version dirs are inert leftovers - safe to delete, keeping only the dir the update installed.
And if an update ever does NOT change the running content (a same-version re-release - the trap
every release now avoids by bumping), the hard reset is `claude plugin uninstall claude-stack`
then `claude plugin install claude-stack@claude-stack`, which rebuilds the cache from the
marketplace.

## Narrate, don't trace

The run must read as a guided installer, not a terminal log. The user sees every tool call's
header, so keep the machinery to as few, small calls as possible and put ALL meaning in your own
narration lines between them:

- ONE quiet call per recompute: write the working file(s) and run `stack-select.js` in a single
  short command - with its output redirected to a file (`> "$TMP/select.out" 2>&1`), never to the
  terminal: the tool-result preview would otherwise dump the whole `required:`/`orphan:` wall
  into the chat. Read the file to parse; the visible result of the call should be empty or one
  count line. Never a call per file, never a re-run to re-read what you already have.
- Never paste tool output (`required:`/`orphan:` dumps, file listings, diffs) into the chat - the
  tables and banners you compose ARE the presentation; raw lines are your input, not the user's.
- Between steps, one narration line in this shape - what just closed, what is being computed,
  what comes next:

```
Final rule set: the 10 recommended (customize round confirmed no changes). Folding into raw.json and recomputing the agents layer's locked set.
24 locked skills. Computing the extras list (release catalog minus locked) before presenting the table.
```

- Machinery that produces no decision (mktemp, downloads, cleanup) gets no narration beyond the
  protocol's own one-liners; a failure is narrated with its consequence, never a stack trace.

## Use the tools from the snapshot

Everything comes out of `$TMP/repo`:
- the installer - `scripts/os/claude-stack.sh` on `darwin`/`linux`, `scripts/os/claude-stack.ps1` on
  Windows (via `pwsh`)
- `scripts/stack-select.js` and `meta/stack-graph.json` (selection closure + prerequisite check)
- the `meta/` catalogs - `recommendations.json`, `evidence.json`, `judgment.json` (seeds, the
  evidence-scan signals, the judgment gates)
- `stack/CLAUDE.template.md` (the CLAUDE.md fill-in / reconcile step)
- `RELEASE-SOURCE` - the snapshot's commit (the `configure` and `update` commands compare the stamp against it
  via the GitHub compare API; an archive has no git history to diff locally)

Run every later `node`/`bash` step against these snapshot copies - never re-fetch one from a raw
URL; the snapshot is already the newest, consistent copy, and it is the copy the installer runs
from.

## Hand the same snapshot to the installer

Pass `--source "$TMP/repo"` (`-Source` on Windows) when running the installer's action. That is
what keeps a guided run at ONE download instead of two, and it guarantees the run lands the same
revision the command's earlier steps inspected. The installer copies out of `$TMP/repo`, writes the
`claude-stack.stamp` naming that revision (from `RELEASE-SOURCE`, or the checkout's HEAD when the
fallback cloned), and never deletes a source it was handed - cleanup is the command's job, below.

## Clean up the temp dir - ALWAYS

`rm -rf "$TMP"` (PowerShell: `Remove-Item -Recurse -Force $TMP`). The archive, the extracted
repo, and the working files you wrote next to them (`raw.json`, `selection.txt`) live there and
nothing else will remove them - the installer only cleans up a source IT fetched, never the one
you passed via `--source`. Do this on EVERY exit path, not just the happy one - each command's
final step lists its own exit cases. Then confirm the project tree holds only installed
artifacts - no archive, no extracted repo, no `raw.json`/`selection.txt`, no installer copy.
