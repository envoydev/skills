#!/usr/bin/env node
'use strict';

// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// instrument-tool-usage.js - env-gated PreToolUse instrumentation (wired by default, OFF by default).
//
// Why: the orchestrator cannot see which Skill / MCP a dispatched subagent loaded or
// called - only that subagent's aggregate token/tool_use totals. That makes a real run's
// tool / skill / MCP usage un-auditable (an audit or benchmark can only ASSESS it, not
// MEASURE it). This hook logs every tool call - built-ins (Read / Edit / Grep / Bash / Task / ...)
// plus `Skill` and `mcp__*` - as one JSONL line so a run can be tallied exactly. It NEVER blocks
// a call - it observes and exits 0.
//
// The installer wires this on matcher '.*' behind a shell gate - `[ "$CLAUDE_STACK_INSTRUMENT" != "1" ] ||` -
// so when the switch is off the per-call cost is a shell test, never a node spawn. The switch is
// `CLAUDE_STACK_INSTRUMENT` in .claude/settings.json env, seeded "0": flip it to "1" for a measured
// benchmark / audit run (optionally CLAUDE_STACK_INSTRUMENT_LOG=<path>), back to "0" after. The env check
// below is the belt for a gate-less manual wiring: only the literal value 1 (or true) records.
//
// Output: one JSONL row per matched call at
//   $CLAUDE_STACK_INSTRUMENT_LOG  (default: <docs-path>/tools-usage/<session-or-agent-id>.jsonl,
//   the docs root resolved from CLAUDE_STACK_DOCS_PATH like every generated artifact)
// Coverage note: PreToolUse fires for the session's tool calls; where the running Claude
// Code build propagates PreToolUse into dispatched subagents, their internal Skill / MCP
// calls are captured too - verify coverage against a known run before trusting a tally.

const sw = String(process.env.CLAUDE_STACK_INSTRUMENT || '').toLowerCase();
if (sw !== '1' && sw !== 'true') process.exit(0); // off unless explicitly switched on ("0"/"false"/unset = no-op)

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  try {
    const ev = JSON.parse(raw || '{}');
    const tool = ev.tool_name || '';
    if (!tool) { process.exit(0); }
    const input = ev.tool_input || {};
    const path = require('path');
    const fs = require('fs');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving
// (the installers rename the key in place on the next install/update).
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';
    // Every tool call is logged (built-ins like Read/Edit/Grep/Bash/Task + Skill + mcp__*).
    // `detail` is a lightweight, non-sensitive hint per tool family - NEVER a command body,
    // file contents, or a full payload: the skill slug, the mcp server, a file's basename,
    // a search pattern, or a Bash step's description.
    let detail = null;
    if (tool === 'Skill') detail = input.skill || input.name || null;
    else if (tool.startsWith('mcp__')) detail = tool.split('__')[1] || null;
    else if (input.file_path) detail = path.basename(String(input.file_path));
    else if (input.pattern) detail = String(input.pattern).slice(0, 60);
    else if (tool === 'Bash') detail = input.description ? String(input.description).slice(0, 60) : null;
    const rec = {
      ts: new Date().toISOString(),
      session: ev.session_id || null,
      tool,
      detail,
      cwd: ev.cwd || null,
    };
    const dir = process.env.CLAUDE_PROJECT_DIR || ev.cwd || '.';
    // one ledger per session/agent id - the filename matches the transcript's id for the --hook-log join
    const sid = String(ev.session_id || 'session').replace(/[^A-Za-z0-9._-]/g, '');
    const docsRoot = docsRootEnv();
    const out =
      process.env.CLAUDE_STACK_INSTRUMENT_LOG ||
      path.resolve(dir, docsRoot, 'tools-usage', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.appendFileSync(out, JSON.stringify(rec) + '\n');
  } catch {
    // never break a tool call because instrumentation hiccuped
  }
  process.exit(0);
});
