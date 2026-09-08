# claude-stack

The Claude Code half of a coding-agent setup - an installable stack of house skills,
subagents, always-on and path-scoped rules, hooks, MCP servers, and plugins that gets applied to
the projects you actually work in. This repo is the single source of truth: everything installs from
one release archive of this repo per run (the rolling `latest` release, with a shallow git clone
as the fallback - either way an install is a single source revision, recorded in
`.claude/claude-stack.stamp`), and consuming projects pull from here rather than
owning their copy. The **Cursor** twin stack lives in its own repo,
[`cursor-stack`](https://github.com/envoydev/cursor-stack) - its installers clone THIS repo for
the shared skills, so the baseline stays single-sourced here.

What it gives a project: consistent house conventions that attach themselves to the right file
types, single-chat and multi-agent build workflows with quality gates, per-project MCP wiring
(docs lookup, symbol navigation, browser and mobile automation, error monitoring), and a guided
install/update flow.

## Technologies

The stack is built for this house's verticals:

- **.NET / C#** - ASP.NET web/API, WPF desktop, console workers / bots / daemons / CLIs
- **Angular / TypeScript** - web frontend, plus Ionic/Capacitor hybrid mobile
- **SQL** - PostgreSQL, SQLite, SQL Server (schema, migrations, query conventions)
- **DevOps** - Docker, GitHub Actions

## What gets installed

| Surface | Count | What it is |
| ------- | ----- | ---------- |
| **Skills** | 78 | house conventions + workflow skills, `.claude/skills/` |
| **Agents** | 43 | model/effort-pinned subagents, `.claude/agents/` |
| **Rules** | 18 | always-on baselines + path-scoped conventions, `.claude/rules/` |
| **Hooks** | 11 | deterministic guards + an env-gated usage instrument (off by default), `.claude/hooks/` |
| **MCP servers** | 8 | per-project registrations in `<repo>/.mcp.json` |
| **Plugins** | 7 | installed via the `claude` CLI |

The full inventory - what every skill, agent, rule, and hook actually does - lives in the browser
inventory at [`docs/claude-stack.html`](docs/claude-stack.html), not in this README.

## Install - with the marketplace plugin (guided)

Register the marketplace and install the setup plugin **per project** - run both commands from
inside the project, so the plugin binding lands in that project's own config. Per-project is the
default to prefer: each repo pins exactly what it uses, and a machine-wide default never leaks
the plugin into projects that do not want it (a user-scope install works, but choose it
deliberately):

```
cd <your-project>
claude plugin marketplace add envoydev/claude-stack
claude plugin install claude-stack@claude-stack
```

Then `/claude-stack:setup` runs a fresh install (in a project it decides the selection FROM the
project; outside one it offers a global install from the recommended set),
`/claude-stack:update` refreshes an existing one to the newest release and prunes what the stack
removed upstream, `/claude-stack:configure` adjusts it (add or drop items), and
`/claude-stack:validate` reconciles an install against THIS project - prunes what its frameworks do
not use and adds the detected stacks' missing artifacts, a per-layer walk (project mode only); and
`/claude-stack:status` shows the install read-only, one table per area.
Setup and configure walk the selection one layer at a time (rules ->
agents -> skills -> hooks -> MCPs -> plugins) as numbered full-catalog tables, locking only what
something kept still requires - always with the reason shown. A deterministic evidence scan of
the project's package manifests (csproj / package.json) pre-selects the specialist skills the
project provably uses, the matched signal shown as the reason. All detect the OS, the install
commands check prerequisites before anything runs, and `/claude-stack` alone routes by state.

## Install - with the script

The **action** (`install` | `update`) is the one required argument. Download the installer into
the project's `.claude/` and keep it there - the copy is the per-project manifest you trim and
re-run.

macOS / Linux (`claude-stack.sh`):

```bash
cd /path/to/your/project
mkdir -p .claude && curl -fsSL https://raw.githubusercontent.com/envoydev/claude-stack/main/scripts/os/claude-stack.sh -o .claude/claude-stack.sh

bash .claude/claude-stack.sh install                 # first time
bash .claude/claude-stack.sh update --installed-only # later refreshes - only what is already installed, from disk
bash .claude/claude-stack.sh install --skills-only   # just the skills, nothing else

# Named flags (any order): --space, --scope, --context7, --sentry-slug, --sentry-auth, --github-cli, --keep-pins, --selection, --installed-only, --print-plan, --skills-only, --source
bash .claude/claude-stack.sh install --space work --scope global --context7 local
```

Windows (`claude-stack.ps1`):

```powershell
Set-Location C:\path\to\your\project
New-Item -ItemType Directory -Force .claude | Out-Null
Invoke-WebRequest -Uri https://raw.githubusercontent.com/envoydev/claude-stack/main/scripts/os/claude-stack.ps1 -OutFile .claude/claude-stack.ps1

pwsh .claude/claude-stack.ps1 install                # first time
pwsh .claude/claude-stack.ps1 update -InstalledOnly  # later refreshes - only what is already installed, from disk
pwsh .claude/claude-stack.ps1 install -Space work -Scope global -Context7 local
```

Hard prerequisites: **node ≥ 22.12**, the **claude** CLI, and **git** (the installers use it to
find the repo root, and it is the download fallback when no release archive is reachable).
Everything else is per-surface - the script runs a prerequisites check first and warns
(never fails) on what's missing, and the guided plugin flow walks you through the fixes.

Each run stamps the installed source commit into `claude-stack.stamp`;
`/claude-stack:configure` diffs it against `main` to tell you what an update would bring.

## Token & tool usage analysis

The one piece of the stack worth naming here: the installed hook
`.claude/hooks/instrument-tool-usage.js` records per-run tool / skill / MCP usage - wired by
default behind an env gate, so it costs nothing until you flip `CLAUDE_STACK_INSTRUMENT` from `"0"` to
`"1"` in `.claude/settings.json` env (flip it back after the measured run), and
[`scripts/analyze-usage.js`](scripts/analyze-usage.js) mines a session's transcript JSONL (plus
its dispatched subagents) into a token/consumption report - join the two with `--hook-log` to see
what fired and what it cost.

```bash
node scripts/analyze-usage.js ~/.claude/projects/<encoded-project>/<session-id>.jsonl
```

## License

[MIT](LICENSE) © 2026 envoydev
