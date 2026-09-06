#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// Three routes into ONE decision: a DELIBERATE orchestration run - a capture, a loop, a solve
// flow - must start in a session that is not already carrying a finished run's history.
//   PreToolUse (Skill)      - the run arrives as a Skill call. Blocks (exit 2).
//   UserPromptSubmit        - the run arrives as a SLASH COMMAND, which emits NO Skill event at
//                             all: measured 4 of 4 runs slash-injected, ZERO Skill tool_use events
//                             in 45 messages, two captures entered at 150k and 164k, both ungated.
//                             This route INJECTS the ask; it never denies, because a
//                             UserPromptSubmit exit 2 ERASES the user's prompt and shows the
//                             reason to the user only - the run would be lost and the model would
//                             never learn why.
//   SessionStart (compact)  - the harness has just auto-compacted, which is PROOF the session
//                             reached the ceiling the gate exists for (~390k measured across three
//                             projects), at a moment a Stop may never come (measured: 23m27s /
//                             277 messages / +178k ctx, zero Stop events; and a conforming
//                             solve-task run emits zero Stops BY DESIGN). Injects, cannot block. The rule existed as
// prose in the generated capabilities rule and lost every time it was tested: measured across 4
// sessions, one of which NAMED the fresh-session need in its own text ('a fresh session is the
// right home for a loop like this') and then ran the loop anyway, to 380k tokens per message.
// Same step run fresh in the next session cost 134k. This is that rule mechanized.
//
// It blocks only when BOTH hold: the session's context is already past the threshold, AND the
// incoming skill is one of the orchestration entry points below. Everything else passes.
// exit 2 = block (stderr fed back); exit 0 = allow. Fail-open on anything unparseable.
const fs = require('fs');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving
// (the installers rename the key in place on the next install/update).
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';
let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (!payload || typeof payload !== 'object') process.exit(0); // a JSON scalar/null - nothing to judge

// --- block telemetry (shared by every guard hook; keep the copies identical) ------------
// A block costs a whole turn - the stderr goes back to the model and the work is re-done - so a
// FALSE positive is 10-100x the cost of the gate itself, and until this existed the block rate was
// the one number the stack could not measure (measured 2026-09-04: the hooks emit ~22-25ms and
// nothing else). One JSONL row per block, written where the tool-usage instrument writes, so
// scripts/analyze-usage.js can tally both from the same docs root. Best-effort in every direction:
// telemetry never changes the verdict and never throws.
(() => {
  let last = '';
  const w = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => { last = String(chunk); return w(chunk, ...rest); };
  const exit = process.exit.bind(process);
  process.exit = (code) => {
    if (code === 2) {
      try {
        const fs = require('fs');
        const path = require('path');
        const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
        // resolve, NOT join: an ABSOLUTE CLAUDE_STACK_DOCS_PATH makes path.join('/a/b','/x/y')
        // '/a/b/x/y', so every ledger row landed in a doubled path that nothing reads (measured
        // across all ten guards). resolve honours an absolute value and still joins a relative one.
        const dir = path.resolve(root, docsRootEnv(), 'hook-blocks');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, `${payload.session_id || 'nosession'}.jsonl`), JSON.stringify({
          ts: new Date().toISOString(),
          hook: path.basename(__filename),
          event: payload.hook_event_name || payload.tool_name || '',
          tool: payload.tool_name || '',
          reason: last.split('\n')[0].slice(0, 200),
        }) + '\n');
      } catch { /* telemetry is never allowed to break the gate */ }
    }
    exit(code);
  };
})();
const EVENT = payload.hook_event_name || '';
const IS_SKILL_CALL = payload.tool_name === 'Skill';
if (!IS_SKILL_CALL && EVENT !== 'UserPromptSubmit' && EVENT !== 'SessionStart') process.exit(0);

// The trigger scales with the CONTEXT WINDOW, not a flat token count. A fixed 150k is ~75% of a
// 200k window (where it was measured) but only 15% of a 1M-context session, which is why it fired
// on nearly every ask there. Percent is tunable per machine with CLAUDE_STACK_FRESH_SESSION_PCT
// (default 40, the same shape as the harness's own auto-compact percentage), seeded into the scope
// settings.json `env` beside CLAUDE_STACK_CONTEXT_WINDOW; where the WINDOW comes from is below.
const _pct = parseInt(process.env.CLAUDE_STACK_FRESH_SESSION_PCT, 10);
// 0 DISABLES the gate outright - a `|| 40` fallback silently turned the off switch back on.
const FRESH_PCT = _pct === 0 ? 0 : Math.min(95, Math.max(5, Number.isNaN(_pct) ? 40 : _pct));
const CTX_FLOOR = 150000;
// The upper bound on any window larger than 200k - see ctxThreshold. Without it the trigger lands
// above the harness's own auto-compact ceiling and the gate can never fire. Keep in sync with the
// identical constant in guard-stop-contract.js.
const CTX_CEILING = 250000;

// --- which context WINDOW is this session running in? -------------------------------------
// Measured on a 1M session: the transcript's message.model records `claude-opus-5` with the
// `[1m]` suffix STRIPPED, the PreToolUse payload carries only cwd/session_id/tool_name/
// tool_input/transcript_path, no transcript field names a window or a token limit, and no env
// var carries the model. settings.json's `model` keeps it - and so does the transcript's own
// `cost-state` record (`modelUsage` is keyed `claude-opus-5[1m]`), which the earlier text
// wrongly called the ONLY source; measured on CLI 2.1.258 and 2.1.261. settings.json's
// `model` (e.g. `opus[1m]`). So, first layer that resolves wins:
//   1. CLAUDE_STACK_CONTEXT_WINDOW - the user's own statement, so it outranks every guess. It
//      goes in the scope settings.json `env` block, seeded `1000000` by the installer and meant to
//      be corrected to `200000` on a 200k model; cleared, it falls through to the layers below.
//      Ranking it BELOW the model id would make it dead on every machine whose settings names a
//      plain model, since that layer would already have answered 200k.
//   2. the settings.json model id's own window suffix - `[1m]`, `[200k]`. A property of the id,
//      never a model -> window TABLE: a table goes stale on every model release, and a wrong
//      guess on an unknown id is worse than falling through to what the session proves.
//   3. what this session has already carried - no request can hold more input tokens than the
//      window, so a message past 200k proves the 1M tier. Latched once proven (below).
// Nothing resolves: 200k, which is exactly the behaviour before this existed.
const _win = parseInt(process.env.CLAUDE_STACK_CONTEXT_WINDOW, 10);
// Below the smallest real window the value is not a window - it FALLS THROUGH to the next layer,
// the same answer windowFromModelId gives a bad suffix and the same one environment.json's
// `min` flags to validate. Clamping it up instead was three answers to one question: the hook
// silently ran on a 100k window while the reconciler called the value invalid.
const WINDOW_OVERRIDE = _win >= 100000 ? _win : null;
function windowFromModelId(id) {
  const m = /\[(\d+)\s*([km])\]/i.exec(String(id || ''));
  if (!m) return null;
  const n = parseInt(m[1], 10) * (m[2].toLowerCase() === 'm' ? 1000000 : 1000);
  return n >= 100000 ? n : null;   // a suffix that is not a window size proves nothing
}
function settingsModelWindow() {
  try {
    const path = require('path');
    const os = require('os');
    const root = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();
    const account = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir() || '', '.claude');
    for (const f of [
      path.join(root, '.claude', 'settings.local.json'),
      path.join(root, '.claude', 'settings.json'),
      path.join(account, 'settings.json'),
    ]) {
      try {
        const w = windowFromModelId(JSON.parse(fs.readFileSync(f, 'utf8')).model);
        if (w) return w;
      } catch { /* absent, unreadable, or not JSON - try the next file */ }
    }
  } catch { /* no home and no cwd - fall through to the next layer */ }
  return null;
}
// The proven tier is LATCHED per session: the max-context scan reads a 512KB transcript TAIL, so
// a long session's early 200k crossing scrolls out of it and the tier would regress from 400k
// back to 150k mid-session. One file per transcript, beside the stop hook's own state.
function tierFile() {
  const os = require('os');
  const key = String(payload.transcript_path || '').replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
  return `${process.env.CLAUDE_STACK_HOOK_LOG_DIR || os.tmpdir()}/guard-ctx-window-${key}.tier`;
}
function latchedWindow() {
  if (!payload.transcript_path) return null;
  try {
    const n = parseInt(fs.readFileSync(tierFile(), 'utf8'), 10);
    return Number.isNaN(n) ? null : n;
  } catch { return null; }
}
function latchWindow(w) {
  if (!payload.transcript_path) return;
  try { fs.writeFileSync(tierFile(), String(w)); } catch { /* best effort - the latch is a cache */ }
}
let _knownWindow;
function knownWindow() {
  if (_knownWindow === undefined) _knownWindow = WINDOW_OVERRIDE || settingsModelWindow() || latchedWindow() || null;
  return _knownWindow;
}
// `proveTier` is LAZY - a thunk returning the largest per-message context seen. A known window
// answers without calling it, which is what keeps the stop hook from re-reading the 512KB
// transcript tail it has already read once per clean turn close.
function ctxThreshold(proveTier) {
  let window = knownWindow();
  if (!window) {
    window = proveTier() > 200000 ? 1000000 : 200000;
    if (window > 200000) latchWindow(window);
  }
  const pct = Math.round((window * FRESH_PCT) / 100);
  // The floor is the MEASURED 200k-tier behaviour, kept so those sessions are unchanged; a window
  // known to be larger is never clamped back down to it (on 1M the percentage IS the setting).
  // Above the 200k tier the PERCENTAGE ALONE IS UNUSABLE: the FRESH_PCT default (40) is the SAME
  // NUMBER as the harness's own auto-compact percentage, so 40% of 1M is 400,000 - above the
  // ceiling the harness actually enforces (measured 387,619-397,171 across three projects). The
  // gate could never fire on a 1M account. Identical to guard-stop-contract.js's copy.
  return window > 200000 ? Math.min(pct, CTX_CEILING) : Math.max(CTX_FLOOR, pct);
}
// The deliberate entry points: each one opens a multi-phase run with its own state file, so a
// fresh session resuming from that file is always cheaper than continuing on carried context.
// The review and per-phase seats are here because they are the same population, measured: one
// session started `project-verify-code` at 364.6k and `security-review` at 383.1k, together 13.7M
// cache-read - 27% of the whole session - for 20.5k of output, and the offer arrived nine minutes
// after that spend. `project-agent-capabilities` is here because the stack's own next-steps card
// tells the user to run it after every update. The four guided plugin commands are here because
// they are multi-phase walks too, and the UserPromptSubmit route is what finally reaches them.
const ORCHESTRATION = /^(project-(quality-loop|architecture-quality-loop|test-coverage-loop|architecture-analyzer|code-style-analyzer|test-coverage-analyzer|solve-task|solve-cross-task|build-from-scratch|stack-usage-analyzer|related-context|version-upgrade|diagnose-failure|solution-design|verify-plan|implementer|verify-code|agent-capabilities)|security-review|claude-stack:(setup|update|configure|validate))$/;
// a plugin-namespaced Skill call arrives as `<plugin>:<skill>`; the four guided commands are
// matched on their FULL name, so a bare `/setup` from some other plugin is not read as one of them
const isOrchestration = (n) => ORCHESTRATION.test(n) || ORCHESTRATION.test(n.replace(/^.*:/, ''));
let skill = '';
if (IS_SKILL_CALL) {
  skill = String((payload.tool_input || {}).skill || (payload.tool_input || {}).name || '');
} else if (EVENT === 'UserPromptSubmit') {
  // A slash turn reaches this event as the expanded prompt: the harness wraps the invocation in a
  // `<command-name>` marker (confirmed twice from live transcripts, matching origin.kind 'human'),
  // and a hand-typed `/name` is the same intent spelled without it.
  const prompt = String(payload.prompt || '');
  const m = prompt.match(/<command-name>\s*\/?([A-Za-z0-9:_-]+)\s*<\/command-name>/)
    || prompt.match(/(?:^|\s)\/([A-Za-z0-9:_-]+)/);
  skill = m ? m[1] : '';
}
if (EVENT !== 'SessionStart' && !isOrchestration(skill)) process.exit(0);

// SessionStart carries no run name and nothing measurable - the transcript has just been REPLACED
// by its summary - so the compaction event itself is the evidence, and the offer goes out on it.
if (EVENT === 'SessionStart') {
  if (FRESH_PCT === 0 || String(payload.source || '') !== 'compact') process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'This session just AUTO-COMPACTED, which means it reached the harness ceiling (~390k ' +
        'tokens per message measured) and the harness - not the user - decided what to drop. ' +
        'Before continuing, put the choice to the user as ONE AskUserQuestion: resume in a fresh ' +
        'session (recommended - end this turn with the paste-ready invocation and the state file ' +
        'or plan file it resumes from), or continue here on the summary with the cost stated. If ' +
        'the remaining work is a single short step, say so and just finish it instead of asking.',
    },
  }));
  process.exit(0);
}

// Context comes from the last assistant message's usage, same source the stop contract uses.
function lastUsage() {
  try {
    const p = payload.transcript_path;
    if (!p) return null;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let usage = null;
    let maxCtx = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"assistant"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type === 'assistant' && o.message && o.message.usage) {
          usage = o.message.usage;
          const u = o.message.usage;
          maxCtx = Math.max(maxCtx, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0));
        }
      } catch { /* partial first line of the tail window - skip */ }
    }
    return usage ? { ...usage, _maxCtx: maxCtx } : null;
  } catch {
    return null;
  }
}
const usage = lastUsage();
if (!usage) process.exit(0);
const ctx = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.input_tokens || 0);
if (FRESH_PCT === 0 || ctx <= ctxThreshold(() => usage._maxCtx || ctx)) process.exit(0);

// UserPromptSubmit can only ADD context - exit 2 there erases the prompt and tells the user, not
// the model - so the slash route states the same thing as an instruction and lets the model ask.
if (EVENT === 'UserPromptSubmit') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `/${skill} is a deliberate orchestration run and this session already carries ` +
        `~${Math.round(ctx / 1000)}k tokens per message of another run's history - every turn of the new ` +
        `run re-sends all of it (measured: the same step cost 260k/message chained vs 134k fresh). ` +
        `Do NOT start the run yet. Put it to the user as ONE AskUserQuestion: start it in a fresh ` +
        `session (recommended - end this turn with the paste-ready invocation and the state file it ` +
        `resumes from), or run it here anyway with the cost stated.`,
    },
  }));
  process.exit(0);
}

process.stderr.write(
  `Blocked: ${skill} is a deliberate orchestration run and this session already carries\n` +
  `~${Math.round(ctx / 1000)}k tokens per message of another run's history - every turn of the new run\n` +
  `re-sends all of it (measured: the same step cost 260k/message chained vs 134k fresh).\n` +
  `Put it to the user as ONE AskUserQuestion: start it in a fresh session (recommended - end\n` +
  `this turn with the paste-ready invocation and the state file it resumes from), or run it\n` +
  `here anyway with the cost stated. Do not start the run before that answer lands.`,
);
process.exit(2);
