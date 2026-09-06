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

const docsRoot = docsRootEnv();
const MAX_RECEIPT_AGE_MS = 2 * 60 * 60 * 1000; // 2h - the gate runs right before the act; re-stamping is one Write
// WAIVED carries the user's words on its own line; VERIFIED needs the authorized: second
// line - a review receipt alone is not consent (measured: a self-written VERIFIED receipt
// once cleared a commit no user had requested). The authorized: line must carry the user's
// actual quoted words: a two-stage receipt's draft placeholder ('authorized: PENDING -
// append...') matches the bare prefix, so a prefix check silently accepted a receipt that
// records no consent (measured: a PENDING draft sat gate-passing for ~2 minutes).
function readReceipt(name) {
  const gate = path.resolve(root, docsRoot, 'flow', name);
  let first = '';
  let second = '';
  let stale = false;
  try {
    const age = Date.now() - fs.statSync(gate).mtimeMs;
    if (age > MAX_RECEIPT_AGE_MS) {
      stale = true;
    } else {
      const lines = fs.readFileSync(gate, 'utf8').split('\n');
      first = (lines[0] || '').trim();
      second = (lines[1] || '').trim();
    }
  } catch {
    // absent or unreadable - no gate receipt
  }
  const authReal = /^authorized:/.test(second) && /["'“‘]/.test(second) && !/\bPENDING\b/i.test(second);
  return {
    gate,
    stale,
    waived: /^WAIVED\b/.test(first),
    verified: /^VERIFIED\b/.test(first),
    noAuth: /^VERIFIED\b/.test(first) && !authReal,
  };
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
  return /\bWAIVED\b/.test(pre) || (/\bVERIFIED\b/.test(pre) && /authorized:/.test(pre));
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
    if (!r.waived && !(r.verified && !r.noAuth)) {
      process.stderr.write(
        (r.stale
          ? `Blocked: ${act} - the publish receipt at ${r.gate} is older than 2h and is treated as absent (a stale receipt from an earlier round did not review THIS push).\n`
          : r.noAuth
            ? `Blocked: ${act} - the publish receipt at ${r.gate} has a VERIFIED first line but its 'authorized:' second line is missing, a PENDING placeholder, or carries no quoted words; nothing records the user asking for THIS publish.\n`
            : `Blocked: ${act} without the publish gate receipt.\n`) +
          `Pushing and merging are where the work leaves this machine - other people and CI get it,\n` +
          `and a shared branch cannot be un-pushed quietly. Measured across four sessions: every\n` +
          `push and merge passed every guard, one of them publishing 40 files to a shared develop\n` +
          `and one running before any review receipt existed at all.\n\n` +
          `Say what is being published and to which branch, get the user's answer, then write\n` +
          `${r.gate}\n` +
          `with one first line - VERIFIED <what is being published, one phrase> - and a second line\n` +
          `authorized: "<the user's words asking for THIS publish, verbatim>". If they EXPLICITLY\n` +
          `waived it this conversation, write WAIVED - "<their words, verbatim>" instead; never\n` +
          `fabricate either quote. Then retry, and clear the file once it lands.\n` +
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
  const numstat = git('diff HEAD --numstat');
  const rows = numstat ? numstat.split('\n') : [];
  let files = rows.length;
  let lines = rows.reduce((n, r) => {
    const [a, d] = r.split('\t');
    return n + (parseInt(a, 10) || 0) + (parseInt(d, 10) || 0);
  }, 0);
  for (const f of git('ls-files --others --exclude-standard').split('\n').filter(Boolean)) {
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
if (c.waived) process.exit(0);
if (c.verified && !c.noAuth) process.exit(0);
process.stderr.write(
  (c.stale
    ? `Blocked: git commit - the gate receipt at ${c.gate} is older than 2h and is treated as absent (a stale receipt from an earlier round is not this diff's review).\n`
    : c.noAuth
      ? `Blocked: git commit - the gate receipt at ${c.gate} has a VERIFIED first line but its 'authorized:' second line is missing, a PENDING placeholder, or carries no quoted words; the review ran, but nothing records the user asking for THIS commit. Append authorized: "<their words, verbatim>" and retry.\n`
      : `Blocked: git commit on a non-trivial diff without the pre-commit gate receipt.\n`) +
    `The checkpoint (baseline-git.md) runs BEFORE a non-trivial commit: the formatter, then\n` +
    `the house review project-verify-code - plus /security-review when the diff touches\n` +
    `auth/crypto/secrets/payment/data-access paths (baseline-security.md). When those pass, write\n` +
    `${c.gate}\n` +
    `with one first line - VERIFIED <what was reviewed, one phrase> - and a second line\n` +
    `authorized: "<the user's words asking for THIS commit, verbatim>" (a receipt proves\n` +
    `the review ran, the authorized line proves the user asked for the commit - measured: a\n` +
    `self-written VERIFIED receipt once passed this gate on a commit no user requested).\n` +
    `Then retry the commit. If the user EXPLICITLY waived the gate this conversation, write\n` +
    `WAIVED - "<their words, verbatim>" instead; never fabricate either quote, and 'commit\n` +
    `it' alone is an instruction to commit, not a waiver of the review. Do not split a real\n` +
    `change into tiny commits to slip under this gate's trivial-diff exemption. Clear the\n` +
    `file once the commit lands (after the LAST commit when one receipt covers a batch).`,
);
process.exit(2);
