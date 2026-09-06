#Requires -Version 5.1
<#
.SYNOPSIS
  Install or update the Claude Code stack (skills, plugins, MCPs, hooks, agents, rules) into a project.

.DESCRIPTION
  PowerShell port of claude-stack.sh: every skill / plugin / MCP from claude-stack.html (the complete
  toolset, not a curated subset), installed INTO a project. Built-in/system CLI skills are excluded
  (they ship with the CLI). Requires the `claude` CLI; claude-only steps fail soft if it is absent.
  The Cursor stack lives in the cursor-stack repo.

  Windows differences vs claude-stack.sh: hook .js files are invoked via `node` (no shebang/exec bit);
  settings.json is merged natively (ConvertFrom/To-Json), no python dependency; MCP arg strings stay
  LITERAL (${CLAUDE_PROJECT_DIR:-.}) so Claude Code interpolates them at launch.

.PARAMETER Action
  REQUIRED. 'install' = first-time provision; MCP/plugin versions freeze until the next update; wires
  .claude/settings.json. 'update' = re-resolve every runtime to latest + refresh hooks/agents/rules;
  re-ensures the settings.json hook wiring (idempotent).

.PARAMETER Space
  Any word -> install into the ~/.claude-<Space> account (CLAUDE_CONFIG_DIR is exported for the claude
  CLI) and use a separate memory_<Space>.db. Omit for the default ~/.claude account + shared memory.db.

.PARAMETER Scope
  'project' (default) installs INTO this repo; 'global' installs into the active account. Overrides the
  SCOPE env var; when neither is set, defaults to 'project'.

.PARAMETER Context7
  context7 transport: 'remote' (default) = the hosted HTTP server, no local process; 'local' = the
  local npx stdio server.

.PARAMETER SentrySlug
  Seed SENTRY_SLUG - the Sentry org ('<org>') or project ('<org>/<project>', Sentry's recommended form) -
  into the ACCOUNT settings.json 'env' (<account>\settings.json); the registration reads it at launch as
  https://mcp.sentry.dev/mcp/${SENTRY_SLUG}. Absent = the env is left as it is.

.PARAMETER SentryAuth
  sentry MCP auth. 'token' (default) sends `Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}` (a
  personal/org API token you add to the same account 'env' yourself); 'oauth' registers NO header, so
  Claude Code runs Sentry's browser consent flow on first connect instead. Both values expand from the
  ACCOUNT settings.json 'env' or the launch environment - never from a project-level .claude\settings.json
  (measured: that stays literal). update: absent = keep the mode the existing registration carries.

.PARAMETER GitHubCli
  Install the GitHub CLI (gh) via winget if missing. Reminds you to run `gh auth login` when unauthenticated.

.PARAMETER KeepPins
  Keep this project's LOCAL model/effort frontmatter edits on installed agents (.claude/agents) and
  skills (SKILL.md) across the refresh - the local value is re-applied after the fetch/reinstall
  (which otherwise resets it to upstream). Only existing keys are re-applied; with the switch on, a
  local pin edit always wins over an upstream pin change.

.PARAMETER Selection
  Install ONLY the skills/plugins/mcps/agents/rules/hooks named in <file> (one 'category name' per
  line); a selection with no 'hook' lines installs all hooks.

.PARAMETER InstalledOnly
  Update only: derive the selection from what is already installed (skills/agents/rules/hooks on
  disk, mcps from .mcp.json; generated project-owned files excluded) and refresh exactly that -
  never adds, never removes. Closed through stack-select.js when it is reachable next to this
  script, so a dependency a new release introduced still installs. MCPs and PLUGINS are refreshed
  to the newest versions: the pinned MCP entries are re-resolved and re-registered, and every
  installed stack plugin gets 'claude plugin update'. Plugins come from 'claude plugin list'
  (machine-level - no project dir to read), intersected with the manifest, so a third-party plugin
  is never touched.

.PARAMETER PrintPlan
  With -Selection or -InstalledOnly, print the resolved per-category install set and exit (dry run).

.PARAMETER SkillsOnly
  Run only the skill install/update step, then exit (testability; skips prerequisites/plugins/mcps/
  hooks/agents/rules).

.PARAMETER Source
  Install FROM an existing claude-stack checkout instead of cloning one. The caller owns the
  directory - this script never deletes it. Used by the /claude-stack setup+configure skills, which
  clone once and pass it here so a guided run takes one clone, not two. Omit it and the script
  clones its own source (and removes it on exit) - the standalone path.

.NOTES
  Environment variables:
    SCOPE=project|global  fallback for -Scope when the flag is absent (default project).
    CLAUDE_CONFIG_DIR     target a specific account when no -Space is given (default ~/.claude).
    STACK_SKILLS_REPO     stack source repo (release-archive download, git-clone fallback; default https://github.com/envoydev/claude-stack).
    CONTEXT7_API_KEY      context7 API key; add it to the ACCOUNT settings.json 'env' for higher rate limits (unset = the keyless free tier).
    CONTEXT7_BAKE_KEY     with -Context7 local, bake CONTEXT7_API_KEY into the registration (keep .mcp.json uncommitted).
    SENTRY_SLUG           the Sentry org or org/project the sentry MCP URL is scoped to - lives in the ACCOUNT settings.json 'env'
                          (seeded by -SentrySlug); unset = a literal ${SENTRY_SLUG} URL that connects and then fails every call.
    SENTRY_ACCESS_TOKEN   -SentryAuth token (default): a sentry API token (Settings -> Account -> API -> Personal Tokens, or
                          an org token) - add it to the ACCOUNT settings.json 'env' yourself; never in .mcp.json, never in a
                          project-level settings.json (does not reach .mcp.json expansion). Not SENTRY_AUTH_TOKEN: that is
                          sentry-cli's release/symbol-upload credential (needs project:releases).

  On Windows PowerShell 5.1 use `powershell` instead of `pwsh`. If scripts are blocked, run once:
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass.

.EXAMPLE
  .\claude-stack.ps1 install
  Install the full stack into the current project (default account, project scope).

.EXAMPLE
  .\claude-stack.ps1 install -Space work -GitHubCli
  Install into the ~/.claude-work account (+ memory_work.db) and install the GitHub CLI.

.EXAMPLE
  .\claude-stack.ps1 update -Scope global
  Update everything to latest in the global (~/.claude) account.
#>
[CmdletBinding()]
param(
  # REQUIRED main action.
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('install', 'update')]
  [string]$Action,
  # Optional space (any word): selects the Claude account ~/.claude-<Space> (skills/plugins/MCPs
  # install there) AND a separate memory DB (memory_<Space>.db). Named-only. Omit for the default
  # account + shared DB. e.g.: .\claude-stack.ps1 install -Space work
  [string]$Space = '',
  # Optional install scope. 'project' (default) installs INTO this repo; 'global' installs into the
  # active account. Overrides the SCOPE env var; empty here -> resolved from SCOPE, then 'project'.
  [string]$Scope = '',
  # Optional: context7 transport. 'remote' (default) = hosted HTTP server, no local process;
  # 'local' = the local npx stdio server. e.g.: .\claude-stack.ps1 install -Context7 local
  [ValidateSet('remote', 'local')]
  [string]$Context7 = 'remote',
  # Optional: seed SENTRY_SLUG ('<org>' or '<org>/<project>') into the ACCOUNT settings.json env, which the
  # sentry MCP URL reads at launch. Empty -> the env is left alone. e.g.: .\claude-stack.ps1 install -SentrySlug acme/api
  [string]$SentrySlug = '',
  # Optional: sentry MCP auth, 'token' (default; Sentry-Bearer header, SENTRY_ACCESS_TOKEN from the account
  # settings.json env) or 'oauth' (no header, browser consent on first connect). Empty -> token on install,
  # the existing mode on update. e.g.: .\claude-stack.ps1 install -SentryAuth oauth
  [string]$SentryAuth = '',
  # Optional: install the GitHub CLI (gh) via winget if missing; prompts for `gh auth login`
  # when unauthenticated. e.g.: .\claude-stack.ps1 install -GitHubCli
  [switch]$GitHubCli,
  # Optional: keep local model/effort frontmatter edits on installed agents/skills across the
  # refresh (an update resets them to upstream otherwise). e.g.: .\claude-stack.ps1 update -KeepPins
  [switch]$KeepPins,
  # Optional: install ONLY the skills/plugins/mcps/agents/rules named in <file> (one 'category name'
  # per line; a selection with no 'hook' lines installs all hooks). e.g.: .\claude-stack.ps1 install -Selection selection.txt
  [string]$Selection = '',
  # Optional (update only): derive the selection from what is already installed and refresh exactly
  # that - never adds, never removes. e.g.: .\claude-stack.ps1 update -InstalledOnly -KeepPins
  [switch]$InstalledOnly,
  # Optional: with -Selection or -InstalledOnly, print the resolved per-category install set and exit (dry run).
  [switch]$PrintPlan,
  # Optional: run only the skill install/update step, then exit (testability; skips prerequisites/
  # plugins/mcps/hooks/agents/rules). e.g.: .\claude-stack.ps1 install -SkillsOnly -Scope project
  [switch]$SkillsOnly,
  # Optional: install FROM an existing claude-stack checkout instead of cloning one. The caller owns
  # <dir> - this script never deletes it. e.g.: .\claude-stack.ps1 install -Source C:\tmp\repo
  [string]$Source = ''
)

$ErrorActionPreference = 'Stop'
# Keep NATIVE command failures non-fatal (mirror the .sh `|| true` tolerance); cmdlet errors still throw.
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

# A space is any word but becomes part of a path (~/.claude-<Space>, memory_<Space>.db) - validate it.
if ($Space -and $Space -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
  Write-Host "space name '$Space' must start alphanumeric and contain only [A-Za-z0-9._-]" -ForegroundColor Red
  exit 1
}

# -InstalledOnly refreshes an EXISTING install from disk - meaningless on a first install, and
# -Selection is the explicit alternative to deriving one; the two cannot both decide the set.
if ($InstalledOnly) {
  if ($Action -ne 'update') { Write-Host "-InstalledOnly is an update flag (got action '$Action')" -ForegroundColor Red; exit 1 }
  if ($Selection) { Write-Host '-InstalledOnly and -Selection are mutually exclusive - one source of the set' -ForegroundColor Red; exit 1 }
}

function Log([string]$Message) { Write-Host "==> $Message" -ForegroundColor Blue }

# Run-outcome tracking for the honest end-of-run summary.
$script:FailCount     = 0        # item install/add failures (skills / plugins / mcps)
$script:ClaudeMissing = $false   # claude CLI absent -> plugins / MCPs / settings.json wiring skipped
$script:PrereqMissing = $false   # a hard prerequisite (uvx / python3 / node) was missing
function Add-Failure([string]$Message) { $script:FailCount++; Write-Host "  !! $Message" -ForegroundColor Red }

function Write-JsonFile([object]$Data, [string]$Path, [int]$Depth = 20) {
  # PowerShell's ConvertTo-Json indents inconsistently and version-dependently (5.1 = 4-space
  # ladders + double-space colons; 7 = deep nested alignment). node's JSON.stringify(_, null, 2)
  # is clean 2-space everywhere, and node is always present (Claude Code requires it). So: write
  # compact via PS, then reformat the file in place with node. Fallback to PS pretty if node is gone.
  $enc = New-Object System.Text.UTF8Encoding($false)
  # Windows gotcha: an existing target carrying the ReadOnly or Hidden attribute makes
  # [IO.File]::WriteAllText (and node's fs.writeFileSync below) throw "Access to the path ... is
  # denied" (UnauthorizedAccessException) even when the ACL would allow the write - FileMode.Create
  # cannot truncate such a file. Clear those bits first so the write lands on the real content.
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    try {
      $f = Get-Item -LiteralPath $Path -Force
      $blocked = [System.IO.FileAttributes]::ReadOnly -bor [System.IO.FileAttributes]::Hidden
      if ($f.Attributes -band $blocked) { $f.Attributes = $f.Attributes -band (-bnot $blocked) }
    } catch {}
  }
  [System.IO.File]::WriteAllText($Path, ($Data | ConvertTo-Json -Depth $Depth -Compress), $enc)
  if (Get-Command node -ErrorAction SilentlyContinue) {
    try {
      & node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8").replace(/^\uFEFF/,""));fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' $Path 2>$null
      if ($LASTEXITCODE -eq 0) { return }
    } catch {}
  }
  [System.IO.File]::WriteAllText($Path, (($Data | ConvertTo-Json -Depth $Depth) + "`n"), $enc)
}

function Install-GitHubCli {  # opt-in via -GitHubCli; fail-soft like everything else
  if (-not $GitHubCli) { return }
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    $ghVersion = try { (& gh --version 2>$null | Select-Object -First 1) } catch { 'version unknown' }
    Log "github-cli: gh already installed ($ghVersion) - skipping install"
  }
  elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Log 'github-cli: installing gh via winget'
    winget install --id GitHub.cli --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { Write-Warning 'winget install gh failed - install manually: https://cli.github.com'; return }
    # No auth during install (deliberate): run `gh auth login` once before the first GitHub
    # platform use (PRs/issues). Plain git push/pull never needs it.
    Log '  installed - run `gh auth login` before first GitHub platform use'
  }
  else {
    Write-Warning 'winget not found - install gh manually: https://cli.github.com (or scoop/choco install gh)'
  }
}

function Test-Prerequisites {
  # Warn (not fail) on missing prerequisites, matching the script's fail-soft philosophy.
  Log 'prerequisites check'
  $ok = $true
  # uvx: required by serena and memory MCP servers.
  if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) {
    Write-Host '  !! uvx not found - serena and memory MCPs will not work.' -ForegroundColor Red
    Write-Host '     Install: powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"' -ForegroundColor Yellow
    $ok = $false
  }
  else { Write-Host "  uvx: $((uvx --version 2>&1) -join '')" -ForegroundColor Green }
  # Python 3: required by the security-guidance plugin hook.
  # The Windows Store stub (WindowsApps) does not count - it pops the Store and exits.
  $pyCmd  = Get-Command python  -ErrorAction SilentlyContinue
  $py3Cmd = Get-Command python3 -ErrorAction SilentlyContinue
  $hasRealPy = ($pyCmd  -and $pyCmd.Source  -notlike '*WindowsApps*') -or
               ($py3Cmd -and $py3Cmd.Source -notlike '*WindowsApps*')
  if (-not $hasRealPy) {
    Write-Host '  !! Python 3 not found (Windows Store stub does not count) - security-guidance hook will fail.' -ForegroundColor Red
    Write-Host '     Install: winget install Python.Python.3.12' -ForegroundColor Yellow
    $ok = $false
  }
  else {
    $src = if ($py3Cmd -and $py3Cmd.Source -notlike '*WindowsApps*') { $py3Cmd.Source } else { $pyCmd.Source }
    Write-Host "  python3: $src" -ForegroundColor Green
  }
  # node: required by Claude Code, the convention hooks, and npx-based MCPs. Below 22.12 LTS some
  # MCPs (chrome-devtools) refuse to start and die at launch with a generic JSON-RPC -32000.
  if (Get-Command node -ErrorAction SilentlyContinue) {
    $nodeVer = (node --version 2>$null) -replace '^v', ''
    $tooOld = $false
    try { $tooOld = [version]($nodeVer -replace '-.*$', '') -lt [version]'22.12.0' } catch { $tooOld = $false }
    if ($tooOld) {
      Write-Host "  !! node $nodeVer - recommend Node >= 22.12 LTS. chrome-devtools (and some npx MCPs)" -ForegroundColor Yellow
      Write-Host '     require it; an older Node makes them die at launch with a generic JSON-RPC -32000.' -ForegroundColor Yellow
    }
    else { Write-Host "  node: $nodeVer" -ForegroundColor Green }
  }
  else {
    Write-Host '  !! node not found - Claude Code, the convention hooks, and npx-based MCPs need it.' -ForegroundColor Red
    $ok = $false
  }
  # csharp-ls: the csharp-lsp plugin shells out to it for Roslyn diagnostics. Off PATH and the
  # plugin dies at launch with "Executable not found in $PATH". Needed only for C# work, so warn.
  $csharpLs = Get-Command csharp-ls -ErrorAction SilentlyContinue
  if ($csharpLs) { Write-Host "  csharp-ls: $($csharpLs.Source)" -ForegroundColor Green }
  else {
    Write-Host '  !! csharp-ls not found - the csharp-lsp plugin needs it (C# work only).' -ForegroundColor Yellow
    Write-Host '     Install: dotnet tool install --global csharp-ls (needs the .NET SDK + ~\.dotnet\tools on PATH).' -ForegroundColor Yellow
  }
  # typescript-language-server: the typescript-lsp plugin shells out to it via a bare-name PATH lookup
  # (a SEPARATE npm package from typescript/tsserver). Off PATH -> the plugin dies at launch with
  # "Executable not found in $PATH". Needed for TS/JS work, so warn.
  $tsLs = Get-Command typescript-language-server -ErrorAction SilentlyContinue
  if ($tsLs) { Write-Host "  typescript-language-server: $($tsLs.Source)" -ForegroundColor Green }
  else {
    Write-Host '  !! typescript-language-server not found - the typescript-lsp plugin needs it (TS/JS work).' -ForegroundColor Yellow
    Write-Host '     Install: npm i -g typescript-language-server typescript.' -ForegroundColor Yellow
  }
  # claude CLI: the core dependency for plugins, MCPs, and settings.json wiring. Absent -> those steps
  # are skipped (fail-soft); flag it upfront so the user can fix PATH before the long skill install runs.
  if (Get-Command claude -ErrorAction SilentlyContinue) { Write-Host "  claude: $((Get-Command claude).Source)" -ForegroundColor Green }
  else {
    Write-Host '  !! claude CLI not found - plugins, MCPs, and settings.json wiring will be SKIPPED.' -ForegroundColor Red
    Write-Host '     Install: https://docs.claude.com/claude-code (then re-run to add plugins/MCPs).' -ForegroundColor Yellow
    $script:ClaudeMissing = $true
  }
  if (-not $ok) { $script:PrereqMissing = $true; Write-Host '  Install the missing tools above, then re-run.' -ForegroundColor Yellow }
}

# -Scope flag wins, else the SCOPE env var, else 'project'. Lower-case both enums so the resolved value
# is canonical and a non-canonical casing ('Global'/'Remote') behaves identically to the bash twin.
if (-not $Scope) { $Scope = if ($env:SCOPE) { $env:SCOPE } else { 'project' } }
$Scope = $Scope.ToLowerInvariant()
$Context7 = $Context7.ToLowerInvariant()
if ($Scope -notin @('project', 'global')) {
  Write-Host "-Scope must be 'project' or 'global' (got '$Scope')" -ForegroundColor Red
  exit 1
}
# -SentryAuth: lower-cased like the other enums; empty means 'resolve later' - token on install, the
# existing registration's mode on update (the sentry block below). -SentrySlug is seeded into the account
# settings.json env and lands inside a URL at launch, so only slug characters: 'org' or 'org/project';
# empty = leave the env alone.
$SentryAuth = $SentryAuth.ToLowerInvariant()
if ($SentryAuth -notin @('', 'token', 'oauth')) {
  Write-Host "-SentryAuth must be 'token' or 'oauth' (got '$SentryAuth')" -ForegroundColor Red
  exit 1
}
$SentrySlugRe = '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)?$'
if ($SentrySlug -and ($SentrySlug -notmatch $SentrySlugRe)) {
  Write-Host "-SentrySlug '$SentrySlug' must be a slug (<org> or <org>/<project>; chars [A-Za-z0-9._-])" -ForegroundColor Red
  exit 1
}

# This script provisions the Claude Code agent. (The Cursor stack lives in the cursor-stack repo.)
$Agent = 'claude-code'

# $ConfigDir is for path resolution only and is normally NOT exported - EXCEPT when a space is given:
# a space (any word) selects the Claude account ~/.claude-<Space> and IS exported so the claude CLI
# (skills/plugins/mcp) installs into it. Without a space, CLAUDE_CONFIG_DIR (a specific account you
# set yourself, e.g. ...\.claude-work) or the ~/.claude default is used and never exported.
if ($Space) {
  $spaceAccount = Join-Path $HOME (".claude-" + $Space)
  # Distinguish an existing account from a brand-new one so a typo'd space ('wrok') is visible, not silent.
  if (Test-Path -LiteralPath $spaceAccount -PathType Container) {
    Log "space '$Space' -> existing account $spaceAccount (CLAUDE_CONFIG_DIR exported for the claude CLI); memory DB memory_$Space.db."
  } else {
    Log "space '$Space' -> creating NEW account $spaceAccount (typo? did you mean an existing one?); memory DB memory_$Space.db."
  }
  if ($env:CLAUDE_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR -ne $spaceAccount) {
    Log "space '$Space' overrides CLAUDE_CONFIG_DIR ($env:CLAUDE_CONFIG_DIR)."
  }
  $ConfigDir = $spaceAccount
  $env:CLAUDE_CONFIG_DIR = $ConfigDir
} else {
  $ConfigDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
  if (-not $env:CLAUDE_CONFIG_DIR) {
    Log "CLAUDE_CONFIG_DIR not set - using the claude CLI default account; resolving config paths to $ConfigDir."
  }
}

$SerenaContext = 'claude-code'   # serena's --context for Claude Code

if ($Scope -eq 'project') {
  $top = (& git rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -eq 0 -and $top) { Set-Location -LiteralPath $top }
  $ClaudeScope = 'project'
}
else {
  $ClaudeScope = 'user'
}

# ===========================================================================
# MANIFEST - edit these, then run.
# ===========================================================================

# (1) Skills "repo|skill" (comment a line to skip). Full inventory - every skill (78).
$Skills = @(
  # House (envoydev/claude-stack)
  'envoydev/claude-stack|create-ticket'             # ticket generator (bug/story/epic/task) - tracker-agnostic EN Markdown, routes to references/<type>.md
  'envoydev/claude-stack|dev-log-convert'           # UA/EN work notes -> structured English work log; trigger 'dev-log'
  'envoydev/claude-stack|explain-code-tutor'        # senior-mentor explainer for code/bug/concept/trade-off via real-file walkthrough; depth ELI5/intermediate/expert
  'envoydev/claude-stack|project-quality-loop'             # autonomous review-and-fix loop pipeline over a loops/ folder of numbered prompts
  'envoydev/claude-stack|project-architecture-quality-loop'        # deliberate analyze-assess-improve loop - the project-architecture-analyzer capture writes ARCHITECTURE.md + ASSESSMENT.md, fix cons by tier, reconcile docs; manual /-only
  'envoydev/claude-stack|project-code-style-analyzer'    # deliberate code-style capture - fans out code-style-analyzer per language, merges docs/PROJECT-CODE-STYLE.md, generates + wires the inject-code-style hook; manual /-only
  'envoydev/claude-stack|project-architecture-analyzer'  # deliberate architecture capture - dispatches architecture-analyzer per module, reasons in the main session, writes docs/architecture/ARCHITECTURE.md + ASSESSMENT.md + the generated awareness rule baseline-project-architecture.md; manual /-only
  'envoydev/claude-stack|project-test-coverage-analyzer' # deliberate coverage capture - detect tooling per surface, instrumented run ONCE per surface in the main session, writes docs/test-coverage/COVERAGE.md (90% line after exclusions default, tiered weak points) + raw/ machine-readable results; manual /-only (the loop Read-loads it)
  'envoydev/claude-stack|project-test-coverage-loop'     # deliberate coverage analyze-triage-fix loop - runs the capture, works weak points by tier (tests inline/implementer briefs, testability refactors approval-gated, structural = user decision), reconciles docs; manual /-only
  'envoydev/claude-stack|project-version-upgrade'        # deliberate BREAKING version-event flow (framework/runtime/package major) - plan in-session via context7 + architecture-analyzer digests, approval gate (auto mode only on explicit user ask), staged execution via implementers + resolvers; manual /-only
  'envoydev/claude-stack|project-agent-capabilities'           # deliberate capabilities capture - inventories installed skills/agents/MCPs/plugins, generates the awareness rule baseline-project-agent-capabilities.md; manual /-only
  'envoydev/claude-stack|project-related-context'        # deliberate related-projects capture - args paths/URLs, fans out related-project-analyzer per sibling, writes the awareness rule baseline-project-related-context.md + docs/related-context/PROJECT-RELATED-CONTEXT.md; manual /-only
  'envoydev/claude-stack|project-build-from-scratch' # greenfield scaffolding + design->scaffold->slice-by-slice build orchestration over the pipeline
  'envoydev/claude-stack|project-solve-cross-task'    # entry-point router: classify -> smallest execution mode -> cross-domain contract freeze + integration gate; home of the shared subagent policies
  'envoydev/claude-stack|project-verify-plan'      # audit an implementation plan BEFORE building - risk-coverage review (traps named per the stack skill, scope, edges, minimal); precedes /code-review
  'envoydev/claude-stack|project-verify-code'     # single-chat, no-dispatch review of an assembled build - the inline alternative to /code-review: rerun build/test, gate vs plan, RUN the app on failable inputs, trace wire-contract changes to consumers, ranked punch-list
  'envoydev/claude-stack|project-implementer'              # single-chat build step: execute a verified plan task-by-task (contracts + per-task green gate + inline red-resolution, no dispatch), finish via /code-review + the done-gate
  'envoydev/claude-stack|project-solution-design'  # single-chat designer twin: read the architecture, judge where a change fits (extend/refactor/isolate), load the stack skill for traps, decompose into an ordered plan; feeds project-verify-plan
  'envoydev/claude-stack|project-solve-task'       # gated single-chat vertical: design -> plan audit -> user approval + build mode -> build -> build review (skippable: project-verify-code inline or the verifier seat) -> done-gate; hard user stop between steps, plan-file + serena-note state survives compaction
  'envoydev/claude-stack|project-diagnose-failure' # gated single-chat investigation: triage evidence to a tier -> gather (evidence-gatherer seats or inline) -> prove root cause -> user fork (report / contracted fix tasks / log-points card); read-only, any evidence source incl. none but a client report
  'envoydev/claude-stack|project-runtime-failure-signatures' # single-chat diagnoser twin: local-runtime crash signatures (null-ref/DI/deadlock/disposed/config-drift/boundary/HTTP-status) -> where to isolate each; pairs with systematic-debugging
  'envoydev/claude-stack|project-ci-failure-signatures'        # single-chat CI-diagnoser twin: red-pipeline signatures (compile/restore, green-locally-red-on-runner, quality-gate, signing/release, workflow-config, infra-flake) -> code-vs-environment call + route; pairs with project-runtime-failure-signatures
  'envoydev/claude-stack|project-stack-usage-analyzer' # token/tool usage audit of stack skill runs: transcript hunt -> analyze-usage.js per session -> per-session report + raw data under <docs-path>/claude-stack-usage-report/
  'envoydev/claude-stack|devops'           # DevOps for the .NET/Angular house: Docker multi-stage/digest-pinned/non-root, GitHub Actions CI/CD, safe expand-contract deploys, secrets/OIDC, Aspire AppHost
  'envoydev/claude-stack|database-conventions' # cross-engine DB conventions + per-engine skill routing
  'envoydev/claude-stack|database-security'    # SQL/data-layer security: parameterized-only injection, least-privilege DB accounts, row-level security, connection-string secrets, encryption, audit
  'envoydev/claude-stack|typescript'       # framework-agnostic TS/JS baseline (strict typing, modules, async, JS+JSDoc)
  'envoydev/claude-stack|javascript'       # base JS-family language layer: ESM modules, async discipline, two failure channels, modern-feature adoption, untrusted input, naming; typescript stacks on it
  'envoydev/claude-stack|ts-js-testing' # plain TS/JS testing hub: runner routing (Vitest default), role-keyed strategy, seam stubs over module mocks, exclusion catalog - practices only, the % bar is user-set via project-test-coverage-analyzer
  'envoydev/claude-stack|npm'                 # professional npm: lockfile+ci discipline, supply-chain baseline (ignore-scripts/cooldown/allow-git), audit gating, overrides vs legacy-peer-deps, exports maps + ESM-first publishing, update-bot cooldowns
  'envoydev/claude-stack|browser-extension'    # MV3 browser extensions: ephemeral service worker + storage tiers, typed cross-context messaging, isolated vs MAIN world, least-privilege permissions, CSP-safe UI, WXT tooling, store review + monetization
  'envoydev/claude-stack|webpack'             # webpack 5 library builds: transpile/type-check split (swc + fork-ts-checker + tsc declarations), externals from package.json, tree-shaking preconditions, ESM output state, resolution traps, config factory + cache pitfalls
  'envoydev/claude-stack|angular-conventions' # Angular 17+/TS house conventions (signals, OnPush, a11y)
  'envoydev/claude-stack|angular-testing'  # Angular testing hub: TestBed/harness patterns, runner routing, exclusion catalog - practices only, the % bar is user-set via project-test-coverage-analyzer
  'envoydev/claude-stack|angular-material'   # Angular Material + CDK: selective imports, M3 theming, CDK primitives, harnesses
  'envoydev/claude-stack|angular-styling'    # Angular CSS/styling: ViewEncapsulation, :host, ::ng-deep ways-out, design tokens, responsive, a11y styling
  'envoydev/claude-stack|angular-security'   # Angular/web frontend security: XSS/DomSanitizer bypass, CSP, CSRF, no-secrets-in-bundle, token storage, SSR/TransferState
  'envoydev/claude-stack|frontend'         # web frontend router: Angular/TS + in-skill design-quality guidance -> mobile
  'envoydev/claude-stack|mobile'           # Ionic/Capacitor router/index over the Angular (angular-conventions) + TypeScript baselines
  'envoydev/claude-stack|ionic'            # house Ionic/Capacitor conventions: UI, nav, lifecycle, permissions, plugin sourcing + wrapping
  'envoydev/claude-stack|capacitor-release' # Ionic/Capacitor release pipeline: cap sync/build, iOS+Android signing, store submission, OTA, versioning, CI, symbols
  'envoydev/claude-stack|ionic-security'   # Ionic/Capacitor mobile security: Keychain/Keystore storage, deep-link validation, permissions, cleartext/WebView hardening
  'envoydev/claude-stack|csharp'           # C# house conventions - style, naming, async, logging, DI
  'envoydev/claude-stack|csharp-design-patterns' # all 23 GoF patterns with modern .NET 8+ forms
  'envoydev/claude-stack|dotnet'           # router mapping .NET work areas to specialist skills
  'envoydev/claude-stack|dotnet-architecture-tests' # architecture fitness tests: NetArchTest (default)/ArchUnitNET - layer+dependency+naming+isolation rules as build-failing tests
  'envoydev/claude-stack|dotnet-aspire'    # .NET Aspire local orchestration: AppHost, ServiceDefaults, service discovery, dashboard
  'envoydev/claude-stack|dotnet-authentication' # ASP.NET Core authn/authz: JWT/OIDC/Identity, policy-based authz, secrets
  'envoydev/claude-stack|dotnet-code-quality' # C# quality enforcement: CSharpier formatter ownership, SDK analyzers + AnalysisLevel, .editorconfig severity, TreatWarningsAsErrors (+ legacy batch promotion), Roslynator, CI gate
  'envoydev/claude-stack|dotnet-console-apps' # console-app interface surface: CLI arg parsing (System.CommandLine 2.0/Spectre.Console.Cli/Cocona) + bot-SDK integration (Telegram/Discord/Slack/exchange) in a BackgroundService
  'envoydev/claude-stack|dotnet-cryptography' # System.Security.Cryptography: SHA-2, AES-GCM, RSA/ECDSA, PBKDF2/Argon2id, constant-time compare
  'envoydev/claude-stack|dotnet-web-error-handling' # Result + ProblemDetails (RFC 9457) + IExceptionHandler + FluentValidation
  'envoydev/claude-stack|dotnet-grpc'      # gRPC: .proto/codegen, ASP.NET Core host, 4 streaming modes, JWT/mTLS, interceptors, health
  'envoydev/claude-stack|dotnet-hosted-services' # worker/background-service host: BackgroundService, ExecuteAsync trap, scoped scope, PeriodicTimer, shutdown, Channels
  'envoydev/claude-stack|dotnet-windows-service' # Windows Service SCM layer: AddWindowsService, budgets, non-zero-exit recovery, sc.exe install, gMSA/hardening, ServiceBase maintenance
  'envoydev/claude-stack|dotnet-messaging' # event-driven messaging: Wolverine (MIT)/MassTransit, outbox, sagas, RabbitMQ/Azure SB
  'envoydev/claude-stack|dotnet-migrate'   # safe migration workflow: EF schema, .NET upgrades, NuGet - rollback + verify per step
  'envoydev/claude-stack|dotnet-minimal-api' # minimal API endpoint mechanics: MapGroup, TypedResults, endpoint filters, binding
  'envoydev/claude-stack|dotnet-mvc-controllers' # controller-based Web API: [ApiController], attribute routing, ActionResult<T>, auto-400 filter, action filters, binding
  'envoydev/claude-stack|dotnet-openapi'   # OpenAPI doc (Swashbuckle / built-in .NET 9+) + Scalar docs UI
  'envoydev/claude-stack|dotnet-realtime'  # SignalR real-time: strongly-typed Hub<T>, IHubContext push, groups/presence, reconnection, JWT-over-querystring, Redis/Azure backplane
  'envoydev/claude-stack|dotnet-security'  # OWASP Top 10 (2021) -> .NET 8 mitigations; deprecated-pattern warnings
  'envoydev/claude-stack|dotnet-source-generators' # Roslyn IIncrementalGenerator authoring + built-in generators (GeneratedRegex/LoggerMessage/STJ)
  'envoydev/claude-stack|dotnet-testing'   # .NET test strategy: AAA, per-layer coverage, library routing
  'envoydev/claude-stack|dotnet-web-backend' # ASP.NET Core cross-cutting: HttpClientFactory, OpenAPI, observability
  'envoydev/claude-stack|dotnet-winforms'  # WinForms conventions: MVP/binding, disposal, GDI leaks, high-DPI, migration
  'envoydev/claude-stack|dotnet-wpf'       # WPF strict-MVVM conventions, bindings, virtualization
  'envoydev/claude-stack|postgres'         # PostgreSQL engine delta: index types, JSONB, SARGability, EXPLAIN, pooling
  'envoydev/claude-stack|sqlite'           # SQLite engine delta: WAL/single-writer, PRAGMAs, type affinity, limited ALTER
  'envoydev/claude-stack|dotnet-data-access' # EF Core + NHibernate ORM hub (references/): DbContext, tracking, N+1, projection
  'envoydev/claude-stack|dotnet-architecture' # architecture decision hub (references/): clean/ddd/vsa/modular/microservices
  'envoydev/claude-stack|markdown-style' # Markdown authoring / review: syntax canon (valid) + house style overlay, two-pass procedure
  'envoydev/claude-stack|docs-as-code' # docs-as-code authoring: Mermaid sequence/ER diagrams, ADRs (Nygard/MADR 4), C4 views - per-type references/
  'envoydev/claude-stack|ilspy-decompile' # decompile a .NET assembly (ilspycmd via dnx) to read real API/behavior - framework internals, NuGet source, pre-upgrade checks
  'envoydev/claude-stack|dotnet-project-setup' # .NET solution build spine (hub, references/): src/tests layout, .slnx, Directory.Build.props, global.json, central package management, dotnet-tool pinning
  'envoydev/claude-stack|dotnet-performance' # perf-aware .NET design (hub, references/): allocation/type design (struct vs class, Span, ValueTask) + serialization-format choice (STJ source-gen / Protobuf / MessagePack)
  'envoydev/claude-stack|dotnet-diagnostics' # measure/diagnose a live .NET process (hub, references/): BenchmarkDotNet microbenchmarks + crash/hang/OOM dump capture & first-look SOS analysis
  'envoydev/claude-stack|nx'               # Nx monorepo: project-graph nav + 'nx affected' scoping, generators, module-boundary tags; CLI over MCP; serena-vs-nx routing
)

# (2) Plugins "<plugin>@<marketplace>" (non-default marketplaces added first).
$ExtraMarketplaces = @(
  'jarrodwatts/claude-hud'
  'DietrichGebert/ponytail'
)
$Plugins = @(
  'superpowers@claude-plugins-official'       # workflow skills: plan, TDD, debug, verify-before-done
  'claude-md-management@claude-plugins-official' # audit + revise CLAUDE.md files
  'csharp-lsp@claude-plugins-official'      # inline Roslyn diagnostics on edit (complements serena nav); needs csharp-ls (dotnet tool install -g csharp-ls)
  'typescript-lsp@claude-plugins-official'  # same for Angular/TS work
  'security-guidance@claude-plugins-official' # security hooks: pattern warnings + LLM diff review on Stop/commit
  'claude-hud@claude-hud'                       # statusline HUD (global/user scope)
  'ponytail@ponytail'                           # 'lazy senior dev' decision ladder: minimal-code default, cuts generated code/latency/cost
)

# (3) MCP servers "name|args"; scope follows $Scope. SINGLE-QUOTED so ${...} stays LITERAL ->
#     Claude Code interpolates ${CLAUDE_PROJECT_DIR:-.} at server launch.
#     memory: uses ${HOME_MEMORY_DIR} - a script-local token resolved to $HOME\.memory-mcp at install
#     time (a fixed home path, so a Cursor install on the same machine shares the same DB). A space
#     (e.g. 'work') switches to a separate per-space DB (memory_<space>.db).
# PERFORMANCE (see claude-stack.sh for the full rationale): resolve each runtime's LATEST version
# HERE (install/update network step) and bake it into the registration. `install` skips already-
# registered MCPs, so the resolved version stays FROZEN until `update` re-resolves and bumps it -
# "latest at provision, frozen until next update", no hardcoded versions. Launch is fast because
# versions are PINNED (npx skips dist-tag resolution). Do NOT add --prefer-offline: against a
# freshly-resolved latest version a stale npm cache index reports "no matching version" and the
# server dies (-32000). serena runs from the pinned PyPI package (not git+https). memory injects
# --with numpy (its sqlite_vec backend needs numpy but the package doesn't declare it, so uvx's
# isolated env omits it -> "No module named 'numpy'"). Offline at provision -> empty -> unpinned.
# Bounded fetches (npm --fetch-timeout / Invoke-RestMethod -TimeoutSec) so a dead network fails fast to
# the unpinned fallback instead of hanging on a single silent line.
function Get-NpmLatest([string]$Pkg)  { try { ((npm view $Pkg version --fetch-timeout=15000 2>$null) | Select-Object -First 1).Trim() } catch { '' } }
function Get-PypiLatest([string]$Pkg) { try { (Invoke-RestMethod "https://pypi.org/pypi/$Pkg/json" -TimeoutSec 15).info.version } catch { '' } }
Log 'resolving latest MCP runtime versions (install/update network step)'
$McpContext7Ver   = Get-NpmLatest  '@upstash/context7-mcp'
$McpPlaywrightVer = Get-NpmLatest  '@playwright/mcp'
$McpSerenaVer     = Get-PypiLatest 'serena-agent'
$McpMemoryVer     = Get-PypiLatest 'mcp-memory-service'
# Version-pin suffix: '@1.2.3' when resolved, '' (unpinned fallback) when offline.
$Ctx7Pin   = if ($McpContext7Ver)   { '@' + $McpContext7Ver }   else { '' }
$PwPin     = if ($McpPlaywrightVer) { '@' + $McpPlaywrightVer } else { '' }
$SerenaPin = if ($McpSerenaVer)     { '@' + $McpSerenaVer }     else { '' }
$MemoryPin = if ($McpMemoryVer)     { '@' + $McpMemoryVer }     else { '' }
# Report what pinned vs. fell back to unpinned - the whole point of this step is 'frozen until update'.
$resolvedVers = [ordered]@{ 'context7' = $McpContext7Ver; 'playwright' = $McpPlaywrightVer; 'serena' = $McpSerenaVer; 'memory' = $McpMemoryVer }
foreach ($k in $resolvedVers.Keys) {
  if ($resolvedVers[$k]) { Log "  pinned $k@$($resolvedVers[$k])" }
  else { Log "  !! could not resolve $k latest - installing unpinned (re-run when online to pin it)" }
}

$MemoryBackend = 'sqlite_vec'  # separation is by DB path (below); backend stays sqlite_vec (the only valid local backend)
$MemoryDbFile  = if ($Space) { "memory_$Space.db" } else { 'memory.db' }
# Native separator: '\' on Windows (Join-Path yields a backslashed root), '/' under pwsh on mac/Linux -
# so the DB is the same file a sh install writes. JSON serialization escapes a backslash automatically.
$MemoryEntry   = 'memory|-e MCP_MEMORY_STORAGE_BACKEND=' + $MemoryBackend +
                 ' -e MCP_MEMORY_SQLITE_PATH=${HOME_MEMORY_DIR}' + [IO.Path]::DirectorySeparatorChar + $MemoryDbFile +
                 ' -- uvx --with numpy --from mcp-memory-service' + $MemoryPin + ' memory server'

# npx-launched MCPs (context7, angular-cli, playwright): on Windows the spawned stdio server can't
# resolve the bare `npx` shim (it's npx.cmd), so it dies with JSON-RPC -32000 - wrap in `cmd /c`.
# Non-Windows (pwsh on mac/Linux) keeps bare npx. $IsWindows is $null on PS 5.1 Desktop -> Windows.
# Entries are built by single-quote concatenation so ${CLAUDE_PROJECT_DIR:-.} stays LITERAL for
# launch-time interpolation (a double-quoted PS string would mangle it).
$OnWindows = if ($null -ne $IsWindows) { $IsWindows } else { $true }
$Npx       = if ($OnWindows) { 'cmd /c npx' } else { 'npx' }

# context7 runs REMOTE (the hosted server) by DEFAULT - no local process, and the key stays out of
# the registration: put CONTEXT7_API_KEY in the ACCOUNT settings.json "env" (<account>\settings.json -
# ~/.claude or the space's dir; or set it in the launch environment) and Claude Code expands
# ${CONTEXT7_API_KEY} in the header at launch, so .mcp.json holds no secret. A PROJECT-level
# .claude\settings.json or settings.local.json "env" value does NOT reach .mcp.json expansion (measured:
# it stays literal; it reaches only the MCP child process environment). On Windows this is the reliable path (no setx/restart dance). Pass -Context7 local for
# the local stdio server - keyless by default too, and $env:CONTEXT7_BAKE_KEY bakes --api-key.
$Context7RemoteUrl = 'https://mcp.context7.com/mcp'
$Context7RemoteHdr = 'CONTEXT7_API_KEY: ${CONTEXT7_API_KEY:-}'   # :- so an unset key sends an EMPTY header = keyless free tier (measured: a literal ${CONTEXT7_API_KEY} is rejected as an invalid key on every call, an empty value passes)

# sentry runs REMOTE only (the hosted MCP at mcp.sentry.dev) - no local process, no pin to resolve.
# The registration is CONSTANT and reads two values from the ACCOUNT settings.json "env" at launch
# (<account>\settings.json - ~/.claude or the space's dir; the launch environment works too; a
# project-level .claude\settings.json does NOT reach .mcp.json expansion - measured, it stays literal):
#   SENTRY_SLUG          -> https://mcp.sentry.dev/mcp/${SENTRY_SLUG} (org, or org/project - Sentry's
#                           recommended scoping; -SentrySlug seeds it)
#   SENTRY_ACCESS_TOKEN  -> `Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}` under -SentryAuth token
#                           (default) - Sentry's documented direct-token mode for a personal/org API token;
#                           plain `Bearer` is the server's OAuth-issued token scheme and rejects an API
#                           token as invalid_token (measured: AUTH_HEADER_REJECTED / 401 under it)
# -SentryAuth oauth registers NO header instead, so Claude Code runs Sentry's browser consent flow on
# first connect - a set-but-wrong header disables that fallback, which is why the modes never mix.
# Why placeholders and not baked values: both values belong to the account, not the file, and the
# guided commands make the user fill them in. Unset, `${SENTRY_SLUG}` stays literal - the server accepts
# that path on tools/list and fails every call naming the variable, and `claude mcp list` prints
# 'Missing environment variables' - a diagnosable state, unlike `${SENTRY_SLUG:-}`, whose trailing slash
# the server 404s (both measured).
# update: -SentryAuth absent keeps the mode the existing registration carries (read back through
# `claude mcp get sentry`); an old plain-`Bearer` registration migrates to the fixed token header.
if ($Action -eq 'update' -and -not $SentryAuth -and (Get-Command claude -ErrorAction SilentlyContinue)) {
  $sentryGet = ''
  try { $sentryGet = ((& claude mcp get sentry 2>$null) -join "`n") } catch { $sentryGet = '' }
  if ($sentryGet -match '(?m)^\s*URL:\s*https://mcp\.sentry\.dev/' -and $sentryGet -notmatch '(?m)^\s*Authorization:\s') {
    $SentryAuth = 'oauth'   # a deliberately headerless registration stays headerless
  }
}
if (-not $SentryAuth) { $SentryAuth = 'token' }
$SentryRemoteUrl = 'https://mcp.sentry.dev/mcp/${SENTRY_SLUG}'
function Set-AccountEnv {  # KEY VALUE - write env.KEY into the ACCOUNT settings.json (the file .mcp.json expansion reads); overwrite - a flag is explicit
  param([string]$Key, [string]$Value)
  $settings = Join-Path $ConfigDir 'settings.json'
  try {
    if (-not (Test-Path -LiteralPath $ConfigDir)) { New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null }
    $data = if (Test-Path -LiteralPath $settings) { Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    if (-not $data.PSObject.Properties['env']) { $data | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
    $before = if ($data.env.PSObject.Properties[$Key]) { [string]$data.env.$Key } else { $null }
    if ($data.env.PSObject.Properties[$Key]) { $data.env.$Key = $Value } else { $data.env | Add-Member -NotePropertyName $Key -NotePropertyValue $Value }
    Write-JsonFile $data $settings   # BOM-less + 2-space, like the sh twin (Set-Content -Encoding UTF8 prefixes a BOM on PS 5.1, which a JSON parser rejects)
    if ($before -eq $Value) { Log "  $Key already $Value in $settings" } else { Log "  $Key=$Value written to $settings env" }
  } catch { Add-Failure "could not write $Key into $settings ($($_.Exception.Message))" }
}
$SentryRemoteHdr = if ($SentryAuth -eq 'oauth') { '' } else { 'Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}' }
if ($Context7 -eq 'local') {
  $Ctx7Cmd = "$Npx -y @upstash/context7-mcp$Ctx7Pin"
  if ($env:CONTEXT7_BAKE_KEY -and $env:CONTEXT7_API_KEY) {
    $Ctx7Cmd += ' --api-key ' + $env:CONTEXT7_API_KEY
    Log "  !! baking CONTEXT7_API_KEY into the context7 registration; at project scope it lands in <repo>/.mcp.json - keep .mcp.json uncommitted (or use -Context7 remote to keep the key out of the file)."
  }
  $Ctx7Spec = '-- ' + $Ctx7Cmd
} else {
  $Ctx7Spec = '@HTTP@'
  if ($env:CONTEXT7_BAKE_KEY) {
    Log "  !! CONTEXT7_BAKE_KEY is set but context7 is remote - it is ignored; pass -Context7 local to bake, or add CONTEXT7_API_KEY to settings.json 'env'."
  }
}
$Context7Entry = 'context7|' + $Ctx7Spec
$AngularCliEntry = 'angular-cli|-- ' + $Npx + ' -y @angular/cli mcp'
$PlaywrightEntry = 'playwright|-- ' + $Npx + " -y @playwright/mcp$PwPin " + '--user-data-dir ${CLAUDE_PROJECT_DIR:-.}/.playwright --output-dir ${CLAUDE_PROJECT_DIR:-.}/.playwright/output'
$SerenaEntry     = 'serena|-e SERENA_HOME=.serena/home -- uvx --from serena-agent' + $SerenaPin + ' serena start-mcp-server --context @SERENA_CONTEXT@ --enable-web-dashboard false --project-from-cwd'
$SentryEntry     = 'sentry|@HTTP@'
$ChromeDevtoolsEntry = 'chrome-devtools|-- ' + $Npx + ' -y chrome-devtools-mcp@latest'
$AppiumMcpEntry      = 'appium-mcp|-- ' + $Npx + ' -y appium-mcp@latest'

$Mcps = @(
  $AngularCliEntry                            # angular-cli: only for Angular workspaces - comment out elsewhere (unpinned: matches the workspace ng).
  $SerenaEntry                                # LSP symbol navigation; PyPI-pinned (not git), dashboard off
  $PlaywrightEntry                            # drive a real browser for visual checks / web app verification
  $ChromeDevtoolsEntry                        # OPT-IN browser/extension debug; drives a full Chrome (heavy) - comment out outside web projects; no WS-frame payloads; pin a version
  $AppiumMcpEntry                             # OPT-IN native mobile E2E (official Appium MCP); embedded UiAutomator2/XCUITest drivers, needs Xcode and/or Android SDK + Java (heavy) - comment out outside Capacitor/Ionic mobile projects; pin a version
  $SentryEntry  # OPT-IN Sentry error monitoring - hosted remote MCP (mcp.sentry.dev/mcp/${SENTRY_SLUG} - SENTRY_SLUG + SENTRY_ACCESS_TOKEN live in the ACCOUNT settings.json "env", expanded at launch; -SentrySlug seeds the slug); -SentryAuth token (default) sends `Sentry-Bearer ${SENTRY_ACCESS_TOKEN}`, oauth registers no header; comment out where the project has no Sentry
  $MemoryEntry  # memory: cross-project recall - the subagent handoff runs on serena; comment out in a standalone project
  $Context7Entry                              # up-to-date library/framework/SDK docs (beats recalled API knowledge)
)

# (4) Hooks: copied into the repo from the run's source snapshot (stack/hooks/) on BOTH actions
#     (per-hook fail-soft - a hook not yet upstream keeps its committed repo copy); INSTALL
#     also wires each into settings.json. UPDATE refreshes the files and re-ensures the wiring (idempotent).
#     Each entry: "filename::matcher::args" - args (if any) are appended to the hook command.
#     Windows note: the .js has no shebang/exec bit here, so it is invoked via `node`.
#     $CLAUDE_PROJECT_DIR is substituted by Claude Code; if your Windows build needs
#     %CLAUDE_PROJECT_DIR% instead, change that one token in Set-HookSettings below. The instrument
#     entry's gate `[ "$CLAUDE_STACK_INSTRUMENT" != "1" ] ||` is POSIX and assumes the default
#     (bash-like) hook shell; under the PowerShell hook-shell opt-in it fails as a non-blocking error
#     and records nothing.
$Hooks = @(
  'guard-protected-force-push.js::Bash::'         # block force-push to main/master/develop
  'guard-catastrophic-rm.js::Bash::'              # block recursive rm of /, ~, $HOME, the cwd or its parent (. / ..), a bare *, or several top-level dirs at once
  'guard-read-whole-file.js::Read::'              # block whole-file Read of a >200-line source file - locate via serena first; caps cumulative half-split reconstruction
  'guard-read-whole-file.js::Bash::'              # same gate on Bash: a bare `cat file.ts` of a large source file is the Read block routed through the shell
  'guard-unapproved-dispatch.js::Task|Agent::'    # block *-implementer dispatch without the docs-root flow/APPROVAL gate file (APPROVED/AUTO)
  'guard-ungated-commit.js::Bash::'               # block a non-trivial git commit without the docs-root flow/COMMIT-GATE receipt (VERIFIED/WAIVED), and a git push / gh pr merge without flow/PUSH-GATE (CLAUDE_STACK_PUSH_GATE=0 turns that half off)
  'guard-stop-contract.js::@Stop::'               # Stop event: block a turn ending on a decision-shaped question in prose - re-emit as AskUserQuestion (measured stalls 13min-37h); also carries the fresh-session offer, once per 1.5x of context growth past 40% of the window
  'guard-stop-contract.js::AskUserQuestion::'  # PreToolUse AskUserQuestion: INJECT context into the ask being built - stale scope (an option naming repo/remote/job state with no fresh read this turn), a recommendation contradicting an un-actioned earlier prompt, the fresh-session offer for a flow whose every stop is a tool call, a live credential, and the house voice in the ask's own text. Presence only, never denies
  'guard-fresh-session-start.js::Skill::'        # PreToolUse Skill: block a deliberate orchestration run starting on another run's carried history past the window-scaled trigger - route it through an AskUserQuestion fresh-session choice
  'guard-fresh-session-start.js::@UserPromptSubmit::'   # the same run invoked as a SLASH COMMAND emits no Skill event at all (measured: 4 of 4 runs slash-injected, zero Skill events in 45 messages) - this route injects the ask, never denies (a UserPromptSubmit denial erases the prompt)
  'guard-fresh-session-start.js::@SessionStart:compact::'  # the harness just auto-compacted, which proves the session hit the ~390k ceiling at a moment a Stop may never come - inject the fresh-session ask there too
  'guard-cross-project-write.js::Write|Edit|NotebookEdit|Bash::'  # one session, one project: block a WRITE that lands outside the project root (reads/investigation untouched) - the change another repo needs is handed off as a task card
  'guard-answer-length.js::@UserPromptSubmit::'   # inject the answer budget (~3 sentences plus points) at the end of the turn's context - the short-answer rule mechanized
  'guard-answer-length.js::@SessionStart::'     # re-inject the budget after a COMPACTION rebuilds the context without it (measured absent for 277 of 366 messages in one session) - a startup/resume session gets it before the first prompt too
  'guard-answer-length.js::@Stop::'               # Stop event: block a wall-of-text answer (prose past the hard cap, no depth request in the user's message) - re-answer at budget
  'instrument-tool-usage.js::.*::'                # wired env-gated: a sh test skips the node spawn unless CLAUDE_STACK_INSTRUMENT=1 (seeded '0' in settings env - flip it for a measured run; see README)
)

# settings.json permissions.deny (claude-code): hard-block Read of secret-bearing files. Wired into
# .claude/settings.json alongside the hooks on INSTALL (idempotent, union-merged - a consuming project's
# own deny entries are preserved). Bare globs match at any depth (gitignore semantics).
# It reaches the Read TOOL ONLY. The claim that Claude Code also applies a Read() deny to recognized
# Bash reads (cat/head/tail/sed) stood here for releases and is FALSE - refuted live: an account
# carrying `Read(**/config.json)` returned the content of two Bash `cat`s of a config.json with zero
# denial strings. A shell read of a denied file is not blocked by anything here; that route is
# covered by baseline-security.md's behavioral rule and by the Stop-time credential branch in
# guard-stop-contract.js.
# The ACCOUNT settings.json is on this list because the stack's OWN design fills it with credentials
# (CLAUDE.md and the setup walk both send SENTRY_ACCESS_TOKEN there, and CONTEXT7_API_KEY lives in an
# env block too). A session cat-ed one whole as its FIRST tool call. The PROJECT-level settings.json
# is deliberately NOT denied: it carries the hook wiring a session legitimately inspects, and the
# tokens the stack directs anywhere are account-level.
# Stack-specific secret/config globs stay a per-project addition (the CLAUDE.md template's authoring
# outline prompts the fill-in; baseline-security.md keeps the behavioral rule).
# The settings.json deny-list is a Claude Code feature (no equivalent elsewhere).
$SecretDeny = @(
  'Read(.env)'
  'Read(.env.*)'
  'Read(*.pem)'
  'Read(*.pfx)'
  'Read(*.p12)'
  'Read(*.key)'
  'Read(~/.claude/settings.json)'
  'Read(~/.claude/settings.local.json)'
  'Read(~/.claude-*/settings.json)'
  'Read(~/.claude-*/settings.local.json)'
)

# (5) Subagents (claude-code): specialist agents copied into .claude/agents/ from the run's source
# clone (agents/) on BOTH actions (per-agent fail-soft). Claude Code auto-discovers
# .claude/agents/*.md; no settings.json wiring. (Cursor's twins of these live in the cursor-stack repo.)
$Agents = @(
  'dotnet-build-error-resolver.md'   # implement phase (sonnet/high): dotnet build -> minimal fix loop (serena/csharp-lsp), capped
  'dotnet-test-failure-resolver.md'  # implement phase (sonnet/high): dotnet test -> red->green repair loop, anti-reward-hacking, capped
  'ng-build-error-resolver.md'       # implement phase (sonnet/high): ng build -> minimal fix loop (serena/LSP), capped
  'angular-test-resolver.md'         # implement phase (sonnet/high): ng test/Jest -> red->green repair loop, anti-reward-hacking, capped
  'architecture-analyzer.md'                 # analysis support (sonnet/low): read-only per-module characterizer (purpose/surface/deps/patterns/smells) - the architecture + test-coverage captures fan it out, also independently callable
  'test-coverage-analyzer.md'             # analysis phase (sonnet/medium): read-only per-surface coverage characterizer - the project-test-coverage-analyzer skill fans it out over the raw results; never runs the suite
  'code-style-analyzer.md'                # analysis phase (sonnet/medium): read-only per-language style characterizer - the project-code-style-analyzer skill fans it out per language and merges docs/PROJECT-CODE-STYLE.md + the inject-code-style hook from its structured reports
  'related-project-analyzer.md'           # analysis support (sonnet/medium): read-only sibling-repo characterizer (name/relation/first_read/seam, URL siblings shallow-cloned to scratch) - the project-related-context skill fans it out per sibling and merges docs/related-context/PROJECT-RELATED-CONTEXT.md
  'ci-failure-diagnoser.md'          # analysis phase (opus/high): read-only CI red-run diagnosis via gh - categorize, local repro, route
  'runtime-failure-diagnoser.md'               # analysis phase (opus/xhigh): read-only bug diagnosis from logs/errors/screenshots - root cause + route, no fix
  'evidence-gatherer.md'             # diagnosis support (sonnet/low): read-only - a diagnoser dispatches it to reproduce/confirm and return a compact digest, keeping log volume off the opus seat
  'security-auditor.md'              # analysis phase (opus/xhigh): read-only cross-stack security posture audit - OWASP/CWE punch-list routed to implementers, complements /security-review
  'integration-reviewer.md'          # final gate (opus/xhigh): read-only cross-domain integration review - contract consistency, assembled build/test/migration, the commit gate no single-stack verifier is
  # Per-domain specialist team (10 stacks x designer/implementer/verifier) + architect analysis agents above; model/effort pinned in frontmatter
  'aspnet-solution-designer.md'      # design phase (opus/xhigh): ASP.NET Core architecture + plan + test strategy, decomposes into parallel tasks
  'aspnet-implementer.md'            # build phase (sonnet/medium): builds one ASP.NET task - code + tests
  'aspnet-verifier.md'               # verify phase (sonnet/xhigh): gates the ASP.NET build vs plan + quality, punch-list back
  'web-angular-solution-designer.md'     # design phase (opus/xhigh): Angular architecture + plan + test strategy, decomposes
  'web-angular-implementer.md'           # build phase (sonnet/medium): builds one Angular task - code + tests
  'web-angular-verifier.md'              # verify phase (sonnet/xhigh): gates the Angular build vs plan + quality
  'wpf-solution-designer.md'         # design phase (opus/xhigh): WPF strict-MVVM architecture + plan + test strategy, decomposes
  'wpf-implementer.md'               # build phase (sonnet/medium): builds one WPF task - code + tests
  'wpf-verifier.md'                  # verify phase (sonnet/xhigh): gates the WPF build vs plan + quality
  'console-solution-designer.md'     # design phase (opus/xhigh): headless .NET (Generic Host worker/bot/daemon/CLI) architecture + plan + test strategy, decomposes
  'console-implementer.md'           # build phase (sonnet/medium): builds one console/worker task - code + tests
  'console-verifier.md'              # verify phase (sonnet/xhigh): gates the console/worker build vs plan + quality
  'ionic-angular-solution-designer.md'      # design phase (opus/xhigh): Ionic/Capacitor architecture + plan + test strategy, decomposes
  'ionic-angular-implementer.md'            # build phase (sonnet/medium): builds one mobile task - code + tests
  'ionic-angular-verifier.md'               # verify phase (sonnet/xhigh): gates the mobile build vs plan + quality
  'data-solution-designer.md'        # design phase (opus/xhigh): schema/data-model architecture + plan + test strategy, decomposes
  'data-implementer.md'              # build phase (sonnet/medium): builds one data task - SQL + migration tests
  'data-verifier.md'                 # verify phase (sonnet/xhigh): gates the data build vs plan + quality
  'devops-solution-designer.md'      # design phase (opus/xhigh): Docker/CI/CD/deploy architecture + plan + validation strategy, decomposes
  'devops-implementer.md'            # build phase (sonnet/medium): builds one devops task - Dockerfile/workflow/deploy + local validation
  'devops-verifier.md'               # verify phase (sonnet/xhigh): gates the devops build vs plan + quality
  'browser-extension-solution-designer.md' # design phase (opus/xhigh): MV3 extension architecture (SW/content/UI topology, message contract, permissions) + plan + test strategy, decomposes
  'browser-extension-implementer.md' # build phase (sonnet/medium): builds one extension task - code + tests
  'browser-extension-verifier.md'    # verify phase (sonnet/xhigh): gates the extension build vs plan + quality
  'windows-service-solution-designer.md' # design phase (opus/xhigh): SCM recovery/budget/identity topology + plan + test strategy, decomposes
  'windows-service-implementer.md' # build phase (sonnet/medium): builds one Windows Service task - code + tests
  'windows-service-verifier.md' # verify phase (sonnet/xhigh): gates the Windows Service build vs plan + quality
  'winforms-solution-designer.md'    # design phase (opus/xhigh): WinForms MVP seam / binding / disposal topology + plan + test strategy, decomposes
  'winforms-implementer.md'          # build phase (sonnet/medium): builds one WinForms task - code + tests
  'winforms-verifier.md'             # verify phase (sonnet/xhigh): gates the WinForms build vs plan + quality
)

# (6) Path-scoped rules (claude-code): fetched into .claude/rules/ on BOTH actions - lazy-load on
# matching file reads; conventions stay with the convention-gate hook, rules carry only glob-scoped routing.
# NOTE: baseline-project-related-context.md, baseline-project-architecture.md and
# baseline-project-agent-capabilities.md are GENERATED per-project (by /project-related-context,
# /project-architecture-analyzer and /project-agent-capabilities) - NEVER add those names to this
# manifest (the copy would overwrite the generated copies); nothing prunes the rules dir, so
# they survive update.
$ClaudeRules = @(
  # Always-on baseline (no paths) - loads every session like CLAUDE.md; one job per file, comment out what a project doesn't want.
  'baseline-interaction.md'    # communication + evaluating-proposals + planning (merged by exclusion affinity)
  'baseline-quality-gates.md'  # code-quality + definition-of-done (merged by exclusion affinity)
  'baseline-security.md'
  'baseline-git.md'
  'baseline-navigation.md'
  'baseline-docs-root.md'      # generated-docs root resolution (CLAUDE_STACK_DOCS_PATH)
  # Path-scoped routing
  'markdown-docs.md'          # markdown-style routing, path-scoped **/*.md
  'javascript-conventions.md'  # JS-family conventions, path-scoped js/jsx/mjs/cjs
  'dotnet-repair-agents.md'   # .NET repair-loop routing, path-scoped cs/csproj/sln/xaml
  'angular-repair-agents.md'  # Angular repair-loop routing, path-scoped
  # Convention rules (soft, glob auto-attach) - each points ONE file family at its house-style skill; replaced the require-convention-skill hard gate.
  'typescript-conventions.md' # ts/js family -> typescript (framework-agnostic baseline)
  'angular-conventions.md'    # Angular file shapes -> angular-conventions (Angular/Ionic projects only)
  'angular-styling-conventions.md' # scss/css -> angular-styling (Angular/Ionic projects only)
  'csharp-conventions.md'     # c#: .cs -> csharp (backend, desktop, console)
  'wpf-conventions.md'        # wpf: .xaml -> dotnet-wpf
  'winforms-conventions.md'   # winforms: .Designer.cs -> dotnet-winforms
  'sql-conventions.md'        # sql: .sql -> database-conventions
  'devops-conventions.md'     # rest (devops): Dockerfile/compose/workflow -> devops
)

# --- -InstalledOnly: derive the selection from the install target ---------
# The update fast path, twin of claude-stack.sh --installed-only: refresh
# exactly what is on disk, adding nothing. File-based layers from the target
# dirs (generated project-owned files excluded), mcps from the project's
# .mcp.json; plugins are machine-level and skipped. Closed through
# stack-select.js when it is reachable next to this script, so a dependency a
# NEW release introduced still installs. User-authored files are safe by
# construction: the manifest filter below only ever intersects with stack items.
$script:InstalledOnlyTmp = ''
if ($InstalledOnly) {
  $script:InstalledOnlyTmp = Join-Path ([System.IO.Path]::GetTempPath()) ('claude-stack-io-' + [System.IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $script:InstalledOnlyTmp -Force | Out-Null
  $ioClaude = if ($ClaudeScope -eq 'user') { $ConfigDir } else { Join-Path (Get-Location).Path '.claude' }
  $ioLines = @()
  foreach ($d in @(Get-ChildItem -LiteralPath (Join-Path $ioClaude 'skills') -Directory -ErrorAction SilentlyContinue)) {
    if (Test-Path (Join-Path $d.FullName 'SKILL.md')) { $ioLines += "skill $($d.Name)" }
  }
  foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $ioClaude 'agents') -Filter '*.md' -File -ErrorAction SilentlyContinue)) {
    $ioLines += "agent $($f.BaseName)"
  }
  foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $ioClaude 'rules') -Filter '*.md' -File -ErrorAction SilentlyContinue)) {
    if ($f.BaseName -like 'baseline-project-*' -or $f.BaseName -eq 'project-code-style') { continue }   # generated, project-owned
    $ioLines += "rule $($f.BaseName)"
  }
  foreach ($f in @(Get-ChildItem -LiteralPath (Join-Path $ioClaude 'hooks') -Filter '*.js' -File -ErrorAction SilentlyContinue)) {
    if ($f.BaseName -eq 'inject-code-style') { continue }                                               # legacy generated
    $ioLines += "hook $($f.BaseName)"
  }
  $ioMcpJson = Join-Path (Get-Location).Path '.mcp.json'
  if ($ClaudeScope -eq 'project' -and (Test-Path $ioMcpJson)) {
    try {
      foreach ($n in @((Get-Content -Raw $ioMcpJson | ConvertFrom-Json).mcpServers.PSObject.Properties.Name)) { $ioLines += "mcp $n" }
    } catch {}
  }
  elseif (Get-Command claude -ErrorAction SilentlyContinue) {
    # No .mcp.json to read (a global install, or a project whose config the CLI owns): ask the CLI
    # which servers are registered. The selection filter intersects with the MCPS manifest, so a
    # claude.ai-managed or hand-added server is never touched.
    try {
      foreach ($l in @(& claude mcp list 2>$null)) {
        if ($l -match '^([A-Za-z0-9_.-]+):\s') { $ioLines += "mcp $($Matches[1])" }
      }
    } catch {}
  }
  # Plugins are machine-level, so they come from the CLI listing rather than a project directory -
  # without this the fast path filtered $Plugins to empty and 'update' never ran `claude plugin
  # update` on anything. Only names the manifest carries are kept, so a third-party plugin is
  # neither touched nor reported as unknown.
  if (Get-Command claude -ErrorAction SilentlyContinue) {
    $ioKnown = @($Plugins | ForEach-Object { ($_ -split '@')[0] })
    try {
      $ioFound = @()
      foreach ($l in @(& claude plugin list 2>$null)) {
        foreach ($m in [regex]::Matches([string]$l, '(?<name>[A-Za-z0-9_.-]+)@[A-Za-z0-9_.-]+')) {
          $n = $m.Groups['name'].Value
          if ($ioKnown -contains $n -and $ioFound -notcontains $n) { $ioFound += $n }
        }
      }
      foreach ($n in $ioFound) { $ioLines += "plugin $n" }
    } catch {}
  }
  # The CLI could not be read (absent, or an unexpected listing shape): fall back to the manifest's
  # plugin set. Safe here because -InstalledOnly is update-only and `claude plugin update` updates
  # an installed plugin and never installs a missing one.
  if (-not ($ioLines | Where-Object { $_.StartsWith('plugin ') })) {
    foreach ($p in $Plugins) { $ioLines += "plugin $(($p -split '@')[0])" }
  }
  if (-not $ioLines) {
    Write-Host "error: -InstalledOnly found nothing installed under $ioClaude - run install (or the /claude-stack:setup command) first" -ForegroundColor Red
    Remove-Item -LiteralPath $script:InstalledOnlyTmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }
  # No hooks on disk must stay no hooks: the filter's no-hook-lines special case
  # would otherwise install all of them.
  if (-not ($ioLines | Where-Object { $_.StartsWith('hook ') })) { $Hooks = @() }
  $Selection = Join-Path $script:InstalledOnlyTmp 'selection.txt'
  Set-Content -LiteralPath $Selection -Value $ioLines
  $ioSelJs = Join-Path $PSScriptRoot '..\stack-select.js'
  $ioGraph = Join-Path $PSScriptRoot '..\..\meta\stack-graph.json'
  if ((Get-Command node -ErrorAction SilentlyContinue) -and (Test-Path $ioSelJs) -and (Test-Path $ioGraph)) {
    $ioRawFile = Join-Path $script:InstalledOnlyTmp 'raw.json'
    # node builds raw.json from the selection lines (same one-liner as the sh twin) - JSON arrays
    # survive intact, where ConvertTo-Json would unwrap a single-element array.
    & node -e 'const fs=require("fs");const cat={skill:"skills",plugin:"plugins",mcp:"mcps",agent:"agents",rule:"rules",hook:"hooks"};const sel={skills:[],plugins:[],mcps:[],agents:[],rules:[],hooks:[]};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){const m=l.trim().match(/^(\S+)\s+(.+)$/);if(m&&cat[m[1]])sel[cat[m[1]]].push(m[2]);}fs.writeFileSync(process.argv[2],JSON.stringify(sel))' $Selection $ioRawFile
    $ioClosed = Join-Path $script:InstalledOnlyTmp 'closed.txt'
    $ioOut = & node $ioSelJs --selection $ioRawFile --graph $ioGraph --emit $ioClosed 2>&1
    if ($LASTEXITCODE -eq 0 -and (Test-Path $ioClosed)) {
      $Selection = $ioClosed
      foreach ($l in @($ioOut)) { Log "installed-only: $l" }
    } else {
      Log "installed-only: closure failed - refreshing the disk set as-is ($(@($ioOut)[0]))"
    }
  } else {
    Log 'installed-only: stack-select.js not reachable next to this script - refreshing the disk set as-is (new upstream dependencies are not auto-carried; run from a checkout or use the /claude-stack:update command)'
  }
}

# --- Selection subset filter (Component B twin of claude-stack.sh) --------
# With -Selection <file>, keep only the entries whose name appears in the file
# (one 'category name' per line; '#' comments and blank lines ignored). Hooks
# are never filtered. -PrintPlan prints the resolved set and exits (dry run).
if ($Selection) {
  if (-not (Test-Path $Selection)) { Write-Host "selection file not found: $Selection" -ForegroundColor Red; exit 1 }
  $sel = @{}
  foreach ($line in Get-Content $Selection) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $p = $t -split '\s+', 2
    if ($p.Count -eq 2) { $sel["$($p[0]) $($p[1])"] = $true }
  }
  $SelHas = { param($cat, $name) $sel.ContainsKey("$cat $name") }

  $Skills      = @($Skills      | Where-Object { & $SelHas 'skill'  (($_ -replace '^[^|]*\|', '')) })
  $Plugins     = @($Plugins     | Where-Object { & $SelHas 'plugin' (($_ -split '@', 2)[0]) })
  $Mcps        = @($Mcps        | Where-Object { & $SelHas 'mcp'    (($_ -split '\|', 2)[0]) })
  $Agents      = @($Agents      | Where-Object { & $SelHas 'agent'  ((($_ -split '::', 2)[0]) -replace '\.md$', '') })
  $ClaudeRules = @($ClaudeRules | Where-Object { & $SelHas 'rule'   ((($_ -split '::', 2)[0]) -replace '\.md$', '') })
  # Hooks joined the selection with the guided walk's hooks layer. A selection with no
  # 'hook' lines predates that layer - keep its install-every-hook behavior unchanged.
  if (@($sel.Keys | Where-Object { $_.StartsWith('hook ') }).Count -gt 0) {
    $Hooks     = @($Hooks       | Where-Object { & $SelHas 'hook'   ((($_ -split '::', 2)[0]) -replace '\.js$', '') })
  }
}

if ($PrintPlan) {
  'plan skills:'  + (($Skills      | ForEach-Object { ' ' + ($_ -replace '^[^|]*\|', '') }) -join '')
  'plan plugins:' + (($Plugins     | ForEach-Object { ' ' + ($_ -split '@', 2)[0] }) -join '')
  'plan mcps:'    + (($Mcps        | ForEach-Object { ' ' + ($_ -split '\|', 2)[0] }) -join '')
  'plan agents:'  + (($Agents      | ForEach-Object { ' ' + ((($_ -split '::', 2)[0]) -replace '\.md$', '') }) -join '')
  'plan rules:'   + (($ClaudeRules | ForEach-Object { ' ' + ((($_ -split '::', 2)[0]) -replace '\.md$', '') }) -join '')
  'plan hooks:'   + (($Hooks       | ForEach-Object { (($_ -split '::', 2)[0]) } | Select-Object -Unique | ForEach-Object { ' ' + ($_ -replace '\.js$', '') }) -join '')
  if ($script:InstalledOnlyTmp) { Remove-Item -LiteralPath $script:InstalledOnlyTmp -Recurse -Force -ErrorAction SilentlyContinue }   # Remove-StackSrc is defined further down - clean the -InstalledOnly scratch here
  exit 0
}

function Get-RepoRoot {
  $r = (& git rev-parse --show-toplevel 2>$null)
  if ($LASTEXITCODE -eq 0 -and $r) { return $r }
  return $null
}

# ===========================================================================
# INSTALL - skills re-add UNCONDITIONALLY (clean copy each run); MCPs and plugins SKIP if already present
# ===========================================================================
function Get-SkillsDest {
  # Scope-resolved skill destination, matching the .sh twin's `case "$CLAUDE_SCOPE"` inline check.
  if ($ClaudeScope -eq 'user') { return (Join-Path $ConfigDir 'skills') }
  return (Join-Path (Get-Location).Path '.claude\skills')
}

# ===========================================================================
# SOURCE SNAPSHOT - the ONE revision every artifact in a run comes from
# ===========================================================================
# Every file the stack installs (skills, hooks, agents, rules, the CLAUDE.md template) lives in
# this one repo, so a run takes ONE source snapshot and copies out of it: the rolling 'latest'
# release archive (.github/workflows/release.yml republishes it on every push to main, with a
# RELEASE-SOURCE file inside naming the exact commit), falling back to a shallow git clone when
# no release is reachable (a fork without releases, a blocked CDN, the brief window while the
# workflow recreates the release). Why one snapshot and not the per-file
# raw.githubusercontent.com fetches this replaced:
#   - ATOMIC. An archive or clone is a single revision. The raw URLs are per-file and CDN-cached
#     (a push takes ~5 min to propagate), so a raw run could mix revisions - and then
#     claude-stack.stamp, which records the revision this install came from, would be a lie. The
#     snapshot makes the stamp true by construction.
#   - CHEAP. One download replaces ~50 round trips (the Hooks + Agents + ClaudeRules arrays).
# Fail-soft, like the fetches were: no source (archive AND clone failed) means callers keep the
# copies already on disk and the run carries on. $StackSha stays empty, which is what suppresses
# the stamp write.
#
# -Source <dir> hands in a source the CALLER already fetched (an extracted release archive or a
# git checkout). That is the plugin path: the setup / configure skills must download anyway (they
# need stack-select.js, stack-graph.json, the CLAUDE.md template and the stamp diff before the
# install runs), so they pass that same source here and the guided run costs ONE download instead
# of two. A caller-provided dir is borrowed, never deleted. Standalone (no -Source) is
# unchanged: the script fetches its own source and cleans it up.
$StackRepoUrl = if ($env:STACK_SKILLS_REPO) { $env:STACK_SKILLS_REPO } else { 'https://github.com/envoydev/claude-stack' }
$script:StackSrc = ''          # the source worktree; empty until Get-StackSrc runs
$script:StackSha = ''          # the exact commit every artifact this run installs was copied from
$script:StackRef = ''          # the branch that commit is the tip of (whatever the source's HEAD is)
$script:StackSrcTried = $false # memoises the OUTCOME, so a dead source costs one fetch attempt, not one per caller
$script:StackSrcOwned = $false # true only when WE fetched it - Remove-StackSrc removes ours, never the caller's
$script:StackSrcRoot = ''      # the temp dir an owned fetch lives in (Remove-StackSrc's removal target)

function Read-ReleaseSource {
  # An extracted release archive carries its revision in RELEASE-SOURCE (the workflow writes it).
  param([string]$Dir)
  $file = Join-Path $Dir 'RELEASE-SOURCE'
  if (-not (Test-Path -LiteralPath $file)) { return }
  $lines = Get-Content -LiteralPath $file
  $script:StackSha = (($lines | Where-Object { $_ -match '^sha: ' } | Select-Object -First 1) -replace '^sha: ', '')
  $script:StackRef = (($lines | Where-Object { $_ -match '^ref: ' } | Select-Object -First 1) -replace '^ref: ', '')
}

function Get-StackSrc {
  # Resolves on the first call; every later caller reuses the worktree. Returns $false (never throws)
  # when the source is unavailable, so each caller applies its own fail-soft.
  # Memoise BOTH outcomes: five steps call this, and without the failure latch an offline run
  # would pay five download timeouts and report five failures for one root cause.
  if ($script:StackSrc) { return $true }
  if ($script:StackSrcTried) { return $false }
  $script:StackSrcTried = $true
  $hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)

  if ($Source) {
    # Borrowed source. Sanity-check it IS the stack (a wrong -Source would otherwise 'install'
    # nothing and report 117 per-file failures), then read its revision: a git checkout carries
    # it in HEAD, an extracted release archive in its RELEASE-SOURCE file.
    if (-not ((Test-Path -LiteralPath (Join-Path $Source 'stack/skills') -PathType Container) -and
              (Test-Path -LiteralPath (Join-Path $Source 'stack/agents') -PathType Container))) {
      Add-Failure "-Source '$Source' is not a claude-stack checkout (no stack/skills + stack/agents) - stack source unavailable"
      return $false
    }
    $script:StackSrc = $Source
    $script:StackSrcOwned = $false
    if ($hasGit) {
      $script:StackSha = (& git -C $Source rev-parse HEAD 2>$null)
      $script:StackRef = (& git -C $Source rev-parse --abbrev-ref HEAD 2>$null)
    }
    if ($script:StackSha) {
      # Stamp the URL the caller actually cloned from, not our default - they may have used a fork.
      $originUrl = (& git -C $Source remote get-url origin 2>$null)
      if ($originUrl) { $script:StackRepoUrl = $originUrl }
    } else { Read-ReleaseSource -Dir $Source }
    if (-not $script:StackSha) { Log "source: $Source (provided; no git checkout or RELEASE-SOURCE - no revision, so no stamp)" }
    else {
      $shortSha = $script:StackSha.Substring(0, [Math]::Min(12, $script:StackSha.Length))
      $refName = if ($script:StackRef) { $script:StackRef } else { '?' }
      Log "source: $Source (provided) @ $refName $shortSha"
    }
    return $true
  }

  # Release archive first: one asset is one revision, and no git is needed to take it.
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $url = "$StackRepoUrl/releases/latest/download/claude-stack.zip"
  $repo = Join-Path $tmp 'repo'
  try {
    Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp 'claude-stack.zip') -UseBasicParsing -ErrorAction Stop
    Expand-Archive -LiteralPath (Join-Path $tmp 'claude-stack.zip') -DestinationPath $repo -Force
  } catch { <# fall through to the clone below #> }
  if ((Test-Path -LiteralPath (Join-Path $repo 'stack/skills') -PathType Container) -and
      (Test-Path -LiteralPath (Join-Path $repo 'stack/agents') -PathType Container)) {
    $script:StackSrc = $repo
    $script:StackSrcRoot = $tmp
    $script:StackSrcOwned = $true
    Read-ReleaseSource -Dir $repo
    $shortSha = if ($script:StackSha) { $script:StackSha.Substring(0, [Math]::Min(12, $script:StackSha.Length)) } else { 'unknown' }
    $refName = if ($script:StackRef) { $script:StackRef } else { '?' }
    Log "source: $url @ $refName $shortSha"
    return $true
  }
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue

  # Fallback: a shallow clone - a fork without releases, a blocked release CDN, a local test path.
  # Pinned to main: the release branch is what installs deliver, never the default branch
  # (development lands on develop).
  if (-not $hasGit) { Add-Failure 'release archive unreachable and git not found - stack source unavailable'; return $false }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  & git clone --depth 1 -b main $StackRepoUrl $tmp *> $null
  if ($LASTEXITCODE -ne 0) {
    Add-Failure "release archive and clone of $StackRepoUrl both failed - stack source unavailable (nothing refreshed; existing copies kept)"
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    return $false
  }
  $script:StackSrc = $tmp
  $script:StackSrcRoot = $tmp
  $script:StackSrcOwned = $true
  $script:StackSha = (& git -C $tmp rev-parse HEAD 2>$null)
  $script:StackRef = (& git -C $tmp rev-parse --abbrev-ref HEAD 2>$null)
  $shortSha = if ($script:StackSha) { $script:StackSha.Substring(0, [Math]::Min(12, $script:StackSha.Length)) } else { 'unknown' }
  $refName = if ($script:StackRef) { $script:StackRef } else { '?' }
  Log "source: $StackRepoUrl (clone fallback) @ $refName $shortSha"
  return $true
}

function Remove-StackSrc {
  # Only ever removes a fetch WE took - a -Source dir belongs to the caller.
  if ($script:StackSrcOwned -and $script:StackSrcRoot) {
    Remove-Item -LiteralPath $script:StackSrcRoot -Recurse -Force -ErrorAction SilentlyContinue
    $script:StackSrc = ''
    $script:StackSrcRoot = ''
  }
  if ($script:InstalledOnlyTmp) {
    Remove-Item -LiteralPath $script:InstalledOnlyTmp -Recurse -Force -ErrorAction SilentlyContinue
    $script:InstalledOnlyTmp = ''
  }
}

function Copy-FromStackSrc {
  # Shared body of the hook/agent/rule steps: copy each named file out of the run's clone. Per-file
  # fail-soft (a file not yet upstream keeps its committed copy), and an unchanged file is reported
  # 'current' rather than rewritten, so a no-op run leaves timestamps alone.
  param([string]$SubDir, [string]$Label, [string]$DestDir, [string[]]$Files)
  if (-not (Get-StackSrc)) { Log "  !! stack source unavailable - kept existing $Label copies"; return }
  foreach ($file in $Files) {
    $src = Join-Path $script:StackSrc (Join-Path $SubDir $file)
    if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Add-Failure "$Label '$file' not found in $StackRepoUrl"; continue }
    $dest = Join-Path $DestDir $file
    $dir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    if ((Test-Path -LiteralPath $dest) -and ((Get-FileHash -LiteralPath $src).Hash -eq (Get-FileHash -LiteralPath $dest).Hash)) {
      Log "  $Label current: $file"; continue
    }
    Copy-Item -LiteralPath $src -Destination $dest -Force
    Log "  $Label installed -> $file"
  }
}

function Install-Skills {
  # Copy each selected skills/<name>/ out of the run's clone into the scope dest - all house skills
  # live in ONE repo, so a plain copy fully reproduces what the skills CLI used to stage; no
  # npx/network-registry dependency.
  if (-not (Get-StackSrc)) { Add-Failure 'skills not installed'; return }   # fail-soft: skip, never abort
  $dest = Get-SkillsDest
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  foreach ($entry in $Skills) {
    $name = $entry.Split('|', 2)[1]
    $src = Join-Path $script:StackSrc (Join-Path 'stack/skills' $name)
    if (Test-Path -LiteralPath $src -PathType Container) {
      $target = Join-Path $dest $name
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Copy-Item -LiteralPath $src -Destination $target -Recurse -Force
      Log "skill [$ClaudeScope]: $name -> $target"
    }
    else {
      Add-Failure "skill '$name' not found in $StackRepoUrl"
    }
  }
}

function Install-Plugins {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { $script:ClaudeMissing = $true; return }   # fail-soft: skip, never abort
  foreach ($mp in $ExtraMarketplaces) { try { & claude plugin marketplace add $mp 2>$null } catch {} }
  foreach ($p in $Plugins) {
    # claude-hud is a statusline HUD - force USER scope regardless of $ClaudeScope. A project-scoped
    # install + the global statusline enable mismatch, so every OTHER project warns "plugin not cached".
    $pScope = if ($p -like 'claude-hud@*') { 'user' } else { $ClaudeScope }
    Log "plugin [$pScope]: $p"
    try { & claude plugin install $p --scope $pScope -y } catch {}   # -y: the marketplace-command consent prompt cannot be answered when stdin/stdout is not a TTY (the guided commands run this non-interactively)
    if ($LASTEXITCODE -ne 0) { Add-Failure "plugin $p failed" }
  }
}

function Resolve-McpArgv([string]$Spec) {
  # Split the manifest args into argv words FIRST, then resolve the path tokens inside each word - so a
  # resolved path that contains a space (C:\Users\Jane Doe) stays ONE argument instead of splitting
  # into two. .Split(' ') yields an array (no glob expansion, unlike bash word-splitting).
  # HOME_MEMORY_DIR: the shared memory root ($HOME\.memory-mcp) - always resolved at install time to a
  # fixed home path, so a Cursor install on the same machine points to the same DB.
  $memDir = Join-Path $HOME '.memory-mcp'
  return @($Spec.Split(' ') | Where-Object { $_ -ne '' } | ForEach-Object { $_.Replace('@SERENA_CONTEXT@', $SerenaContext).Replace('${HOME_MEMORY_DIR}', $memDir) })
}

function Install-Mcps {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { $script:ClaudeMissing = $true; return }   # fail-soft: skip, never abort
  foreach ($entry in $Mcps) {
    $parts = $entry.Split('|', 2)
    $name = $parts[0]
    $spec = $parts[1]
    $argArr = Resolve-McpArgv $spec
    # PS 5.1 + ErrorActionPreference='Stop': a native command's redirected stderr throws, so probe in try/catch.
    $configured = $false
    try { & claude mcp get $name *> $null; $configured = ($LASTEXITCODE -eq 0) } catch { $configured = $false }
    if ($name -eq 'sentry' -and $SentrySlug) { Set-AccountEnv SENTRY_SLUG $SentrySlug }   # the env seed lands even when the registration is skipped below
    if ($configured) { Write-Host "  mcp $name already configured - skipping"; continue }
    Log "mcp [$ClaudeScope]: $name"
    if ($spec -eq '@HTTP@') {
      # remote (hosted) server - url/header keyed by name: sentry, else context7. An EMPTY header
      # (sentry -SentryAuth oauth) registers with no --header at all, so the OAuth fallback stays on.
      $url = if ($name -eq 'sentry') { $SentryRemoteUrl } else { $Context7RemoteUrl }
      $hdr = if ($name -eq 'sentry') { $SentryRemoteHdr } else { $Context7RemoteHdr }
      if ($hdr) { try { & claude mcp add --transport http --scope $ClaudeScope $name $url --header $hdr } catch {} }
      else      { try { & claude mcp add --transport http --scope $ClaudeScope $name $url } catch {} }
      if ($LASTEXITCODE -ne 0) { Add-Failure "mcp $name failed" }
      continue
    }
    try { & claude mcp add --scope $ClaudeScope $name @argArr } catch {}
    if ($LASTEXITCODE -ne 0) { Add-Failure "mcp $name failed" }
  }
}

function Get-Hooks {
  # Copy each hook file into the repo from the run's clone; per-hook fail-soft (keeps repo copy).
  $root = Get-RepoRoot
  if (-not $root) { Log '  !! not in a git repo - skipping hooks'; return }
  $files = @(foreach ($entry in $Hooks) { ($entry -split '::', 2)[0] })
  Copy-FromStackSrc -SubDir 'stack/hooks' -Label 'hook' -DestDir (Join-Path $root '.claude/hooks') -Files $files
}

function Get-Agents {
  # Copy each subagent .md into the repo from the run's clone; per-agent fail-soft (keeps repo copy).
  $root = Get-RepoRoot
  if (-not $root) { Log '  !! not in a git repo - skipping agents'; return }
  Copy-FromStackSrc -SubDir 'stack/agents' -Label 'agent' -DestDir (Join-Path $root '.claude/agents') -Files $Agents
}

function Get-Rules {
  # Copy each rule .md into the repo from the run's clone; per-rule fail-soft (keeps repo copy).
  $root = Get-RepoRoot
  if (-not $root) { Log '  !! not in a git repo - skipping rules'; return }
  Copy-FromStackSrc -SubDir 'stack/rules' -Label 'rule' -DestDir (Join-Path $root '.claude/rules') -Files $ClaudeRules
  Set-DocsRootStamp $root
}

function Set-DocsRootStamp {
  # Replace __DOCS_ROOT__ in the copied baseline-docs-root.md with the CURRENT env value
  # (settings.json, else the default) - runs on install AND update, so the stamp always tracks the env.
  param([string]$root)
  $rule = Join-Path $root '.claude/rules/baseline-docs-root.md'
  if (-not (Test-Path $rule)) { return }
  $val = '.claude/docs'
  $settings = Join-Path $root '.claude/settings.json'
  if (Test-Path $settings) {
    try {
      $data = Get-Content $settings -Raw | ConvertFrom-Json
      # the pre-0.2.43 key is still read: an install stamped before the rename landed
      foreach ($k in @('CLAUDE_STACK_DOCS_PATH', 'CLAUDE_DOCS_PATH')) {
        if ($data.env -and $data.env.PSObject.Properties[$k] -and $data.env.($k)) { $val = $data.env.($k); break }
      }
    } catch { Log '  !! docs-root stamp: settings.json unreadable - stamping the default' }
  }
  try {
    # BOM-less on PS 5.1 too: Set-Content -Encoding utf8 would prefix a BOM before the rule's frontmatter.
    [System.IO.File]::WriteAllText($rule, (Get-Content -LiteralPath $rule -Raw).Replace('__DOCS_ROOT__', $val), (New-Object System.Text.UTF8Encoding($false)))
  } catch { Log '  !! docs-root stamp failed - the rule keeps the env-wins fallback' }
}

function New-ClaudeMd {
  # INSTALL: lay down a starter .claude/CLAUDE.md from the template when the project has none (never clobber a filled one).
  $root = Get-RepoRoot
  if (-not $root) { Log '  !! not in a git repo - skipping CLAUDE.md'; return }
  # Auto-loaded from either ./CLAUDE.md or ./.claude/CLAUDE.md - skip if EITHER exists so we never leave two copies.
  if ((Test-Path -LiteralPath (Join-Path $root 'CLAUDE.md')) -or (Test-Path -LiteralPath (Join-Path $root '.claude/CLAUDE.md'))) { Log '  CLAUDE.md: already present - left as-is (finish its authoring outline if not done)'; return }
  if (-not (Get-StackSrc)) { Log '  !! stack source unavailable - create .claude/CLAUDE.md by hand from CLAUDE.template.md'; return }
  $src = Join-Path $script:StackSrc (Join-Path 'stack' 'CLAUDE.template.md')
  if (-not (Test-Path -LiteralPath $src -PathType Leaf)) { Add-Failure "CLAUDE.template.md not found in $StackRepoUrl"; return }
  $dest = Join-Path $root '.claude/CLAUDE.md'
  New-Item -ItemType Directory -Force -Path (Join-Path $root '.claude') | Out-Null
  Copy-Item -LiteralPath $src -Destination $dest -Force
  Log '  CLAUDE.md: seeded to .claude/CLAUDE.md - write the project top from its authoring-outline comment, and keep the .claude/* + !.claude/CLAUDE.md gitignore lines so it stays committed'
}

$script:SerenaIgnores = '[".serena", ".claude", ".playwright"]'

function Test-SerenaListKey {
  # true when $Key carries a NON-EMPTY list (inline or block) in the given project.yml text
  param([string[]]$Lines, [string]$Key)
  $pending = $false
  foreach ($line in $Lines) {
    if ($line -match '^\s*([a-z_]+)\s*:(.*)$') {
      $k = $Matches[1]; $rest = $Matches[2].Trim(); $pending = $false
      if ($Key -split '\|' -contains $k) {
        if ($rest -match '\[\s*[^\]\s]') { return $true }
        if ($rest -eq '') { $pending = $true }
      }
      continue
    }
    if ($pending -and $line -match '^\s*-\s*\S') { return $true }
  }
  return $false
}

function Set-SerenaListKey {
  # Neither key is ever APPENDED when it already exists: serena's own auto-generated config ships
  # `language_servers: []` / `ignored_paths: []`, and a second key of the same name is a
  # duplicate-key YAML error, not an override. Empty is rewritten in place; entries are left alone.
  param([string]$Cfg, [string]$Key, [string]$Value, [string]$Comment)
  $lines = @(Get-Content -LiteralPath $Cfg)
  if (Test-SerenaListKey -Lines $lines -Key $Key) { return }
  if ($lines -match "^\s*$Key\s*:") {
    $out = $lines | ForEach-Object { if ($_ -match "^\s*$Key\s*:") { "${Key}: $Value" } else { $_ } }
    Set-Content -LiteralPath $Cfg -Value $out -Encoding UTF8
    Log "  serena: $Key set to $Value (was empty)"
  } else {
    Add-Content -LiteralPath $Cfg -Value ''
    Add-Content -LiteralPath $Cfg -Value "# Added by claude-stack: $Comment"
    Add-Content -LiteralPath $Cfg -Value "${Key}: $Value"
    Log "  serena: $Key $Value appended to project.yml"
  }
}

function Get-SerenaLangs {
  param([string]$Root)
  $skip = '[\\/]node_modules[\\/]|[\\/]\.git[\\/]'   # both separators - pwsh also runs on Unix
  $langs = @()
  $cs = @(Get-ChildItem -LiteralPath $Root -Recurse -Depth 3 -File -Include '*.sln', '*.slnx', '*.csproj' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $skip } | Select-Object -First 1)
  if ($cs.Count -gt 0) { $langs += 'csharp' }
  # serena's typescript server handles plain JavaScript too, so a package.json-only or .js-only
  # repo takes it as well - without this a JS project detected nothing and got no seed at all.
  $ts = @(Get-ChildItem -LiteralPath $Root -Recurse -Depth 3 -File -Include 'tsconfig*.json', 'package.json', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch $skip } | Select-Object -First 1)
  if ($ts.Count -gt 0) { $langs += 'typescript' }
  return $langs
}

function New-SerenaProject {
  # INSTALL + UPDATE: seed .serena/project.yml with the languages actually in this repo.
  # serena's --project-from-cwd only RESOLVES the root (a .serena/project.yml, else a .git). It DOES
  # auto-generate a config for a root that has none - but not one to rely on: verified in serena
  # 1.7.0 (serena/config/serena_config.py), ProjectConfigAutoGenerationMode.ASYNCHRONOUS writes the
  # language list EMPTY and fills it from a background thread, and _determine_project_language_servers
  # enables only the single TOP language by file count when it is not interactive - so a C#+Angular
  # repo gets one server, and a lookup racing the background pass gets none (measured in a consuming
  # C# project: serena nav dead, the session fell back to grep). Seeding makes it deterministic and
  # multi-language before the first symbol lookup. Detection is deliberately narrow - project files
  # only, depth 4, no network - and a key that already carries entries is never rewritten, so a
  # hand-tuned config survives every update. Ids are serena's own (project.template.yml).
  if (-not ($Mcps | Where-Object { $_ -like 'serena|*' })) { return }
  $root = Get-RepoRoot
  if (-not $root) { return }   # not a repo - serena has no root to bind either
  $cfg = Join-Path $root '.serena/project.yml'
  if (Test-Path -LiteralPath $cfg) {
    if (Test-SerenaListKey -Lines @(Get-Content -LiteralPath $cfg) -Key 'language_servers|languages') {
      Log '  serena: project.yml already names its language servers - left as-is'
    } else {
      $langs = Get-SerenaLangs -Root $root
      if ($langs.Count -gt 0) {
        $list = ($langs | ForEach-Object { '"' + $_ + '"' }) -join ', '
        Set-SerenaListKey -Cfg $cfg -Key 'language_servers' -Value "[$list]" -Comment 'serena writes this key empty (async) or with only the single top language.'
      } else {
        Log "  serena: no C#/TypeScript/JS sources found - language_servers left to serena's own detection"
      }
    }
    # ALWAYS, independent of the languages branch: an install predating this key, and every config
    # serena generated itself, otherwise keeps indexing .serena/home - measured on a 14-file
    # fixture, 126 files attempted and 112 failed, every one inside the language-server directory.
    Set-SerenaListKey -Cfg $cfg -Key 'ignored_paths' -Value $script:SerenaIgnores -Comment '.serena holds the ~327MB of language servers, .claude the stack files, .playwright the MCP browser profile - none are project source.'
    return
  }
  $langs = Get-SerenaLangs -Root $root
  # language_servers has no default in serena's schema, so a file without it fails to load: with
  # nothing detected, write nothing and let serena generate its own.
  if ($langs.Count -eq 0) { Log "  serena: no C#/TypeScript/JS sources found - left project.yml to serena's own detection"; return }
  $list = ($langs | ForEach-Object { '"' + $_ + '"' }) -join ', '
  $name = Split-Path -Leaf $root
  New-Item -ItemType Directory -Force -Path (Join-Path $root '.serena') | Out-Null
  $yml = @"
# Seeded by claude-stack. serena binds this repo via --project-from-cwd; the config it would
# auto-generate instead is written with an EMPTY language list in async mode and with only the
# single top language otherwise, so it is stated here explicitly. Detected from the files in this
# repo at install time; edit freely - a key that carries entries is never rewritten by an update.
# The C# (Roslyn) server needs .NET 10+; serena installs it itself when the runtime is not on
# PATH, into SERENA_HOME (.serena/home, ~327MB - keep .serena ignored).
project_name: "$name"
language_servers: [$list]
# .serena holds SERENA_HOME (the language servers, ~327MB of DLLs and node_modules),
# .claude the stack's own files, .playwright the browser profile/traces the playwright MCP
# writes - none of them project source. Without this line serena's indexer walks into them:
# measured on a 14-file fixture it tried 126 files and failed 112, every one of them inside
# .serena/home.
ignored_paths: $script:SerenaIgnores
"@
  Set-Content -LiteralPath $cfg -Value $yml -Encoding UTF8
  Log "  serena: seeded .serena/project.yml (project_name=$name, language_servers=[$list])"
}

# ===========================================================================
# INSTALL STAMP - which revision this install came from
# ===========================================================================
# Claude Code has no per-artifact version: `version:` is in the plugin.json schema and NOWHERE else
# (not skills, not agents, not rules, not hooks - an added key there parses but is ignored). So the
# stack versions the INSTALL, not the file: one stamp naming the commit every artifact was copied
# from. That is what /claude-stack:configure diffs against to answer 'what changed since I
# installed?' - exactly, for every artifact, with nothing to hand-bump:
#     <repo>/compare/<sha>...main  (the GitHub compare view / API)
# Machine-local by design (it describes THIS checkout's install) and already covered by the
# '.claude/*' gitignore line the run prints.
function Get-StackVersionFrom {
  # The stack's ONE version: an extracted release archive carries it in RELEASE-SOURCE; a git
  # checkout reads it from the plugin manifest - the same file the marketplace serves from main,
  # so the stamp, the release, and the marketplace always name the same version.
  param([string]$Dir)
  $rel = Join-Path $Dir 'RELEASE-SOURCE'
  if (Test-Path -LiteralPath $rel) {
    $v = ((Get-Content -LiteralPath $rel | Where-Object { $_ -match '^version: ' } | Select-Object -First 1) -replace '^version: ', '')
    if ($v) { return $v }
  }
  $manifest = Join-Path $Dir 'setup-plugin/.claude-plugin/plugin.json'
  if (Test-Path -LiteralPath $manifest) {
    try { return [string](Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).version } catch { }
  }
  return ''
}

function Write-Stamp {
  # No SHA means no source resolved this run (the archive download and the clone fallback both
  # failed, and every step fail-softly kept its existing copy). Stamping then would claim an
  # install that did not occur, and a wrong stamp is worse than none - so leave any previous
  # stamp untouched.
  if (-not $script:StackSha) { Log '  stamp: skipped - no source revision resolved this run'; return }
  $version = if ($script:StackSrc) { Get-StackVersionFrom -Dir $script:StackSrc } else { '' }
  if ($ClaudeScope -eq 'user') { $dir = $ConfigDir }
  else {
    # Prefer the repo root - that is where hooks/agents/rules land. Outside a repo fall back to the
    # cwd, which is where Install-Skills puts .claude/skills: the stamp belongs next to whatever
    # this run actually installed, and a skills-only install into a plain directory still gets one.
    $root = Get-RepoRoot
    if (-not $root) { $root = (Get-Location).Path }
    $dir = Join-Path $root '.claude'
  }
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $dest = Join-Path $dir 'claude-stack.stamp'
  $stampedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $lines = @(
    '# claude-stack install stamp - machine-local, written by claude-stack.sh / claude-stack.ps1.'
    '# The revision every artifact of this install was copied from. To see what changed since:'
    "#   open $StackRepoUrl/compare/$($script:StackSha)...main"
    '# /claude-stack:configure reports exactly this diff. Then re-run the installer''s'
    "# '$Action' action (or that skill) to take the changes."
    "source: $StackRepoUrl"
    "ref: $($script:StackRef)"
    "sha: $($script:StackSha)"
    "version: $version"
    "installed: $stampedAt"
    "action: $Action"
    "scope: $ClaudeScope"
  )
  Set-Content -LiteralPath $dest -Value $lines -Encoding utf8
  $shortSha = $script:StackSha.Substring(0, [Math]::Min(12, $script:StackSha.Length))
  Log "  stamp: $dest @ $shortSha"
}

function Set-HookSettings {
  # INSTALL + UPDATE: ensure the hook PreToolUse blocks + secret-read deny-list + mcp allow-list are in settings.json (idempotent).
  $root = Get-RepoRoot
  if (-not $root) { return }
  $settings = Join-Path $root '.claude/settings.json'
  $dir = Split-Path -Parent $settings
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $data = [pscustomobject]@{}
  if (Test-Path -LiteralPath $settings) {
    # Refuse to touch a settings.json that does not parse - a rewrite from scratch would replace the
    # project's whole file (permissions, statusLine, env) with just the stack's entries.
    try { $data = Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json } catch { $data = $null }
    if ($null -eq $data) { Write-Warning '  settings.json is not valid JSON - left untouched; fix it and re-run'; return }
  }

  if (-not $data.PSObject.Properties['hooks']) { $data | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $data.hooks.PSObject.Properties['PreToolUse']) { $data.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @() }
  $pre = @($data.hooks.PreToolUse)
  # Keyed on matcher::command: one hook file wired on two tools (guard-read-whole-file on Read AND Bash) is
  # two entries - keying on the command alone dropped the second (measured: no install ever carried the Bash matcher).
  $have = @(foreach ($e in $pre) { foreach ($h in $e.hooks) { "$($e.matcher)::$($h.command)" } })
  $changed = $false
  # Every hook here does <30ms of work (measured: 22-25ms, almost all of it the node spawn), but a
  # `command` hook with no timeout takes Claude Code's 600s default - so one stalled subprocess
  # (guard-protected-force-push and guard-ungated-commit both shell out to git, and a stuck
  # index.lock or a slow network mount hangs `git rev-parse`) freezes the session for ten minutes.
  # 10s is ~400x the measured cost and still fails fast.
  $HookTimeout = 10
  # Backfill the timeout onto entries an earlier install wrote bare (they carry the 600s default).
  foreach ($evEntries in $data.hooks.PSObject.Properties) {
    foreach ($e in @($evEntries.Value)) {
      foreach ($h in @($e.hooks)) {
        if ($h.command -and $h.command -match 'claude/hooks/guard-|claude/hooks/instrument-') {
          if (-not $h.PSObject.Properties['timeout']) { $h | Add-Member -NotePropertyName timeout -NotePropertyValue $HookTimeout; $changed = $true }
          elseif ($h.timeout -ne $HookTimeout) { $h.timeout = $HookTimeout; $changed = $true }
        }
      }
    }
  }
  # Unwire a hook file this stack RETIRED (its file is pruned in the same run): keyed on the file name
  # across EVERY event, since a retired hook may have been wired outside PreToolUse (inject-code-style
  # ran on a prompt event). Left wired, the entry keeps spawning a command whose file no longer exists.
  foreach ($evEntries in @($data.hooks.PSObject.Properties)) {
    $keptEv = @()
    foreach ($e in @($evEntries.Value)) {
      $hs = @(foreach ($h in @($e.hooks)) {
        $m = [regex]::Match([string]$h.command, '/\.claude/hooks/([A-Za-z0-9._-]+\.js)')
        if ($m.Success -and ($RetiredHooks -contains $m.Groups[1].Value)) { $changed = $true } else { $h }
      })
      if ($hs.Count -gt 0) { $e.hooks = $hs; $keptEv += $e } else { $changed = $true }
    }
    if ($keptEv.Count -gt 0) { $data.hooks.($evEntries.Name) = $keptEv } else { $data.hooks.PSObject.Properties.Remove($evEntries.Name) }
  }
  if (-not $data.hooks.PSObject.Properties['PreToolUse']) { $data.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @() }
  $pre = @($data.hooks.PreToolUse)
  # Prune OUR hook file from a PreToolUse matcher this version no longer wires (guard-stop-contract's
  # retired AskUserQuestion entry): the plugin route applies meta/migrations.json, the script route must
  # match, or the legacy entry survives every update with a freshly backfilled timeout (measured).
  # Keyed on the SELECTED $Hooks, so a hook the user de-selected keeps its entries (configure's job).
  $oursFiles = @(foreach ($entry in $Hooks) { ($entry -split '::', 3)[0] })
  $wired = @(foreach ($entry in $Hooks) { $p = $entry -split '::', 3; if ($p[1] -and -not $p[1].StartsWith('@')) { "$($p[1])::$($p[0])" } })
  $kept = @()
  foreach ($e in $pre) {
    $hs = @(foreach ($h in @($e.hooks)) {
      $m = [regex]::Match([string]$h.command, '/\.claude/hooks/([A-Za-z0-9._-]+\.js)')
      if ($m.Success -and ($oursFiles -contains $m.Groups[1].Value) -and -not ($wired -contains "$($e.matcher)::$($m.Groups[1].Value)")) { $changed = $true } else { $h }
    })
    if ($hs.Count -gt 0) { $e.hooks = $hs; $kept += $e } else { $changed = $true }
  }
  $pre = $kept
  foreach ($entry in $Hooks) {
    $parts = $entry -split '::', 3
    $file = $parts[0]
    $matcher = $parts[1]
    $argStr = if ($parts.Count -ge 3) { $parts[2] } else { '' }
    if (-not $matcher) { continue }
    # Single-quoted segments keep $CLAUDE_PROJECT_DIR literal (Claude Code substitutes it at runtime).
    $cmd = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/' + $file + '"'
    if ($argStr) { $cmd = $cmd + ' ' + $argStr }
    if ($file -eq 'instrument-tool-usage.js') {
      # env-gated: the sh test costs ~nothing when off; node spawns only under CLAUDE_STACK_INSTRUMENT=1
      $cmd = '[ "$CLAUDE_STACK_INSTRUMENT" != "1" ] || ' + $cmd
    }
    if ($matcher.StartsWith('@')) {
      # "@<Event>" wires a non-PreToolUse lifecycle event (e.g. @Stop - no matcher key there).
      # "@<Event>:<matcher>" is the same with a matcher, which some events DO key on: SessionStart's
      # source (`compact` / `startup` / `resume`) is the one this stack uses. Without the matcher
      # the entry fires on every session start, which is not what the fresh-session offer is for.
      $evParts = $matcher.Substring(1) -split ':', 2
      $evName = $evParts[0]
      $evMatcher = if ($evParts.Count -ge 2) { $evParts[1] } else { '' }
      if (-not $data.hooks.PSObject.Properties[$evName]) { $data.hooks | Add-Member -NotePropertyName $evName -NotePropertyValue @() }
      $ev = @($data.hooks.$evName)
      $evHave = @(foreach ($e in $ev) { foreach ($h in $e.hooks) { "$([string]$e.matcher)::$($h.command)" } })
      if ($evHave -contains "$evMatcher::$cmd") { continue }
      $evBlock = [pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = $cmd; timeout = $HookTimeout }) }
      if ($evMatcher) { $evBlock | Add-Member -NotePropertyName matcher -NotePropertyValue $evMatcher }
      $ev += $evBlock
      $data.hooks.$evName = $ev
      $changed = $true
      continue
    }
    if ($have -contains "$matcher::$cmd") { continue }
    $block = [pscustomobject]@{ matcher = $matcher; hooks = @([pscustomobject]@{ type = 'command'; command = $cmd; timeout = $HookTimeout }) }
    $pre += $block
    $have += "$matcher::$cmd"
    $changed = $true
  }
  $data.hooks.PreToolUse = $pre
  # permissions.deny: union-merge the secret-file Read blocks, preserving any the project already set.
  if (-not $data.PSObject.Properties['permissions']) { $data | Add-Member -NotePropertyName permissions -NotePropertyValue ([pscustomobject]@{}) }
  if (-not $data.permissions.PSObject.Properties['deny']) { $data.permissions | Add-Member -NotePropertyName deny -NotePropertyValue @() }
  $deny = @($data.permissions.deny)
  foreach ($rule in $SecretDeny) {
    if ($deny -notcontains $rule) { $deny += $rule; $changed = $true }
  }
  $data.permissions.deny = $deny
  # NO permissions.allow seed for the gate stamps, deliberately. The hooks require a write to
  # <docs-root>/flow/APPROVAL and /COMMIT-GATE, and under the default docs root those sit inside
  # '.claude/' - a PROTECTED path. Protected-path writes are never auto-approved outside
  # bypassPermissions, and the safety check runs BEFORE settings allow-rules, so an Edit()/Write()
  # entry here is a silent no-op. The working levers are the prompt's own 'allow Claude to edit its
  # own settings for this session' option, or a CLAUDE_STACK_DOCS_PATH outside '.claude/'.
  # enabledMcpjsonServers: pre-approve exactly the project .mcp.json servers we register (never enableAllProjectMcpServers).
  if (-not $data.PSObject.Properties['enabledMcpjsonServers']) { $data | Add-Member -NotePropertyName enabledMcpjsonServers -NotePropertyValue @() }
  $enabled = @($data.enabledMcpjsonServers)
  foreach ($mcpEntry in $Mcps) {
    $mcpName = ($mcpEntry -split '\|', 2)[0]   # server name = the token before the first '|'
    if ($enabled -notcontains $mcpName) { $enabled += $mcpName; $changed = $true }
  }
  $data.enabledMcpjsonServers = $enabled
  # Environment keys this stack RENAMED: carry the user's VALUE to the new name and drop the old
  # key, BEFORE the absent-only seeds below - seeding first would write the default over a value the
  # user had set under the old name. One pair per rename; keep the list identical in both installer
  # twins and in meta/migrations.json (the plugin route applies it from there).
  if (-not $data.PSObject.Properties['env']) { $data | Add-Member -NotePropertyName env -NotePropertyValue ([pscustomobject]@{}) }
  foreach ($pair in @(@{ old = 'CLAUDE_DOCS_PATH'; new = 'CLAUDE_STACK_DOCS_PATH' })) {
    if ($data.env.PSObject.Properties[$pair.old]) {
      $val = [string]$data.env.($pair.old)
      if (-not $data.env.PSObject.Properties[$pair.new] -and $val -ne '') {
        $data.env | Add-Member -NotePropertyName $pair.new -NotePropertyValue $val
      }
      $data.env.PSObject.Properties.Remove($pair.old)
      $changed = $true
      Log "  settings.json env: $($pair.old) renamed to $($pair.new)"
    }
  }
  # Environment keys whose SEEDED DEFAULT turned out to be WRONG: clear the key when its value is
  # still exactly that seed - a value the user set by hand is theirs and is never touched. Same
  # list in both installer twins and in meta/migrations.json (the plugin route applies it there).
  foreach ($reset in @(@{ key = 'CLAUDE_STACK_CONTEXT_WINDOW'; seed = '1000000' })) {
    if ($data.env.PSObject.Properties[$reset.key] -and [string]$data.env.($reset.key) -eq $reset.seed) {
      $data.env.($reset.key) = ''
      $changed = $true
      Log "  settings.json env: $($reset.key) cleared to auto-detect (the old seed declared a 1M window on every install)"
    }
  }
  # env: project-default auto-compact trigger (compact at ~40% of the context window). Set only when
  # absent, so a project that pins its own value - or holds CONTEXT7_API_KEY here - is never clobbered.
  if (-not $data.env.PSObject.Properties['CLAUDE_AUTOCOMPACT_PCT_OVERRIDE']) {
    $data.env | Add-Member -NotePropertyName CLAUDE_AUTOCOMPACT_PCT_OVERRIDE -NotePropertyValue '40'
    $changed = $true
  }
  # generated-docs root: the authoritative value the baseline-docs-root rule resolves at session start.
  # Forward slashes DELIBERATELY, also on Windows - the value is consumed by Node hooks and the
  # model, both of which resolve '/' fine; backslashes would need JSON escaping and break parity.
  if (-not $data.env.PSObject.Properties['CLAUDE_STACK_DOCS_PATH']) {
    $data.env | Add-Member -NotePropertyName CLAUDE_STACK_DOCS_PATH -NotePropertyValue '.claude/docs'
    $changed = $true
  }
  # instrumentation switch: the wired instrument hook runs only when this is '1' - seeded off.
  if (-not $data.env.PSObject.Properties['CLAUDE_STACK_INSTRUMENT']) {
    $data.env | Add-Member -NotePropertyName CLAUDE_STACK_INSTRUMENT -NotePropertyValue '0'
    $changed = $true
  }
  # publish gate: `git push` / `gh pr merge` need a flow/PUSH-GATE receipt like a commit does.
  # Seeded ON - across four audited sessions every push and merge passed every guard, one of them
  # putting 40 files on a shared `develop`. '0' for a repo whose remote is already gated.
  if (-not $data.env.PSObject.Properties['CLAUDE_STACK_PUSH_GATE']) {
    $data.env | Add-Member -NotePropertyName CLAUDE_STACK_PUSH_GATE -NotePropertyValue '1'
    $changed = $true
  }
  # fresh-session gate, BOTH of its knobs - seeded so they are visible and tunable in one place.
  # Until they were, the only percentage in the block was CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, a
  # different knob (the harness auto-compact trigger); a user raised THAT to 40 and reasonably
  # expected the gate to move (reported 2026-09-04 - the gate reads its own value, absent and
  # defaulted to 40 anyway, so the number matched while the setting did nothing).
  if (-not $data.env.PSObject.Properties['CLAUDE_STACK_FRESH_SESSION_PCT']) {
    $data.env | Add-Member -NotePropertyName CLAUDE_STACK_FRESH_SESSION_PCT -NotePropertyValue '40'
    $changed = $true
  }
  # The context window that percentage applies to - seeded EMPTY, which MEANS auto-detect. It was
  # seeded '1000000', and that killed the gate on every install that was not a 1M account: this
  # value is the FIRST layer of the hooks' window resolution, so a stated 1M window on a 200k
  # session put the trigger above anything that session can ever carry, and no offer could fire
  # (ten confirmations across four projects). Empty, the hooks read the settings model id's own
  # window suffix (`opus[1m]`), else the tier the session has already proven. Fill it in only to
  # OVERRULE that - '1000000' or '200000'; the box is written empty so it stays visible here.
  if (-not $data.env.PSObject.Properties['CLAUDE_STACK_CONTEXT_WINDOW']) {
    $data.env | Add-Member -NotePropertyName CLAUDE_STACK_CONTEXT_WINDOW -NotePropertyValue ''
    $changed = $true
  }
  if ($changed) {
    try {
      Write-JsonFile $data $settings
      Log '  settings.json: hooks + secret deny-list + mcp allow-list + compact default ensured'
    }
    catch {
      # Mirror the .sh twin's `|| log "settings.json wiring failed"`: a single unwritable file must
      # not abort the install (Get-Agents and the serena fix still need to run). ReadOnly/Hidden are
      # cleared in Write-JsonFile, so reaching here means a real lock or ACL denial.
      Write-Warning "  settings.json wiring failed: $($_.Exception.Message)"
      Write-Host '     Likely locked or ACL-restricted. Close Claude Code / editors holding it, or check' -ForegroundColor Yellow
      Write-Host "     write permission on $settings, then re-run (hooks are wired idempotently)." -ForegroundColor Yellow
    }
  }
  else {
    Log '  settings.json: hooks + secret deny-list + mcp allow-list + compact default already present - unchanged'
  }
}

# ===========================================================================
# UPDATE - bring everything to latest
# ===========================================================================
# Renamed/retired upstream names: their old files left the manifests, so the refresh loops never clear
# them - a leftover skill keeps auto-activating next to its successor, a leftover agent stays dispatchable
# under the old @agent-name (and the capabilities capture inventories it). Only names this stack itself
# once installed; an absent one is a no-op. The guided /claude-stack:update prunes from the stamp
# compare instead - these lists are the script path's equivalent (twin of the sh RETIRED_* arrays).
$RetiredSkills = @('project-task-flow', 'project-task-cycle', 'project-capabilities', 'project-failure-signatures', 'typescript-testing', 'data-security', 'dotnet-error-handling', 'mobile-security')
$RetiredRules = @('baseline-agents-skills.md', 'baseline-code-quality.md', 'baseline-communication.md', 'baseline-definition-of-done.md', 'baseline-evaluating-proposals.md', 'baseline-mcp-tools.md', 'baseline-planning.md', 'baseline-related-projects.md', 'house-baseline.md', 'web-conventions.md', 'aspnet-conventions.md')
$RetiredHooks = @('require-convention-skill.js', 'inject-code-style.js')
$RetiredAgents = @('angular-solution-designer.md', 'angular-implementer.md', 'angular-verifier.md', 'mobile-solution-designer.md', 'mobile-implementer.md', 'mobile-verifier.md', 'dotnet-windows-service-solution-designer.md', 'dotnet-windows-service-implementer.md', 'dotnet-windows-service-verifier.md', 'code-analyzer.md', 'issue-diagnoser.md')
# MCP servers this stack no longer ships AT ALL. Empty today, and it is the mechanism that matters:
# skills, agents, rules and hooks each got a retired list; MCPs never did, so a server the stack
# dropped stayed registered in every existing install and kept injecting its tool schemas on every
# session (measured: 24 playwright schemas re-injected into a headless backend project). A server
# the stack still SHIPS but this project no longer needs is a different question - that is
# /claude-stack:validate's whole-stack-absent pass, not a retirement.
$RetiredMcps = @()

function Remove-Skills {
  # rm the manifest skills under the scope dest, so update starts from a clean slate.
  $dest = Get-SkillsDest
  Log "skills [$ClaudeScope]: removing $($Skills.Count) for clean reinstall"
  foreach ($entry in $Skills) {
    $name = $entry.Split('|', 2)[1]
    Remove-Item -LiteralPath (Join-Path $dest $name) -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($name in $RetiredSkills) {
    $p = Join-Path $dest $name
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; Log "  skill pruned (retired upstream): $name" }
  }
}

function Remove-RetiredRules {
  # UPDATE: drop the known old rule names ($RetiredRules above). A leftover rule is worse than a
  # leftover skill: a pathless baseline-*.md loads into EVERY session and subagent, so a retired copy
  # keeps shipping guidance its replacement already merged (measured on a real install: 7 of 14 rule
  # files were names this release no longer ships).
  $root = Get-RepoRoot
  if (-not $root) { return }
  foreach ($name in $RetiredRules) {
    $p = Join-Path $root ".claude/rules/$name"
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; Log "  rule pruned (retired upstream): $name" }
  }
}

function Remove-RetiredHooks {
  # UPDATE: drop the known old hook names ($RetiredHooks above) - the file only; Set-HookSettings
  # drops the matching settings.json entries in the same run (a wired command whose file is gone
  # spawns a failure on every matching tool call).
  $root = Get-RepoRoot
  if (-not $root) { return }
  foreach ($name in $RetiredHooks) {
    $p = Join-Path $root ".claude/hooks/$name"
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; Log "  hook pruned (retired upstream): $name" }
  }
}

function Remove-RetiredAgents {
  # UPDATE: drop the known old agent names ($RetiredAgents above).
  $root = Get-RepoRoot
  if (-not $root) { return }
  foreach ($name in $RetiredAgents) {
    $p = Join-Path $root ".claude/agents/$name"
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; Log "  agent pruned (retired upstream): $name" }
  }
}

function Update-Skills {
  # Fresh clone + copy - the same as install (the copy overwrites), just cleared first.
  Remove-Skills
  Install-Skills
}

function Update-Plugins {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { $script:ClaudeMissing = $true; return }   # fail-soft: skip, never abort
  try { & claude plugin marketplace update 2>$null } catch {}   # refresh marketplaces first
  foreach ($p in $Plugins) {
    $pScope = if ($p -like 'claude-hud@*') { 'user' } else { $ClaudeScope }   # claude-hud is user-scope (statusline)
    Log "plugin update [$pScope]: $p"
    try { & claude plugin update $p --scope $pScope -y } catch {}   # -y for the same non-TTY reason as install
  }
}

function Remove-RetiredMcps {
  # UPDATE: unregister the known retired server names ($RetiredMcps above)
  foreach ($name in $RetiredMcps) {
    claude mcp remove $name -s $script:ClaudeScope 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Log "  mcp pruned (retired upstream): $name" }
  }
}

function Update-Mcps {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) { $script:ClaudeMissing = $true; return }   # fail-soft: skip, never abort
  Remove-RetiredMcps
  # Only the @latest entries (chrome-devtools, appium-mcp) float at launch; the pinned ones (playwright,
  # serena, memory, context7 when local) bump here via remove + re-add. angular-cli stays unpinned by
  # design; the hosted servers (context7 remote, sentry) have nothing to pin.
  foreach ($entry in $Mcps) {
    $parts = $entry.Split('|', 2)
    $name = $parts[0]
    $spec = $parts[1]
    $argArr = Resolve-McpArgv $spec   # split-first + per-word token resolution, as in Install-Mcps
    Log "mcp refresh [$ClaudeScope]: $name"
    if ($name -eq 'sentry' -and $SentrySlug) { Set-AccountEnv SENTRY_SLUG $SentrySlug }
    try { & claude mcp remove $name -s $ClaudeScope 2>$null } catch {}
    if ($spec -eq '@HTTP@') {
      # remote (hosted) server - url/header keyed by name: sentry, else context7. An EMPTY header
      # (sentry -SentryAuth oauth) registers with no --header at all, so the OAuth fallback stays on.
      $url = if ($name -eq 'sentry') { $SentryRemoteUrl } else { $Context7RemoteUrl }
      $hdr = if ($name -eq 'sentry') { $SentryRemoteHdr } else { $Context7RemoteHdr }
      if ($hdr) { try { & claude mcp add --transport http --scope $ClaudeScope $name $url --header $hdr } catch {} }
      else      { try { & claude mcp add --transport http --scope $ClaudeScope $name $url } catch {} }
      if ($LASTEXITCODE -ne 0) { Add-Failure "mcp $name failed" }
      continue
    }
    try { & claude mcp add --scope $ClaudeScope $name @argArr } catch {}
    if ($LASTEXITCODE -ne 0) { Add-Failure "mcp $name failed" }
  }
}

function Update-Hooks { Remove-RetiredHooks; Get-Hooks; Set-HookSettings }   # UPDATE: refresh hook files + re-ensure the settings.json wiring (idempotent - a new hook block, deny rule, or env key ships to updated projects too)
function Update-Agents { Remove-RetiredAgents; Get-Agents } # UPDATE: drop retired names, refresh subagent files
function Update-Rules { Remove-RetiredRules; Get-Rules }   # UPDATE: drop retired names, refresh rule files

# ===========================================================================
# KEEP-PINS (-KeepPins) - preserve local model/effort frontmatter edits across the refresh.
# The agent fetch and the skills clean-reinstall reset every file to upstream, wiping a per-project
# model/effort re-pin. With -KeepPins the values are snapshotted BEFORE the refresh and re-applied
# AFTER it - only keys present in both the old local file and the refreshed one (no add/remove), and
# the local value always wins over an upstream pin change (the switch cannot tell the two apart).
# ===========================================================================
function Get-FrontmatterPin([string]$Path, [string]$Key) {
  # Return the key's value from the leading frontmatter block ('' if absent).
  try { $lines = [System.IO.File]::ReadAllLines($Path) } catch { return '' }
  if (-not $lines -or $lines.Count -eq 0 -or $lines[0] -notmatch '^---\s*$') { return '' }
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^---\s*$') { break }
    if ($lines[$i] -match ('^' + [regex]::Escape($Key) + ':\s*(.*?)\s*$')) { return $Matches[1] }
  }
  return ''
}

function Set-FrontmatterPin([string]$Path, [string]$Key, [string]$Value) {
  # Rewrite the key's line INSIDE the frontmatter block only. .NET IO keeps UTF-8 intact
  # (Set-Content on PS 5.1 would re-encode the body), and the LF join keeps the fetched files'
  # Unix line endings (WriteAllLines would rewrite the whole file CRLF on Windows).
  $lines = [System.IO.File]::ReadAllLines($Path)
  if (-not $lines -or $lines.Count -eq 0 -or $lines[0] -notmatch '^---\s*$') { return }
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^---\s*$') { break }
    if ($lines[$i] -match ('^' + [regex]::Escape($Key) + ':')) {
      $lines[$i] = "${Key}: $Value"
      [System.IO.File]::WriteAllText($Path, (($lines -join "`n") + "`n"))
      return
    }
  }
}

function Get-PinFiles {
  # Every locally-installed pin-bearing target: manifest agents + skill SKILL.md files.
  $files = @()
  $root = Get-RepoRoot
  if ($root) {
    foreach ($f in $Agents) {
      $p = Join-Path $root ".claude/agents/$f"
      if (Test-Path -LiteralPath $p) { $files += $p }
    }
  }
  $skillsDir = if ($Scope -eq 'project') { if ($root) { Join-Path $root '.claude/skills' } } else { Join-Path $ConfigDir 'skills' }
  if ($skillsDir) {
    foreach ($entry in $Skills) {
      $p = Join-Path $skillsDir ($entry.Split('|', 2)[1] + '/SKILL.md')
      if (Test-Path -LiteralPath $p) { $files += $p }
    }
  }
  return $files
}

$script:PinSnapshot = @{}
function Save-Pins {
  # -KeepPins: record each installed agent/skill file's model/effort before the refresh.
  if (-not $KeepPins) { return }
  foreach ($f in Get-PinFiles) {
    $m = Get-FrontmatterPin $f 'model'
    $e = Get-FrontmatterPin $f 'effort'
    if ($m -or $e) { $script:PinSnapshot[$f] = @{ model = $m; effort = $e } }
  }
  Log "keep-pins: snapshotted model/effort from $($script:PinSnapshot.Count) file(s)"
}

function Restore-Pins {
  # -KeepPins: re-apply every snapshotted value the refresh changed.
  if (-not $KeepPins) { return }
  $kept = 0
  foreach ($f in Get-PinFiles) {
    if (-not $script:PinSnapshot.ContainsKey($f)) { continue }
    # Display name matching the .sh twin: agents/<file> or skills/<skill>/SKILL.md.
    $disp = if ($f -match '[\\/]\.claude[\\/]agents[\\/]') { 'agents/' + (Split-Path -Leaf $f) } else { 'skills/' + (Split-Path -Leaf (Split-Path -Parent $f)) + '/SKILL.md' }
    foreach ($key in @('model', 'effort')) {
      $saved = $script:PinSnapshot[$f][$key]
      if (-not $saved) { continue }
      $cur = Get-FrontmatterPin $f $key
      if ($cur -and $cur -ne $saved) {
        Set-FrontmatterPin $f $key $saved; $kept++
        Log "  pin kept: $disp $key=$saved (upstream: $cur)"
      }
    }
  }
  $script:PinSnapshot = @{}
  Log "keep-pins: re-applied $kept local pin value(s)"
}

function Remove-AgentsCache {
  # Legacy cleanup: an npx-skills-era install staged an agent-neutral .agents/ store. The git-copy
  # install_skills never creates one, so this is a no-op on a fresh install and only matters for a
  # project upgrading from the old flow. Guard: keep it if any skill entry under .claude/skills is a
  # symlink (a symlinked tree still depends on .agents/; removing it would dangle).
  $root = Get-RepoRoot
  if (-not $root) { return }
  $agents = Join-Path $root '.agents'
  if (-not (Test-Path -LiteralPath $agents)) { return }
  $hasSymlink = $false
  foreach ($d in @((Join-Path $root '.claude/skills'))) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    $sym = [bool](Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Attributes -band [System.IO.FileAttributes]::ReparsePoint })
    if ($sym) { $hasSymlink = $true; break }
  }
  if ($hasSymlink) { Log '  kept .agents/ - a skills tree has symlinks that still depend on it' }
  else { Remove-Item -LiteralPath $agents -Recurse -Force -ErrorAction SilentlyContinue; Log '  pruned .agents/ (skills are real per-agent copies)' }
}

# ===========================================================================
# WINDOWS SERENA FIX (interim) - remove once oraios/serena#311 ships upstream
# ===========================================================================
function Repair-SerenaTsLspWindows {
  # Windows-only. serena/solidlsp spawns npm's extensionless POSIX shim
  # (.bin/typescript-language-server), which cmd.exe can't run, so serena's TS symbol/reference
  # tools die at language-server init (oraios/serena#311). serena exposes NO command/path override,
  # so the only lever is patching _create_launch_command in the cached package. Two steps:
  #   1) pre-warm: `claude mcp add` only registers serena - the package isn't materialized in the uv
  #      cache until serena first launches, so force a uvx run now or there is nothing to patch yet.
  #   2) delegate the idempotent patch to scripts/os/fix-serena-ts-windows.ps1 (single source of truth),
  #      fetched from the repo like the hooks. Fail-soft throughout. No-op on the .sh twin (Unix runs
  #      the shim directly via its shebang). REMOVE this whole block once #311 ships upstream.
  if (-not $OnWindows) { return }
  if (-not (Get-Command uvx -ErrorAction SilentlyContinue)) { return }
  $serenaOn = $false
  try { & claude mcp get serena *> $null; $serenaOn = ($LASTEXITCODE -eq 0) } catch {}
  if (-not $serenaOn) { return }   # only patch when serena is actually part of this stack

  Log 'serena: applying interim Windows TS-LSP launch fix (oraios/serena#311)'
  # Pre-warm: any subcommand makes uvx resolve+cache serena-agent (download happens before the
  # command runs, so the exit code is irrelevant); $SerenaPin keeps it the same version the MCP uses.
  try { & uvx --from ('serena-agent' + $SerenaPin) serena --help *> $null } catch {}

  # From the run's source clone, like every other repo-owned file - so this patch is the same
  # revision as the rest of the install rather than whatever the raw CDN happens to be serving.
  if (-not (Get-StackSrc)) { Write-Warning '  serena TS-LSP fix skipped - stack source unavailable'; return }
  $fixSrc = Join-Path $script:StackSrc (Join-Path 'scripts/os' 'fix-serena-ts-windows.ps1')
  if (-not (Test-Path -LiteralPath $fixSrc -PathType Leaf)) { Write-Warning '  serena TS-LSP fix skipped - fix-serena-ts-windows.ps1 not found in the source'; return }
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $fixSrc   # child process: its `exit` won't kill this installer
  }
  catch { Write-Warning "  serena TS-LSP fix skipped (run failed): $($_.Exception.Message)" }
}

# ===========================================================================
# DISPATCH
# ===========================================================================
# -SkillsOnly: run ONLY the skill step and exit, before any prerequisite check or claude-CLI-
# dependent step (testability - drives just the git-copy with no claude/gh/network dependency).
if ($SkillsOnly) {
  if ($Action -eq 'install') { Install-Skills } else { Update-Skills }
  Write-Stamp      # a skills-only run still installs FROM a revision - record it
  Remove-StackSrc
  exit 0
}

Test-Prerequisites
Install-GitHubCli

# claude-only steps fail soft (Get-Command claude) if the CLI is not installed.
Save-Pins   # -KeepPins only: no-op without the switch (install re-adds skills unconditionally too, so both actions refresh)
# try/finally is the .ps1 stand-in for the .sh EXIT trap: the source clone is removed even if a step
# throws. Write-Stamp runs after every copy step, so the stamp only ever names a revision that fully landed.
try {
  if ($Action -eq 'install') { Install-Skills; Install-Plugins; Install-Mcps; Get-Hooks; Set-HookSettings; Get-Agents; Get-Rules; New-ClaudeMd; New-SerenaProject; Repair-SerenaTsLspWindows }
  else { Update-Skills; Update-Plugins; Update-Mcps; Update-Hooks; Update-Agents; Update-Rules; New-SerenaProject; Repair-SerenaTsLspWindows }
  Restore-Pins
  Write-Stamp
}
finally { Remove-StackSrc }

Remove-AgentsCache
Write-Host ''
Log "done: $Action [scope=$Scope, account=$ConfigDir, agent=$Agent]"
$hookFiles = @($Hooks | ForEach-Object { ($_ -split '::', 2)[0] } | Select-Object -Unique).Count   # hook FILES (a hook wired on two tools is one hook), matching the plan (ten hooks today)
$summary = "  installed/refreshed this run - skills=$($Skills.Count), plugins=$($Plugins.Count), mcps=$($Mcps.Count), hooks=$hookFiles, agents=$($Agents.Count), rules=$($ClaudeRules.Count)"
if ($Space) { $summary += "; space=$Space, memory DB=$MemoryDbFile" }
if ($KeepPins) { $summary += '; keep-pins=on' }
Log "$summary; context7=$Context7"
# The counts above are the SELECTION this run wrote, not a listing of .claude/ - generated
# project-owned files and names this release no longer ships are neither refreshed nor counted
# (a real install compared its 14 rule FILES against rules=4 and read it as a silent drop).
if ($InstalledOnly) { Log "  (a directory listing can be larger: generated project files and any 'unknown:' name above are left untouched)" }
if ($script:ClaudeMissing) { Log "  !! claude CLI absent - plugins, MCPs, and settings.json wiring were SKIPPED (install it, then re-run)" }
if ($script:FailCount -gt 0) { Log "  !! $($script:FailCount) item(s) failed above - re-run '$Action' to retry" }

Log 'next steps:'
Log "  - write your project's CLAUDE.md top from the template's authoring-outline comment (framework, stack, conventions, secret/config globs) - install seeds a starter from the template when the project has none; the claude-md-management plugin can help audit it"
Log "  - if this repo has sibling projects (a backend/frontend pair, a consumed package), run /project-related-context with their paths/URLs - it generates the awareness rule (baseline-project-related-context.md) + related-context/PROJECT-RELATED-CONTEXT.md under the docs root"
Log "  - once oriented, run the other two captures the CLAUDE.md rules table names: /project-architecture-analyzer (architecture map + assessment + awareness rule) and /project-code-style-analyzer (PROJECT-CODE-STYLE.md under the docs root + the generated path-scoped style rule)"
Log "  - run /project-agent-capabilities LAST - it inventories the installed skills/agents/MCPs and generates baseline-project-agent-capabilities.md (re-run after update or a manifest trim)"
if ($Mcps | Where-Object { $_ -like 'serena|*' }) {
  Log '  - index the codebase for serena ONCE (a few seconds to a few minutes; the first run also downloads the language server): $env:SERENA_HOME=".serena/home"; uvx --from serena-agent serena project index - re-run it after a large refactor, a branch switch that moves many files, or whenever symbol lookups start missing things'
}
Log '  - restart Claude Code (or reopen the project) to load the new MCPs, hooks, and settings'
if ($script:PrereqMissing) { Log '  - install the missing prerequisites flagged above, then re-run' }
if ($Context7 -eq 'remote') { Log "  - context7 is remote; add CONTEXT7_API_KEY to $ConfigDir\settings.json 'env' (the ACCOUNT file - a project-level one does not reach .mcp.json) for higher rate limits, or re-run with -Context7 local" }
if (@($Mcps | Where-Object { $_ -like 'sentry|*' }).Count -gt 0) {
  Log "  - sentry reads SENTRY_SLUG (your org, or org/project) from $ConfigDir\settings.json 'env' - seeded by -SentrySlug, or add it there by hand (a project-level settings.json does not reach .mcp.json)"
  if ($SentryAuth -eq 'token') {
    Log "  - sentry auth is token: add SENTRY_ACCESS_TOKEN (a personal/org API token) to the same $ConfigDir\settings.json 'env' yourself - or re-run with -SentryAuth oauth for the browser consent flow"
    # The token never goes through a chat, and not through a command argument either (it would land
    # in the PSReadLine history file). Read-Host -AsSecureString takes it from the terminal without
    # echoing it; the file is written by this snippet, not by anything that can log the value.
    Log "      the token never travels through a chat, and does not belong in a command argument. Paste it into this:"
    Log "      `$t = Read-Host 'token (not echoed)' -AsSecureString"
    Log "      `$p = '$ConfigDir\settings.json'"
    Log "      `$d = if (Test-Path `$p) { Get-Content `$p -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }"
    Log "      if (-not `$d.PSObject.Properties['env']) { `$d | Add-Member env ([pscustomobject]@{}) }"
    Log "      `$d.env | Add-Member SENTRY_ACCESS_TOKEN (ConvertFrom-SecureString `$t -AsPlainText) -Force"
    Log "      `$d | ConvertTo-Json -Depth 20 | Set-Content `$p"
  }
  else { Log "  - sentry is registered with no header: the first use opens Sentry's consent flow in the browser via /mcp" }
}
if ($GitHubCli) { Log "  - run 'gh auth login' if gh is not yet authenticated (needed before PRs/issues)" }

# Reminder: stack-generated, machine-local artifacts that should NOT be committed.
Write-Host ''
Write-Host "Add these stack-generated, machine-local artifacts to the project's .gitignore (or .git\info\exclude):"
Write-Host '  .serena          serena per-project state: registry, cache, language servers (SERENA_HOME=.serena/home)'
Write-Host '  .claude/*        Claude Code project config + local state (settings.local.json, hooks) - ignore the contents...'
Write-Host '  !.claude/CLAUDE.md   ...but TRACK the project instructions: they live at .claude/CLAUDE.md and must be committed (git can only re-include a file if the parent dir is not wholesale-ignored, hence .claude/* not .claude/)'
Write-Host '  .slopwatch       dotnet-slopwatch output'
Write-Host '  .playwright      playwright MCP user-data-dir + output (screenshots, traces)'
Write-Host '  .mcp.json        generated MCP server config (machine-local)'
Write-Host ''
Write-Host "The generated-docs root is CLAUDE_STACK_DOCS_PATH in .claude\settings.json env (seeded '.claude/docs') -"
Write-Host 'generated docs inherit the .claude ignore above and are machine-local: not committed, not shared,'
Write-Host 're-captured after a fresh clone. To share them with the team, set CLAUDE_STACK_DOCS_PATH to a committed'
Write-Host "path (e.g. 'docs', forward slashes on every OS) and track <docs-path>/superpowers/ too."
Write-Host ''
Write-Host 'The same env block carries the fresh-session gate''s two knobs (seeded, absent-only, so a'
Write-Host 'hand-edited value survives every update):'
Write-Host '  CLAUDE_STACK_FRESH_SESSION_PCT   what share of the context window a session may carry before an'
Write-Host '                                   orchestration run is offered a fresh one (default 40; 0 = off)'
Write-Host '  CLAUDE_STACK_CONTEXT_WINDOW      the window that percentage applies to - seeded EMPTY, which'
Write-Host '                                   means auto-detect: the hooks read the settings model id''s'
Write-Host '                                   window suffix (opus[1m]), else the tier the session has'
Write-Host '                                   already proven. Fill it in (1000000 / 200000) only to'
Write-Host '                                   overrule that; the value outranks every detection layer.'
Write-Host 'On the auto-detected 200k tier the percentage is INERT below 76: the trigger keeps the measured'
Write-Host '150k floor, and 200k x 75% is still 150k. Above that tier it is capped at 250k, because the'
Write-Host 'harness auto-compacts at ~390k and a trigger above that ceiling can never fire.'
