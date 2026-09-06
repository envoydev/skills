#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// PreToolUse gate (matcher: Bash): the PUBLISH ceremony, mechanized - one hook because commit
// and push are one gate family and share the receipt machinery, the heredoc blanking and the
// quote masking below. A non-trivial
// `git commit` runs only after the house review gate (project-verify-code, plus
// /security-review on auth/crypto/data-access paths) or the user's explicit waiver -
// recorded as a receipt file the gate step writes. Prose measured unreliable: 8 ungated
// commit events across 6 audited sessions, including one where baseline-git.md was
// provably read into context the same session and skipped anyway, and one commit with
// no user authorization at all. Trivial diffs pass untouched (the rule's own
// typo/one-line exemption, judged from the working-tree diff). exit 2 = block
// (stderr fed back to the model); exit 0 = allow.
// The PUBLISH half: `git push` and `gh pr merge` put the work where other people (and CI) get
// it, and NOTHING gated them - replayed across four bundles, every push and merge passed every
// guard. In one session the FIRST state-changing act of the run published unpushed commits 18
// minutes before any receipt existed, and 40 files reached a shared `develop` ungated. Same
// receipt shape, its own file (<docs-root>/flow/PUSH-GATE), and CLAUDE_STACK_PUSH_GATE=0 turns
// it off for a repo whose remote is already gated by branch protection or a required review.
// Receipt lifecycle: the gate step writes <docs-root>/flow/COMMIT-GATE when its checks
// pass (VERIFIED <scope>) or the user explicitly waives (WAIVED - "<their words>");
// the commit turn clears it after the commit lands. Receipts older than
// MAX_RECEIPT_AGE_MS are treated as absent - the stale-stamp lesson from the approval
// gate (a leftover stamp silently authorized later, unrelated runs).
const fs = require('fs');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving
// (the installers rename the key in place on the next install/update).
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';
const path = require('path');
const { execSync } = require('child_process');
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
const command = String((payload.tool_input || {}).command || '');
// The publish half is on by default and switched off per install for a repo whose remote already
// gates the branch (protection rules, a required review). Any value but "0" leaves it on.
const PUSH_GATE_ON = process.env.CLAUDE_STACK_PUSH_GATE !== '0';
// A heredoc body is DATA, not shell: a plan document, a commit-message draft or a receipt that
// merely describes `git commit` is inert text. Matching it blocked a 47KB plan write and cost a
// full re-author of the same document (~19.8k output + 24.4k cache-write, ~3 minutes), and a
// second session lost a plan-doc write the same way. Blank the payload spans before matching,
// keeping the character count so commitMatch.index still points into the real command.
const scanned = command.replace(
  /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
  (m) => m.replace(/[^\n]/g, ' '),
);
// A QUOTED span is data for exactly the same reason a heredoc body is: a grep pattern, an echo
// label or a search term that merely CONTAINS `git commit` invokes nothing. Blanking it matters
// twice over. It blocked the stack's OWN mandated sweep (project-stack-usage-analyzer greps every
// `git commit` event in a transcript) - and the session then completed that sweep by obfuscating
// the token, which is the dangerous half: the evasion the false positive TAUGHT defeats this gate
// on a genuine commit. Replayed on the pre-fix hook: `grep -o 'git commit' f` exit 2,
// `echo 'run git commit later'` exit 2, but `C=commit; git $C -m x` exit 0 and
// `git "com""mit" -m x` exit 0. Length is preserved so commitMatch.index still points into
// the real command, and the fill is a NON-space so the span stays one opaque argument token:
// blanking `git -C "<sibling>" commit` to spaces dissolved the -C argument and the whole match
// with it, which un-gated a commit in another checkout (caught by this hook's own tests).
const scannedQuoted = scanned
  .replace(/'[^'\n]*'/g, (m) => m.replace(/[^\n]/g, 'x'))
  .replace(/"[^"\n]*"/g, (m) => m.replace(/[^\n]/g, 'x'));
// A real `git commit` subcommand (allowing -C/-c/global flags between), not e.g. `git log --grep commit`.
let commitMatch = scannedQuoted.match(/\bgit(\s+-[cC]?\s*\S+|\s+--\S+)*\s+commit\b/);
if (!commitMatch) {
  // ...and a `git` whose SUBCOMMAND is not a plain literal cannot be judged at all: `git $C`,
  // `git ${VERB}`, `git $(echo commit)`, `git "com""mit"`. Reading those as 'not a commit' is
  // precisely what makes the obfuscation above work, so they are UNJUDGEABLE and gate like a
  // commit rather than passing. A quoted literal that normalizes to `commit` is a commit.
  const re = /(?:^|[;&|(]\s*|\s)git\s+((?:(?:-[cC]\s*\S+|--\S+)\s+)*)(\S+)/g;
  let m;
  while ((m = re.exec(command))) {
    const sub = m[2];
    const spliced = sub.replace(/["']/g, '');
    if (/[$`]/.test(sub) || (spliced === 'commit' && /["']/.test(sub))) {
      commitMatch = { 0: m[0].trim(), index: m.index, opaque: true };
      break;
    }
  }
}
// The PUBLISH verbs. Matched on the same quote-masked copy the commit verb is, so a `git push`
// inside a report's prose or a commit message is text, not an act - the false-positive pair this
// gate MUST not reproduce cost 430,740 tokens when a report write was denied for quoting a merge
// command. `--dry-run` / `-n` publishes nothing, and neither does a push with nothing ahead of
// its upstream.
const publishMatch = PUSH_GATE_ON
  ? (scannedQuoted.match(/(?:^|[;&|(]\s*|\s)git(?:\s+-[cC]?\s*\S+|\s+--\S+)*\s+push\b/)
    || scannedQuoted.match(/(?:^|[;&|(]\s*|\s)gh\s+pr\s+merge\b/))
  : null;
if (!commitMatch && !publishMatch) process.exit(0);

// Resolve the repo the act actually runs in: a `cd <sibling> && git commit` or a
// `git -C <sibling> push` executes in a DIFFERENT repo than this hook's default root,
// so the diff/receipt checks below would silently judge the wrong tree (measured: a
// cross-repo commit's ledger cwd named the home repo while the commit ran in the sibling).
// Git Bash / MSYS spell a Windows path in POSIX MOUNT form (`/c/Users/...`, `/cygdrive/c/...`),
// which node on win32 resolves against the CURRENT drive instead - the same falsehood that made
// the cross-project guard block a session's own temp cleanup. Translate before resolving; off
// Windows the spelling is a real POSIX path and is never touched.
let root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const MOUNT_RE = /^(?:\/cygdrive)?\/([A-Za-z])(?=\/|$)/;
const nativePath = (p) => (process.platform === 'win32'
  ? String(p).replace(MOUNT_RE, (m, d) => `${d.toUpperCase()}:\\`)
  : String(p));
const unq = (s) => s.replace(/^["']|["']$/g, '');
// the FIRST of the two acts anchors the cd scan - everything before it moved the cwd
const actIndex = Math.min(
  commitMatch ? commitMatch.index : Number.MAX_SAFE_INTEGER,
  publishMatch ? publishMatch.index : Number.MAX_SAFE_INTEGER,
);
const cdMatches = [...command.slice(0, actIndex).matchAll(/(?:^|&&|;|\n|\|)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)];
if (cdMatches.length) root = path.resolve(root, nativePath(unq(cdMatches[cdMatches.length - 1][1])));
// the match came off the quote-masked copy, so read the -C ARGUMENT back out of the real
// command - the mask keeps the offsets, not the path (a masked `-C "<sibling>"` resolved to a
// directory of x's, judged this repo instead, and let the sibling commit through ungated).
const rawOf = (m) => (m && !m.opaque ? command.substr(m.index, m[0].length) : (m ? m[0] : ''));
const dashC = rawOf(publishMatch || commitMatch).match(/\s-C\s*("[^"]+"|'[^']+'|\S+)/);
if (dashC) root = path.resolve(root, nativePath(unq(dashC[1])));
const git = (args) => execSync(`git ${args}`, { cwd: root, timeout: 5000 }).toString().trim();
// The files this act would commit. The stack's own docs root is excluded: the receipt is written
// INTO it moments before the act, so counting it inflated both the trivial-diff bar and the spec
// check - a conformant `spec: 3 files` read as covering 3 of 4 because the fourth was the receipt.
const docsPrefix = () => {
  let d = docsRootEnv().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!d) return null;
  // An ABSOLUTE docs root can still sit INSIDE the repo, and then the receipt this gate is reading
  // counts as one of the changed files its own `spec:` line is measured against - so a conformant
  // receipt fails its own count and the gate blocks the commit it just authorized. Relativize
  // against the repo root and exclude it whenever it lands inside; a root genuinely outside the
  // tree has nothing to exclude.
  if (path.isAbsolute(d)) {
    const rel = path.relative(root, d).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return null;
    d = rel;
  }
  return `${d}/`;
};
function changedFiles() {
  const pre = docsPrefix();
  const keep = (f) => f && !(pre && f.replace(/\\/g, '/').startsWith(pre));
  const tracked = git('diff HEAD --name-only').split('\n').filter(keep);
  const untracked = git('ls-files --others --exclude-standard').split('\n').filter(keep);
  return { tracked, untracked, count: tracked.length + untracked.length };
}

const docsRoot = docsRootEnv();
const MAX_RECEIPT_AGE_MS = 2 * 60 * 60 * 1000; // 2h - the gate runs right before the act; re-stamping is one Write
// The RECEIPT CONTRACT. Every clause here was bought with a receipt that passed the gate and
// recorded nothing: `authorized: "what time is it?"` exit 0, `authorized: ""` exit 0 - the only
// discriminator the first version applied was the presence of a quote character.
//   auth   - the quoted span must be non-empty AND carry a consent verb. A question, a filename or
//            an empty pair of quotes is not somebody asking for this commit.
//   label  - a span CHARACTER-IDENTICAL to an option label in this transcript is the MODEL's own
//            words, not the user's (measured: `authorized: "Commit now (Recommended)"`, marker and
//            all, prescribed by a skill while the denial text demanded 'their words, verbatim').
//            Consent given by picking an option has its own spelling: `answered: <label>`.
//   head   - the review covered a TREE. Without the sha, a receipt written before three more edits
//            landed still reads as this diff's review.
//   spec   - and it covered a SET of files: one measured receipt asserted a review of a 17-file diff
//            in which 9 files had been read.
//   probe  - a VERIFIED line that names a review must carry its live-probe result: one receipt
//            asserted a passing review with no build/test output and no probe at all. Spelled
//            case-insensitively with an optional hyphen or space - `live probe = ...` is conformant.
//   carried- a stamp minted from a carried resume block says so, or the freshness check is
//            silently satisfied by a re-mint of a 9h30m-old answer.
// A PENDING draft placeholder matches the bare prefix, so the prefix alone is never the test
// (measured: a PENDING draft sat gate-passing for ~2 minutes).
const CONSENT_VERB = /\b(commit|commits|committing|push|pushes|pushing|land|lands|landing|ship|ships|shipping|merge|merges|merging|publish|publishes|publishing|release|releases|releasing|go ahead|do it|approve[ds]?|yes)\b/i;
const CONSENT_VERB_CYR = /(коміт|комміт|закоміт|запуш|пуш|залив|злий|мерж|злит|відправ|отправ|випуст|выпуст|дава[йй]|погоджу|согласен|схвал|так, |да, )/i;
const QUOTED = /["'“‘”’]([^"'“‘”’]*)["'“‘”’]/;

// The transcript tail, read once and shared by the two checks that need it. 256KB is the same
// window every other guard reads; a receipt is minted within a turn or two of its evidence.
let _tail;
function tail() {
  if (_tail !== undefined) return _tail;
  _tail = '';
  try {
    const tp = payload.transcript_path;
    if (tp) {
      const size = fs.statSync(tp).size;
      const start = Math.max(0, size - 256 * 1024);
      const fd = fs.openSync(tp, 'r');
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      _tail = buf.toString('utf8');
    }
  } catch { _tail = ''; }
  return _tail;
}
// Is this exact string one of the assistant's own AskUserQuestion option labels? Compared with the
// `(Recommended)` marker STRIPPED, because the harness stores the marked label as the user's answer
// (correction 3) - so the marker's presence proves nothing either way.
function isOwnOptionLabel(span) {
  const norm = (t) => String(t).replace(/\s*\(recommended\)\s*$/i, '').trim().toLowerCase();
  const want = norm(span);
  if (!want) return false;
  for (const m of tail().matchAll(/"label"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
    let lbl;
    try { lbl = JSON.parse(`"${m[1]}"`); } catch { lbl = m[1]; }
    if (norm(lbl) === want) return true;
  }
  return false;
}
const skillCallRan = () => /"name"\s*:\s*"Skill"/.test(tail());

// One judge, two routes. The receipt written as its own file and the receipt written inside the
// same command as the act are the SAME document, so they answer to the same contract - otherwise
// the atomic shape (which this gate accepts by design) is a hole straight through every clause.
function judgeReceipt(body, opts) {
  // A receipt written through `printf` carries LITERAL backslash-n, not newlines.
  const text = String(body).replace(/\\n/g, '\n');
  // The verdict token, and the rest of ITS line. Anchoring to the start of a line read the atomic
  // shape as having no verdict at all, because there the line begins `printf 'VERIFIED ...`.
  const first = ((/\b(VERIFIED|WAIVED)\b[^\n]*/i.exec(text) || [''])[0]).trim();
  // Fields are read by PREFIX from any line, not by line number: a receipt that carries its
  // head/spec lines in a different order is still a conformant receipt.
  const field = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*:?[ \\t]*(.*)$`, 'im').exec(text);
    return m ? m[1].trim() : null;
  };
  const waived = /^WAIVED\b/.test(first);
  const verified = /^VERIFIED\b/.test(first);
  const r = { waived, verified, problem: null };
  if (!waived && !verified) return r;
  const bodyText = text;

  const quotedOf = (line) => {
    if (line == null) return null;
    if (/\bPENDING\b/i.test(line)) return null;
    const m = QUOTED.exec(line);
    return m ? m[1].trim() : null;
  };
  const consents = (t) => CONSENT_VERB.test(t) || CONSENT_VERB_CYR.test(t);

  if (waived) {
    const w = quotedOf(first);
    if (!w) r.problem = 'the WAIVED line carries no quoted words - a waiver is the user\'s own sentence, in quotes, on that line';
    return r;
  }

  // --- VERIFIED: consent -------------------------------------------------------------------
  const authorized = quotedOf(field('authorized'));
  const answered = field('answered') || field('answer');
  if (authorized) {
    if (!consents(authorized)) {
      r.problem = `the authorized: quote (${JSON.stringify(authorized).slice(0, 60)}) carries no commit / push / land / ship verb - it records the user saying something, not the user asking for THIS act`;
      return r;
    }
    if (isOwnOptionLabel(authorized)) {
      r.problem = 'the authorized: quote is character-identical to an option label THIS run wrote - that is the model\'s sentence, not the user\'s. Consent given by picking an option is spelled `answered: <the chosen label>` instead';
      return r;
    }
  } else if (answered) {
    if (!answered.replace(/^option\s+\d+\s*/i, '').replace(/["'“‘”’]/g, '').trim()) {
      r.problem = 'the answered: line names no option';
      return r;
    }
  } else {
    r.problem = 'no authorized: line carrying the user\'s quoted words, and no answered: line naming the option they picked';
    return r;
  }

  // --- VERIFIED: what was reviewed ---------------------------------------------------------
  const head = field('head');
  if (!head) {
    r.problem = 'no head: line - the review covered a TREE, and without its sha a receipt written before three more edits landed still reads as this diff\'s review';
    return r;
  }
  let realHead = '';
  try { realHead = git('rev-parse HEAD'); } catch { realHead = ''; }
  const h = head.replace(/[^0-9a-fA-F]/g, '');
  if (realHead && h && !realHead.startsWith(h) && !h.startsWith(realHead)) {
    r.problem = `head: ${head} is not this repo's HEAD (${realHead.slice(0, 12)}) - the review ran against a different commit`;
    return r;
  }
  const spec = field('spec');
  if (!spec) {
    r.problem = 'no spec: line naming the file set reviewed (measured: a receipt asserted a review of a 17-file diff in which 9 files had been read)';
    return r;
  }
  // The count is compared against the working tree only for a COMMIT: a publish's spec names the
  // commit set leaving the machine, which has nothing to do with what is uncommitted here.
  const claimed = (opts && opts.countAgainstTree) ? /(\d+)\s*files?\b/i.exec(spec) : null;
  if (claimed) {
    let actual = 0;
    try { actual = changedFiles().count; } catch { actual = 0; }
    if (actual && Number(claimed[1]) < actual) {
      r.problem = `spec: claims ${claimed[1]} file(s) but the tree has ${actual} uncommitted - review the rest, or narrow what this act commits`;
      return r;
    }
  }
  if (!/live[-\s]?probe/i.test(bodyText)) {
    r.problem = 'no live-probe line - a VERIFIED review states what it actually ran, either the quoted output or `NOT RUN - <reason>` (spelled live-probe, live probe or live_probe)';
    return r;
  }
  // A stamp minted from a CARRIED resume block must say so, or a 9h30m-old answer mints fresh
  // consent in 45 seconds and defeats the freshness check.
  if (/\b(project-)?verify-(code|plan)\b|\bquality-loop\b/i.test(first) && !skillCallRan() && !field('carried')) {
    r.problem = `the VERIFIED line names a verify skill but no Skill call ran in this session - if this review is carried from an earlier cycle say so: \`carried: <cycle id>, reviewed <date>\``;
    return r;
  }
  return r;
}

function readReceipt(name) {
  const gate = path.resolve(root, docsRoot, 'flow', name);
  let stale = false;
  let body = '';
  try {
    const age = Date.now() - fs.statSync(gate).mtimeMs;
    if (age > MAX_RECEIPT_AGE_MS) stale = true;
    else body = fs.readFileSync(gate, 'utf8');
  } catch {
    // absent or unreadable - no gate receipt
  }
  if (stale) return { gate, stale, waived: false, verified: false, problem: null };
  return { gate, stale, ...judgeReceipt(body, { countAgainstTree: name === 'COMMIT-GATE' }) };
}
// An atomic write-receipt-then-act command carries its own receipt: the gate file is
// written (with a VERIFIED/WAIVED line in the same command text) before git runs. Blocking
// it would reject the receipt discipline this gate exists to enforce (measured: the
// write+act+clear-in-one-call shape is the corpus's dominant conforming pattern).
// All matches are bound to the segment BEFORE the act (a commit message merely mentioning
// COMMIT-GATE VERIFIED is not a receipt), and the receipt must be WRITTEN, not merely
// mentioned: requiring the words anywhere in that text let a single
// `echo "... VERIFIED ... authorized: ..." > notes.txt` satisfy the gate on a real dirty tree
// (reproduced). The redirect/tee/printf/cat has to target a path ending in flow/<NAME>.
function carriesOwnReceipt(name, upto) {
  const pre = command.slice(0, upto);
  if (!pre.includes(name)) return false;
  const writes = new RegExp(`(?:>>?|\\btee\\s+(?:-a\\s+)?|\\bprintf\\b[^>]*>>?|\\bcat\\s*>>?)\\s*["']?(\\S*flow\\/${name})\\b`);
  if (!writes.test(pre)) return false;
  // ...and it answers to the SAME contract as the file. Judging the atomic shape more leniently
  // made it the cheapest way to skip every clause below: one printf and the gate was satisfied.
  const j = judgeReceipt(pre, { countAgainstTree: name === 'COMMIT-GATE' });
  return (j.waived || j.verified) && !j.problem;
}

// --- the PUBLISH gate ---------------------------------------------------------------------
// Pushing and merging are what put the work where other people and CI get it, and until this
// existed nothing gated either: replayed across four bundles, every `git push` and `gh pr merge`
// passed every guard. In one session the FIRST state-changing act published unpushed commits 18
// minutes before any receipt existed, and 40 files reached a shared `develop` ungated.
if (publishMatch) {
  const act = rawOf(publishMatch).trim().replace(/\s+/g, ' ');
  const isGitPush = /\bgit\b/.test(act);
  // a dry run publishes nothing, and neither does a push with nothing ahead of its upstream
  const dryRun = /\s--dry-run\b/.test(command) || (isGitPush && /\bpush\b[^;|&]*\s-n\b/.test(command));
  let ahead = true;
  if (isGitPush) {
    try { ahead = git('log @{u}..HEAD --oneline').length > 0; } catch { ahead = true; } // no upstream = a new branch, which publishes
  }
  if (!dryRun && ahead && !carriesOwnReceipt('PUSH-GATE', publishMatch.index)) {
    const r = readReceipt('PUSH-GATE');
    if (!((r.waived || r.verified) && !r.problem)) {
      process.stderr.write(
        (r.stale
          ? `Blocked: ${act} - the publish receipt at ${r.gate} is older than 2h and is treated as absent (a stale receipt from an earlier round did not review THIS push).\n`
          : r.problem
            ? `Blocked: ${act} - the publish receipt at ${r.gate} does not hold: ${r.problem}.\n`
            : `Blocked: ${act} without the publish gate receipt.\n`) +
          `Pushing and merging are where the work leaves this machine - other people and CI get it,\n` +
          `and a shared branch cannot be un-pushed quietly. Measured across four sessions: every\n` +
          `push and merge passed every guard, one of them publishing 40 files to a shared develop\n` +
          `and one running before any review receipt existed at all.\n\n` +
          `Say what is being published and to which branch, get the user's answer, then write\n` +
          `${r.gate}\n` +
          `with these lines:\n` +
          `  VERIFIED <what is being published, one phrase>\n` +
          `  authorized: "<the user's words asking for THIS publish, verbatim>"   (or, when they\n` +
          `    picked an option instead of typing, answered: <the chosen label>)\n` +
          `  head: <git rev-parse HEAD>\n` +
          `  spec: <N files - the set this publish covers>\n` +
          `  live-probe: <what you actually ran, or NOT RUN - <reason>>\n` +
          `The quoted words must carry a publish verb and must not be an option label this run\n` +
          `wrote. If they EXPLICITLY waived it this conversation, write WAIVED - "<their words,\n` +
          `verbatim>" instead; never fabricate either quote. Then retry, and clear the file once\n` +
          `it lands.\n` +
          `A repo whose remote is already gated (branch protection, a required review) can turn\n` +
          `this half off for good: CLAUDE_STACK_PUSH_GATE=0 in the settings.json env block.`,
      );
      process.exit(2);
    }
  }
}

// --- the COMMIT gate ----------------------------------------------------------------------
if (!commitMatch) process.exit(0);
if (carriesOwnReceipt('COMMIT-GATE', commitMatch.index)) process.exit(0);
// Trivial-diff exemption: total churn across the uncommitted tree (staged + unstaged -
// a chained `git add && git commit` stages mid-command, so staged-only would undercount).
// <= 2 files and <= 15 changed lines is the typo/one-line class; anything bigger gates.
// Untracked files count too: `git diff HEAD` never lists them, so a feature landing in NEW
// files only (`git add -A && git commit`) read as 'nothing to commit' and passed ungated
// (reproduced: three 40-line new files, exit 0). An untracked file is one row and its line
// count is its churn - the same arithmetic a staged add gets.
try {
  const pre = docsPrefix();
  const rows = git('diff HEAD --numstat').split('\n')
    .filter((r) => r && !(pre && (r.split('\t')[2] || '').replace(/\\/g, '/').startsWith(pre)));
  let files = rows.length;
  let lines = rows.reduce((n, r) => {
    const [a, d] = r.split('\t');
    return n + (parseInt(a, 10) || 0) + (parseInt(d, 10) || 0);
  }, 0);
  for (const f of changedFiles().untracked) {
    files += 1;
    if (files > 2) break; // already past the bar - no need to size the rest
    try { lines += fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter(Boolean).length; } catch { /* unreadable - the row alone counts */ }
  }
  if (files === 0) process.exit(0); // nothing to commit - let git say so
  if (files <= 2 && lines <= 15) process.exit(0);
} catch {
  process.exit(0); // not a git repo / git unavailable - never block on our own failure
}
const c = readReceipt('COMMIT-GATE');
if ((c.waived || c.verified) && !c.problem) process.exit(0);
process.stderr.write(
  (c.stale
    ? `Blocked: git commit - the gate receipt at ${c.gate} is older than 2h and is treated as absent (a stale receipt from an earlier round is not this diff's review).\n`
    : c.problem
      ? `Blocked: git commit - the gate receipt at ${c.gate} does not hold: ${c.problem}.\n`
      : `Blocked: git commit on a non-trivial diff without the pre-commit gate receipt.\n`) +
    `The checkpoint (baseline-git.md) runs BEFORE a non-trivial commit: the formatter, then\n` +
    `the house review project-verify-code - plus /security-review when the diff touches\n` +
    `auth/crypto/secrets/payment/data-access paths (baseline-security.md). When those pass, write\n` +
    `${c.gate}\n` +
    `with these lines:\n` +
    `  VERIFIED <what was reviewed, one phrase>\n` +
    `  authorized: "<the user's words asking for THIS commit, verbatim>"   (or, when they picked\n` +
    `    an option instead of typing, answered: <the chosen label>)\n` +
    `  head: <git rev-parse HEAD>\n` +
    `  spec: <N files - the set the review covered>\n` +
    `  live-probe: <what you actually ran, or NOT RUN - <reason>>\n` +
    `The VERIFIED line proves the review ran; the authorized line proves the user asked for the\n` +
    `commit, and its quote must carry a commit verb and must not be an option label this run\n` +
    `wrote (measured: a self-written VERIFIED receipt passed this gate on a commit no user\n` +
    `requested, and 'authorized: "what time is it?"' passed it too).\n` +
    `Then retry the commit. If the user EXPLICITLY waived the gate this conversation, write\n` +
    `WAIVED - "<their words, verbatim>" instead; never fabricate either quote, and 'commit\n` +
    `it' alone is an instruction to commit, not a waiver of the review. Do not split a real\n` +
    `change into tiny commits to slip under this gate's trivial-diff exemption. Clear the\n` +
    `file once the commit lands (after the LAST commit when one receipt covers a batch).`,
);
process.exit(2);
