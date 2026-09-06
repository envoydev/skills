#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// The short-answer contract (baseline-interaction.md: 'at most 3 sentences plus points', 'if the
// user wants deeper detail they will ask') failed as prose the same way every other house mandate
// did: the user re-asked for it as a BRAND NEW rule while both rule copies carried it verbatim,
// and the memory record holds four separate 'you write too much text' / 'shorter and simpler'
// corrections across sessions. Prose guards measured ignored 1/5-1/3 of the time; mechanisms held.
// This hook is the mechanization.
//
// UserPromptSubmit wiring: appends the answer budget to the turn's context, where it lands LAST -
//   immediately before the answer is written, not 30 bullets deep in an always-on rule.
// Stop wiring: an answer whose prose (code blocks, tables and inline spans excluded) runs past the
//   hard cap with no depth request in the user's own message is blocked, and the model re-answers
//   at budget. The answer measured is the payload's `last_assistant_message`; the transcript's
//   assistant row is the fallback, and the user's own message always comes from the transcript.
//   Deliberately a wall-of-text catch, not a byte-counter: the soft budget lives in the reminder
//   because a Stop block cannot unsay text the user already read - it can only add more.
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

const BUDGET = 900; // soft: ~3 sentences plus points, the rule's own shape
const HARD_CAP = 1800; // block: double the budget with no depth request = a wall of text
// An explicit depth request in the user's OWN words lifts the cap for that turn. Deliberately
// narrow: 'explain X' does NOT qualify - the rule caps explanations too ('whether it is work
// output or an explanation'); only an ask for depth, length or a written document does.
const DEPTH_RE = /\b(in detail|detailed|more detail|deep ?dive|in ?depth|elaborate|expand on|walk me through|step[- ]by[- ]step|full (breakdown|analysis|report|list|picture|write[- ]?up)|comprehensive|thorough(ly)?|verbose|long(er)? (answer|version|form)|everything (you|about)|write (me )?(a|the) (plan|report|doc|document|spec|summary)|don'?t (be )?(short|brief))\b/i;
// The same ask in the user's other languages. Kept as its own pattern because JS \b is ASCII-only -
// a word boundary around a Cyrillic stem never matches, so these are matched as bare substrings
// (stems only: 'детальн' covers детально / детальніше / детальный).
const DEPTH_RE_CYR = /(детальн|докладн|подробн|розгорнут|развернут|покроков|пошагов|крок за кроком|шаг за шагом|розпиши|распиши|розбір|разбор|напиши план|повністю|полностью|поясни глибше|глибше|глубже)/i;

// --- transcript tail (last ~512KB): the final assistant message and the user's last real turn ---
function tailLines() {
  const p = payload.transcript_path;
  if (!p) return [];
  const size = fs.statSync(p).size;
  const start = Math.max(0, size - 512 * 1024);
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(size - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n');
}

function lastMessages() {
  let assistant = null;
  let user = null;
  for (const line of tailLines()) {
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // partial first line of the tail window
    }
    if (!o || !o.message) continue;
    // One logical assistant turn is written as SEVERAL jsonl rows sharing one message.id (a
    // thinking row, then the text row). Keeping only the last row read the wall of text as an
    // empty fragment and passed it silently - the same defect measured six times in the stop
    // contract's own transcript reader, which is why both now merge by id.
    if (o.type === 'assistant' && Array.isArray(o.message.content)) {
      const id = o.message.id;
      if (assistant && id && assistant.message.id === id) {
        assistant.message.content = assistant.message.content.concat(o.message.content);
        if (o.message.usage) assistant.message.usage = o.message.usage;
      } else {
        assistant = { ...o, message: { ...o.message, content: o.message.content.slice() } };
      }
    }
    if (o.type === 'user') {
      const c = o.message.content;
      // A tool_result arrives as a user message - only a real typed turn counts.
      const typed = typeof c === 'string'
        ? c
        : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n') : '';
      if (typed.trim()) user = typed;
    }
  }
  return { assistant, user };
}

// Prose only: code blocks, tables, inline spans and link targets are the parts a short answer is
// allowed to be long in - they carry the payload, not the talking.
function proseOf(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^\s*\|.*$/gm, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/\]\([^)\s]*\)/g, ']')
    .replace(/\s+/g, ' ')
    .trim();
}

// The budget text, one copy for both routes that inject it.
const BUDGET_TEXT =
        `Answer budget (baseline-interaction.md, house rule): at most 3 sentences plus bullet ` +
        `points, ~${BUDGET} characters of prose. Lead with the result and stop - no preamble, no ` +
        `restating the request, no listing what you considered, no caveat paragraph. Code, ` +
        `tables and command output are exempt and do not count. Write more ONLY if THIS message ` +
        `asked for depth, in ANY language (in detail / walk me through / write a plan; детально, ` +
        `покроково, розпиши); 'explain' by itself does ` +
        `not - explanations are capped too, and short means plainer words, never compressed jargon. ` +
        `House voice, same rule, same source: single dashes, never em-dashes, and single quotes in ` +
        `prose - in the answer AND in an AskUserQuestion's own text, which no Stop hook reads.`;

if (payload.hook_event_name === 'UserPromptSubmit') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: BUDGET_TEXT },
  }));
  process.exit(0);
}

// A COMPACTION rebuilds the context without the injection and emits no UserPromptSubmit, so the
// budget simply disappears for the rest of the session: measured absent for 74 of 195 messages in
// one session and 277 of 366 (75.7%) in another, where the close came in at 1.44x the hard cap -
// all four compactMetadata.preservedMessages records carry preserved:false for the budget's uuid.
// A co-installed plugin's banner WAS re-injected at every compaction, so this route is proven.
// Any hook whose whole value is an INJECTION needs this wiring; a hook that only BLOCKS does not.
if (payload.hook_event_name === 'SessionStart') {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: BUDGET_TEXT },
  }));
  process.exit(0);
}

if (payload.hook_event_name === 'Stop') {
  if (payload.stop_hook_active) process.exit(0); // continuation we caused - one block per turn
  let last;
  let user;
  try {
    ({ assistant: last, user } = lastMessages());
  } catch {
    process.exit(0);
  }
  // The harness's `last_assistant_message` is the turn's final text; the transcript is written
  // asynchronously and can lag it (documented), so the field wins and the transcript's assistant
  // row is the fallback. The user's message still comes from the transcript - the Stop payload
  // carries no prompt - so an unreadable transcript stays the fail-open pass above.
  let text = typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : '';
  if (!text.trim()) {
    if (!last) process.exit(0);
    const blocks = last.message.content;
    if (blocks.some((b) => b && b.type === 'tool_use')) process.exit(0); // ended on a tool call
    text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
  }
  const body = proseOf(text);
  if (body.length <= HARD_CAP) process.exit(0);
  if (user && (DEPTH_RE.test(user) || DEPTH_RE_CYR.test(user))) process.exit(0); // depth asked this turn

  process.stderr.write(
    `This answer is ${body.length} characters of prose - the house budget is ~${BUDGET} (about 3\n` +
    `sentences plus points) and the hard cap is ${HARD_CAP}. Code, tables and command output were\n` +
    `already excluded from that count, and nothing in the user's message asked for depth, so this\n` +
    `is the wall-of-text failure baseline-interaction.md exists to prevent (measured: repeated\n` +
    `'you write too much text' / 'shorter and simpler' corrections with the rule loaded verbatim).\n` +
    `Re-answer now at budget: the result first, then only what the user must act on. Cut preamble,\n` +
    `the recap of what they asked, the options you rejected, the caveats they did not ask for, and\n` +
    `every sentence about your own process. Do NOT apologize, do NOT explain the trim, and do NOT\n` +
    `append the short version to the long one - write the short answer alone. If the detail is\n` +
    `genuinely needed, say one line offering it instead of delivering it.`,
  );
  process.exit(2);
}

process.exit(0);
