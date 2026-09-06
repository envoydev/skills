#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// PreToolUse gate (matchers: Read + Bash): enforce baseline-navigation.md's hard rule - "Read
// is for code you've ALREADY located, never to find a symbol." Blocks a whole-file Read of a
// large source file so navigation goes through serena (get_symbols_overview -> find_symbol)
// first; on Bash it blocks the same dump routed around the Read tool (a bare `cat file.ts` -
// measured: one session cat-ed the exact file the Read matcher had blocked, unblocked, and a
// 47-file grep loop dumped ~19.8k tokens the guard never saw). It also caps CUMULATIVE ranged
// reads per file per session: 2-3 half-splits that reconstruct the whole file satisfied the
// per-call check in 7 files across one run with zero counter-examples, so past ~60% coverage
// the remainder goes through serena. A cat whose output is redirected into a file is a copy,
// not a dump, and passes. exit 2 = block (stderr fed back); exit 0 = allow.
const fs = require('fs');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving
// (the installers rename the key in place on the next install/update).
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';
const os = require('os');
const pathMod = require('path');
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
const GATED_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|cs|go|razor|cshtml|xaml|html)$/;
// Same extensions, unanchored - a sweep command names its files inside a glob or a loop body,
// never as the string's own tail, so the anchored form above can never match a command line.
const GATED_EXT_ANY = /\.(ts|tsx|js|jsx|mjs|cjs|cs|go|razor|cshtml|xaml|html)\b/i;
// Small files are cheap to read whole. 200, not 100: measured across four real
// sessions (315 blocks), ~71% of blocks hit 100-200-line files where the forced
// serena detour costs about what the whole-file read would - the guard only pays above 200.
const THRESHOLD = 200;
const lineCountOf = (p) => {
  try { return fs.readFileSync(p, 'utf8').split('\n').length; } catch { return 0; }
};
// Resolve a possibly-relative path the way the session sees it. The hook subprocess's own
// cwd is NOT the Bash tool's persisted cwd (a prior `cd` in another call moves it), so a bare
// relative path must be anchored - same anchor the sibling hooks use (measured: 10 relative
// `cat -n` dumps after a `cd` all resolved ENOENT -> lineCount 0 -> the guard silently passed
// ~20k tokens of whole-file dumps; reproduced: the same payload blocks from the project root).
const anchorDirs = [process.env.CLAUDE_PROJECT_DIR, payload.cwd, process.cwd()].filter(Boolean);
// Git Bash / MSYS spell a Windows path in POSIX MOUNT form (`/c/Users/...`, `/cygdrive/c/...`),
// which node on win32 resolves against the CURRENT drive instead - the same falsehood that made
// the cross-project guard block a session's own temp cleanup. Translate before resolving; off
// Windows the spelling is a real POSIX path and is never touched.
const MOUNT_RE = /^(?:\/cygdrive)?\/([A-Za-z])(?=\/|$)/;
const nativePath = (p) => (process.platform === 'win32'
  ? String(p).replace(MOUNT_RE, (m, d) => `${d.toUpperCase()}:\\`)
  : String(p));
const resolveLineCount = (raw) => {
  const p = nativePath(raw);
  if (pathMod.isAbsolute(p)) return { lc: lineCountOf(p), resolved: true };
  for (const d of anchorDirs) {
    const abs = pathMod.join(d, p);
    if (fs.existsSync(abs)) return { lc: lineCountOf(abs), resolved: true };
  }
  return { lc: 0, resolved: false };
};
const serenaHint = (p) =>
  `Locate first with serena: get_symbols_overview('${p}') then find_symbol(...),\n` +
  `then Read with offset+limit on the returned range (find_symbol with include_body=true only for a SMALL symbol;\n` +
  `for a large body fetch it without the body first, then Read the range you need).`;

const input = payload.tool_input || {};

// ---- Bash matcher: a whole-file dump via cat/sed is the Read block routed around ----
if (payload.tool_name === 'Bash') {
  // A heredoc body is DATA, not shell: a plan or checklist that merely DESCRIBES a dangerous
  // command is inert text, and matching it blocks a document write for its own prose (reproduced).
  // Blank the payload spans, keeping the character count so any index into the command still holds.
  const stripHeredocs = (c) => c.replace(
    /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
    (m) => m.replace(/[^\n]/g, ' '),
  );
  const command = stripHeredocs(String(input.command || ''));
  // Only `cat`/`sed` were gated, so the same whole-file dump walked through under any other verb:
  // `head -n 100000`, `tail -n +1`, `less`, `awk '1'`, `python3 -c "print(open(f).read())"` all
  // passed (reproduced x5 against a 1371-line file).
  // This pre-filter must name every verb the branches below look for: `readFileSync` / `File.read`
  // were in the runtime-dump pattern but not here, so `node -e "...readFileSync(f)..."` exited on
  // this line and that branch never ran (reproduced against the same 1371-line file).
  if (!/\bcat\b|\bsed\b|\bhead\b|\btail\b|\bless\b|\bmore\b|\bawk\b|\bopen\(|\breadFileSync\b|File\.read/.test(command)) process.exit(0);
  // EVERY test below is PER SEGMENT, and the extension is tested against the PATH the verb names -
  // never against the whole command. Testing `GATED_EXT_ANY` against the whole compound command
  // denied a command for an unrelated `*.js` glob sitting in a SIBLING segment (replayed: exit 2;
  // the same command minus that segment exit 0), and the sweep test running above the loop denied
  // an exact-filename `find -name` because a co-located bounded `grep | head -20` shared the line.
  // A path this guard cannot resolve is judged by its own segment, which is the old behaviour
  // narrowed to one segment rather than the whole line.
  const gatedIn = (text) => GATED_EXT_ANY.test(text);

  // Three shapes dumped whole source trees straight past the single-file check below (measured in
  // 5 sessions, 16-23 .cs files each, ~20k tokens a sweep): a shell loop whose cat argument is the
  // loop VARIABLE, a find -exec whose argument is the literal {}, and a multi-file `cat a.cs b.cs`
  // where only the first argument was ever size-checked. None can be size-checked per file.
  // A loop SPANS `;` boundaries by nature, so this one test stays above the segment loop - but the
  // extension is tested against the CONSTRUCT's own text, not the whole line, which is what denied
  // a command for an unrelated glob in a sibling segment. And a `find -name '<literal filename>'`
  // is exempt: no glob metacharacter means it names ONE file - the 'I know the name, not the path'
  // idiom, which falls through to the size check below like any other named target (its own denial
  // text used to advise doing exactly that).
  const sweepM = command.match(/\bfor\s+\w+\s+in\b[^\n]*?\bdo\b[^\n]*?\bcat\b[^\n]*/i)
    || command.match(/\bfind\b[^\n]*?-exec\s+cat\b[^\n]*/i)
    || command.match(/[^\n]*?\|\s*xargs\s+(?:-\w+\s+)*cat\b[^\n]*/i);
  if (sweepM) {
    const sweep = /\bfor\b/i.test(sweepM[0]) ? 'a shell loop over a file list'
      : /-exec/i.test(sweepM[0]) ? 'find -exec cat' : 'xargs cat';
    const namedFind = sweepM[0].match(/-name\s+(["']?)([^"'\s*?\[\]]+)\1(?=\s|$)/);
    if (!namedFind && gatedIn(sweepM[0])) {
      process.stderr.write(
        `Blocked: whole-file sweep of source files via ${sweep}.\n` +
        `Every file in the sweep is dumped unchecked - the per-file size gate cannot see a loop\n` +
        `variable or a find placeholder. Per baseline-navigation.md, locate what you need first\n` +
        `(serena find_symbol / get_symbols_overview, or grep -n for a pattern), then read only the\n` +
        `ranges that matter. If you genuinely need one whole small file, cat it by name.`,
      );
      process.exit(2);
    }
  }
  for (const seg of command.split(/&&|\|\||;|\n/)) {
    if (/\|\s*(head|tail|sed|grep|rg|wc|awk|cut)\b/.test(seg)) continue;
    // Output redirected INTO a file never reaches the context - `cat a.ts > copy.ts` is a copy,
    // not a dump (an fd form like `2>&1` / `>&2` still prints, so only a path target is exempt).
    if (/\s>>?\s*[^&\s>]/.test(seg)) continue;

    // A whole-file read through a language runtime is the same dump with a different spelling.
    const rtCall = seg.match(/\b(?:python3?|node|perl|ruby)\b[^\n]*?\b(?:open\(\s*(["'][^"']*["'])[^)]*\)\s*\.read\(|(?:readFileSync|File\.read)\(\s*(["'][^"']*["']))/);
    if (rtCall && gatedIn(rtCall[1] || rtCall[2] || seg)) {
      process.stderr.write(
        'Blocked: whole-file read of a source file through a language runtime.\n' +
        'Per baseline-navigation.md this is the same whole-file read the Read gate blocks, spelled\n' +
        'differently. Locate the symbol first (serena find_symbol / get_symbols_overview), then read\n' +
        'only the range you need.',
      );
      process.exit(2);
    }

    // A dump verb whose output is unbounded is a dump: `head -n <huge>` and `tail -n +1` both print
    // the whole file, while a bounded `head -40` is the targeted read this gate exists to encourage.
    const unb = seg.match(/\bhead\s+-n\s*\d{5,}\s+((?:-\S+\s+)*\S+)/)
      || seg.match(/\btail\s+-n\s*\+\s*1\s+((?:-\S+\s+)*\S+)/)
      || seg.match(/\b(?:less|more)\s+((?:-\S+\s+)*\S+)/)
      || seg.match(/\bawk\s+(?:['"])1(?:['"])\s+((?:-\S+\s+)*\S+)/);
    if (unb && gatedIn(unb[1])) {
      process.stderr.write(
        'Blocked: unbounded whole-file dump (head -n <huge> / tail -n +1 / less / awk \'1\').\n' +
        'Per baseline-navigation.md, read the located range - serena find_symbol, or a bounded\n' +
        'sed -n \'<start>,<end>p\' once you know where to look.',
      );
      process.exit(2);
    }

    // Per pipeline segment: a bare `cat <gated file>` (or sed -n '1,$p') with no limiting
    // filter after it is a whole-file dump; `cat f | head -40` / grep / wc are targeted.
    const catAll = seg.match(/\bcat\s+((?:(?:-\w+|"[^"]+"|'[^']+'|[^\s;&|<>]+)\s*)+)/);
    const files = catAll
      ? catAll[1].trim().split(/\s+/).filter((t) => !t.startsWith('-')).map((t) => t.replace(/^["']|["']$/g, ''))
      : [];
    const sedM = seg.match(/\bsed\s+-n\s+["']1,\$p["']\s+("[^"]+"|'[^']+'|[^\s;&|<>]+)/);
    if (sedM) files.push(sedM[1].replace(/^["']|["']$/g, ''));
    for (const f of files) {
    if (!GATED_EXT.test(f)) continue;
    const { lc, resolved } = resolveLineCount(f);
    if (!resolved) {
      // A dump-shaped command on a gated file whose size we cannot check fails CLOSED -
      // an unresolvable relative path was exactly how whole-file dumps slipped past this
      // matcher. Re-run with an absolute path (or read the located range via serena).
      process.stderr.write(
        `Blocked: cannot size ${f} (relative path did not resolve against the project root or session cwd).\n` +
        `A whole-file cat/sed of a source file must be size-checked - use an absolute path,\n` +
        `or locate the symbol first:\n` + serenaHint(f),
      );
      process.exit(2);
    }
    if (lc > THRESHOLD) {
      process.stderr.write(
        `Blocked: whole-file dump of ${f} (${lc} lines) via Bash.\n` +
        `Per baseline-navigation.md, a bare cat/sed of a large source file is the same\n` +
        `whole-file read the Read gate blocks - routed through the shell.\n` + serenaHint(f),
      );
      process.exit(2);
    }
    }
  }
  process.exit(0);
}

// ---- Read matcher ----
const path = input.file_path || '';
// Only gate source / markup files we navigate by symbol or read by range:
// the symbol-navigable languages the stack's LSP plugins cover (TS/JS family,
// C#, Go), plus large templates (Angular .html, Razor .razor/.cshtml, WPF
// .xaml) where you should read the range. SQL/SCSS/markdown aren't symbol-nav.
if (!GATED_EXT.test(path)) process.exit(0);
const lineCount = lineCountOf(path);
if (lineCount === 0) process.exit(0); // missing/unreadable - let Read surface its own error
if (lineCount <= THRESHOLD) process.exit(0);

const offset = Math.max(1, input.offset ?? 1);
const wholeShape = (input.offset ?? 0) <= 1 && (input.limit == null || input.limit >= lineCount);
// A head window genuinely smaller than the file is targeted; a limit that spans
// the whole file (limit: 2000 from the top) is a whole-file Read wearing a range.
if (wholeShape) {
  process.stderr.write(
    `Blocked: whole-file Read of ${path} (${lineCount} lines).\n` +
      `Per baseline-navigation.md, Read is for code you've ALREADY located - never to find a symbol.\n` +
      `A limit that covers the whole file is still a whole-file Read - and so is\n` +
      `offset 1 with limit = the file's line count (measured: that exact retry got\n` +
      `blocked twice in a row). Read HALF the file or less per range.\n` + serenaHint(path),
  );
  process.exit(2);
}

// Cumulative cap: merge this range into the per-session interval set for the file; if the
// merged coverage would exceed ~60% of the file, the remainder goes through serena - two
// half-splits reconstructing the file are the whole-file read in two calls (measured).
const CAP = 0.6;
const end = Math.min(lineCount, offset + (input.limit != null ? input.limit : lineCount) - 1);
const stateFile = pathMod.join(os.tmpdir(), `guard-read-${(payload.session_id || 'nosession').replace(/[^\w-]/g, '')}.json`);
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* fresh state */ }
const intervals = (state[path] || []).concat([[offset, end]]).sort((a, b) => a[0] - b[0]);
const merged = [];
for (const iv of intervals) {
  const last = merged[merged.length - 1];
  if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
  else merged.push([iv[0], iv[1]]);
}
const covered = merged.reduce((n, [a, b]) => n + (b - a + 1), 0);
if (covered > lineCount * CAP) {
  process.stderr.write(
    `Blocked: ranged Reads of ${path} now cover ${Math.round((100 * covered) / lineCount)}% of its ${lineCount} lines this session -\n` +
      `reconstructing a large file from half-splits is the whole-file read the guard exists to stop\n` +
      `(measured: 2-3-call splits rebuilt 7 blocked files in one run). For the remainder:\n` + serenaHint(path),
  );
  process.exit(2);
}
state[path] = merged;
try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch { /* state is best-effort */ }
process.exit(0);
