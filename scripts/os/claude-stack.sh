#!/usr/bin/env bash
#
# claude-stack.sh install|update [--space <name>] [--scope project|global] [--context7 local|remote]
# [--sentry-slug <slug>] [--sentry-auth token|oauth] [--github-cli] [--keep-pins] - install/update the CLAUDE CODE stack FOR A PROJECT: every skill / plugin / MCP from
# claude-stack.html (the complete toolset, not a curated subset), installed INTO a project. Built-in/
# system CLI skills are excluded (they ship with the CLI). Bash twin of claude-stack.ps1; the Cursor
# stack lives in the cursor-stack repo.
#
# Usage - run this file directly inside the target project:
#   bash claude-stack.sh install   # install for Claude Code
#   bash claude-stack.sh update    # update Claude Code (skills + plugins + mcp + hooks)
#
# Provisions Claude Code: skills --agent claude-code; plugins; MCPs via `claude mcp add`; hooks +
# settings.json. Requires the `claude` CLI; claude-only steps fail soft if it is absent.
#
# The action (install|update) is the one positional argument; everything else is a named flag (any order):
#   --space <name>          any word; selects the Claude account ~/.claude-<name> (skills/plugins/MCPs
#                           install there - CLAUDE_CONFIG_DIR is exported for the claude CLI) AND a
#                           separate memory DB (memory_<name>.db). Omit for the default ~/.claude
#                           account + shared DB. The DB lives at ~/.memory-mcp, so a Cursor install
#                           on the same machine sees the same per-space DB.
#   --scope project|global  project (default) installs the full set INTO this repo (skills project-
#                           scoped, plugins/mcps --scope project); global installs it into the active
#                           account (skills -g, plugins/mcps --scope user). Overrides the SCOPE env var.
#   --context7 local|remote context7 transport; remote (default) is the hosted HTTP server, local the
#                           npx stdio server.
#   --github-cli            install the GitHub CLI (gh) via Homebrew (macOS) if missing; prompts for
#                           `gh auth login` when unauthenticated.
#   --keep-pins             keep this project's LOCAL model/effort frontmatter edits on installed
#                           agents (.claude/agents) and skills (SKILL.md) across the refresh - the
#                           local value is re-applied after the fetch/reinstall (which otherwise
#                           resets it to upstream). Only existing keys are re-applied; with the flag
#                           on, a local pin edit always wins over an upstream pin change.
#
# Full inventory - comment out manifest entries below to trim it to a curated subset.
set -euo pipefail

usage() {
  cat <<USAGE
claude-stack.sh - install or update the Claude Code stack into a project.

Usage: bash $0 <install|update> [--space <name>] [--scope project|global] [--context7 local|remote] [--sentry-slug <slug>] [--sentry-auth token|oauth] [--github-cli] [--keep-pins]

Action (one is REQUIRED, positional):
  install   first-time provision; MCP/plugin versions freeze until the next update; wires .claude/settings.json
  update    re-resolve every runtime to latest + refresh hooks/agents/rules; re-ensures the settings.json hook wiring (idempotent)

Named flags (any order, each optional with a default):
  --space <name>           install into the ~/.claude-<name> account + a separate memory_<name>.db
  --scope project|global   project (default) installs INTO this repo; global installs into the account
  --context7 local|remote  context7 transport; remote (default) is the hosted server, local the npx server
  --sentry-slug <slug>     seed SENTRY_SLUG - the Sentry org ('<org>') or project ('<org>/<project>',
                           Sentry's recommended form) - into the ACCOUNT settings.json "env"
                           (<account>/settings.json); the registration reads it at launch as
                           https://mcp.sentry.dev/mcp/\${SENTRY_SLUG}. Absent = the env is left as it is
  --sentry-auth token|oauth  sentry MCP auth. token (default) sends 'Authorization: Sentry-Bearer
                           \${SENTRY_ACCESS_TOKEN}' (a personal/org API token you add to the same account
                           "env" yourself); oauth registers NO header, so Claude Code runs Sentry's
                           browser consent flow on first connect instead. Both values expand from the
                           ACCOUNT settings.json "env" or the launch shell - never from a project-level
                           .claude/settings.json (measured: that stays literal). update: absent = keep
                           the mode the registration already has
  --github-cli             install the GitHub CLI (gh) if missing
  --keep-pins              keep local model/effort frontmatter edits on installed agents/skills across
                           the refresh (an update resets them to upstream otherwise)
  --selection <file>       install ONLY the skills/plugins/mcps/agents/rules/hooks named in <file> (one 'category name' per line); a selection with no 'hook' lines installs all hooks
  --installed-only         update only: derive the selection from what is already installed (skills/
                           agents/rules/hooks on disk, mcps from .mcp.json; generated project-owned
                           files excluded) and refresh exactly that - never adds, never removes.
                           Closed through stack-select.js when it is reachable next to this script,
                           so a dependency a new release introduced still installs. MCPs and
                           PLUGINS are refreshed to the newest versions: the pinned MCP entries are
                           re-resolved and re-registered, and every installed stack plugin gets
                           'claude plugin update'. Plugins come from 'claude plugin list' (machine-
                           level - no project dir to read), intersected with the manifest, so a
                           third-party plugin is never touched
  --print-plan             with --selection or --installed-only, print the resolved per-category install set and exit (dry run)
  --skills-only            run only the skill install/update step, then exit (testability; skips
                           prerequisites/plugins/mcps/hooks/agents/rules)
  --source <dir>           install FROM an existing claude-stack checkout instead of cloning one.
                           The caller owns <dir> - this script never deletes it. Used by the
                           /claude-stack setup+configure skills, which clone once and pass it here
                           so a guided run takes one clone, not two. Omit it and the script clones
                           its own source (and removes it on exit) - the standalone path.

Environment variables:
  SCOPE=project|global   fallback for --scope when the flag is absent (default project)
  CLAUDE_CONFIG_DIR      target a specific account when no --space is given (default ~/.claude)
  STACK_SKILLS_REPO      stack source repo (release-archive download, git-clone fallback; default https://github.com/envoydev/claude-stack); ignored with --source
  CONTEXT7_API_KEY       context7 API key, read from the ACCOUNT settings.json "env" (or the launch shell) at launch - higher
                         rate limits; unset = the keyless free tier
  CONTEXT7_BAKE_KEY      with --context7 local, bake CONTEXT7_API_KEY into the registration (keep .mcp.json uncommitted)
  SENTRY_SLUG            the Sentry org or org/project the sentry MCP URL is scoped to - lives in the ACCOUNT
                         settings.json "env" (seeded by --sentry-slug); unset = a literal \${SENTRY_SLUG} URL
                         that connects and then fails every call naming the variable (claude mcp list warns)
  SENTRY_ACCESS_TOKEN    --sentry-auth token (default): a sentry API token (Settings -> Account -> API ->
                         Personal Tokens, or an org token) - add it to the ACCOUNT settings.json "env"
                         yourself (or export it in the launch shell); never in .mcp.json (the registration
                         keeps \${SENTRY_ACCESS_TOKEN} literal), never in a project-level settings.json (does
                         not reach .mcp.json expansion). Not SENTRY_AUTH_TOKEN: that is sentry-cli's
                         release/symbol-upload credential (needs project:releases)

Examples:
  bash $0 install
  bash $0 install --space work --github-cli
  bash $0 update --scope global
USAGE
}

# -h/--help anywhere -> print full usage and exit 0, before the required-action check below.
for _a in "$@"; do case "$_a" in -h|--help) usage; exit 0 ;; esac; done

# 'install' or 'update' is REQUIRED - the one positional argument (the action). Everything after it is
# a named flag with a default (parsed below); shift the action off so $@ is just the flags.
ACTION="${1:-}"
case "$ACTION" in
  install|update) shift ;;
  help) usage; exit 0 ;;
  *) usage >&2; echo "error: first argument must be 'install' or 'update' (got '${ACTION:-<none>}')" >&2; exit 1 ;;
esac

# This script provisions the Claude Code agent. (The Cursor stack lives in the cursor-stack repo.)
AGENT="claude-code"

# Named flags (any order, each with a default): --space <name> (account ~/.claude-<name> +
# memory_<name>.db), --scope project|global, --context7 local|remote, --sentry-slug <slug>,
# --sentry-auth token|oauth, --github-cli (install gh), --keep-pins (preserve local model/effort pin
# edits across the refresh).
# Named-only: there is no positional space - a value must be attached to its flag, so a space can be
# literally any word (no reserved-word collisions with the flag names).
SPACE=""
SCOPE_FLAG=""
INSTALL_GITHUB_CLI=false
KEEP_PINS=false
CONTEXT7_MODE="remote"
SENTRY_SLUG_FLAG=""
SENTRY_AUTH_FLAG=""
SELECTION=""
INSTALLED_ONLY=false
PRINT_PLAN=false
SKILLS_ONLY=false
SOURCE_DIR=""
_flag_val() {  # $1 = flag name, $2 = the arg meant to be its value ('' when the flag was last)
  [ -n "$2" ] || { usage >&2; echo "error: $1 needs a value" >&2; exit 1; }
}
while [ $# -gt 0 ]; do
  case "$1" in
    --space)      _flag_val "$1" "${2:-}"; SPACE="$2";         shift 2 ;;
    --space=*)    SPACE="${1#*=}";                             shift ;;
    --scope)      _flag_val "$1" "${2:-}"; SCOPE_FLAG="$2";    shift 2 ;;
    --scope=*)    SCOPE_FLAG="${1#*=}";                        shift ;;
    --context7)   _flag_val "$1" "${2:-}"; CONTEXT7_MODE="$2"; shift 2 ;;
    --context7=*) CONTEXT7_MODE="${1#*=}";                     shift ;;
    --sentry-slug)  _flag_val "$1" "${2:-}"; SENTRY_SLUG_FLAG="$2"; shift 2 ;;
    --sentry-slug=*) SENTRY_SLUG_FLAG="${1#*=}";                   shift ;;
    --sentry-auth) _flag_val "$1" "${2:-}"; SENTRY_AUTH_FLAG="$2"; shift 2 ;;
    --sentry-auth=*) SENTRY_AUTH_FLAG="${1#*=}";                  shift ;;
    --github-cli) INSTALL_GITHUB_CLI=true;                     shift ;;
    --keep-pins)  KEEP_PINS=true;                              shift ;;
    --selection)   _flag_val "$1" "${2:-}"; SELECTION="$2";     shift 2 ;;
    --selection=*) SELECTION="${1#*=}";                          shift ;;
    --installed-only) INSTALLED_ONLY=true;                       shift ;;
    --print-plan)  PRINT_PLAN=true;                              shift ;;
    --skills-only) SKILLS_ONLY=true;                              shift ;;
    --source)      _flag_val "$1" "${2:-}"; SOURCE_DIR="$2";      shift 2 ;;
    --source=*)    SOURCE_DIR="${1#*=}";                          shift ;;
    *) usage >&2; echo "error: unknown argument '$1' (named flags only: --space, --scope, --context7, --sentry-slug, --sentry-auth, --github-cli, --keep-pins, --selection, --installed-only, --print-plan, --skills-only, --source)" >&2; exit 1 ;;
  esac
done

# Validate: --space is baked into a path (~/.claude-<space>, memory_<space>.db); --scope + --context7 are enums.
if [ -n "$SPACE" ]; then
  case "$SPACE" in
    [!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
      usage >&2; echo "error: --space '$SPACE' must start alphanumeric; chars [A-Za-z0-9._-]" >&2; exit 1 ;;
  esac
fi
# --scope flag wins, else the SCOPE env var, else project. Lower-case the two enums (NOT the space,
# whose casing is significant) so a non-canonical casing like 'Global'/'Remote' is accepted the same as
# on the case-insensitive PowerShell twin - printf|tr always exits 0, so this is set -e safe.
SCOPE="${SCOPE_FLAG:-${SCOPE:-project}}"
SCOPE="$(printf '%s' "$SCOPE" | tr '[:upper:]' '[:lower:]')"
CONTEXT7_MODE="$(printf '%s' "$CONTEXT7_MODE" | tr '[:upper:]' '[:lower:]')"
case "$SCOPE" in project|global) ;;
  *) usage >&2; echo "error: --scope must be 'project' or 'global' (got '$SCOPE')" >&2; exit 1 ;;
esac
case "$CONTEXT7_MODE" in local|remote) ;;
  *) usage >&2; echo "error: --context7 must be 'local' or 'remote' (got '$CONTEXT7_MODE')" >&2; exit 1 ;;
esac
# --sentry-auth: lower-cased like the other enums; empty means 'resolve later' - token on install, the
# existing registration's mode on update (the sentry block below). --sentry-slug is seeded into the
# account settings.json "env" and lands inside a URL at launch, so only slug characters: `org` or
# `org/project`; empty = leave the env alone.
SENTRY_AUTH="$(printf '%s' "$SENTRY_AUTH_FLAG" | tr '[:upper:]' '[:lower:]')"
case "$SENTRY_AUTH" in ""|token|oauth) ;;
  *) usage >&2; echo "error: --sentry-auth must be 'token' or 'oauth' (got '$SENTRY_AUTH')" >&2; exit 1 ;;
esac
SENTRY_SLUG="$SENTRY_SLUG_FLAG"
_sentry_slug_ok() {  # $1 = candidate: <org> or <org>/<project>, slug characters only (it lands inside a URL)
  case "$1" in ""|[!A-Za-z0-9]*|*[!A-Za-z0-9._/-]*|*/|*//*) return 1 ;; esac; return 0
}
if [ -n "$SENTRY_SLUG" ] && ! _sentry_slug_ok "$SENTRY_SLUG"; then
  usage >&2; echo "error: --sentry-slug '$SENTRY_SLUG' must be a slug (<org> or <org>/<project>; chars [A-Za-z0-9._-])" >&2; exit 1
fi
# --installed-only refreshes an EXISTING install from disk - meaningless on a first install, and
# --selection is the explicit alternative to deriving one; the two cannot both decide the set.
if [ "$INSTALLED_ONLY" = true ]; then
  [ "$ACTION" = "update" ] || { usage >&2; echo "error: --installed-only is an update flag (got action '$ACTION')" >&2; exit 1; }
  [ -z "$SELECTION" ] || { usage >&2; echo "error: --installed-only and --selection are mutually exclusive - one source of the set" >&2; exit 1; }
fi
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

# Run-outcome tracking for the honest end-of-run summary.
FAIL_COUNT=0            # item install/add failures (skills / plugins / mcps)
CLAUDE_MISSING=false    # claude CLI absent -> plugins / MCPs / settings.json wiring skipped
PREREQ_MISSING=false    # a hard prerequisite (uvx / python3 / node) was missing
note_failure() { FAIL_COUNT=$((FAIL_COUNT + 1)); log "  !! $*"; }

prerequisites_check() {
  # Warn (not fail) on missing prerequisites, matching the script's fail-soft philosophy.
  log "prerequisites check"
  local ok=true
  if command -v uvx >/dev/null 2>&1; then
    printf '  uvx: %s\n' "$(uvx --version 2>&1 | head -1)"
  else
    echo "  !! uvx not found - serena and memory MCPs will not work." >&2
    echo "     Install: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    ok=false
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '  python3: %s\n' "$(command -v python3)"
  else
    echo "  !! python3 not found - the security-guidance hook and the settings.json wiring will fail." >&2
    ok=false
  fi
  # node: required by Claude Code, the convention hooks, and npx-based MCPs. Below 22.12 LTS some
  # MCPs (chrome-devtools) refuse to start and die at launch with a generic JSON-RPC -32000.
  if command -v node >/dev/null 2>&1; then
    node_ver="$(node -v 2>/dev/null | sed 's/^v//')"
    node_major="${node_ver%%.*}"; node_rest="${node_ver#*.}"; node_minor="${node_rest%%.*}"
    case "$node_major" in (*[!0-9]*|'') node_major=0 ;; esac
    case "$node_minor" in (*[!0-9]*|'') node_minor=0 ;; esac
    if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
      echo "  !! node $node_ver - recommend Node >= 22.12 LTS. chrome-devtools (and some npx MCPs)" >&2
      echo "     require it; an older Node makes them die at launch with a generic JSON-RPC -32000." >&2
    else
      printf '  node: %s\n' "$node_ver"
    fi
  else
    echo "  !! node not found - Claude Code, the convention hooks, and npx-based MCPs need it." >&2
    ok=false
  fi
  # csharp-ls: the csharp-lsp plugin shells out to it for Roslyn diagnostics. Off $PATH and the
  # plugin dies at launch with "Executable not found in $PATH". Needed only for C# work, so warn.
  if command -v csharp-ls >/dev/null 2>&1; then
    printf '  csharp-ls: %s\n' "$(command -v csharp-ls)"
  else
    echo "  !! csharp-ls not found - the csharp-lsp plugin needs it (C# work only)." >&2
    echo "     Install: dotnet tool install --global csharp-ls (needs the .NET SDK + ~/.dotnet/tools on PATH)." >&2
  fi
  # typescript-language-server: the typescript-lsp plugin shells out to it via a bare-name $PATH
  # lookup (a SEPARATE npm package from typescript/tsserver). Off $PATH -> the plugin dies at launch
  # with "Executable not found in $PATH". Needed for TS/JS work, so warn (the plugin self-scopes).
  if command -v typescript-language-server >/dev/null 2>&1; then
    printf '  typescript-language-server: %s\n' "$(command -v typescript-language-server)"
  else
    echo "  !! typescript-language-server not found - the typescript-lsp plugin needs it (TS/JS work)." >&2
    echo "     Install: npm i -g typescript-language-server typescript (nvm scopes globals per node version; add both to ~/.nvm/default-packages to cover future versions)." >&2
  fi
  # claude CLI: the core dependency for plugins, MCPs, and settings.json wiring. Absent -> those steps
  # are skipped (fail-soft); flag it upfront so the user can fix PATH before the long skill install runs.
  if command -v claude >/dev/null 2>&1; then
    printf '  claude: %s\n' "$(command -v claude)"
  else
    echo "  !! claude CLI not found - plugins, MCPs, and settings.json wiring will be SKIPPED." >&2
    echo "     Install: https://docs.claude.com/claude-code (then re-run to add plugins/MCPs)." >&2
    CLAUDE_MISSING=true
  fi
  if ! $ok; then PREREQ_MISSING=true; echo "  Install the missing tools above, then re-run." >&2; fi
}

install_github_cli() {  # opt-in via the 'github-cli' extra; fail-soft like everything else
  $INSTALL_GITHUB_CLI || return 0
  if command -v gh >/dev/null 2>&1; then
    log "github-cli: gh already installed ($(gh --version 2>/dev/null | head -1)) - skipping install"
  elif command -v brew >/dev/null 2>&1; then
    log "github-cli: installing gh via Homebrew"
    brew install gh || { echo "  !! brew install gh failed - install manually: https://cli.github.com" >&2; return 0; }
    # No auth during install (deliberate): run `gh auth login` once before the first GitHub
    # platform use (PRs/issues). Plain git push/pull never needs it.
    log "  installed - run 'gh auth login' before first GitHub platform use"
  else
    echo "  !! brew not found - install Homebrew or gh manually: https://cli.github.com" >&2
  fi
}

# CONFIG_DIR is for path resolution only and is normally NOT exported - EXCEPT when a space is given:
# a space (any word) selects the Claude account ~/.claude-<space> and IS exported so the claude CLI
# (skills/plugins/mcp) installs into it. Without a space, CLAUDE_CONFIG_DIR (a specific account you
# set yourself, e.g. ~/.claude-work) or the ~/.claude default is used and never exported.
if [ -n "$SPACE" ]; then
  CONFIG_DIR="$HOME/.claude-$SPACE"
  # Distinguish an existing account from a brand-new one so a typo'd space ('wrok') is visible, not silent.
  if [ -d "$CONFIG_DIR" ]; then
    log "space '$SPACE' -> existing account $CONFIG_DIR (CLAUDE_CONFIG_DIR exported for the claude CLI); memory DB memory_$SPACE.db."
  else
    log "space '$SPACE' -> creating NEW account $CONFIG_DIR (typo? did you mean an existing one?); memory DB memory_$SPACE.db."
  fi
  [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "${CLAUDE_CONFIG_DIR}" != "$CONFIG_DIR" ] && \
    log "space '$SPACE' overrides CLAUDE_CONFIG_DIR ($CLAUDE_CONFIG_DIR)."
  export CLAUDE_CONFIG_DIR="$CONFIG_DIR"
else
  CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  if [ -z "${CLAUDE_CONFIG_DIR:-}" ]; then
    log "CLAUDE_CONFIG_DIR not set - using the claude CLI default account; resolving config paths to $CONFIG_DIR."
  fi
fi

SERENA_CTX="claude-code"   # serena's --context for Claude Code

# Shared memory root - always resolved at install time to a fixed home path, so a Cursor install on
# the same machine points to the same DB.
HOME_MEMORY_DIR="$HOME/.memory-mcp"

if [ "$SCOPE" = "project" ]; then
  cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
  CLAUDE_SCOPE="project"
else
  CLAUDE_SCOPE="user"
fi

# ===========================================================================
# MANIFEST - edit these, then run.
# ===========================================================================

# (1) Skills, one per line as "repo|skill" (comment a line to skip it).
SKILLS=(
  # House (envoydev/claude-stack)
  "envoydev/claude-stack|create-ticket"             # ticket generator (bug/story/epic/task) - tracker-agnostic EN Markdown, routes to references/<type>.md
  "envoydev/claude-stack|dev-log-convert"           # UA/EN work notes -> structured English work log; trigger 'dev-log'
  "envoydev/claude-stack|explain-code-tutor"        # senior-mentor explainer for code/bug/concept/trade-off via real-file walkthrough; depth ELI5/intermediate/expert
  "envoydev/claude-stack|project-quality-loop"             # autonomous review-and-fix loop pipeline over a loops/ folder of numbered prompts
  "envoydev/claude-stack|project-architecture-quality-loop"        # deliberate analyze-assess-improve loop - the project-architecture-analyzer capture writes ARCHITECTURE.md + ASSESSMENT.md, fix cons by tier, reconcile docs; manual /-only
  "envoydev/claude-stack|project-code-style-analyzer"    # deliberate code-style capture - fans out code-style-analyzer per language, merges docs/PROJECT-CODE-STYLE.md, generates + wires the inject-code-style hook; manual /-only
  "envoydev/claude-stack|project-architecture-analyzer"  # deliberate architecture capture - dispatches architecture-analyzer per module, reasons in the main session, writes docs/architecture/ARCHITECTURE.md + ASSESSMENT.md + the generated awareness rule baseline-project-architecture.md; manual /-only
  "envoydev/claude-stack|project-test-coverage-analyzer" # deliberate coverage capture - detect tooling per surface, instrumented run ONCE per surface in the main session, writes docs/test-coverage/COVERAGE.md (90% line after exclusions default, tiered weak points) + raw/ machine-readable results; manual /-only (the loop Read-loads it)
  "envoydev/claude-stack|project-test-coverage-loop"     # deliberate coverage analyze-triage-fix loop - runs the capture, works weak points by tier (tests inline/implementer briefs, testability refactors approval-gated, structural = user decision), reconciles docs; manual /-only
  "envoydev/claude-stack|project-version-upgrade"        # deliberate BREAKING version-event flow (framework/runtime/package major) - plan in-session via context7 + architecture-analyzer digests, approval gate (auto mode only on explicit user ask), staged execution via implementers + resolvers; manual /-only
  "envoydev/claude-stack|project-agent-capabilities"           # deliberate capabilities capture - inventories installed skills/agents/MCPs/plugins, generates the awareness rule baseline-project-agent-capabilities.md; manual /-only
  "envoydev/claude-stack|project-related-context"        # deliberate related-projects capture - args paths/URLs, fans out related-project-analyzer per sibling, writes the awareness rule baseline-project-related-context.md + docs/related-context/PROJECT-RELATED-CONTEXT.md; manual /-only
  "envoydev/claude-stack|project-build-from-scratch" # greenfield scaffolding + design->scaffold->slice-by-slice build orchestration over the pipeline
  "envoydev/claude-stack|project-solve-cross-task"    # entry-point router: classify -> smallest execution mode -> cross-domain contract freeze + integration gate; home of the shared subagent policies
  "envoydev/claude-stack|project-verify-plan"      # audit an implementation plan BEFORE building - risk-coverage review (traps named per the stack skill, scope, edges, minimal); precedes /code-review
  "envoydev/claude-stack|project-verify-code"     # single-chat, no-dispatch review of an assembled build - the inline alternative to /code-review: rerun build/test, gate vs plan, RUN the app on failable inputs, trace wire-contract changes to consumers, ranked punch-list
  "envoydev/claude-stack|project-implementer"              # single-chat build step: execute a verified plan task-by-task (contracts + per-task green gate + inline red-resolution, no dispatch), finish via /code-review + the done-gate
  "envoydev/claude-stack|project-solution-design"  # single-chat designer twin: read the architecture, judge where a change fits (extend/refactor/isolate), load the stack skill for traps, decompose into an ordered plan; feeds project-verify-plan
  "envoydev/claude-stack|project-solve-task"       # gated single-chat vertical: design -> plan audit -> user approval + build mode -> build -> build review (skippable: project-verify-code inline or the verifier seat) -> done-gate; hard user stop between steps, plan-file + serena-note state survives compaction
  "envoydev/claude-stack|project-diagnose-failure" # gated single-chat investigation: triage evidence to a tier -> gather (evidence-gatherer seats or inline) -> prove root cause -> user fork (report / contracted fix tasks / log-points card); read-only, any evidence source incl. none but a client report
  "envoydev/claude-stack|project-runtime-failure-signatures" # single-chat diagnoser twin: local-runtime crash signatures (null-ref/DI/deadlock/disposed/config-drift/boundary/HTTP-status) -> where to isolate each; pairs with systematic-debugging
  "envoydev/claude-stack|project-ci-failure-signatures"        # single-chat CI-diagnoser twin: red-pipeline signatures (compile/restore, green-locally-red-on-runner, quality-gate, signing/release, workflow-config, infra-flake) -> code-vs-environment call + route; pairs with project-runtime-failure-signatures
  "envoydev/claude-stack|project-stack-usage-analyzer" # token/tool usage audit of stack skill runs: transcript hunt -> analyze-usage.js per session -> per-session report + raw data under <docs-path>/claude-stack-usage-report/
  "envoydev/claude-stack|devops"           # DevOps for the .NET/Angular house: Docker multi-stage/digest-pinned/non-root, GitHub Actions CI/CD, safe expand-contract deploys, secrets/OIDC, Aspire AppHost
  "envoydev/claude-stack|database-conventions" # cross-engine DB conventions + per-engine skill routing
  "envoydev/claude-stack|database-security"    # SQL/data-layer security: parameterized-only injection, least-privilege DB accounts, row-level security, connection-string secrets, encryption, audit
  "envoydev/claude-stack|typescript"       # framework-agnostic TS/JS baseline (strict typing, modules, async, JS+JSDoc)
  "envoydev/claude-stack|javascript"       # base JS-family language layer: ESM modules, async discipline, two failure channels, modern-feature adoption, untrusted input, naming; typescript stacks on it
  "envoydev/claude-stack|ts-js-testing" # plain TS/JS testing hub: runner routing (Vitest default), role-keyed strategy, seam stubs over module mocks, exclusion catalog - practices only, the % bar is user-set via project-test-coverage-analyzer
  "envoydev/claude-stack|npm"                 # professional npm: lockfile+ci discipline, supply-chain baseline (ignore-scripts/cooldown/allow-git), audit gating, overrides vs legacy-peer-deps, exports maps + ESM-first publishing, update-bot cooldowns
  "envoydev/claude-stack|browser-extension"    # MV3 browser extensions: ephemeral service worker + storage tiers, typed cross-context messaging, isolated vs MAIN world, least-privilege permissions, CSP-safe UI, WXT tooling, store review + monetization
  "envoydev/claude-stack|webpack"             # webpack 5 library builds: transpile/type-check split (swc + fork-ts-checker + tsc declarations), externals from package.json, tree-shaking preconditions, ESM output state, resolution traps, config factory + cache pitfalls
  "envoydev/claude-stack|angular-conventions" # Angular 17+/TS house conventions (signals, OnPush, a11y)
  "envoydev/claude-stack|angular-testing"  # Angular testing hub: TestBed/harness patterns, runner routing, exclusion catalog - practices only, the % bar is user-set via project-test-coverage-analyzer
  "envoydev/claude-stack|angular-material"   # Angular Material + CDK: selective imports, M3 theming, CDK primitives, harnesses
  "envoydev/claude-stack|angular-styling"    # Angular CSS/styling: ViewEncapsulation, :host, ::ng-deep ways-out, design tokens, responsive, a11y styling
  "envoydev/claude-stack|angular-security"   # Angular/web frontend security: XSS/DomSanitizer bypass, CSP, CSRF, no-secrets-in-bundle, token storage, SSR/TransferState
  "envoydev/claude-stack|frontend"         # web frontend router: Angular/TS + in-skill design-quality guidance -> mobile
  "envoydev/claude-stack|mobile"           # Ionic/Capacitor router/index over the Angular (angular-conventions) + TypeScript baselines
  "envoydev/claude-stack|ionic"            # house Ionic/Capacitor conventions: UI, nav, lifecycle, permissions, plugin sourcing + wrapping
  "envoydev/claude-stack|capacitor-release" # Ionic/Capacitor release pipeline: cap sync/build, iOS+Android signing, store submission, OTA, versioning, CI, symbols
  "envoydev/claude-stack|ionic-security"   # Ionic/Capacitor mobile security: Keychain/Keystore storage, deep-link validation, permissions, cleartext/WebView hardening
  "envoydev/claude-stack|csharp"           # C# house conventions - style, naming, async, logging, DI
  "envoydev/claude-stack|csharp-design-patterns" # all 23 GoF patterns with modern .NET 8+ forms
  "envoydev/claude-stack|dotnet"           # router mapping .NET work areas to specialist skills
  "envoydev/claude-stack|dotnet-architecture-tests" # architecture fitness tests: NetArchTest (default)/ArchUnitNET - layer+dependency+naming+isolation rules as build-failing tests
  "envoydev/claude-stack|dotnet-aspire"    # .NET Aspire local orchestration: AppHost, ServiceDefaults, service discovery, dashboard
  "envoydev/claude-stack|dotnet-authentication" # ASP.NET Core authn/authz: JWT/OIDC/Identity, policy-based authz, secrets
  "envoydev/claude-stack|dotnet-code-quality" # C# quality enforcement: CSharpier formatter ownership, SDK analyzers + AnalysisLevel, .editorconfig severity, TreatWarningsAsErrors (+ legacy batch promotion), Roslynator, CI gate
  "envoydev/claude-stack|dotnet-console-apps" # console-app interface surface: CLI arg parsing (System.CommandLine 2.0/Spectre.Console.Cli/Cocona) + bot-SDK integration (Telegram/Discord/Slack/exchange) in a BackgroundService
  "envoydev/claude-stack|dotnet-cryptography" # System.Security.Cryptography: SHA-2, AES-GCM, RSA/ECDSA, PBKDF2/Argon2id, constant-time compare
  "envoydev/claude-stack|dotnet-web-error-handling" # Result + ProblemDetails (RFC 9457) + IExceptionHandler + FluentValidation
  "envoydev/claude-stack|dotnet-grpc"      # gRPC: .proto/codegen, ASP.NET Core host, 4 streaming modes, JWT/mTLS, interceptors, health
  "envoydev/claude-stack|dotnet-hosted-services" # worker/background-service host: BackgroundService, ExecuteAsync trap, scoped scope, PeriodicTimer, shutdown, Channels
  "envoydev/claude-stack|dotnet-windows-service" # Windows Service SCM layer: AddWindowsService, budgets, non-zero-exit recovery, sc.exe install, gMSA/hardening, ServiceBase maintenance
  "envoydev/claude-stack|dotnet-messaging" # event-driven messaging: Wolverine (MIT)/MassTransit, outbox, sagas, RabbitMQ/Azure SB
  "envoydev/claude-stack|dotnet-migrate"   # safe migration workflow: EF schema, .NET upgrades, NuGet - rollback + verify per step
  "envoydev/claude-stack|dotnet-minimal-api" # minimal API endpoint mechanics: MapGroup, TypedResults, endpoint filters, binding
  "envoydev/claude-stack|dotnet-mvc-controllers" # controller-based Web API: [ApiController], attribute routing, ActionResult<T>, auto-400 filter, action filters, binding
  "envoydev/claude-stack|dotnet-openapi"   # OpenAPI doc (Swashbuckle / built-in .NET 9+) + Scalar docs UI
  "envoydev/claude-stack|dotnet-realtime"  # SignalR real-time: strongly-typed Hub<T>, IHubContext push, groups/presence, reconnection, JWT-over-querystring, Redis/Azure backplane
  "envoydev/claude-stack|dotnet-security"  # OWASP Top 10 (2021) -> .NET 8 mitigations; deprecated-pattern warnings
  "envoydev/claude-stack|dotnet-source-generators" # Roslyn IIncrementalGenerator authoring + built-in generators (GeneratedRegex/LoggerMessage/STJ)
  "envoydev/claude-stack|dotnet-testing"   # .NET test strategy: AAA, per-layer coverage, library routing
  "envoydev/claude-stack|dotnet-web-backend" # ASP.NET Core cross-cutting: HttpClientFactory, OpenAPI, observability
  "envoydev/claude-stack|dotnet-winforms"  # WinForms conventions: MVP/binding, disposal, GDI leaks, high-DPI, migration
  "envoydev/claude-stack|dotnet-wpf"       # WPF strict-MVVM conventions, bindings, virtualization
  "envoydev/claude-stack|postgres"         # PostgreSQL engine delta: index types, JSONB, SARGability, EXPLAIN, pooling
  "envoydev/claude-stack|sqlite"           # SQLite engine delta: WAL/single-writer, PRAGMAs, type affinity, limited ALTER
  "envoydev/claude-stack|dotnet-data-access" # EF Core + NHibernate ORM hub (references/): DbContext, tracking, N+1, projection
  "envoydev/claude-stack|dotnet-architecture" # architecture decision hub (references/): clean/ddd/vsa/modular/microservices
  "envoydev/claude-stack|markdown-style" # Markdown authoring / review: syntax canon (valid) + house style overlay, two-pass procedure
  "envoydev/claude-stack|docs-as-code" # docs-as-code authoring: Mermaid sequence/ER diagrams, ADRs (Nygard/MADR 4), C4 views - per-type references/
  "envoydev/claude-stack|ilspy-decompile" # decompile a .NET assembly (ilspycmd via dnx) to read real API/behavior - framework internals, NuGet source, pre-upgrade checks
  "envoydev/claude-stack|dotnet-project-setup" # .NET solution build spine (hub, references/): src/tests layout, .slnx, Directory.Build.props, global.json, central package management, dotnet-tool pinning
  "envoydev/claude-stack|dotnet-performance" # perf-aware .NET design (hub, references/): allocation/type design (struct vs class, Span, ValueTask) + serialization-format choice (STJ source-gen / Protobuf / MessagePack)
  "envoydev/claude-stack|dotnet-diagnostics" # measure/diagnose a live .NET process (hub, references/): BenchmarkDotNet microbenchmarks + crash/hang/OOM dump capture & first-look SOS analysis
  "envoydev/claude-stack|nx"               # Nx monorepo: project-graph nav + 'nx affected' scoping, generators, module-boundary tags; CLI over MCP; serena-vs-nx routing
)

# (2) Plugins "<plugin>@<marketplace>" (non-default marketplaces added first).
EXTRA_MARKETPLACES=(
  "jarrodwatts/claude-hud"
  "DietrichGebert/ponytail"
)
PLUGINS=(
  "superpowers@claude-plugins-official"       # workflow skills: plan, TDD, debug, verify-before-done
  "claude-md-management@claude-plugins-official" # audit + revise CLAUDE.md files
  "csharp-lsp@claude-plugins-official"      # inline Roslyn diagnostics on edit (complements serena nav); needs csharp-ls (dotnet tool install -g csharp-ls)
  "typescript-lsp@claude-plugins-official"  # same for Angular/TS work
  "security-guidance@claude-plugins-official" # security hooks: pattern warnings + LLM diff review on Stop/commit
  "claude-hud@claude-hud"                       # statusline HUD (global/user scope)
  "ponytail@ponytail"                           # 'lazy senior dev' decision ladder: minimal-code default, cuts generated code/latency/cost
)

# (3) MCP servers as "name|args"; scope follows SCOPE.
#     @SERENA_CONTEXT@   -> resolved at install time to claude-code.
#     @HOME_MEMORY_DIR@  -> resolved at install time to ~/.memory-mcp (shared with any Cursor install on the box).
#     \${CLAUDE_PROJECT_DIR:-.} stays LITERAL so Claude Code interpolates it at server launch.
#     memory (mcp-memory-service): a space (e.g. 'work') switches to memory_<space>.db.
#
# PERFORMANCE - network resolution is the cost of a slow new-session start, so it happens HERE
# (install/update), never at launch:
#   - install/update resolves each runtime's LATEST published version (below) and bakes it into the
#     registration. `install` SKIPS MCPs already registered, so the resolved version stays FROZEN
#     until you run `update` (which removes + re-adds -> re-resolves -> bumps). No versions are
#     hardcoded in this script - "latest at provision, frozen until next update".
#   - launch is fast because versions are PINNED (npx skips dist-tag resolution; uvx reuses its
#     cached env). Do NOT add --prefer-offline: with a freshly-resolved latest version, a stale npm
#     cache index reports "no matching version" and the server dies (-32000). The pin alone is the
#     speed-up; npx fetches the exact version once if the cache lacks it, then reuses it.
#   - serena runs from the pinned PyPI package (NOT git+https, which re-fetched the ref on every
#     launch - the biggest startup cost), web dashboard off (no HTTP server spun up).
#   - memory: --with numpy is injected because mcp-memory-service's sqlite_vec backend needs numpy
#     but doesn't declare it, so uvx's isolated env omits it -> "No module named 'numpy'" (-32000).
#   - offline at provision -> resolution yields empty -> the entry falls back to unpinned.
# Bounded fetches (npm_config_fetch_timeout / curl --max-time) so a dead network fails fast to the
# unpinned fallback instead of hanging on a single silent line.
_npm_latest()  { command -v npm >/dev/null 2>&1 && npm_config_fetch_timeout=15000 npm view "$1" version 2>/dev/null | tr -d '[:space:]'; }
_pypi_latest() { curl -fsSL --max-time 15 "https://pypi.org/pypi/$1/json" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['info']['version'])" 2>/dev/null; }
log "resolving latest MCP runtime versions (install/update network step)"
# '|| true' is REQUIRED: under `set -e` a failing command substitution (offline, or npm/curl/python3
# absent) aborts the whole run - these must fall through to empty -> unpinned, per the design above.
MCP_CONTEXT7_VER="$(_npm_latest @upstash/context7-mcp)" || true
MCP_PLAYWRIGHT_VER="$(_npm_latest @playwright/mcp)" || true
MCP_SERENA_VER="$(_pypi_latest serena-agent)" || true
MCP_MEMORY_VER="$(_pypi_latest mcp-memory-service)" || true
# Version-pin suffix: "@1.2.3" when resolved, "" (unpinned fallback) when offline.
CTX7_PIN="${MCP_CONTEXT7_VER:+@$MCP_CONTEXT7_VER}"
PW_PIN="${MCP_PLAYWRIGHT_VER:+@$MCP_PLAYWRIGHT_VER}"
SERENA_PIN="${MCP_SERENA_VER:+@$MCP_SERENA_VER}"
MEMORY_PIN="${MCP_MEMORY_VER:+@$MCP_MEMORY_VER}"
# Report what pinned vs. fell back to unpinned - the whole point of this step is 'frozen until update'.
for _pv in "context7:$MCP_CONTEXT7_VER" "playwright:$MCP_PLAYWRIGHT_VER" "serena:$MCP_SERENA_VER" "memory:$MCP_MEMORY_VER"; do
  _pn="${_pv%%:*}"; _pver="${_pv#*:}"
  if [ -n "$_pver" ]; then log "  pinned $_pn@$_pver"
  else log "  !! could not resolve $_pn latest - installing unpinned (re-run when online to pin it)"; fi
done

MEMORY_BACKEND="sqlite_vec"; MEMORY_DB_FILE="memory.db"
if [ -n "$SPACE" ]; then MEMORY_DB_FILE="memory_$SPACE.db"; fi  # space -> per-space DB; backend stays sqlite_vec (the only valid local backend)
MEMORY_ENTRY="memory|-e MCP_MEMORY_STORAGE_BACKEND=$MEMORY_BACKEND -e MCP_MEMORY_SQLITE_PATH=@HOME_MEMORY_DIR@/$MEMORY_DB_FILE -- uvx --with numpy --from mcp-memory-service${MEMORY_PIN} memory server"

# context7 runs REMOTE (the hosted server) by DEFAULT - no local process, and the key stays out of
# the registration: put CONTEXT7_API_KEY in the ACCOUNT settings.json "env" (<account>/settings.json -
# ~/.claude or the space's dir; or export it in the launch shell) and Claude Code expands
# ${CONTEXT7_API_KEY} in the header at launch, so .mcp.json holds no secret. A PROJECT-level
# .claude/settings.json or settings.local.json "env" value does NOT reach .mcp.json expansion (measured:
# it stays literal; it reaches only the MCP child process environment). Pass --context7 local for the local stdio server instead - keyless by default too,
# and CONTEXT7_BAKE_KEY=1 (with CONTEXT7_API_KEY) bakes --api-key into <repo>/.mcp.json (keep it uncommitted).
CONTEXT7_REMOTE_URL='https://mcp.context7.com/mcp'
CONTEXT7_REMOTE_HDR='CONTEXT7_API_KEY: ${CONTEXT7_API_KEY:-}'   # :- so an unset key sends an EMPTY header = keyless free tier (measured: a literal ${CONTEXT7_API_KEY} is rejected as an invalid key on every call, an empty value passes)

# sentry runs REMOTE only (the hosted MCP at mcp.sentry.dev) - no local process, no pin to resolve.
# The registration is CONSTANT and reads two values from the ACCOUNT settings.json "env" at launch
# (<account>/settings.json - ~/.claude or the space's dir; the launch shell works too; a project-level
# .claude/settings.json does NOT reach .mcp.json expansion - measured, it stays literal):
#   SENTRY_SLUG          -> https://mcp.sentry.dev/mcp/${SENTRY_SLUG} (org, or org/project - Sentry's
#                           recommended scoping; --sentry-slug seeds it)
#   SENTRY_ACCESS_TOKEN  -> `Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}` under --sentry-auth
#                           token (default) - Sentry's documented direct-token mode for a personal/org API
#                           token; plain `Bearer` is the server's OAuth-issued token scheme and rejects an
#                           API token as invalid_token (measured: AUTH_HEADER_REJECTED / 401 under it)
# --sentry-auth oauth registers NO header instead, so Claude Code runs Sentry's browser consent flow on
# first connect - a set-but-wrong header disables that fallback, which is why the modes never mix.
# Why placeholders and not baked values: both values belong to the account, not the file, and the
# guided commands make the user fill them in. Unset, `${SENTRY_SLUG}` stays literal - the server
# accepts that path on tools/list and fails every call naming the variable, and `claude mcp list`
# prints 'Missing environment variables' - a diagnosable state, unlike `${SENTRY_SLUG:-}`, whose
# trailing slash the server 404s (both measured).
# update: --sentry-auth absent keeps the mode the existing registration carries (read back through
# `claude mcp get sentry`); an old plain-`Bearer` registration migrates to the fixed token header.
if [ "$ACTION" = "update" ] && [ -z "$SENTRY_AUTH" ] && command -v claude >/dev/null 2>&1; then
  _sentry_get="$(claude mcp get sentry 2>/dev/null || true)"
  if printf '%s\n' "$_sentry_get" | grep -q '^ *URL: https://mcp\.sentry\.dev/' && ! printf '%s\n' "$_sentry_get" | grep -q '^ *Authorization: '; then
    SENTRY_AUTH="oauth"   # a deliberately headerless registration stays headerless
  fi
fi
[ -n "$SENTRY_AUTH" ] || SENTRY_AUTH="token"
SENTRY_REMOTE_URL='https://mcp.sentry.dev/mcp/${SENTRY_SLUG}'
SENTRY_REMOTE_HDR='Authorization: Sentry-Bearer ${SENTRY_ACCESS_TOKEN}'
[ "$SENTRY_AUTH" = "oauth" ] && SENTRY_REMOTE_HDR=""
seed_account_env() {  # $1 = KEY $2 = VALUE - write env.KEY into the ACCOUNT settings.json (the file .mcp.json expansion reads); overwrite - a flag is explicit
  local settings="$CONFIG_DIR/settings.json"
  mkdir -p "$CONFIG_DIR"
  node -e '
const fs=require("fs");const [p,k,v]=process.argv.slice(1);
let d={};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){if(e.code!=="ENOENT")throw e}
d.env=d.env||{};const before=d.env[k];d.env[k]=v;
fs.writeFileSync(p,JSON.stringify(d,null,2)+"\n");
console.log(before===v?`  ${k} already ${v} in ${p}`:`  ${k}=${v} written to ${p} env`);
' "$settings" "$1" "$2" || note_failure "could not write $1 into $settings"
}
if [ "$CONTEXT7_MODE" = "local" ]; then
  CONTEXT7_SPEC="-- npx -y @upstash/context7-mcp${CTX7_PIN}"
  if [ -n "${CONTEXT7_BAKE_KEY:-}" ] && [ -n "${CONTEXT7_API_KEY:-}" ]; then
    CONTEXT7_SPEC="$CONTEXT7_SPEC --api-key $CONTEXT7_API_KEY"
    log "  !! baking CONTEXT7_API_KEY into the context7 registration; at project scope it lands in <repo>/.mcp.json - keep .mcp.json uncommitted (or use --context7 remote to keep the key out of the file)."
  fi
else
  CONTEXT7_SPEC="@HTTP@"
  if [ -n "${CONTEXT7_BAKE_KEY:-}" ]; then
    log "  !! CONTEXT7_BAKE_KEY is set but context7 is remote - it is ignored; pass --context7 local to bake, or add CONTEXT7_API_KEY to settings.json 'env'."
  fi
fi
CONTEXT7_ENTRY="context7|$CONTEXT7_SPEC"

MCPS=(
  "angular-cli|-- npx -y @angular/cli mcp" # angular-cli: only for Angular workspaces - comment out elsewhere (unpinned: matches the workspace ng).
  "serena|-e SERENA_HOME=.serena/home -- uvx --from serena-agent${SERENA_PIN} serena start-mcp-server --context @SERENA_CONTEXT@ --enable-web-dashboard false --project-from-cwd" # LSP symbol navigation; per-project SERENA_HOME (.serena/home - gitignore it, holds ~327MB LSP) isolates serena's registry/memories/logs/LSP, no pooling across projects/accounts; --project-from-cwd self-activates the repo (.serena/project.yml in cwd) on launch; PyPI (not git), dashboard off
  "playwright|-- npx -y @playwright/mcp${PW_PIN} --user-data-dir \${CLAUDE_PROJECT_DIR:-.}/.playwright --output-dir \${CLAUDE_PROJECT_DIR:-.}/.playwright/output" # drive a real browser for visual checks / web app verification
  "chrome-devtools|-- npx -y chrome-devtools-mcp@latest" # OPT-IN browser/extension debug; drives a full Chrome (heavy) - comment out outside web projects; no WS-frame payloads; pin a version
  "appium-mcp|-- npx -y appium-mcp@latest" # OPT-IN native mobile E2E (official Appium MCP); embedded UiAutomator2/XCUITest drivers, needs Xcode and/or Android SDK + Java (heavy) - comment out outside Capacitor/Ionic mobile projects; pin a version
  "sentry|@HTTP@" # OPT-IN Sentry error monitoring - hosted remote MCP (mcp.sentry.dev/mcp/${SENTRY_SLUG} - SENTRY_SLUG + SENTRY_ACCESS_TOKEN live in the ACCOUNT settings.json "env", expanded at launch; --sentry-slug seeds the slug); --sentry-auth token (default) sends `Sentry-Bearer ${SENTRY_ACCESS_TOKEN}`, oauth registers no header; comment out where the project has no Sentry
  "$MEMORY_ENTRY"  # memory: cross-project recall - the subagent handoff runs on serena; comment out in a standalone project
  "$CONTEXT7_ENTRY"                           # up-to-date library/framework/SDK docs (beats recalled API knowledge)
)

# (4) Hooks (claude-code): copied into the repo from the run's source snapshot (stack/hooks/) on BOTH
# actions (per-hook fail-soft - a hook not yet upstream keeps its committed repo copy); on INSTALL each is
# also wired into .claude/settings.json. UPDATE refreshes the files and re-ensures the wiring (idempotent).
# Each entry: "filename::matcher::args" - args (if any) are appended to the hook command.
HOOKS=(
  "guard-protected-force-push.js::Bash::"         # block force-push to main/master/develop
  "guard-catastrophic-rm.js::Bash::"              # block recursive rm of /, ~, $HOME, the cwd or its parent (. / ..), a bare *, or several top-level dirs at once
  "guard-read-whole-file.js::Read::"              # block whole-file Read of a >200-line source file - locate via serena first; caps cumulative half-split reconstruction
  "guard-read-whole-file.js::Bash::"              # same gate on Bash: a bare `cat file.ts` of a large source file is the Read block routed through the shell
  "guard-unapproved-dispatch.js::Task|Agent::"    # block *-implementer dispatch without the docs-root flow/APPROVAL gate file (APPROVED/AUTO)
  "guard-ungated-commit.js::Bash::"               # block a non-trivial git commit without the docs-root flow/COMMIT-GATE receipt (VERIFIED/WAIVED), and a git push / gh pr merge without flow/PUSH-GATE (CLAUDE_STACK_PUSH_GATE=0 turns that half off)
  "guard-stop-contract.js::@Stop::"               # Stop event: block a turn ending on a decision-shaped question in prose - re-emit as AskUserQuestion (measured stalls 13min-37h); also carries the fresh-session offer, once per 1.5x of context growth past 40% of the window
  "guard-stop-contract.js::AskUserQuestion::"  # PreToolUse AskUserQuestion: INJECT context into the ask being built - stale scope (an option naming repo/remote/job state with no fresh read this turn), a recommendation contradicting an un-actioned earlier prompt, the fresh-session offer for a flow whose every stop is a tool call, a live credential, and the house voice in the ask's own text. Presence only, never denies
  "guard-fresh-session-start.js::Skill::"        # PreToolUse Skill: block a deliberate orchestration run starting on another run's carried history past the window-scaled trigger - route it through an AskUserQuestion fresh-session choice
  "guard-fresh-session-start.js::@UserPromptSubmit::"   # the same run invoked as a SLASH COMMAND emits no Skill event at all (measured: 4 of 4 runs slash-injected, zero Skill events in 45 messages) - this route injects the ask, never denies (a UserPromptSubmit denial erases the prompt)
  "guard-fresh-session-start.js::@SessionStart:compact::"  # the harness just auto-compacted, which proves the session hit the ~390k ceiling at a moment a Stop may never come - inject the fresh-session ask there too
  "guard-cross-project-write.js::Write|Edit|NotebookEdit|Bash::"  # one session, one project: block a WRITE that lands outside the project root (reads/investigation untouched) - the change another repo needs is handed off as a task card
  "guard-answer-length.js::@UserPromptSubmit::"   # inject the answer budget (~3 sentences plus points) at the end of the turn's context - the short-answer rule mechanized
  "guard-answer-length.js::@SessionStart::"     # re-inject the budget after a COMPACTION rebuilds the context without it (measured absent for 277 of 366 messages in one session) - a startup/resume session gets it before the first prompt too
  "guard-answer-length.js::@Stop::"               # Stop event: block a wall-of-text answer (prose past the hard cap, no depth request in the user's message) - re-answer at budget
  "instrument-tool-usage.js::.*::"                # wired env-gated: a sh test skips the node spawn unless CLAUDE_STACK_INSTRUMENT=1 (seeded "0" in settings env - flip it for a measured run; see README)
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
SECRET_DENY=(
  "Read(.env)"
  "Read(.env.*)"
  "Read(*.pem)"
  "Read(*.pfx)"
  "Read(*.p12)"
  "Read(*.key)"
  "Read(~/.claude/settings.json)"
  "Read(~/.claude/settings.local.json)"
  "Read(~/.claude-*/settings.json)"
  "Read(~/.claude-*/settings.local.json)"
)

# (5) Subagents (claude-code): specialist agents copied into .claude/agents/ from the run's source clone
# (agents/) on BOTH actions (per-agent fail-soft - an agent not yet upstream keeps its committed repo copy).
# Claude Code auto-discovers .claude/agents/*.md; no settings.json wiring needed. (Cursor's twins of these
# live in the cursor-stack repo.)
AGENTS=(
  "dotnet-build-error-resolver.md"   # implement phase (sonnet/high): dotnet build -> categorize errors -> minimal fix loop (serena/csharp-lsp), capped
  "dotnet-test-failure-resolver.md"  # implement phase (sonnet/high): dotnet test -> red->green repair loop, anti-reward-hacking guard, capped
  "ng-build-error-resolver.md"       # implement phase (sonnet/high): ng build -> minimal fix loop (serena/LSP), capped
  "angular-test-resolver.md"         # implement phase (sonnet/high): ng test/Jest -> red->green repair loop, anti-reward-hacking, capped
  "architecture-analyzer.md"                 # analysis support (sonnet/low): read-only per-module characterizer (purpose/surface/deps/patterns/smells) - the architecture + test-coverage captures fan it out, also independently callable
  "test-coverage-analyzer.md"             # analysis phase (sonnet/medium): read-only per-surface coverage characterizer - the project-test-coverage-analyzer skill fans it out over the raw results; never runs the suite
  "code-style-analyzer.md"                # analysis phase (sonnet/medium): read-only per-language style characterizer - the project-code-style-analyzer skill fans it out per language and merges docs/PROJECT-CODE-STYLE.md + the inject-code-style hook from its structured reports
  "related-project-analyzer.md"           # analysis support (sonnet/medium): read-only sibling-repo characterizer (name/relation/first_read/seam, URL siblings shallow-cloned to scratch) - the project-related-context skill fans it out per sibling and merges docs/related-context/PROJECT-RELATED-CONTEXT.md
  "ci-failure-diagnoser.md"          # analysis phase (opus/high): read-only CI red-run diagnosis via gh - categorize, local repro, route
  "runtime-failure-diagnoser.md"               # analysis phase (opus/xhigh): read-only bug diagnosis from logs/errors/screenshots - root cause + route, no fix
  "evidence-gatherer.md"             # diagnosis support (sonnet/low): read-only - a diagnoser dispatches it to reproduce/confirm and return a compact digest, keeping log volume off the opus seat
  "security-auditor.md"              # analysis phase (opus/xhigh): read-only cross-stack security posture audit - OWASP/CWE punch-list routed to implementers, complements /security-review
  "integration-reviewer.md"          # final gate (opus/xhigh): read-only cross-domain integration review - contract consistency, assembled build/test/migration, the commit gate no single-stack verifier is
  # Per-domain specialist team (10 stacks x designer/implementer/verifier) + architect analysis agents above; model/effort pinned in frontmatter
  "aspnet-solution-designer.md"      # design phase (opus/xhigh): ASP.NET Core architecture + plan + test strategy, decomposes into parallel tasks
  "aspnet-implementer.md"            # build phase (sonnet/medium): builds one ASP.NET task - code + tests
  "aspnet-verifier.md"               # verify phase (sonnet/xhigh): gates the ASP.NET build vs plan + quality, punch-list back
  "web-angular-solution-designer.md"     # design phase (opus/xhigh): Angular architecture + plan + test strategy, decomposes
  "web-angular-implementer.md"           # build phase (sonnet/medium): builds one Angular task - code + tests
  "web-angular-verifier.md"              # verify phase (sonnet/xhigh): gates the Angular build vs plan + quality
  "wpf-solution-designer.md"         # design phase (opus/xhigh): WPF strict-MVVM architecture + plan + test strategy, decomposes
  "wpf-implementer.md"               # build phase (sonnet/medium): builds one WPF task - code + tests
  "wpf-verifier.md"                  # verify phase (sonnet/xhigh): gates the WPF build vs plan + quality
  "console-solution-designer.md"     # design phase (opus/xhigh): headless .NET (Generic Host worker/bot/daemon/CLI) architecture + plan + test strategy, decomposes
  "console-implementer.md"           # build phase (sonnet/medium): builds one console/worker task - code + tests
  "console-verifier.md"              # verify phase (sonnet/xhigh): gates the console/worker build vs plan + quality
  "ionic-angular-solution-designer.md"      # design phase (opus/xhigh): Ionic/Capacitor architecture + plan + test strategy, decomposes
  "ionic-angular-implementer.md"            # build phase (sonnet/medium): builds one mobile task - code + tests
  "ionic-angular-verifier.md"               # verify phase (sonnet/xhigh): gates the mobile build vs plan + quality
  "data-solution-designer.md"        # design phase (opus/xhigh): schema/data-model architecture + plan + test strategy, decomposes
  "data-implementer.md"              # build phase (sonnet/medium): builds one data task - SQL + migration tests
  "data-verifier.md"                 # verify phase (sonnet/xhigh): gates the data build vs plan + quality
  "devops-solution-designer.md"      # design phase (opus/xhigh): Docker/CI/CD/deploy architecture + plan + validation strategy, decomposes
  "devops-implementer.md"            # build phase (sonnet/medium): builds one devops task - Dockerfile/workflow/deploy + local validation
  "devops-verifier.md"               # verify phase (sonnet/xhigh): gates the devops build vs plan + quality
  "browser-extension-solution-designer.md" # design phase (opus/xhigh): MV3 extension architecture (SW/content/UI topology, message contract, permissions) + plan + test strategy, decomposes
  "browser-extension-implementer.md" # build phase (sonnet/medium): builds one extension task - code + tests
  "browser-extension-verifier.md"    # verify phase (sonnet/xhigh): gates the extension build vs plan + quality
  "windows-service-solution-designer.md" # design phase (opus/xhigh): SCM recovery/budget/identity topology + plan + test strategy, decomposes
  "windows-service-implementer.md" # build phase (sonnet/medium): builds one Windows Service task - code + tests
  "windows-service-verifier.md" # verify phase (sonnet/xhigh): gates the Windows Service build vs plan + quality
  "winforms-solution-designer.md"    # design phase (opus/xhigh): WinForms MVP seam / binding / disposal topology + plan + test strategy, decomposes
  "winforms-implementer.md"          # build phase (sonnet/medium): builds one WinForms task - code + tests
  "winforms-verifier.md"             # verify phase (sonnet/xhigh): gates the WinForms build vs plan + quality
)

# (6) Path-scoped rules (claude-code): copied into .claude/rules/ from the run's source clone (rules/)
# on BOTH actions - lazy-load on matching file reads; conventions stay with the convention-gate hook,
# rules carry only glob-scoped routing.
# NOTE: baseline-project-related-context.md, baseline-project-architecture.md and
# baseline-project-agent-capabilities.md are GENERATED per-project (by /project-related-context,
# /project-architecture-analyzer and /project-agent-capabilities) - NEVER add those names to this
# manifest (the copy would overwrite the generated copies); nothing prunes the rules dir, so
# they survive update.
CLAUDE_RULES=(
  # Always-on baseline (no paths) - loads every session like CLAUDE.md; one job per file, comment out what a project doesn't want.
  "baseline-interaction.md"    # communication + evaluating-proposals + planning (merged by exclusion affinity)
  "baseline-quality-gates.md"  # code-quality + definition-of-done (merged by exclusion affinity)
  "baseline-security.md"
  "baseline-git.md"
  "baseline-navigation.md"
  "baseline-docs-root.md"      # generated-docs root resolution (CLAUDE_STACK_DOCS_PATH)
  # Path-scoped routing
  "markdown-docs.md"          # markdown-style routing, path-scoped **/*.md
  "javascript-conventions.md"  # JS-family conventions, path-scoped js/jsx/mjs/cjs
  "dotnet-repair-agents.md"   # .NET repair-loop routing, path-scoped cs/csproj/sln/xaml
  "angular-repair-agents.md"  # Angular repair-loop routing, path-scoped
  # Convention rules (soft, glob auto-attach) - each points ONE file family at its house-style skill; replaced the require-convention-skill hard gate.
  "typescript-conventions.md" # ts/js family -> typescript (framework-agnostic baseline)
  "angular-conventions.md"    # Angular file shapes -> angular-conventions (Angular/Ionic projects only)
  "angular-styling-conventions.md" # scss/css -> angular-styling (Angular/Ionic projects only)
  "csharp-conventions.md"     # c#: .cs -> csharp (backend, desktop, console)
  "wpf-conventions.md"        # wpf: .xaml -> dotnet-wpf
  "winforms-conventions.md"   # winforms: .Designer.cs -> dotnet-winforms
  "sql-conventions.md"        # sql: .sql -> database-conventions
  "devops-conventions.md"     # rest (devops): Dockerfile/compose/workflow -> devops
)

# --- --installed-only: derive the selection from the install target -------
# The update fast path: refresh exactly what is on disk, adding nothing. The
# file-based layers come from the target dirs (generated project-owned files
# excluded - the captures rewrite those, not the stack), mcps from the
# project's .mcp.json (global mode has no file to read - MCP refresh is skipped
# there); plugins are machine-level and left to 'claude plugin update' or the
# guided commands. The derived set is closed through stack-select.js when it is
# reachable next to this script (a checkout or an extracted snapshot), so a
# dependency a NEW release introduced still installs; a bare curl-piped run has
# no graph and refreshes the disk set as-is. User-authored files are safe by
# construction: the manifest filter below only ever intersects with stack
# items, so a name the manifests do not carry is never installed or removed.
if [ "$INSTALLED_ONLY" = true ]; then
  _IO_TMP="$(mktemp -d)"
  SELECTION="$_IO_TMP/selection.txt"
  case "$CLAUDE_SCOPE" in user) _io_claude="$CONFIG_DIR" ;; *) _io_claude="$PWD/.claude" ;; esac
  {
    for d in "$_io_claude"/skills/*/; do [ -f "${d}SKILL.md" ] && printf 'skill %s\n' "$(basename "$d")" || true; done
    for f in "$_io_claude"/agents/*.md; do [ -f "$f" ] && printf 'agent %s\n' "$(basename "${f%.md}")" || true; done
    for f in "$_io_claude"/rules/*.md; do
      [ -f "$f" ] || continue; _io_b="$(basename "${f%.md}")"
      case "$_io_b" in baseline-project-*|project-code-style) continue ;; esac
      printf 'rule %s\n' "$_io_b"
    done
    for f in "$_io_claude"/hooks/*.js; do
      [ -f "$f" ] || continue; _io_b="$(basename "${f%.js}")"
      case "$_io_b" in inject-code-style) continue ;; esac
      printf 'hook %s\n' "$_io_b"
    done
    if [ "$CLAUDE_SCOPE" = "project" ] && [ -f "$PWD/.mcp.json" ] && command -v node >/dev/null 2>&1; then
      node -e 'for(const n of Object.keys((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).mcpServers)||{}))console.log("mcp "+n)' "$PWD/.mcp.json" 2>/dev/null || true
    elif command -v claude >/dev/null 2>&1; then
      # No .mcp.json to read (a global install, or a project whose config the CLI owns): ask the CLI
      # which servers are registered. Names are intersected with the MCPS manifest by the selection
      # filter below, so a claude.ai-managed or hand-added server is never touched.
      claude mcp list 2>/dev/null | sed -n 's/^\([A-Za-z0-9_.-]*\):[[:space:]].*/mcp \1/p' || true
    fi
    # Plugins are machine-level, so they are derived from the CLI listing rather than from a
    # project directory - without this the fast path filtered PLUGINS to empty and 'update' never
    # ran `claude plugin update` on anything. Run from the project dir, the listing carries this
    # project's plugins plus the user-scoped ones (claude-hud); duplicates are collapsed.
    if command -v claude >/dev/null 2>&1; then
      _io_known=""; for _io_p in ${PLUGINS[@]+"${PLUGINS[@]}"}; do _io_known="$_io_known ${_io_p%%@*}"; done
      claude plugin list 2>/dev/null \
        | awk -v known=" $_io_known " '{for(i=1;i<=NF;i++) if($i ~ /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/){split($i,a,"@"); if(index(known," " a[1] " ")) print "plugin " a[1]}}' \
        | sort -u || true
    fi
  } > "$SELECTION"
  # The CLI could not be read (absent, or an unexpected listing shape): fall back to the manifest's
  # plugin set. Safe on this path because --installed-only is update-only and `claude plugin update`
  # updates an installed plugin and never installs a missing one.
  if ! grep -q '^plugin ' "$SELECTION"; then
    for _io_p in ${PLUGINS[@]+"${PLUGINS[@]}"}; do printf 'plugin %s\n' "${_io_p%%@*}" >> "$SELECTION"; done
  fi
  # The nothing-installed guard tests the FILE layers only. A bare `grep -q .` could never fail here:
  # the plugin fallback directly above appends a line for every manifest plugin, so a derivation that
  # found zero skills, agents, rules and hooks still carried lines and the run continued to a stamped
  # no-op update. Plugins are machine-level and mcps come from .mcp.json; neither is evidence that
  # THIS target has an install.
  grep -qE '^(skill|agent|rule|hook) ' "$SELECTION" || { echo "error: --installed-only found nothing installed under $_io_claude - run '$0 install' (or the /claude-stack:setup command) first" >&2; rm -rf "$_IO_TMP"; exit 1; }
  # No hooks on disk must stay no hooks: the filter's no-hook-lines special case
  # would otherwise install all of them.
  grep -q '^hook ' "$SELECTION" || HOOKS=()
  _io_script_dir="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
  _io_sel_js="$_io_script_dir/../stack-select.js"
  _io_graph="$_io_script_dir/../../meta/stack-graph.json"
  if command -v node >/dev/null 2>&1 && [ -f "$_io_sel_js" ] && [ -f "$_io_graph" ]; then
    node -e 'const fs=require("fs");const cat={skill:"skills",plugin:"plugins",mcp:"mcps",agent:"agents",rule:"rules",hook:"hooks"};const sel={skills:[],plugins:[],mcps:[],agents:[],rules:[],hooks:[]};for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){const m=l.trim().match(/^(\S+)\s+(.+)$/);if(m&&cat[m[1]])sel[cat[m[1]]].push(m[2]);}fs.writeFileSync(process.argv[2],JSON.stringify(sel))' "$SELECTION" "$_IO_TMP/raw.json"
    if node "$_io_sel_js" --selection "$_IO_TMP/raw.json" --graph "$_io_graph" --emit "$_IO_TMP/closed.txt" > "$_IO_TMP/closure.log" 2>&1; then
      SELECTION="$_IO_TMP/closed.txt"
      while IFS= read -r _io_l; do log "installed-only: $_io_l"; done < "$_IO_TMP/closure.log"
    else
      log "installed-only: closure failed - refreshing the disk set as-is ($(head -1 "$_IO_TMP/closure.log" 2>/dev/null))"
    fi
  else
    log "installed-only: stack-select.js not reachable next to this script - refreshing the disk set as-is (new upstream dependencies are not auto-carried; run from a checkout or use the /claude-stack:update command)"
  fi
fi

# --- Selection subset filter (Component B) --------------------------------
# With --selection <file>, keep only the SKILLS / PLUGINS / MCPS / AGENTS /
# CLAUDE_RULES entries whose name appears in the file (one 'category name' per
# line; '#' comments and blank lines ignored). HOOKS are never filtered - they
# are foundational. --print-plan prints the resolved per-category set and exits
# (a dry run) before any prerequisite or install step runs.
if [ -n "$SELECTION" ]; then
  [ -f "$SELECTION" ] || { printf 'selection file not found: %s\n' "$SELECTION" >&2; exit 1; }

  _sel_has() { grep -qxF "$1 $2" "$SELECTION"; }   # 0 if 'category name' is a line

  _f=(); for e in ${SKILLS[@]+"${SKILLS[@]}"};             do _sel_has skill  "${e#*|}"                                    && _f+=("$e"); done; SKILLS=(${_f[@]+"${_f[@]}"})
  _f=(); for e in ${PLUGINS[@]+"${PLUGINS[@]}"};           do _sel_has plugin "${e%%@*}"                                   && _f+=("$e"); done; PLUGINS=(${_f[@]+"${_f[@]}"})
  _f=(); for e in ${MCPS[@]+"${MCPS[@]}"};                 do _sel_has mcp    "${e%%|*}"                                   && _f+=("$e"); done; MCPS=(${_f[@]+"${_f[@]}"})
  _f=(); for e in ${AGENTS[@]+"${AGENTS[@]}"};             do n="${e%%::*}"; _sel_has agent "${n%.md}"                     && _f+=("$e"); done; AGENTS=(${_f[@]+"${_f[@]}"})
  _f=(); for e in ${CLAUDE_RULES[@]+"${CLAUDE_RULES[@]}"}; do n="${e%%::*}"; _sel_has rule  "${n%.md}"                     && _f+=("$e"); done; CLAUDE_RULES=(${_f[@]+"${_f[@]}"})
  # Hooks joined the selection with the guided walk's hooks layer. A selection with no
  # 'hook' lines predates that layer - keep its install-every-hook behavior unchanged.
  if grep -q '^hook ' "$SELECTION"; then
    _f=(); for e in ${HOOKS[@]+"${HOOKS[@]}"};             do n="${e%%::*}"; _sel_has hook  "${n%.js}"                     && _f+=("$e"); done; HOOKS=(${_f[@]+"${_f[@]}"})
  fi
fi

if [ "$PRINT_PLAN" = true ]; then
  printf 'plan skills:';  for e in ${SKILLS[@]+"${SKILLS[@]}"};             do printf ' %s' "${e#*|}";                 done; printf '\n'
  printf 'plan plugins:'; for e in ${PLUGINS[@]+"${PLUGINS[@]}"};           do printf ' %s' "${e%%@*}";                done; printf '\n'
  printf 'plan mcps:';    for e in ${MCPS[@]+"${MCPS[@]}"};                 do printf ' %s' "${e%%|*}";                done; printf '\n'
  printf 'plan agents:';  for e in ${AGENTS[@]+"${AGENTS[@]}"};             do n="${e%%::*}"; printf ' %s' "${n%.md}"; done; printf '\n'
  printf 'plan rules:';   for e in ${CLAUDE_RULES[@]+"${CLAUDE_RULES[@]}"}; do n="${e%%::*}"; printf ' %s' "${n%.md}"; done; printf '\n'
  # dedupe display: one hook wired on two tools is still one hook in the plan
  printf 'plan hooks:';   _seen=""; for e in ${HOOKS[@]+"${HOOKS[@]}"};     do n="${e%%::*}"; case " $_seen " in *" $n "*) continue ;; esac; _seen="$_seen $n"; printf ' %s' "${n%.js}"; done; printf '\n'
  [ -n "${_IO_TMP:-}" ] && rm -rf "$_IO_TMP"   # the EXIT trap is installed further down - clean the --installed-only scratch here
  exit 0
fi

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
#   - CHEAP. One download replaces ~50 round trips (the HOOKS + AGENTS + CLAUDE_RULES arrays).
# Fail-soft, like the fetches were: no source (archive AND clone failed) means callers keep the
# copies already on disk and the run carries on. STACK_SHA stays empty, which is what suppresses
# the stamp write.
#
# --source <dir> hands in a source the CALLER already fetched (an extracted release archive or a
# git checkout). That is the plugin path: the setup / configure skills must download anyway (they
# need stack-select.js, stack-graph.json, the CLAUDE.md template and the stamp diff before the
# install runs), so they pass that same source here and the guided run costs ONE download instead
# of two. A caller-provided dir is borrowed, never deleted. Standalone (no --source) is
# unchanged: the script fetches its own source and cleans it up.
STACK_REPO_URL="${STACK_SKILLS_REPO:-https://github.com/envoydev/claude-stack}"
STACK_SRC=""            # the source worktree; empty until stack_src runs
STACK_SHA=""            # the exact commit every artifact this run installs was copied from
STACK_REF=""            # the branch that commit is the tip of (whatever the source's HEAD is)
STACK_SRC_TRIED=false   # memoises the OUTCOME, so a dead source costs one fetch attempt, not one per caller
STACK_SRC_OWNED=false   # true only when WE fetched it - the EXIT trap removes ours, never the caller's
STACK_SRC_ROOT=""       # the temp dir an owned fetch lives in (the EXIT trap's removal target)

_cleanup_stack_src() {
  if $STACK_SRC_OWNED && [ -n "$STACK_SRC_ROOT" ]; then rm -rf "$STACK_SRC_ROOT"; fi
  [ -n "${_IO_TMP:-}" ] && rm -rf "$_IO_TMP"
  return 0
}
trap _cleanup_stack_src EXIT

stack_src() {
  # Resolves on the first call; every later caller reuses the worktree. Returns non-zero (never
  # aborts) when the source is unavailable, so each caller applies its own fail-soft.
  # Memoise BOTH outcomes: five steps call this, and without the failure latch an offline run
  # would pay five download timeouts and report five failures for one root cause.
  [ -n "$STACK_SRC" ] && return 0
  $STACK_SRC_TRIED && return 1
  STACK_SRC_TRIED=true

  if [ -n "$SOURCE_DIR" ]; then
    # Borrowed source. Sanity-check it IS the stack (a wrong --source would otherwise 'install'
    # nothing and report 117 per-file failures), then read its revision: a git checkout carries
    # it in HEAD, an extracted release archive in its RELEASE-SOURCE file.
    if [ ! -d "$SOURCE_DIR/stack/skills" ] || [ ! -d "$SOURCE_DIR/stack/agents" ]; then
      note_failure "--source '$SOURCE_DIR' is not a claude-stack checkout (no stack/skills + stack/agents) - stack source unavailable"
      return 1
    fi
    STACK_SRC="$SOURCE_DIR"; STACK_SRC_OWNED=false
    STACK_SHA="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || true)"
    STACK_REF="$(git -C "$SOURCE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    if [ -n "$STACK_SHA" ]; then
      # Stamp the URL the caller actually cloned from, not our default - they may have used a fork.
      STACK_REPO_URL="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || echo "$STACK_REPO_URL")"
    elif [ -f "$SOURCE_DIR/RELEASE-SOURCE" ]; then
      STACK_SHA="$(sed -n 's/^sha: //p' "$SOURCE_DIR/RELEASE-SOURCE" | head -1)"
      STACK_REF="$(sed -n 's/^ref: //p' "$SOURCE_DIR/RELEASE-SOURCE" | head -1)"
    fi
    if [ -z "$STACK_SHA" ]; then
      log "source: $SOURCE_DIR (provided; no git checkout or RELEASE-SOURCE - no revision, so no stamp)"
    else
      log "source: $SOURCE_DIR (provided) @ ${STACK_REF:-?} $(printf '%.12s' "$STACK_SHA")"
    fi
    return 0
  fi

  # Release archive first: one asset is one revision, and no git is needed to take it.
  local tmp; tmp="$(mktemp -d)"
  local url="$STACK_REPO_URL/releases/latest/download/claude-stack.tar.gz"
  if command -v curl >/dev/null 2>&1 &&
     curl -fsSL "$url" -o "$tmp/claude-stack.tar.gz" 2>/dev/null &&
     mkdir -p "$tmp/repo" &&
     tar -xzf "$tmp/claude-stack.tar.gz" -C "$tmp/repo" 2>/dev/null &&
     [ -d "$tmp/repo/stack/skills" ] && [ -d "$tmp/repo/stack/agents" ]; then
    STACK_SRC="$tmp/repo"; STACK_SRC_ROOT="$tmp"; STACK_SRC_OWNED=true
    STACK_SHA="$(sed -n 's/^sha: //p' "$tmp/repo/RELEASE-SOURCE" 2>/dev/null | head -1)"
    STACK_REF="$(sed -n 's/^ref: //p' "$tmp/repo/RELEASE-SOURCE" 2>/dev/null | head -1)"
    log "source: $url @ ${STACK_REF:-?} $(printf '%.12s' "${STACK_SHA:-unknown}")"
    return 0
  fi
  rm -rf "$tmp"

  # Fallback: a shallow clone - a fork without releases, a blocked release CDN, a local test path.
  # Pinned to main: the release branch is what installs deliver, never the default branch
  # (development lands on develop).
  command -v git >/dev/null 2>&1 || { note_failure "release archive unreachable and git not found - stack source unavailable"; return 1; }
  tmp="$(mktemp -d)"
  if ! git clone --depth 1 -b main "$STACK_REPO_URL" "$tmp" >/dev/null 2>&1; then
    note_failure "release archive and clone of $STACK_REPO_URL both failed - stack source unavailable (nothing refreshed; existing copies kept)"
    rm -rf "$tmp"; return 1
  fi
  STACK_SRC="$tmp"; STACK_SRC_ROOT="$tmp"; STACK_SRC_OWNED=true
  STACK_SHA="$(git -C "$tmp" rev-parse HEAD 2>/dev/null)"
  STACK_REF="$(git -C "$tmp" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  log "source: $STACK_REPO_URL (clone fallback) @ ${STACK_REF:-?} $(printf '%.12s' "${STACK_SHA:-unknown}")"
  return 0
}

# ===========================================================================
# INSTALL - skills re-add UNCONDITIONALLY (clean copy each run); MCPs and plugins SKIP if already present
# ===========================================================================
install_skills() {
  # Copy each selected skills/<name>/ out of the run's clone into the scope dest - all house
  # skills live in ONE repo, so a plain copy fully reproduces what the skills CLI used to stage;
  # no npx/network-registry dependency.
  stack_src || { note_failure "skills not installed"; return 0; }   # fail-soft: skip, never abort
  local name dest entry
  case "$CLAUDE_SCOPE" in user) dest="$CONFIG_DIR/skills" ;; *) dest="$PWD/.claude/skills" ;; esac
  mkdir -p "$dest"
  for entry in ${SKILLS[@]+"${SKILLS[@]}"}; do
    name="${entry#*|}"
    if [ -d "$STACK_SRC/stack/skills/$name" ]; then
      rm -rf "$dest/$name"; cp -R "$STACK_SRC/stack/skills/$name" "$dest/$name"
      log "skill [$CLAUDE_SCOPE]: $name -> $dest/$name"
    else
      note_failure "skill '$name' not found in $STACK_REPO_URL"
    fi
  done
}

install_plugins() {
  command -v claude >/dev/null 2>&1 || { CLAUDE_MISSING=true; return 0; }   # fail-soft: skip, never abort the run
  for mp in ${EXTRA_MARKETPLACES[@]+"${EXTRA_MARKETPLACES[@]}"}; do claude plugin marketplace add "$mp" 2>/dev/null || true; done
  for p in ${PLUGINS[@]+"${PLUGINS[@]}"}; do
    # claude-hud is a statusline HUD - force USER scope regardless of $CLAUDE_SCOPE. A project-scoped
    # install + the global statusline enable mismatch, so every OTHER project warns "plugin not cached".
    pscope="$CLAUDE_SCOPE"; case "$p" in claude-hud@*) pscope="user" ;; esac
    log "plugin [$pscope]: $p"
    claude plugin install "$p" --scope "$pscope" -y || note_failure "plugin $p failed"   # -y: the marketplace-command consent prompt cannot be answered when stdin/stdout is not a TTY (the guided commands run this non-interactively)
  done
}

_mcp_argv() {  # $1 = manifest args -> spec_words: the argv for `claude mcp add`, path tokens resolved per word
  # Split into argv words FIRST, then resolve @SERENA_CONTEXT@ / @HOME_MEMORY_DIR@ inside each word - so
  # a resolved path that contains a space (a home dir like '/Users/Jane Doe') stays ONE argument instead
  # of splitting into two. read -ra splits on whitespace into an array AND disables glob expansion, so
  # a bare '*' in the spec is passed literally, never expanded.
  local i
  read -ra spec_words <<<"$1"
  for i in "${!spec_words[@]}"; do
    spec_words[i]="${spec_words[i]//@SERENA_CONTEXT@/$SERENA_CTX}"
    spec_words[i]="${spec_words[i]//@HOME_MEMORY_DIR@/$HOME_MEMORY_DIR}"
  done
}

install_mcps() {
  command -v claude >/dev/null 2>&1 || { CLAUDE_MISSING=true; return 0; }   # fail-soft: skip, never abort the run
  local entry name args url hdr
  local -a spec_words
  for entry in ${MCPS[@]+"${MCPS[@]}"}; do
    name="${entry%%|*}"; args="${entry#*|}"
    if [ "$name" = "sentry" ] && [ -n "$SENTRY_SLUG" ]; then seed_account_env SENTRY_SLUG "$SENTRY_SLUG"; fi   # the env seed lands even when the registration is skipped below
    if claude mcp get "$name" >/dev/null 2>&1; then echo "  mcp $name already configured - skipping"; continue; fi
    log "mcp [$CLAUDE_SCOPE]: $name"
    if [ "$args" = "@HTTP@" ]; then
      # remote (hosted) server - url/header keyed by name: sentry, else context7. An EMPTY header
      # (sentry --sentry-auth oauth) registers with no --header at all, so the OAuth fallback stays on.
      if [ "$name" = "sentry" ]; then url="$SENTRY_REMOTE_URL"; hdr="$SENTRY_REMOTE_HDR"
      else url="$CONTEXT7_REMOTE_URL"; hdr="$CONTEXT7_REMOTE_HDR"; fi
      if [ -n "$hdr" ]; then
        claude mcp add --transport http --scope "$CLAUDE_SCOPE" "$name" "$url" --header "$hdr" || note_failure "mcp $name failed"
      else
        claude mcp add --transport http --scope "$CLAUDE_SCOPE" "$name" "$url" || note_failure "mcp $name failed"
      fi
      continue
    fi
    _mcp_argv "$args"
    claude mcp add --scope "$CLAUDE_SCOPE" "$name" "${spec_words[@]}" || note_failure "mcp $name failed"
  done
}

# _install_from_src <subdir> <label> <dest-dir> <executable?> <file...>
# Shared body of the hook/agent/rule steps: copy each named file out of the run's clone. Per-file
# fail-soft (a file not yet upstream keeps its committed copy), and an unchanged file is reported
# 'current' rather than rewritten, so a no-op run leaves mtimes alone.
_install_from_src() {
  local subdir="$1" label="$2" dest_dir="$3" exec_bit="$4"; shift 4
  stack_src || { log "  !! stack source unavailable - kept existing $label copies"; return 0; }
  local file src dest
  for file in "$@"; do
    src="$STACK_SRC/$subdir/$file"
    [ -f "$src" ] || { note_failure "$label '$file' not found in $STACK_REPO_URL"; continue; }
    dest="$dest_dir/$file"; mkdir -p "$(dirname "$dest")"
    if [ -f "$dest" ] && cmp -s "$src" "$dest"; then
      # Unchanged content can still have lost its exec bit (a re-clone, a checkout that dropped the mode) - re-assert it.
      [ "$exec_bit" = "exec" ] && [ ! -x "$dest" ] && chmod +x "$dest"
      log "  $label current: $file"; continue
    fi
    cp "$src" "$dest"
    [ "$exec_bit" = "exec" ] && chmod +x "$dest"
    log "  $label installed -> $file"
  done
}

download_hooks() {  # copy each hook file into the repo; per-hook fail-soft (keeps repo copy)
  local root entry file; local -a files=()
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "  !! not in a git repo - skipping hooks"; return 0; }
  for entry in ${HOOKS[@]+"${HOOKS[@]}"}; do file="${entry%%::*}"; files+=("$file"); done   # empty-array-safe on bash 3.2 (macOS /bin/bash) under set -u
  _install_from_src stack/hooks hook "$root/.claude/hooks" exec ${files[@]+"${files[@]}"}
}

download_agents() {  # copy each subagent .md into .claude/agents/; per-agent fail-soft (keeps repo copy)
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "  !! not in a git repo - skipping agents"; return 0; }
  _install_from_src stack/agents agent "$root/.claude/agents" no ${AGENTS[@]+"${AGENTS[@]}"}
}

download_rules() {  # copy each rule .md into .claude/rules/; per-rule fail-soft (keeps repo copy)
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "  !! not in a git repo - skipping rules"; return 0; }
  _install_from_src stack/rules rule "$root/.claude/rules" no ${CLAUDE_RULES[@]+"${CLAUDE_RULES[@]}"}
  stamp_docs_root_rule "$root"
}

stamp_docs_root_rule() {  # replace __DOCS_ROOT__ in the copied baseline-docs-root.md with the CURRENT env value (settings.json, else the default) - runs on install AND update, so the stamp always tracks the env
  local root="$1" rule="$1/.claude/rules/baseline-docs-root.md"
  [ -f "$rule" ] || return 0
  python3 - "$rule" "$root/.claude/settings.json" <<'PY' || log "  !! docs-root stamp failed - the rule keeps the env-wins fallback"
import json, sys
rule, settings = sys.argv[1], sys.argv[2]
val = ".claude/docs"
try:
    _env = json.load(open(settings)).get("env", {})
    # the pre-0.2.43 key is still read: an install stamped before the rename landed
    v = _env.get("CLAUDE_STACK_DOCS_PATH", "") or _env.get("CLAUDE_DOCS_PATH", "")
    if v: val = v
except Exception:
    pass
s = open(rule, encoding="utf-8").read()
open(rule, "w", encoding="utf-8").write(s.replace("__DOCS_ROOT__", val))
PY
}

seed_claude_md() {  # INSTALL: lay down a starter .claude/CLAUDE.md from the template when the project has none (never clobber a filled one)
  local root dest src
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "  !! not in a git repo - skipping CLAUDE.md"; return 0; }
  # Auto-loaded from either ./CLAUDE.md or ./.claude/CLAUDE.md - skip if EITHER exists so we never leave two copies.
  if [ -f "$root/CLAUDE.md" ] || [ -f "$root/.claude/CLAUDE.md" ]; then log "  CLAUDE.md: already present - left as-is (finish its authoring outline if not done)"; return 0; fi
  stack_src || { log "  !! stack source unavailable - create .claude/CLAUDE.md by hand from CLAUDE.template.md"; return 0; }
  src="$STACK_SRC/stack/CLAUDE.template.md"
  [ -f "$src" ] || { note_failure "CLAUDE.template.md not found in $STACK_REPO_URL"; return 0; }
  dest="$root/.claude/CLAUDE.md"; mkdir -p "$root/.claude"
  cp "$src" "$dest"; log "  CLAUDE.md: seeded to .claude/CLAUDE.md - write the project top from its authoring-outline comment, and keep the '.claude/*' + '!.claude/CLAUDE.md' gitignore lines so it stays committed"
}

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
_serena_ignores='[".serena", ".claude", ".playwright"]'
_serena_has_entries() {  # $1 = file, $2 = key alternation - true when a key carries a NON-EMPTY list
  awk -v keys="$2" '
    BEGIN { n = split(keys, k, "|"); for (i = 1; i <= n; i++) want[k[i]] = 1 }
    /^[[:space:]]*[a-z_]+[[:space:]]*:/ {
      key = $0; sub(/^[[:space:]]*/, "", key); sub(/[[:space:]]*:.*$/, "", key)
      rest = $0; sub(/^[^:]*:[[:space:]]*/, "", rest)
      pending = 0
      if (key in want) { if (rest ~ /\[[[:space:]]*[^][[:space:]]/) { found = 1 } else if (rest == "") pending = 1 }
      next
    }
    pending && /^[[:space:]]*-[[:space:]]*[^[:space:]]/ { found = 1; pending = 0 }
    END { exit(found ? 0 : 1) }' "$1" 2>/dev/null
}
_serena_detect_langs() {  # $1 = repo root - print the detected ids, one per line (empty = detected nothing)
  local root="$1"
  find "$root" -maxdepth 4 \( -name '*.sln' -o -name '*.slnx' -o -name '*.csproj' \) \
    -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -1 | grep -q . && echo csharp
  # serena's typescript server handles plain JavaScript too, so a package.json-only or .js-only
  # repo takes it as well - without this a JS project detected nothing and got no seed at all.
  find "$root" -maxdepth 4 \( -name 'tsconfig*.json' -o -name 'package.json' -o -name '*.ts' -o -name '*.tsx' \
    -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \) \
    -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -1 | grep -q . && echo typescript
  return 0
}
# Both list keys are ensured the same way, and NEITHER is ever appended when the key already
# exists: serena's own auto-generated config ships `language_servers: []` / `ignored_paths: []`,
# and a second key of the same name is a duplicate-key YAML error, not an override. An empty key
# is rewritten in place; a key carrying entries is hand-tuned and left alone.
_serena_set_list_key() {  # $1 = project.yml, $2 = key, $3 = value, $4 = comment line
  local cfg="$1" key="$2" value="$3" comment="$4"
  _serena_has_entries "$cfg" "$key" && return 0
  if grep -Eq "^[[:space:]]*$key[[:space:]]*:" "$cfg"; then
    sed -i.stackbak "s|^[[:space:]]*$key[[:space:]]*:.*|$key: $value|" "$cfg" && rm -f "$cfg.stackbak"
    log "  serena: $key set to $value (was empty)"
  else
    printf '\n# Added by claude-stack: %s\n%s: %s\n' "$comment" "$key" "$value" >> "$cfg"
    log "  serena: $key $value appended to project.yml"
  fi
}
seed_serena_project() {
  printf '%s\n' ${MCPS[@]+"${MCPS[@]}"} | grep -q '^serena|' || return 0   # serena not in this selection
  local root cfg langs list name
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0           # not a repo - serena has no root to bind either
  cfg="$root/.serena/project.yml"
  if [ -f "$cfg" ]; then
    if _serena_has_entries "$cfg" 'language_servers|languages'; then
      log "  serena: project.yml already names its language servers - left as-is"
    else
      langs="$(_serena_detect_langs "$root")"
      if [ -n "$langs" ]; then
        list="$(printf '%s\n' $langs | sed 's/^/"/;s/$/"/' | paste -sd, - | sed 's/,/, /g')"
        _serena_set_list_key "$cfg" language_servers "[$list]" "serena writes this key empty (async) or with only the single top language."
      else
        log "  serena: no C#/TypeScript/JS sources found - language_servers left to serena's own detection"
      fi
    fi
    # ALWAYS, independent of the languages branch: an install predating this key, and every config
    # serena generated itself, otherwise keeps indexing .serena/home - measured on a 14-file
    # fixture, 126 files attempted and 112 failed, every one inside the language-server directory.
    _serena_set_list_key "$cfg" ignored_paths "$_serena_ignores" ".serena holds the ~327MB of language servers, .claude the stack files, .playwright the MCP browser profile - none are project source."
    return 0
  fi
  langs="$(_serena_detect_langs "$root")"
  # language_servers has no default in serena's schema, so a file without it fails to load: with
  # nothing detected, write nothing and let serena generate its own.
  [ -n "$langs" ] || { log "  serena: no C#/TypeScript/JS sources found - left project.yml to serena's own detection"; return 0; }
  list="$(printf '%s\n' $langs | sed 's/^/"/;s/$/"/' | paste -sd, - | sed 's/,/, /g')"
  name="$(basename "$root")"
  mkdir -p "$root/.serena"
  cat > "$cfg" <<SERENA_YML
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
ignored_paths: $_serena_ignores
SERENA_YML
  log "  serena: seeded .serena/project.yml (project_name=$name, language_servers=[$list])"
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
stack_version_from() {
  # The stack's ONE version: an extracted release archive carries it in RELEASE-SOURCE; a git
  # checkout reads it from the plugin manifest - the same file the marketplace serves from main,
  # so the stamp, the release, and the marketplace always name the same version.
  # '|| true': a source with neither file (a bare checkout) yields an empty version - under set -e +
  # pipefail the failing sed would otherwise abort the run inside write_stamp.
  { sed -n 's/^version: //p' "$1/RELEASE-SOURCE" 2>/dev/null | head -1 | grep .; } ||
    sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/setup-plugin/.claude-plugin/plugin.json" 2>/dev/null | head -1 || true
}

write_stamp() {
  # No SHA means no source resolved this run (the archive download and the clone fallback both
  # failed, and every step fail-softly kept its existing copy). Stamping then would claim an
  # install that did not occur, and a wrong stamp is worse than none - so leave any previous
  # stamp untouched.
  [ -n "$STACK_SHA" ] || { log "  stamp: skipped - no source revision resolved this run"; return 0; }
  local dir dest root version
  version="$(stack_version_from "$STACK_SRC")"
  case "$CLAUDE_SCOPE" in
    user) dir="$CONFIG_DIR" ;;
    # Prefer the repo root - that is where hooks/agents/rules land. Outside a repo fall back to
    # $PWD, which is where install_skills puts .claude/skills: the stamp belongs next to whatever
    # this run actually installed, and a skills-only install into a plain directory still gets one.
    *)    root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
          [ -n "$root" ] || root="$PWD"
          dir="$root/.claude" ;;
  esac
  mkdir -p "$dir"; dest="$dir/claude-stack.stamp"
  cat > "$dest" <<STAMP
# claude-stack install stamp - machine-local, written by claude-stack.sh / claude-stack.ps1.
# The revision every artifact of this install was copied from. To see what changed since:
#   open $STACK_REPO_URL/compare/$STACK_SHA...main
# /claude-stack:configure reports exactly this diff. Then re-run the installer's
# '$ACTION' action (or that skill) to take the changes.
source: $STACK_REPO_URL
ref: $STACK_REF
sha: $STACK_SHA
version: $version
installed: $(date -u +%Y-%m-%dT%H:%M:%SZ)
action: $ACTION
scope: $CLAUDE_SCOPE
STAMP
  log "  stamp: $dest @ $(printf '%.12s' "$STACK_SHA")"
}

wire_hooks_settings() {  # INSTALL + UPDATE: ensure the hook PreToolUse blocks + secret-read deny-list + mcp allow-list are in settings.json (idempotent)
  local root settings; root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  settings="$root/.claude/settings.json"; mkdir -p "$(dirname "$settings")"
  command -v python3 >/dev/null || { log "  !! python3 not found - wire hooks into settings.json by hand"; return 0; }
  # NB: program via -c (not `python3 - <<heredoc`): a pipe + heredoc both target stdin and the pipe
  # wins, so a heredoc program would never run. -c frees stdin for the piped hook specs.
  local prog; prog=$(cat <<'PY'
import json, os, sys
path = sys.argv[1]
deny_specs, mcp_names, retired_hooks, bucket = [], [], [], None
for a in sys.argv[2:]:
    if a == "--DENY": bucket = deny_specs; continue
    if a == "--MCP": bucket = mcp_names; continue
    if a == "--RETIRED": bucket = retired_hooks; continue
    if bucket is not None: bucket.append(a)
specs = []
HOOK_TIMEOUT = 10   # seconds - see the note below; the default would be 600
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    file, matcher, args = (line.split("::", 2) + ["", ""])[:3]
    if not matcher:
        continue
    # The placeholder is QUOTED so a project path with a space survives the shell (the hooks docs:
    # 'explicitly quote path placeholders'); `legacy` is the unquoted text earlier installs wired,
    # rewritten in place below so an update never leaves two entries for one hook.
    tail = (" " + args) if args else ""
    # Every hook here does <30ms of work (measured: 22-25ms, almost all of it the node spawn), but
    # a `command` hook with no timeout takes Claude Code's 600s default - so one stalled subprocess
    # (guard-protected-force-push and guard-ungated-commit both shell out to git, and a stuck
    # index.lock or a slow network mount hangs `git rev-parse`) freezes the session for ten minutes.
    # 10s is ~400x the measured cost and still fails fast.
    cmd = '"$CLAUDE_PROJECT_DIR/.claude/hooks/' + file + '"' + tail
    legacy = "$CLAUDE_PROJECT_DIR/.claude/hooks/" + file + tail
    if file == "instrument-tool-usage.js":
        # env-gated: the sh test costs ~nothing when off; node spawns only under CLAUDE_STACK_INSTRUMENT=1
        gate = '[ "$CLAUDE_STACK_INSTRUMENT" != "1" ] || '
        cmd, legacy = gate + cmd, gate + legacy
    specs.append((matcher, cmd, legacy))
if os.path.exists(path):
    # Refuse to touch a settings.json that does not parse: falling back to {} would REPLACE the project's
    # whole file (permissions, statusLine, env) with just the stack's entries.
    try:
        data = json.load(open(path))
    except Exception as exc:
        print("  !! settings.json is not valid JSON (%s) - left untouched; fix it and re-run" % exc, file=sys.stderr)
        sys.exit(1)
    if not isinstance(data, dict):
        print("  !! settings.json top level is not an object - left untouched", file=sys.stderr)
        sys.exit(1)
else:
    data = {}
changed = False
# Migrate the unquoted command text earlier installs wired (same file, any event) to the quoted form.
for matcher, command, legacy in specs:
    for entries in data.get("hooks", {}).values():
        for e in entries:
            for h in e.get("hooks", []):
                if h.get("command") == legacy:
                    h["command"] = command; changed = True
# Backfill the timeout onto entries an earlier install wrote bare (they carry the 600s default).
_ours = {c for _, c, _ in specs} | {l for _, _, l in specs}
for entries in data.get("hooks", {}).values():
    for e in entries:
        for h in e.get("hooks", []):
            if h.get("command") in _ours and h.get("timeout") != HOOK_TIMEOUT:
                h["timeout"] = HOOK_TIMEOUT; changed = True
# Prune OUR hook file from a PreToolUse matcher this version no longer wires (guard-stop-contract's
# retired AskUserQuestion entry): the plugin route applies meta/migrations.json, the script route must
# match, or the legacy entry survives every update with a freshly backfilled timeout (measured).
# Keyed on the SELECTED specs, so a hook the user de-selected keeps its entries (configure's job).
_ours_files = {c.split("/.claude/hooks/")[-1].split('"')[0] for _, c, _ in specs}
_pairs = {(m, c) for m, c, _ in specs if not m.startswith("@")}
_pre = data.get("hooks", {}).get("PreToolUse", [])
for e in list(_pre):
    for h in list(e.get("hooks", [])):
        c = h.get("command", "")
        if "/.claude/hooks/" in c and c.split("/.claude/hooks/")[-1].split('"')[0] in _ours_files and (e.get("matcher", ""), c) not in _pairs:
            e["hooks"].remove(h); changed = True
    if not e.get("hooks"):
        _pre.remove(e); changed = True
# Unwire a hook file this stack RETIRED (its file is pruned in the same run): keyed on the file name
# across EVERY event, since a retired hook may have been wired outside PreToolUse (inject-code-style
# ran on a prompt event). Left wired, the entry keeps spawning a command whose file no longer exists.
for ev_name, entries in list(data.get("hooks", {}).items()):
    for e in list(entries):
        for h in list(e.get("hooks", [])):
            c = h.get("command", "")
            if "/.claude/hooks/" in c and c.split("/.claude/hooks/")[-1].split('"')[0] in retired_hooks:
                e["hooks"].remove(h); changed = True
        if not e.get("hooks"):
            entries.remove(e); changed = True
    if not entries:
        del data["hooks"][ev_name]; changed = True
# "@<Event>" matchers wire a non-PreToolUse lifecycle event (e.g. @Stop - no matcher key there).
# "@<Event>:<matcher>" is the same with a matcher, which some events DO key on: SessionStart's
# source (`compact` / `startup` / `resume`) is the one this stack uses. Without the matcher the
# entry fires on every session start, which is not what the fresh-session offer is for.
for matcher, command, legacy in specs:
    if matcher.startswith("@"):
        ev_name, _, ev_matcher = matcher[1:].partition(":")
        ev = data.setdefault("hooks", {}).setdefault(ev_name, [])
        if any(h.get("command", "") == command for e in ev for h in e.get("hooks", []) if e.get("matcher", "") == ev_matcher):
            continue
        entry = {"hooks": [{"type": "command", "command": command, "timeout": HOOK_TIMEOUT}]}
        if ev_matcher:
            entry["matcher"] = ev_matcher
        ev.append(entry)
        changed = True
        continue
    cur = data.setdefault("hooks", {}).setdefault("PreToolUse", [])
    # Keyed on (matcher, command): one hook file wired on two tools (guard-read-whole-file on Read AND Bash)
    # is two entries - keying on the command alone dropped the second (measured: no install ever carried
    # the Bash matcher).
    have = {(e.get("matcher", ""), h.get("command", "")) for e in cur for h in e.get("hooks", [])}
    if (matcher, command) in have:
        continue
    cur.append({"matcher": matcher, "hooks": [{"type": "command", "command": command, "timeout": HOOK_TIMEOUT}]})
    changed = True
# permissions.deny: union-merge the secret-file Read blocks, preserving any the project already set.
deny = data.setdefault("permissions", {}).setdefault("deny", [])
for rule in deny_specs:
    if rule not in deny:
        deny.append(rule); changed = True
# NO permissions.allow seed for the gate stamps, deliberately. The hooks require a write to
# <docs-root>/flow/APPROVAL and /COMMIT-GATE, and under the default docs root those sit inside
# `.claude/` - a PROTECTED path. Protected-path writes are never auto-approved outside
# bypassPermissions, and the safety check runs BEFORE settings allow-rules, so an Edit()/Write()
# entry here is a silent no-op (measured: one project's runs were refused on every route and
# DELEGATED mode silently degraded to inline for a whole 12-stage run). The working levers are the
# prompt's own 'allow Claude to edit its own settings for this session' option, or a
# CLAUDE_STACK_DOCS_PATH outside `.claude/`. The flows carry the ask-fallback for the refusal case.
# enabledMcpjsonServers: pre-approve exactly the project .mcp.json servers we register, so no per-launch
# trust prompt - never blanket enableAllProjectMcpServers. Union-merged; an unlisted name is a harmless no-op.
enabled = data.setdefault("enabledMcpjsonServers", [])
for name in mcp_names:
    if name not in enabled:
        enabled.append(name); changed = True
# Environment keys this stack RENAMED: carry the user's VALUE to the new name and drop the old
# key, BEFORE the absent-only seeds below - seeding first would write the default over a value the
# user had set under the old name. One pair per rename; keep the list identical in both installer
# twins and in meta/migrations.json (the plugin route applies it from there).
env = data.setdefault("env", {})
for _old, _new in (("CLAUDE_DOCS_PATH", "CLAUDE_STACK_DOCS_PATH"),):
    if _old in env:
        if _new not in env and env[_old] != "":
            env[_new] = env[_old]
        del env[_old]
        changed = True
        print("  settings.json env: %s renamed to %s" % (_old, _new))
# Environment keys whose SEEDED DEFAULT turned out to be WRONG: clear the key when its value is
# still exactly that seed - a value the user set by hand is theirs and is never touched. Same list
# in both installer twins and in meta/migrations.json (the plugin route applies it from there).
for _key, _bad_seed, _to in (("CLAUDE_STACK_CONTEXT_WINDOW", "1000000", "AUTO"), ("CLAUDE_STACK_CONTEXT_WINDOW", "", "AUTO")):
    if env.get(_key) == _bad_seed:
        env[_key] = _to
        changed = True
        print("  settings.json env: %s reset to %s (auto-detect)" % (_key, _to))
# env: project-default auto-compact trigger (compact at ~40% of the context window). Set only when
# absent, so a project that pins its own value - or holds CONTEXT7_API_KEY here - is never clobbered.
if "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE" not in env:
    env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = "40"; changed = True
# generated-docs root: the authoritative value the baseline-docs-root rule resolves at session start.
# Forward slashes on every OS (Node hooks and the model resolve them fine on Windows).
if "CLAUDE_STACK_DOCS_PATH" not in env:
    env["CLAUDE_STACK_DOCS_PATH"] = ".claude/docs"; changed = True
# instrumentation switch: the wired instrument hook runs only when this is "1" - seeded off.
if "CLAUDE_STACK_INSTRUMENT" not in env:
    env["CLAUDE_STACK_INSTRUMENT"] = "0"; changed = True
# publish gate: `git push` / `gh pr merge` need a flow/PUSH-GATE receipt like a commit does.
# Seeded ON - across four audited sessions every push and merge passed every guard, one of them
# putting 40 files on a shared `develop`. "0" for a repo whose remote is already gated.
if "CLAUDE_STACK_PUSH_GATE" not in env:
    env["CLAUDE_STACK_PUSH_GATE"] = "1"; changed = True
# fresh-session gate, BOTH of its knobs - seeded so they are visible and tunable in one place.
# Until they were, the only percentage in the block was CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, a
# different knob (the harness auto-compact trigger); a user raised THAT to 40 and reasonably
# expected the gate to move (reported 2026-09-04 - the gate reads its own value, absent and
# defaulted to 40 anyway, so the number matched while the setting did nothing).
if "CLAUDE_STACK_FRESH_SESSION_PCT" not in env:
    env["CLAUDE_STACK_FRESH_SESSION_PCT"] = "40"; changed = True
# The context window that percentage applies to - seeded "AUTO", which MEANS auto-detect. The
# sentinel is a WORD, not an empty string: the box is written so the knob stays visible in the env
# block, and an empty value there reads as a variable nobody filled in rather than as a decision.
# Anything that is not a window size falls through to detection identically, so an install still
# carrying the old "" is reset to AUTO by the pass above. It was seeded "1000000", and that killed
# the gate on every install that was not a 1M account: this value is the FIRST layer of the hooks'
# window resolution, so a stated 1M window on a 200k session put the trigger above anything that
# session can ever carry, and no offer could fire (ten confirmations across four projects). On
# AUTO the hooks read the settings model id's own window suffix (`opus[1m]`), else the tier the
# session has already proven. Put a NUMBER here only to OVERRULE that - "1000000" or "200000".
if "CLAUDE_STACK_CONTEXT_WINDOW" not in env:
    env["CLAUDE_STACK_CONTEXT_WINDOW"] = "AUTO"; changed = True
if changed:
    json.dump(data, open(path, "w"), indent=2); open(path, "a").write("\n")
    print("  settings.json: hooks + secret deny-list + mcp allow-list + compact default ensured")
else:
    print("  settings.json: hooks + secret deny-list + mcp allow-list + compact default already present - unchanged")
PY
)
  local -a mcp_names; mcp_names=()
  for _m in ${MCPS[@]+"${MCPS[@]}"}; do mcp_names+=("${_m%%|*}"); done   # server name = the token before the first '|'
  printf '%s\n' ${HOOKS[@]+"${HOOKS[@]}"} | python3 -c "$prog" "$settings" --DENY "${SECRET_DENY[@]}" --MCP ${mcp_names[@]+"${mcp_names[@]}"} --RETIRED ${RETIRED_HOOKS[@]+"${RETIRED_HOOKS[@]}"} || log "  !! settings.json wiring failed"
}

# ===========================================================================
# UPDATE - bring everything to latest
# ===========================================================================
# Renamed/retired upstream names: their old files left the manifests, so the refresh loops never clear
# them - a leftover skill keeps auto-activating next to its successor, a leftover agent stays dispatchable
# under the old @agent-name (and the capabilities capture inventories it). Only names this stack itself
# once installed; an absent one is a no-op. The guided /claude-stack:update prunes from the stamp
# compare instead - these lists are the script path's equivalent. Unquoted on purpose: the parity lint
# reads the quoted manifest blocks only.
RETIRED_SKILLS=(project-task-flow project-task-cycle project-capabilities project-failure-signatures typescript-testing data-security dotnet-error-handling mobile-security)
RETIRED_RULES=(baseline-agents-skills.md baseline-code-quality.md baseline-communication.md baseline-definition-of-done.md baseline-evaluating-proposals.md baseline-mcp-tools.md baseline-planning.md baseline-related-projects.md house-baseline.md web-conventions.md aspnet-conventions.md)
RETIRED_HOOKS=(require-convention-skill.js inject-code-style.js)
RETIRED_AGENTS=(angular-solution-designer.md angular-implementer.md angular-verifier.md mobile-solution-designer.md mobile-implementer.md mobile-verifier.md dotnet-windows-service-solution-designer.md dotnet-windows-service-implementer.md dotnet-windows-service-verifier.md code-analyzer.md issue-diagnoser.md)
# MCP servers this stack no longer ships AT ALL. Empty today, and it is the mechanism that matters:
# skills, agents, rules and hooks each got a retired list; MCPs never did, so a server the stack
# dropped stayed registered in every existing install and kept injecting its tool schemas on every
# session (measured: 24 playwright schemas re-injected into a headless backend project). A server
# the stack still SHIPS but this project no longer needs is a different question - that is
# /claude-stack:validate's whole-stack-absent pass, not a retirement.
RETIRED_MCPS=()

remove_skills() {  # rm -rf each manifest skill under the scope dest, so update starts from a clean slate
  local dest entry name
  case "$CLAUDE_SCOPE" in user) dest="$CONFIG_DIR/skills" ;; *) dest="$PWD/.claude/skills" ;; esac
  log "skills [$CLAUDE_SCOPE]: removing ${#SKILLS[@]} for clean reinstall"
  for entry in ${SKILLS[@]+"${SKILLS[@]}"}; do
    name="${entry#*|}"
    rm -rf "$dest/$name"
  done
  for name in ${RETIRED_SKILLS[@]+"${RETIRED_SKILLS[@]}"}; do
    [ -d "$dest/$name" ] && { rm -rf "${dest:?}/$name"; log "  skill pruned (retired upstream): $name"; }
  done
  return 0
}

prune_retired_agents() {  # UPDATE: drop the known old agent names (RETIRED_AGENTS above)
  local root name; root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  for name in ${RETIRED_AGENTS[@]+"${RETIRED_AGENTS[@]}"}; do
    [ -f "$root/.claude/agents/$name" ] && { rm -f "$root/.claude/agents/$name"; log "  agent pruned (retired upstream): $name"; }
  done
  return 0
}

prune_retired_rules() {  # UPDATE: drop the known old rule names (RETIRED_RULES above)
  # A leftover rule is worse than a leftover skill: a pathless baseline-*.md is loaded into EVERY
  # session and subagent, so a retired copy keeps shipping guidance its replacement already merged
  # (measured on a real install: 7 of 14 rule files were names this release no longer ships).
  local root name; root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  for name in ${RETIRED_RULES[@]+"${RETIRED_RULES[@]}"}; do
    [ -f "$root/.claude/rules/$name" ] && { rm -f "$root/.claude/rules/$name"; log "  rule pruned (retired upstream): $name"; }
  done
  return 0
}

prune_retired_hooks() {  # UPDATE: drop the known old hook names (RETIRED_HOOKS above)
  # The file only - wire_hooks_settings drops the matching settings.json entries in the same run
  # (a wired command whose file is gone spawns a failure on every matching tool call).
  local root name; root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  for name in ${RETIRED_HOOKS[@]+"${RETIRED_HOOKS[@]}"}; do
    [ -f "$root/.claude/hooks/$name" ] && { rm -f "$root/.claude/hooks/$name"; log "  hook pruned (retired upstream): $name"; }
  done
  return 0
}

update_skills() {
  # Fresh clone + copy - the same as install (the copy overwrites), just cleared first.
  remove_skills
  install_skills
}

update_plugins() {
  command -v claude >/dev/null 2>&1 || { CLAUDE_MISSING=true; return 0; }   # fail-soft: skip, never abort the run
  claude plugin marketplace update 2>/dev/null || true            # refresh marketplaces first
  for p in ${PLUGINS[@]+"${PLUGINS[@]}"}; do
    pscope="$CLAUDE_SCOPE"; case "$p" in claude-hud@*) pscope="user" ;; esac   # claude-hud is user-scope (statusline)
    log "plugin update [$pscope]: $p"
    claude plugin update "$p" --scope "$pscope" -y 2>&1 | tail -1 || true   # -y for the same non-TTY reason as install
  done
}

prune_retired_mcps() {  # UPDATE: unregister the known retired server names (RETIRED_MCPS above)
  local name
  for name in ${RETIRED_MCPS[@]+"${RETIRED_MCPS[@]}"}; do
    claude mcp remove "$name" -s "$CLAUDE_SCOPE" >/dev/null 2>&1 && log "  mcp pruned (retired upstream): $name"
  done
  return 0
}

update_mcps() {
  command -v claude >/dev/null 2>&1 || { CLAUDE_MISSING=true; return 0; }   # fail-soft: skip, never abort the run
  prune_retired_mcps
  # Only the @latest entries (chrome-devtools, appium-mcp) float at launch; the pinned ones (playwright,
  # serena, memory, context7 when local) bump here via remove + re-add. angular-cli stays unpinned by
  # design; the hosted servers (context7 remote, sentry) have nothing to pin.
  local entry name args url hdr
  local -a spec_words
  for entry in ${MCPS[@]+"${MCPS[@]}"}; do
    name="${entry%%|*}"; args="${entry#*|}"
    log "mcp refresh [$CLAUDE_SCOPE]: $name"
    if [ "$name" = "sentry" ] && [ -n "$SENTRY_SLUG" ]; then seed_account_env SENTRY_SLUG "$SENTRY_SLUG"; fi
    claude mcp remove "$name" -s "$CLAUDE_SCOPE" >/dev/null 2>&1 || true
    if [ "$args" = "@HTTP@" ]; then
      # remote (hosted) server - url/header keyed by name: sentry, else context7. An EMPTY header
      # (sentry --sentry-auth oauth) registers with no --header at all, so the OAuth fallback stays on.
      if [ "$name" = "sentry" ]; then url="$SENTRY_REMOTE_URL"; hdr="$SENTRY_REMOTE_HDR"
      else url="$CONTEXT7_REMOTE_URL"; hdr="$CONTEXT7_REMOTE_HDR"; fi
      if [ -n "$hdr" ]; then
        claude mcp add --transport http --scope "$CLAUDE_SCOPE" "$name" "$url" --header "$hdr" || note_failure "mcp $name failed"
      else
        claude mcp add --transport http --scope "$CLAUDE_SCOPE" "$name" "$url" || note_failure "mcp $name failed"
      fi
      continue
    fi
    _mcp_argv "$args"   # split-first + per-word token resolution, as in install_mcps
    claude mcp add --scope "$CLAUDE_SCOPE" "$name" "${spec_words[@]}" || note_failure "mcp $name failed"
  done
}

update_hooks() { prune_retired_hooks; download_hooks; wire_hooks_settings; }   # UPDATE: refresh hook files + re-ensure the settings.json wiring (idempotent - a new hook block, deny rule, or env key ships to updated projects too)
update_agents() { prune_retired_agents; download_agents; } # UPDATE: drop retired names, refresh subagent files
update_rules() { prune_retired_rules; download_rules; }   # UPDATE: drop retired names, refresh rule files

# ===========================================================================
# KEEP-PINS (--keep-pins) - preserve local model/effort frontmatter edits across the refresh.
# The agent fetch and the skills clean-reinstall reset every file to upstream, wiping a per-project
# model/effort re-pin. With --keep-pins the values are snapshotted BEFORE the refresh and re-applied
# AFTER it - only keys present in both the old local file and the refreshed one (no add/remove), and
# the local value always wins over an upstream pin change (the flag cannot tell the two apart).
# ===========================================================================
_fm_pin() {  # $1=file $2=key -> print the key's value from the leading frontmatter block ('' if absent)
  awk -v k="$2" '
    NR==1 { if ($0 !~ /^---[[:space:]]*$/) exit; next }
    /^---[[:space:]]*$/ { exit }
    index($0, k":") == 1 { sub("^"k":[[:space:]]*", ""); sub(/[[:space:]]+$/, ""); print; exit }
  ' "$1" 2>/dev/null
}

_fm_set_pin() {  # $1=file $2=key $3=value - rewrite the key's line INSIDE the frontmatter block only
  local tmp; tmp="$(mktemp)"
  awk -v k="$2" -v v="$3" '
    NR==1 && /^---[[:space:]]*$/ { fm=1; print; next }
    fm==1 && /^---[[:space:]]*$/ { fm=2; print; next }
    fm==1 && index($0, k":") == 1 { print k": "v; next }
    { print }
  ' "$1" > "$tmp" && mv "$tmp" "$1"
}

_pin_files() {  # print every locally-installed pin-bearing target: manifest agents + skill SKILL.md files
  local root file entry skills_dir
  root="$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
  for file in ${AGENTS[@]+"${AGENTS[@]}"}; do
    [ -f "$root/.claude/agents/$file" ] && printf '%s\n' "$root/.claude/agents/$file"
  done
  if [ "$SCOPE" = "project" ]; then skills_dir="$root/.claude/skills"; else skills_dir="$CONFIG_DIR/skills"; fi
  for entry in ${SKILLS[@]+"${SKILLS[@]}"}; do
    [ -f "$skills_dir/${entry#*|}/SKILL.md" ] && printf '%s\n' "$skills_dir/${entry#*|}/SKILL.md"
  done
}

PIN_DIR=""
snapshot_pins() {  # --keep-pins: record each installed agent/skill file's model/effort before the refresh
  $KEEP_PINS || return 0
  PIN_DIR="$(mktemp -d)"
  local f key m e count=0
  while IFS= read -r f; do
    m="$(_fm_pin "$f" model)"; e="$(_fm_pin "$f" effort)"
    [ -z "$m" ] && [ -z "$e" ] && continue
    key="$(printf '%s' "$f" | tr '/' '_')"   # flatten the path -> one snapshot file per target
    printf 'model=%s\neffort=%s\n' "$m" "$e" > "$PIN_DIR/$key"
    count=$((count + 1))
  done < <(_pin_files)
  log "keep-pins: snapshotted model/effort from $count file(s)"
}

restore_pins() {  # --keep-pins: re-apply every snapshotted value the refresh changed
  $KEEP_PINS || return 0
  [ -n "$PIN_DIR" ] || return 0
  local f key k saved cur disp kept=0
  while IFS= read -r f; do
    key="$(printf '%s' "$f" | tr '/' '_')"
    [ -f "$PIN_DIR/$key" ] || continue
    case "$f" in
      */.claude/agents/*) disp="agents/${f##*/.claude/agents/}" ;;
      */skills/*)         disp="skills/${f##*/skills/}" ;;
      *)                  disp="$f" ;;
    esac
    for k in model effort; do
      saved="$(sed -n "s/^$k=//p" "$PIN_DIR/$key")"
      [ -n "$saved" ] || continue
      cur="$(_fm_pin "$f" "$k")"
      if [ -n "$cur" ] && [ "$cur" != "$saved" ]; then
        _fm_set_pin "$f" "$k" "$saved"; kept=$((kept + 1))
        log "  pin kept: $disp $k=$saved (upstream: $cur)"
      fi
    done
  done < <(_pin_files)
  rm -rf "$PIN_DIR"; PIN_DIR=""
  log "keep-pins: re-applied $kept local pin value(s)"
}

prune_agents_cache() {
  # Legacy cleanup: an npx-skills-era install staged an agent-neutral .agents/ store. The git-copy
  # install_skills never creates one, so this is a no-op on a fresh install and only matters for a
  # project upgrading from the old flow. Guard: keep it if any skill entry under .claude/skills is a
  # symlink (a symlinked tree still depends on .agents/; removing it would dangle).
  local root d; root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  [ -d "$root/.agents" ] || return 0
  local has_symlink=false
  for d in "$root/.claude/skills"; do
    [ -d "$d" ] || continue
    if find "$d" -maxdepth 1 -type l 2>/dev/null | grep -q .; then has_symlink=true; break; fi
  done
  if $has_symlink; then
    log "  kept .agents/ - a skills tree has symlinks that still depend on it"
  else
    rm -rf "$root/.agents" && log "  pruned .agents/ (skills are real per-agent copies)"
  fi
}

# ===========================================================================
# DISPATCH
# ===========================================================================
# --skills-only: run ONLY the skill step and exit, before any prerequisite check or claude-CLI-
# dependent step (testability - drives just the git-copy with no claude/gh/network dependency).
if [ "$SKILLS_ONLY" = true ]; then
  if [ "$ACTION" = "install" ]; then install_skills; else update_skills; fi
  write_stamp   # a skills-only run still installs FROM a revision - record it
  exit 0
fi

prerequisites_check
install_github_cli

# claude-only steps fail soft (command -v claude) if the CLI is not installed.
snapshot_pins   # --keep-pins only: no-op without the flag (install re-adds skills unconditionally too, so both actions refresh)
if [ "$ACTION" = "install" ]; then
  install_skills; install_plugins; install_mcps; download_hooks; wire_hooks_settings; download_agents; download_rules; seed_claude_md; seed_serena_project
else
  update_skills; update_plugins; update_mcps; update_hooks; update_agents; update_rules; seed_serena_project
fi
restore_pins
write_stamp   # after every copy step, so the stamp only ever names a revision that fully landed

prune_agents_cache
echo
log "done: $ACTION [scope=$SCOPE, account=$CONFIG_DIR, agent=$AGENT]"
_hook_files=0; _seen=""   # count hook FILES (a hook wired on two tools is one hook), matching the plan (ten hooks today)
for _e in ${HOOKS[@]+"${HOOKS[@]}"}; do _n="${_e%%::*}"; case " $_seen " in *" $_n "*) continue ;; esac; _seen="$_seen $_n"; _hook_files=$((_hook_files + 1)); done
_summary="  installed/refreshed this run - skills=${#SKILLS[@]}, plugins=${#PLUGINS[@]}, mcps=${#MCPS[@]}, hooks=$_hook_files, agents=${#AGENTS[@]}, rules=${#CLAUDE_RULES[@]}"
[ -n "$SPACE" ] && _summary="$_summary; space=$SPACE, memory DB=$MEMORY_DB_FILE"
[ "$KEEP_PINS" = true ] && _summary="$_summary; keep-pins=on"
log "$_summary; context7=$CONTEXT7_MODE"
# The counts above are the SELECTION this run wrote, not a listing of .claude/ - generated
# project-owned files and names this release no longer ships are neither refreshed nor counted
# (a real install compared its 14 rule FILES against rules=4 and read it as a silent drop).
[ "$INSTALLED_ONLY" = true ] && log "  (a directory listing can be larger: generated project files and any 'unknown:' name above are left untouched)"
if [ "$CLAUDE_MISSING" = true ]; then
  log "  !! claude CLI absent - plugins, MCPs, and settings.json wiring were SKIPPED (install it, then re-run)"
fi
if [ "$FAIL_COUNT" -gt 0 ]; then
  log "  !! $FAIL_COUNT item(s) failed above - re-run '$ACTION' to retry"
fi

log "next steps:"
log "  - write your project's CLAUDE.md top from the template's authoring-outline comment (framework, stack, conventions, secret/config globs) - install seeds a starter from the template when the project has none; the claude-md-management plugin can help audit it"
log "  - if this repo has sibling projects (a backend/frontend pair, a consumed package), run /project-related-context with their paths/URLs - it generates the awareness rule (baseline-project-related-context.md) + related-context/PROJECT-RELATED-CONTEXT.md under the docs root"
log "  - once oriented, run the other two captures the CLAUDE.md rules table names: /project-architecture-analyzer (architecture map + assessment + awareness rule) and /project-code-style-analyzer (PROJECT-CODE-STYLE.md under the docs root + the generated path-scoped style rule)"
log "  - run /project-agent-capabilities LAST - it inventories the installed skills/agents/MCPs and generates baseline-project-agent-capabilities.md (re-run after update or a manifest trim)"
if printf '%s\n' ${MCPS[@]+"${MCPS[@]}"} | grep -q '^serena|'; then
  log "  - index the codebase for serena ONCE (a few seconds to a few minutes; the first run also downloads the language server): SERENA_HOME=.serena/home uvx --from serena-agent serena project index - re-run it after a large refactor, a branch switch that moves many files, or whenever symbol lookups start missing things"
fi
log "  - restart Claude Code (or reopen the project) to load the new MCPs, hooks, and settings"
[ "$PREREQ_MISSING" = true ] && log "  - install the missing prerequisites flagged above, then re-run"
if [ "$CONTEXT7_MODE" = "remote" ]; then
  log "  - context7 is remote; add CONTEXT7_API_KEY to $CONFIG_DIR/settings.json 'env' (the ACCOUNT file - a project-level one does not reach .mcp.json) for higher rate limits, or re-run with --context7 local"
fi
if printf '%s\n' ${MCPS[@]+"${MCPS[@]}"} | grep -q '^sentry|'; then
  log "  - sentry reads SENTRY_SLUG (your org, or org/project) from $CONFIG_DIR/settings.json 'env' - seeded by --sentry-slug, or add it there by hand (a project-level settings.json does not reach .mcp.json)"
  if [ "$SENTRY_AUTH" = "token" ]; then
    log "  - sentry auth is token: add SENTRY_ACCESS_TOKEN (a personal/org API token) to the same $CONFIG_DIR/settings.json 'env' yourself - or re-run with --sentry-auth oauth for the browser consent flow"
    # The token never goes through a chat, and not through a shell argument either (it would land in
    # the history file). getpass reads it from the terminal without echoing; the file is written by
    # this snippet, not by anything that can log the value.
    log "      the token never travels through a chat, and does not belong in a shell argument. Paste it into this:"
    log "      python3 -c \"import getpass,json,pathlib;f=pathlib.Path('$CONFIG_DIR/settings.json');d=json.loads(f.read_text() or '{}') if f.exists() else {};d.setdefault('env',{})['SENTRY_ACCESS_TOKEN']=getpass.getpass('token (not echoed): ');f.parent.mkdir(parents=True,exist_ok=True);f.write_text(json.dumps(d,indent=2))\""
  else log "  - sentry is registered with no header: the first use opens Sentry's consent flow in the browser via /mcp"; fi
fi
[ "$INSTALL_GITHUB_CLI" = true ] && log "  - run 'gh auth login' if gh is not yet authenticated (needed before PRs/issues)"

# Reminder: stack-generated, machine-local artifacts that should NOT be committed.
cat <<'GITIGNORE'

Add these stack-generated, machine-local artifacts to the project's .gitignore (or .git/info/exclude):
  .serena          serena per-project state: registry, cache, language servers (SERENA_HOME=.serena/home)
  .claude/*        Claude Code project config + local state (settings.local.json, hooks) - ignore the contents...
  !.claude/CLAUDE.md   ...but TRACK the project instructions: they live at .claude/CLAUDE.md and must be committed (git can only re-include a file if the parent dir is not wholesale-ignored, hence '.claude/*' not '.claude/')
  .slopwatch       dotnet-slopwatch output
  .playwright      playwright MCP user-data-dir + output (screenshots, traces)
  .mcp.json        generated MCP server config (machine-local)

The generated-docs root is CLAUDE_STACK_DOCS_PATH in .claude/settings.json env (seeded '.claude/docs') -
generated docs inherit the .claude ignore above and are machine-local: not committed, not shared,
re-captured after a fresh clone. To share them with the team, set CLAUDE_STACK_DOCS_PATH to a committed
path (e.g. 'docs', forward slashes on every OS) and track <docs-path>/superpowers/ too.

The same env block carries the fresh-session gate's two knobs (seeded, absent-only, so a
hand-edited value survives every update):
  CLAUDE_STACK_FRESH_SESSION_PCT   what share of the context window a session may carry before an
                                   orchestration run is offered a fresh one (default 40; 0 = off)
  CLAUDE_STACK_CONTEXT_WINDOW      the window that percentage applies to - seeded 'AUTO', which
                                   means auto-detect: the hooks read the settings model id's
                                   window suffix ('opus[1m]'), else the tier the session has
                                   already proven. Put a number there ('1000000' / '200000') only
                                   to overrule that; it outranks every detection layer.
On the auto-detected 200k tier the percentage is INERT below 76: the trigger keeps the measured
150k floor, and 200k x 75% is still 150k. Above that tier it is capped at 250k, because the
harness auto-compacts at ~390k and a trigger above that ceiling can never fire.
GITIGNORE
