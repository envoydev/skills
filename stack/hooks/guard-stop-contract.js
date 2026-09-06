#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// Two wirings, one contract: the blocking-ask mandate (baseline-interaction.md) and the
// fresh-session construction check (the flow skills' stop contracts) both failed as prose in
// every audited strengthening - measured across 123 sessions: ~25 sessions ended turns on
// 'say the word' / 'want me to X?' prose (stalls of 13min-37h, one plaintext-credential
// decision dropped at /exit), and the 150k fresh-session option fired in ~0 of 50+ qualifying
// asks (0/11, 0/14, 0/7...) with the clause loaded verbatim. This hook is the mechanization.
//
// Stop wiring: a turn that ends on a decision-shaped question in PROSE (no AskUserQuestion
//   call in the final assistant message) is blocked - the model re-emits it as the tool call.
//   The text judged is the payload's `last_assistant_message` (the harness's own copy of the
//   turn's final text); the transcript tail is the fallback for a build that does not send it.
//   The same Stop wiring carries the fresh-session offer: on a CLEAN close past the
//   window-scaled trigger, the turn is held once so the user is asked whether to continue here
//   or resume fresh. It fires only after the work is done (never mid-response, which is what the
//   old PreToolUse denial did), and re-arms only when the context has grown 1.5x since the last
//   one - so a long session is asked once per real cost step, not once per question.
// PreToolUse (AskUserQuestion) wiring: INJECTION ONLY - `hookSpecificOutput.additionalContext`,
//   presence-only, never ranks an option and never denies. It carries the four checks that have no
//   other route (stale ask scope, a recommendation contradicting an un-actioned request, the
//   fresh-session offer for a flow whose every stop is a tool call, and a live credential) plus the
//   house-voice check on the ask's own text. The DENIAL this matcher used to carry is gone for
//   good: it fired mid-response and cost the user a red block every turn.
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

// The trigger scales with the CONTEXT WINDOW, not a flat token count. A fixed 150k is ~75% of a
// 200k window (where it was measured) but only 15% of a 1M-context session, which is why it fired
// on nearly every ask there. Percent is tunable per machine with CLAUDE_STACK_FRESH_SESSION_PCT
// (default 40, the same shape as the harness's own auto-compact percentage), seeded into the scope
// settings.json `env` beside CLAUDE_STACK_CONTEXT_WINDOW; where the WINDOW comes from is below.
const _pct = parseInt(process.env.CLAUDE_STACK_FRESH_SESSION_PCT, 10);
// 0 DISABLES the offer outright - a `|| 40` fallback silently turned the off switch back on.
// Anything else is clamped into 5..95; unset or garbage takes the 40 default.
const FRESH_PCT = _pct === 0 ? 0 : Math.min(95, Math.max(5, Number.isNaN(_pct) ? 40 : _pct));
const CTX_FLOOR = 150000;
// The upper bound on any window larger than 200k - see ctxThreshold for the measurement behind it.
// Without it the trigger lands above the harness's own auto-compact ceiling and never fires.
const CTX_CEILING = 250000;

// --- which context WINDOW is this session running in? -------------------------------------
// Measured on a 1M session: the transcript's message.model records `claude-opus-5` with the
// `[1m]` suffix STRIPPED, the PreToolUse payload carries only cwd/session_id/tool_name/
// tool_input/transcript_path, no transcript field names a window or a token limit, and no env
// var carries the model. settings.json's `model` keeps it - and so does the transcript's own
// `cost-state` record (`modelUsage` is keyed `claude-opus-5[1m]`), which the earlier text wrongly
// called the ONLY source; measured on CLI 2.1.258 and 2.1.261. settings.json's
// `model` (e.g. `opus[1m]`). So, first layer that resolves wins:
//   1. CLAUDE_STACK_CONTEXT_WINDOW - the user's own statement, so it outranks every guess. It
//      goes in the scope settings.json `env` block, seeded `AUTO` - the word, so the knob reads as
//      answered rather than as an empty box someone forgot. Anything that is not a window size
//      (AUTO, empty, a typo) falls through to the layers below, which is the seeded behaviour;
//      a NUMBER here is the overrule.
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
  // Above the 200k tier the PERCENTAGE ALONE IS UNUSABLE, and the reason is arithmetic: the
  // FRESH_PCT default (40) is the SAME NUMBER as the harness's own auto-compact percentage, so
  // 40% of a 1M window is 400,000 - which sits ABOVE the ceiling the harness actually enforces.
  // Measured auto-compaction preTokens across three projects: 387,619 / 391,290 / 393,516 /
  // 393,969 / 395,112 / 396,651 / 396,954 / 397,171. The gate could never fire on a 1M account:
  // the harness compacted first every time and took the decision this offer exists to give the
  // user (one session dropped 1,474,734 tokens over four compactions and was never offered).
  // The ceiling keeps the offer inside the reachable band on any window larger than 200k; the
  // floor keeps the MEASURED 200k-tier behaviour unchanged.
  return window > 200000 ? Math.min(pct, CTX_CEILING) : Math.max(CTX_FLOOR, pct);
}
// How far the context must grow before the fresh-session offer is made again (see below).
const REOFFER_GROWTH = 1.5;
// `/clear` is NOT in this list. It matched the token quoted as report CONTENT - a turn merely
// describing session hygiene ('every <=130k session opened with `/clear` + resumed from a file')
// silenced the offer at PEAK context (A/B replay: with the token exit 0, with the same sentence in
// prose exit 2). A report about session hygiene will always contain the words; only an OFFER counts.
const FRESH_RE = /fresh session|new session|fresh chat|resume (in|from) a fresh/i;
// Decision-shaped prose endings measured in the corpus. Deliberately narrow: a plain
// clarifying question is not matched - only the offer-and-wait shapes that stalled sessions.
const PROSE_ASK_RE = /\b(say the word|say go|just say so|want me to [^.?!\n]{0,80}\?|shall i [^.?!\n]{0,80}\?|should i [^.?!\n]{0,80}\?|your call\b|let me know (when|if|whether)|give me the word|tell me (if|when|whether) you want|paste (this|that|it) and i'?ll|run this to unblock|i'?ll [^.\n]{0,60}(the moment|as soon as|once) you\b|worth your decision)/i;
// A close with NO question of any shape: the named step is done and a next action sits
// un-taken, stated as fact. Measured in 4 projects - the user answers it with 'are you
// finished?' after 2-22 minutes, so the shape is a stop, not a status line. Both halves must
// hit: something finished, and something still pending on the user or on a running job.
const DONE_RE = /\b(done|complete[d]?|finished|committed|landed|green|all tests pass|ready)\b/i;
const PENDING_RE = /\b(not pushed|nothing pushed|awaiting|waiting (on|for)|still running|pending your|next step|remains?|left to do|yet to|whenever you|when you'?re ready|un-?pushed)\b/i;

// --- read the transcript tail (last ~512KB) and pull the last assistant message ---
function lastAssistantMessage() {
  try {
    const p = payload.transcript_path;
    if (!p) return null;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    let last = null;
    for (const line of lines) {
      if (!line.includes('"assistant"')) continue;
      try {
        const o = JSON.parse(line);
        if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
        // One logical assistant turn is written as SEVERAL jsonl lines sharing one message.id
        // (a thinking line, then the text line). Taking the last line as the whole message made
        // the hook read an empty-text or tool_use-only fragment and pass silently - measured: 6
        // sessions where an offline replay of this same hook blocks the turn the live run let
        // through, stalls of 15-74 minutes. Merge every line carrying the same id.
        const id = o.message.id;
        if (last && id && last.message.id === id) {
          last.message.content = last.message.content.concat(o.message.content);
          if (o.message.usage) last.message.usage = o.message.usage;
        } else {
          last = { ...o, message: { ...o.message, content: o.message.content.slice() } };
        }
      } catch { /* partial first line of the tail window - skip */ }
    }
    return last;
  } catch (err) {
    breadcrumb(`transcript read failed: ${err && err.message}`);
    return null;
  }
}

// Did the user JUST answer an AskUserQuestion, or decline one with 'clarify'? Three separate
// measured defects share this one blind spot, and all three are this hook demanding a tool-shaped
// ask for a decision the tool had already settled:
//   1. the acknowledgement of an answer given 3.9 SECONDS earlier was blocked; the user went
//      silent for 1h32m and quit with the work still refused;
//   2. a close restating a choice the user made 21 seconds earlier was blocked, and the forced
//      re-ask REVERSED that choice;
//   3. after an ask is declined with 'clarify' the harness itself instructs prose - and this hook
//      blocked it, deadlocking the turn (0 steps executed, 532.0k wasted, a manual redo 2h26m later).
// Judged over the tail's last 8KB and deliberately fail-OPEN: for a gate with a measured
// false-positive problem, missing one real block is far cheaper than manufacturing another.
function askJustAnswered() {
  try {
    const p = payload.transcript_path;
    if (!p) return false;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - 8 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return /Your questions have been answered:|The user (declined|chose not) to answer|tool use was rejected/i.test(buf.toString('utf8'));
  } catch {
    return false;
  }
}

// --- credential exposure ------------------------------------------------------------------
// SEVEN measured exposures across the audited corpus, and the two shapes need two different
// detectors, because in three of them the run NOTICED and in one it never did:
//   NOTICED  - the close names the exposure and prescribes rotation as a prose bullet. Every
//              such turn passed every branch of this hook; the user read it and quit without
//              acting (19m, 1h40m, and one 2m02s before /exit). A rotation verb beside a
//              credential noun is a pending DECISION, not a status line.
//   UNNOTICED- the session's FIRST tool call `cat`ed an account settings.json whole and printed
//              two live tokens; both closes were credential-free, so nothing in the assistant's
//              own text could ever have caught it. The values existed only in a tool_result.
// The token VALUE is never read into a variable, never logged and never printed - only its shape
// is matched, and the denial names the shape alone.
const SECRET_SHAPE = /\b(sntryu_[0-9a-f]{16,}|ctx7sk-[0-9a-f-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const ROTATE_RE = /\b(rotate|revoke|purge|scrub|regenerate)\b[^\n]{0,120}\b(credential|token|secret|key|dsn|password|api[- ]?key|history)\b/i;
function secretInToolResults() {
  try {
    const p = payload.transcript_path;
    if (!p) return false;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      // only USER-role rows carry tool_results; the assistant's own text is judged separately
      if (!line.includes('"toolUseResult"') && !line.includes('"tool_result"')) continue;
      if (SECRET_SHAPE.test(line)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// A silent fail-open is indistinguishable from a clean turn, which is how the misses above
// stayed invisible across 74 audited bundles. Every path that declines to judge says so.
function breadcrumb(why) {
  try {
    const dir = process.env.CLAUDE_STACK_HOOK_LOG_DIR || require('os').tmpdir();
    fs.appendFileSync(`${dir}/guard-stop-contract.log`, `${new Date().toISOString()} ${why}\n`);
  } catch { /* never let logging break the gate */ }
}

if (payload.hook_event_name === 'Stop') {
  if (payload.stop_hook_active) process.exit(0); // continuation we caused - never loop
  // The harness sends the turn's final text as `last_assistant_message` (Stop / SubagentStop) and
  // documents the transcript as written ASYNCHRONOUSLY - it can lag the in-memory turn, which is
  // how a live decision stop reads as the previous turn's clean close. The field wins; the
  // transcript tail is the fallback for a build that does not send it.
  let text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
  if (!text.trim()) {
    const last = lastAssistantMessage();
    if (!last) { breadcrumb('Stop: no assistant message readable - passing'); process.exit(0); }
    const blocks = last.message.content;
    const hasToolUse = blocks.some((b) => b && b.type === 'tool_use');
    if (hasToolUse) process.exit(0); // the turn ended on a tool call, not prose
    text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
    if (!text.trim()) { breadcrumb('Stop: merged message carries no text - passing'); process.exit(0); }
  }
  // Fenced spans are PAYLOAD, not prose: the fresh-session contract asks the turn to end with a
  // paste-ready resume block, and judging inside that fence made this hook block its own mandated
  // deliverable (measured: DONE_RE matched `green` and PENDING_RE matched `NOT pushed`, both inside
  // the fence; replay exit 2 at both window tiers). guard-answer-length.js's proseOf() has stripped
  // fences for the length cap all along - this is the same rule for the contract check.
  const prose = text.replace(/```[\s\S]*?```/g, ' ');
  const tail = prose.slice(-1500); // the offer lives at the end of the turn
  // The phrase list only ever covered the shapes MEASURED in the corpus, so an ordinary
  // decision question ('What's the deploy target?', 'Which one should we go with?') walked
  // straight past it (reproduced). A turn that ends on a question and hands nothing to a tool is
  // the shape the contract is about, whatever words it uses.
  const endsOnQuestion = /\?["')\]]*\s*$/.test(tail.trim())
    || /\b(which|what|who|where|when|how|should|do you|would you|prefer)\b[^?]{0,120}\?\s*$/i.test(tail.trim());
  // ...but a question ABOUT something already settled, or a rhetorical aside mid-report, is not a
  // stop: require the question to be the turn's last word, which the tests above already encode.
  const doneClose = DONE_RE.test(tail) && PENDING_RE.test(tail) && !/\?/.test(tail)
    // A background job the user has no say over is a status line, not a pending decision -
    // blocking it forced an AskUserQuestion over 'tests are still running in CI' (reproduced).
    // ...and the harness's own idiom for a backgrounded job is part of that shape. Without these
    // spellings a pure status line ('Waiting on CI run <id> in the background - I'll merge when it
    // goes green') was blocked, and the denial's own prescribed escape then tripped PROSE_ASK_RE:
    // one status close, two blocks, from two branches of this hook (measured, 87k re-sent).
    && !/\b(ci|pipeline|workflow|build|suite|tests?|job|deploy(ment)?)\b[^.\n]{0,40}\b((still )?(running|in progress|queued|pending)|in the background|backgrounded)\b/i.test(tail)
    && !/\b(in the background|backgrounded|i'?ll report back|watching (it|the run|for))\b/i.test(tail);
  // A live credential that has entered this session outranks every other close: it cannot be
  // undone by a later turn, and the transcript keeps the value whatever happens next. This branch
  // runs FIRST and fires on a clean close too - three measured exposures ended exactly there.
  if (!askJustAnswered() && (ROTATE_RE.test(prose) || secretInToolResults())) {
    process.stderr.write(
      'A credential appears to have entered this session - either named for rotation in this\n' +
      'turn, or matched by shape in a tool result. Measured seven times in the audited corpus:\n' +
      'the run states it as a closing bullet, the user reads it and does not act (19m, 1h40m,\n' +
      'and one that quit 2m02s later with the token still live). A pasted or printed secret\n' +
      'CANNOT be unsent - it is in the transcript on disk and in every later request - so the\n' +
      'only open question is whether it gets rotated. End this turn with ONE AskUserQuestion:\n' +
      "'Rotate it now (Recommended)' and 'Acknowledge and defer'. Name the credential by its KEY\n" +
      'and its shape only - never repeat the value, and never pass it to a tool.',
    );
    process.exit(2);
  }
  if (!PROSE_ASK_RE.test(tail) && !doneClose && !endsOnQuestion) {
    // The turn closed cleanly - the work is DONE, which is the only moment this offer belongs at.
    // Past the window-scaled trigger, ask once per cost step whether to carry on here or resume
    // fresh; a turn that already made the offer, and a session already asked at this cost step,
    // both pass untouched.
    const usage = (() => { const l = lastAssistantMessage(); return (l && l.message && l.message.usage) || null; })();
    if (!usage || FRESH_PCT === 0) process.exit(0);
    const ctx = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.input_tokens || 0);
    // Below the floor no window tier can qualify, so return before maxCtxSeen re-reads the same
    // 512KB tail lastAssistantMessage just read - this branch runs on EVERY clean turn close.
    // maxCtxSeen re-reads the tail lastAssistantMessage just read, so it is passed LAZILY: a
    // known window never calls it, and the floor rule itself lives in ctxThreshold, once.
    if (ctx <= ctxThreshold(() => maxCtxSeen(ctx))) process.exit(0);
    if (FRESH_RE.test(prose)) process.exit(0); // the OFFER is prose - a fenced example is not one
    const since = lastBlockCtx();
    if (since && ctx < since * REOFFER_GROWTH) {
      breadcrumb(`Stop: fresh-session offer skipped, ctx ${ctx} has not grown ${REOFFER_GROWTH}x since ${since}`);
      process.exit(0);
    }
    recordBlockCtx(ctx);
    process.stderr.write(
      // The old text claimed a resume 'costs roughly a tenth'. Eleven measurements put it at
      // 21.5-59.4% of the carried context, never under 21%, with a measured predecessor/successor
      // pair at 38.75% - so the ratio was 2-6x optimistic and it reached users verbatim inside the
      // option descriptions they then acted on. State the absolute number instead, and the number
      // the model can actually read: this turn's own per-message context.
      `The work in this turn is finished and this session now carries ~${Math.round(ctx / 1000)}k tokens per\n` +
      `message - every further turn re-sends all of it. A fresh session restarts near this project's\n` +
      `cold floor, measured at 80-105k per message (NOT a tenth of the carry - quote the two absolute\n` +
      `numbers, never a ratio). Before continuing here, put the choice to the user with ONE\n` +
      `AskUserQuestion call: first option 'Resume in a fresh session (Recommended)' carrying those\n` +
      `two numbers, second option continuing here. Say in the description that the harness's own\n` +
      `auto-compaction would recover a similar floor unaided, so what the resume buys is the\n` +
      `difference plus keeping the choice theirs. If they pick the resume, answer with a short ack\n` +
      `and the paste-ready\n` +
      `resume block only - do not start new work in this chat. Add nothing else to this turn: the\n` +
      `report you just wrote stands.`,
    );
    process.exit(2);
  }
  // Both remaining branches DEMAND an AskUserQuestion. If one was just answered - or declined with
  // 'clarify', which the harness answers by instructing prose - the decision is already settled and
  // demanding it again is the measured failure documented at askJustAnswered().
  if (askJustAnswered()) {
    breadcrumb('Stop: an AskUserQuestion was just answered or declined - not re-asking');
    process.exit(0);
  }
  if (doneClose && !PROSE_ASK_RE.test(tail)) {
    process.stderr.write(
      'This turn reports the step done and leaves the next action pending, stated as a fact\n' +
      'rather than asked. Measured across four projects: that close draws a literal "are you\n' +
      'finished?" from the user 2-22 minutes later. Put the pending decision (push or hold,\n' +
      'continue or stop, which deliverable next) through ONE AskUserQuestion call with the\n' +
      'options you already have in mind, recommended one marked. If nothing is actually\n' +
      'pending, say so in one line with no open next action and stop.',
    );
    process.exit(2);
  }
  process.stderr.write(
    'This turn ends on a decision-shaped question in prose. Per baseline-interaction.md a\n' +
    'blocking ask goes through the AskUserQuestion tool - a prose-only question gets skipped\n' +
    'in live runs (measured stalls: 13 minutes to 37 hours; one security decision died at\n' +
    '/exit). Re-emit the pending decision as ONE AskUserQuestion call with concrete options\n' +
    '(recommended one marked). If the session context is already past ~150k tokens per\n' +
    'message, include the fresh-session resume option. If the turn truly holds no decision -\n' +
    'the question was rhetorical or informational - restate the close WITHOUT question\n' +
    'phrasing and stop.',
  );
  process.exit(2);
}

// The context at which this session last blocked an ask for carrying no fresh-session option.
// The FIRST block is what makes the choice informed; repeating it on every later ask only
// prints an error the user has already answered (reported from a real session sitting at ~203k
// per message, where every ask opened with the same red block). So the offer is re-required
// only when the context has grown by half again since the last block - 150k -> 225k -> 337k:
// still an escalation, but one that tracks the cost actually growing rather than the ask count.
function lastBlockCtx() {
  try {
    return parseInt(fs.readFileSync(blockStateFile(), 'utf8'), 10) || 0;
  } catch {
    return 0;
  }
}
function recordBlockCtx(ctx) {
  try { fs.writeFileSync(blockStateFile(), String(ctx)); } catch { /* never let state break the gate */ }
}
function blockStateFile() {
  const os = require('os');
  const key = String(payload.transcript_path || '').replace(/[^a-zA-Z0-9]/g, '_').slice(-80);
  return `${process.env.CLAUDE_STACK_HOOK_LOG_DIR || os.tmpdir()}/guard-stop-fresh-${key}.blocked`;
}

// The largest per-message context this session has carried, read off the same transcript tail.
// It is what proves the window tier (see ctxThreshold): the CURRENT message can be small while
// the session has already been far past 200k.
function maxCtxSeen(fallback) {
  try {
    const p = payload.transcript_path;
    if (!p) return fallback;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - 512 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let max = fallback;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      try {
        const u = JSON.parse(line).message.usage;
        max = Math.max(max, (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0));
      } catch { /* not an assistant row, or a partial first line */ }
    }
    return max;
  } catch {
    return fallback;
  }
}

// --- PreToolUse on AskUserQuestion: INJECT, never deny ---------------------
// This branch used to DENY an ask that carried no fresh-session option. That enforced the right
// thing at the wrong moment: the denial landed mid-response, so the run stopped the work it was
// doing to rebuild a question and the user watched a red block open every turn. The answer is not
// to abandon the surface - it is to stop deciding on it. This branch now emits
// `hookSpecificOutput.additionalContext` and NOTHING else: presence only, never ranks an option,
// never denies. Five separate measured failures land on exactly this surface, and four of them
// have no other route:
//   1. STALE SCOPE - an ask built on a fifty-minute-old `git status`; the sibling was committed and
//      pushed by another agent while the ask was on screen, and the user's answer was discarded
//      whole (third measured instance; baseline-git.md has mandated the fresh read twice, as prose).
//   2. CONTRADICTED REQUEST - two prompts arrived in one turn, the run answered the second and put
//      an ask whose Recommended option asserted the opposite of the first; the user took the
//      recommendation, then re-typed their first prompt verbatim 2m54s later.
//   3. FRESH SESSION - the Stop wiring cannot see a flow whose every stop is a tool call, which is
//      every CONFORMING solve-task run. This is the only route that reaches those mid-turn.
//   4. CREDENTIAL - the rotation choice belongs in the ask the turn is already making.
//   5. HOUSE VOICE - the em-dash / single-quote rule is measured 0 for 10, and an ask's own text is
//      a surface no Stop hook reads at all.
if (payload.tool_name === 'AskUserQuestion') {
  const notes = [];
  try {
    // Build the ask's text from its FIELDS. JSON.stringify would introduce double quotes of its
    // own and make the house-voice check fire on every ask ever made.
    const parts = [];
    for (const q of ((payload.tool_input || {}).questions) || []) {
      if (!q) continue;
      parts.push(String(q.question || ''), String(q.header || ''));
      for (const o of q.options || []) {
        if (!o) continue;
        parts.push(String(o.label || ''), String(o.description || ''));
      }
    }
    const askText = parts.join('\n');

    const voice = [];
    if (/[\u2014\u2013]/.test(askText)) voice.push('an em- or en-dash (use a single dash)');
    if (/"/.test(askText)) voice.push('a double quote (use single quotes)');
    if (voice.length) {
      notes.push(`This ask's own text carries ${voice.join(' and ')}. baseline-interaction.md's ` +
        `house voice covers an AskUserQuestion's question, header, labels and descriptions - a ` +
        `surface no Stop hook reads. Fix the text before sending it.`);
    }

    // 1. STALE SCOPE: an option that names repository, remote or job state is a MEASUREMENT, and a
    // measurement taken before this turn is not evidence about now.
    if (/\b(commit|push|branch|pull request|\bPRs?\b|merge|rebase|stash|staged|unstaged|uncommitted|untracked|remote|upstream|deploy(ed|ment)?|pipeline|\bCI\b|workflow run|job)\b/i.test(askText)
        && !freshStateReadThisTurn()) {
      notes.push('An option here names repository, remote or job state and no `git status` / ' +
        '`git diff` / `gh` call ran in this turn. Derive that scope FRESH before asking - a ' +
        'fifty-minute-old read had already been overtaken by another agent while the ask was on ' +
        'screen, and the answer it produced was discarded whole.');
    }

    // 2. CONTRADICTED REQUEST: the presence signal is two typed turns arriving before one reply.
    if (typedTurnsBeforeThisReply() >= 2) {
      notes.push('The user sent more than one message before this reply. Check every option, and ' +
        'the Recommended one first, against BOTH - an ask whose recommendation contradicted an ' +
        'un-actioned earlier request was taken by the user, who then re-typed that request verbatim.');
    }

    // 3. FRESH SESSION. No recordBlockCtx here: this is a note, not the ask itself, so it must not
    // consume the cost step the Stop wiring's real offer is owed.
    if (FRESH_PCT !== 0 && !FRESH_RE.test(askText)) {
      const u = (() => { const l = lastAssistantMessage(); return (l && l.message && l.message.usage) || null; })();
      const ctx = u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0) : 0;
      const since = lastBlockCtx();
      if (ctx > ctxThreshold(() => maxCtxSeen(ctx)) && !(since && ctx < since * REOFFER_GROWTH)) {
        notes.push(`This session carries ~${Math.round(ctx / 1000)}k tokens per message and every ` +
          `further turn re-sends all of it. If this ask is about what to do NEXT, add an option to ` +
          `resume in a fresh session, carrying both absolute numbers (this carry, and the ~80-105k ` +
          `cold floor) - never a ratio.`);
      }
    }

    // 4. CREDENTIAL.
    if (secretInToolResults()) {
      notes.push('A credential-shaped value has already entered this session\'s tool results. It ' +
        'cannot be unsent. If this ask closes the turn, one of its questions must be whether to ' +
        'rotate it now - name the key and its shape only, never the value.');
    }
  } catch { /* fail-open: an injection is never worth breaking an ask over */ }

  if (notes.length) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notes.join('\n\n') },
    }));
  }
  process.exit(0);
}

// Did a repository/remote state read run since the last typed user turn? The ask's scope has to be
// derived at ask time, and the cheap proof of that is a state-reading call in the same turn.
function freshStateReadThisTurn() {
  try {
    const p = payload.transcript_path;
    if (!p) return false;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    // walk BACKWARDS to the turn boundary - the last typed (non-tool_result) user row
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || !o.message) continue;
      if (o.type === 'user' && isTypedTurn(o)) return false;
      if (o.type === 'assistant' && Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
          if (!b || b.type !== 'tool_use' || b.name !== 'Bash') continue;
          const cmd = String((b.input && b.input.command) || '');
          if (/\bgit\s+(status|diff|log|show|rev-parse|rev-list|ls-files|fetch)\b|\bgh\s+(pr|run|api|repo)\b/.test(cmd)) return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

// A user row is a TYPED turn only when it carries text and no tool_result - a tool result arrives
// as a user message, and counting those made every turn look like a multi-prompt turn.
function isTypedTurn(o) {
  const c = o.message.content;
  if (typeof c === 'string') return !o.isMeta && c.trim().length > 0;
  if (!Array.isArray(c)) return false;
  if (c.some((b) => b && b.type === 'tool_result')) return false;
  return !o.isMeta && c.some((b) => b && b.type === 'text' && String(b.text || '').trim());
}

// How many typed turns the user sent before the reply now in progress. Two or more is the shape
// that produced the contradicted-recommendation failure.
function typedTurnsBeforeThisReply() {
  try {
    const p = payload.transcript_path;
    if (!p) return 0;
    const size = fs.statSync(p).size;
    const start = Math.max(0, size - 256 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    let run = 0;
    let last = 0;
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (!o || !o.message) continue;
      if (o.type === 'user' && isTypedTurn(o)) { run += 1; continue; }
      if (o.type === 'assistant' && run > 0) { last = run; run = 0; }
    }
    return run > 0 ? run : last;
  } catch {
    return 0;
  }
}

