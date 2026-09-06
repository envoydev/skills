#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// PreToolUse gate (matcher: Task|Agent): the approval gate for implementer fan-out.
// An *-implementer dispatch is the expensive, hard-to-reverse step of a build flow -
// it runs only after the user's explicit approval (or an explicit 'run without stops'
// waiver), recorded as a gate file the flows write. Prose approval gates measured
// unreliable (collapse on an ambiguous 'go'); this converts the gate into a file
// check the dispatch tool cannot pass without. Designers pass (they produce the plan
// BEFORE approval exists) and verifiers pass (read-only audits; verify-plan dispatches
// one pre-approval). exit 2 = block (stderr fed back to the model); exit 0 = allow.
// Stamp lifecycle: each flow/loop writes its OWN stamp when its consent lands and
// clears it at run end; a stamp persists across a flow's resumed sessions until that
// clear. Stamps older than MAX_STAMP_AGE_MS are treated as absent - measured: a
// leftover stamp from a finished flow silently authorized three later, unrelated
// runs' dispatches in one consuming project.
// Generic-seat rule: while a VALID stamp exists (a flow is running), an edit-capable
// generic dispatch (general-purpose/claude) is blocked too - flows dispatch NAMED
// domain seats, and the name-keyed implementer gate is silently bypassed by a generic
// stand-in (measured: one run put all 10 of a loop's dispatches on general-purpose,
// losing every seat pin and this gate; one legitimate generic dispatch in 33 audited
// sessions would have been bounced, a one-retry re-route). Outside a stamped flow,
// generic seats pass untouched.
// Symbol-search rule: a SYMBOL question - who calls this, where is it declared, what
// type resolves here - is never delegated to a grep-shaped seat (Explore/general-purpose/
// claude). Those answer by name-match, and the built-in Explore does not even load the
// project's rules, so baseline-navigation's 'locate with serena, inline' never reaches it
// (measured: a consuming session handed a C# symbol hunt to Explore and got grep hits).
// Blocked here regardless of any stamp; a broad multi-file sweep with no symbol question
// in it still passes.
const fs = require('fs');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving
// (the installers rename the key in place on the next install/update).
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';
const path = require('path');
let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0); // unparseable stdin - don't block
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
const input = payload.tool_input || {};
const seat = String(input.subagent_type || '');
const GENERIC_SEATS = new Set(['general-purpose', 'claude']);
const SEARCH_SEATS = new Set(['Explore', 'general-purpose', 'claude']);
const isImplementer = /-implementer$/.test(seat);

// A symbol question routed at a grep-shaped seat: block and send it back to serena.
// The patterns are the QUESTION shapes baseline-navigation names, not tool words - a
// sweep brief ('map the auth module', 'which files configure logging') carries none.
const SYMBOL_QUESTION = new RegExp(
  [
    'who calls\\b',
    'call(?:ers|[- ]sites)\\s+(?:of|for)\\b',
    'where\\s+(?:is|are)\\s+\\S.{0,60}?\\b(?:defined|declared|implemented|instantiated|registered)\\b',
    '\\b(?:find|locate|get)\\s+(?:the\\s+)?(?:definition|declaration|implementation|signature|body)\\s+of\\b',
    '\\breferences?\\s+to\\b',
    '\\busages?\\s+of\\b',
    '\\bwhat\\s+type\\b',
    '\\bimplementations?\\s+of\\b',
    '\\bsubclasses\\s+of\\b',
    '\\b(?:find|locate)\\s+(?:the\\s+)?(?:class|interface|method|function|component|service|enum|record|struct)\\s+`?[A-Za-z_]',
  ].join('|'),
  'i',
);
if (SEARCH_SEATS.has(seat)) {
  const brief = `${input.prompt || ''}\n${input.description || ''}`;
  const asked = brief.match(SYMBOL_QUESTION);
  if (asked) {
    process.stderr.write(
      `Blocked: dispatch of ${seat} for a SYMBOL question ('${asked[0].trim()}').\n` +
        `A grep-shaped seat answers that by name-match, and name-matches lie; the built-in\n` +
        `Explore does not load this project's rules at all, so it cannot know to use serena.\n` +
        `Answer it INLINE instead: mcp__serena__find_symbol for a declaration or signature,\n` +
        `mcp__serena__find_referencing_symbols for callers, mcp__serena__get_symbols_overview\n` +
        `(ONE file, depth 2 on C#) to enumerate - falling back to the LSP plugin when serena's\n` +
        `language server cannot resolve it. Dispatch a search seat only for a genuinely broad\n` +
        `multi-file sweep that asks no symbol question.`,
    );
    process.exit(2);
  }
}

if (!isImplementer && !GENERIC_SEATS.has(seat)) {
  process.exit(0);
}
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const docsRoot = docsRootEnv();
const gate = path.resolve(root, docsRoot, 'flow', 'APPROVAL');
const MAX_STAMP_AGE_MS = 8 * 60 * 60 * 1000; // 8h - re-stamping is one Write; staleness shipped unapproved dispatches
let first = '';
let stale = false;
try {
  const stampMs = fs.statSync(gate).mtimeMs;
  const age = Date.now() - stampMs;
  // A stamp written BEFORE this session started belongs to another session's decision, and the
  // age cap alone let one through: five implementer dispatches ran on a stamp a different,
  // already-closed session wrote 2h52m earlier - inside 8h, so the gate saw consent that this
  // run never gave (measured). The stamp is the dispatching session's own or it is not consent.
  // birthtime is real only where the filesystem reports it - Node documents that elsewhere the
  // field falls back to the ctime (or the epoch). A transcript's ctime is its LAST write, which
  // would date every stamp before the session and block every dispatch with a false 'stale';
  // a birthtime equal to the ctime is that fallback and counts as unknown (the age cap still holds).
  let sessionStartMs = 0;
  try {
    const st = fs.statSync(String(payload.transcript_path || ''));
    sessionStartMs = st.birthtimeMs && st.birthtimeMs !== st.ctimeMs ? st.birthtimeMs : 0;
  } catch { sessionStartMs = 0; }
  if (age > MAX_STAMP_AGE_MS || (sessionStartMs && stampMs < sessionStartMs)) {
    stale = true;
  } else {
    first = fs.readFileSync(gate, 'utf8').split('\n')[0].trim();
  }
} catch {
  // absent or unreadable - no approval recorded
}
const approved = /^(APPROVED|AUTO)\b/.test(first);
if (isImplementer) {
  if (approved) process.exit(0);
  process.stderr.write(
    (stale
      ? `Blocked: dispatch of ${seat} - the approval stamp at ${gate} is stale: older than 8h, or written before this session began, so it records another run's decision rather than this one's (measured: a 2h52m-old stamp from a closed session authorized five implementer dispatches).\n`
      : `Blocked: dispatch of ${seat} without an approval gate.\n`) +
      `Implementer fan-out runs only on the user's explicit approval, or their explicit 'run\n` +
      `without stops' waiver - never on an inferred or ambiguous go-ahead.\n` +
      `If the user gave one THIS conversation, write ${gate}\n` +
      `with one first line - APPROVED <plan/contract id> - "<their words, verbatim>" (or\n` +
      `AUTO - "<their words, verbatim>" for a no-stops run) - then retry the dispatch.\n` +
      `Never fabricate the quote. Otherwise: present the plan and ask the user - that\n` +
      `stop IS the recovery path. Do NOT route around this gate by doing the seat's\n` +
      `build work inline instead: a blocked dispatch means the flow is missing its\n` +
      `approval, not that the flow should be abandoned (measured: one session answered\n` +
      `this block by building inline and shipped the runtime defect the gated flow's\n` +
      `verify step exists to catch).\n` +
      `Clear the file when the run completes.`,
  );
  process.exit(2);
}
// Generic seat: blocked only while a flow is actively stamped.
if (!approved) {
  process.exit(0);
}
process.stderr.write(
  `Blocked: dispatch of ${seat} while a flow is active (${gate} is stamped).\n` +
    `A stamped run dispatches its NAMED domain seats - a generic seat carries none of the\n` +
    `seat's pins, preloads, or trap-lists, and silently bypasses the implementer gate.\n` +
    `Use the matching named seat (or a read-only seat like Explore for pure research).\n` +
    `If this generic dispatch is deliberate ad hoc work and the flow is over, clear the\n` +
    `stamp file first, then retry.`,
);
process.exit(2);
