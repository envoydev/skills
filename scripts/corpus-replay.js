#!/usr/bin/env node
// Corpus replay - Tier 1b of docs/regression-corpus.plan.md.
//
// The wired guards ship with ~240 hand-written fixtures. Every one of them was invented by the
// same author who wrote the hook, in the same sitting, so they encode the hook's assumptions -
// including the wrong ones. This replays the guards against REAL collected session payloads and
// answers the one question no fixture can: does each gate ever fire on real traffic, and how often.
//
// A gate that blocks 0 of tens of thousands of real payloads is DEAD (the 203-session audit's worst
// finding was exactly that shape). A gate whose rate jumps without a code reason is a false-positive
// engine, and a false positive is worse than a miss: it teaches the model a bypass it then uses on
// the turn that mattered.
//
// The corpus is private session data and is never tracked. This script reads it, and everything it
// writes carries payload HASHES, never payload text - so its output is safe in a public repo.
//
//   node scripts/corpus-replay.js --corpus docs/session-investigation [--out report.json]
//
// Flags: --jobs N (default: cpus), --hook <substr> (limit), --stops-per-transcript N (default 10),
//        --extract-only (count, do not replay), --limit N (cap replays per route, for a smoke run).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'stack', 'hooks');

// ---------------------------------------------------------------------------
// The wiring. This is the SAME table the installers write into settings.json -
// keep it in step with scripts/os/claude-stack.sh's HOOKS list, which is the
// source of truth. `deny` marks a route whose verdict is exit 2; the rest are
// injection routes, where firing means additionalContext came back on stdout.
// ---------------------------------------------------------------------------
const ROUTES = [
  { hook: 'guard-protected-force-push.js', event: 'PreToolUse', tools: ['Bash'], deny: true },
  { hook: 'guard-catastrophic-rm.js', event: 'PreToolUse', tools: ['Bash'], deny: true },
  { hook: 'guard-read-whole-file.js', event: 'PreToolUse', tools: ['Read', 'Bash'], deny: true },
  { hook: 'guard-unapproved-dispatch.js', event: 'PreToolUse', tools: ['Task', 'Agent'], deny: true },
  { hook: 'guard-ungated-commit.js', event: 'PreToolUse', tools: ['Bash'], deny: true },
  { hook: 'guard-stop-contract.js', event: 'PreToolUse', tools: ['AskUserQuestion'], deny: false, needsTranscript: true },
  { hook: 'guard-fresh-session-start.js', event: 'PreToolUse', tools: ['Skill'], deny: true, needsTranscript: true },
  { hook: 'guard-cross-project-write.js', event: 'PreToolUse', tools: ['Write', 'Edit', 'NotebookEdit', 'Bash'], deny: true },
  { hook: 'guard-stop-contract.js', event: 'Stop', deny: true },
  { hook: 'guard-answer-length.js', event: 'Stop', deny: true },
  { hook: 'guard-fresh-session-start.js', event: 'UserPromptSubmit', deny: false, needsTranscript: true },
  // Injects the budget on EVERY prompt by design - 100% is correct here, not a false-positive rate.
  { hook: 'guard-answer-length.js', event: 'UserPromptSubmit', deny: false, always: true },
];
// A route can be silent on the corpus for two very different reasons: the gate is broken, or the
// thing it guards simply never happened. Only the second is acceptable, and declaring it here is
// the point - it costs one line and a reason, and it keeps every UNDECLARED silence loud.
// The evidence a declared route needs is proof the gate CAN fire: its own unit coverage.
const UNEXERCISED = {
  'guard-protected-force-push.js::PreToolUse:Bash':
    'no force-push to a protected branch occurred in 21.5k Bash payloads; the gate fires in guard-hooks.test.js',
};

const routeId = (r, tool) => `${r.hook}::${r.event}${tool ? ':' + tool : ''}`;

function parseArgs(argv) {
  const a = { corpus: 'docs/session-investigation', jobs: os.cpus().length, stops: 10, limit: 0 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--corpus') a.corpus = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--jobs') a.jobs = Number(argv[++i]) || 1;
    else if (k === '--hook') a.hook = argv[++i];
    else if (k === '--stops-per-transcript') a.stops = Number(argv[++i]) || 0;
    else if (k === '--limit') a.limit = Number(argv[++i]) || 0;
    else if (k === '--extract-only') a.extractOnly = true;
  }
  return a;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // AUDIT/ holds the audit's own write-ups, not collected sessions.
    if (e.isDirectory()) { if (e.name !== 'AUDIT') walk(p, out); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Even spacing that always keeps the LAST point: the final assistant text of a transcript is the
// turn that really ended, and it is the one a Stop gate exists to judge.
function sample(arr, n) {
  if (!n || arr.length <= n) return arr;
  const step = (arr.length - 1) / (n - 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return [...new Set(out)];
}

// ---------------------------------------------------------------------------
// Extraction. One pass per transcript; nothing but the extracted jobs is kept,
// so a 500MB corpus never lands in memory at once.
// ---------------------------------------------------------------------------
function extract(files, opts) {
  const jobs = new Map();          // dedupe key -> job
  const counts = { rows: 0, toolUse: 0, stops: 0, prompts: 0, files: 0 };

  for (const file of files) {
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch { continue; }
    counts.files++;
    const lines = txt.split('\n');
    const answerRows = [];   // every long assistant text
    const typedUserRows = []; // where the user actually took the turn back
    let cwd = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      counts.rows++;
      if (o.cwd) cwd = o.cwd;
      const content = o.message && o.message.content;

      if (o.type === 'assistant' && Array.isArray(content)) {
        for (const b of content) {
          if (b && b.type === 'tool_use') {
            counts.toolUse++;
            for (const r of ROUTES) {
              if (r.event !== 'PreToolUse' || !r.tools.includes(b.name)) continue;
              const payload = { hook_event_name: 'PreToolUse', tool_name: b.name, tool_input: b.input || {}, cwd };
              const key = routeId(r, b.name) + '|' + sha(JSON.stringify([b.name, b.input, cwd]));
              if (!jobs.has(key)) jobs.set(key, { key, route: routeId(r, b.name), hook: r.hook, deny: r.deny, payload, cwd, prefix: r.needsTranscript ? { file, upto: i } : null });
            }
          }
          // A text block long enough to be a real answer is a Stop point: the turn ended there.
          if (b && b.type === 'text' && String(b.text || '').length > 200) answerRows.push(i);
        }
      }

      if (o.type === 'user' && typeof content === 'string' && content.trim() && !content.startsWith('<')) {
        counts.prompts++;
        typedUserRows.push(i);
        for (const r of ROUTES) {
          if (r.event !== 'UserPromptSubmit') continue;
          const payload = { hook_event_name: 'UserPromptSubmit', prompt: content, cwd };
          const key = routeId(r) + '|' + sha(JSON.stringify([content, cwd]));
          if (!jobs.has(key)) jobs.set(key, { key, route: routeId(r), hook: r.hook, deny: r.deny, always: r.always, payload, cwd, prefix: r.needsTranscript ? { file, upto: i } : null });
        }
      }
    }

    // A Stop fires when the TURN ends, not on every long paragraph: the last answer before the
    // user takes the turn back, plus the final answer of the transcript. Treating every long text
    // block as a stop point fed the gate mid-turn prose - prose that legitimately ends on a
    // question, with work still pending, which is precisely what the gate blocks. The first full
    // run read 45% on that definition; it was measuring the harness, not the hook.
    const stopPoints = [];
    for (const u of typedUserRows) {
      const prev = answerRows.filter((a) => a < u).pop();
      if (prev !== undefined && !stopPoints.includes(prev)) stopPoints.push(prev);
    }
    const last = answerRows[answerRows.length - 1];
    if (last !== undefined && !stopPoints.includes(last)) stopPoints.push(last);

    for (const idx of sample(stopPoints, opts.stops)) {
      counts.stops++;
      for (const r of ROUTES) {
        if (r.event !== 'Stop') continue;
        const key = routeId(r) + '|' + sha(file + ':' + idx);
        if (!jobs.has(key)) jobs.set(key, { key, route: routeId(r), hook: r.hook, deny: r.deny, prefix: { file, upto: idx }, cwd });
      }
    }
  }
  return { jobs: [...jobs.values()], counts };
}

// ---------------------------------------------------------------------------
// Replay. Each job is the shipped hook, spawned exactly as the harness spawns
// it. The isolation matters: CLAUDE_STACK_DOCS_PATH goes to scratch so no state
// file or hook-block row lands in a real project, and CLAUDE_CONFIG_DIR is empty
// so a real account settings.json model id cannot move a context threshold.
// ---------------------------------------------------------------------------
function makeEnv(scratch, cwd) {
  return {
    ...process.env,
    CLAUDE_PROJECT_DIR: cwd || scratch,
    CLAUDE_STACK_DOCS_PATH: path.join(scratch, 'docs'),
    CLAUDE_CONFIG_DIR: path.join(scratch, 'config'),
    CLAUDE_STACK_INSTRUMENT: '0',
  };
}

function runOne(job, scratch) {
  return new Promise((resolve) => {
    let payload = job.payload;
    let prefixPath = '';
    if (job.prefix) {
      // The transcript the hook would have read at that moment: the real bytes up to this row.
      // Three of the guards size the session's context off it, so a payload WITHOUT it can never
      // fire - the first full run reported two of them dead for exactly that reason.
      const lines = fs.readFileSync(job.prefix.file, 'utf8').split('\n');
      prefixPath = path.join(scratch, 'transcripts', sha(job.key) + '.jsonl');
      fs.writeFileSync(prefixPath, lines.slice(0, job.prefix.upto + 1).join('\n') + '\n');
      payload = payload
        ? { ...payload, transcript_path: prefixPath }
        : { hook_event_name: 'Stop', transcript_path: prefixPath, cwd: job.cwd };
    }
    const child = spawn(process.execPath, [path.join(HOOKS_DIR, job.hook)], {
      env: makeEnv(scratch, job.cwd), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', () => resolve({ ...job, status: -1, fired: false, error: 'spawn' }));
    child.on('close', (status) => {
      if (prefixPath) { try { fs.unlinkSync(prefixPath); } catch {} }
      // A deny route fires on exit 2. An injection route fires when it actually emitted
      // additionalContext - a silent exit 0 is the hook deciding there was nothing to say.
      const fired = job.deny ? status === 2 : /additionalContext/.test(out);
      resolve({ key: job.key, route: job.route, status, fired, error: status !== 0 && status !== 2 ? err.slice(0, 200) : '' });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function pool(jobs, n, scratch, onTick) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, n) }, async () => {
    while (i < jobs.length) {
      const job = jobs[i++];
      results.push(await runOne(job, scratch));
      if (onTick && results.length % 500 === 0) onTick(results.length, jobs.length);
    }
  });
  await Promise.all(workers);
  return results;
}

// The rows `<docs-path>/hook-blocks/<session>.jsonl` accumulated in the field, collected with the
// bundles. Small - the ledger shipped recently, so most bundles predate it - but it is ground truth.
function fieldBlocks(corpus) {
  const out = {};
  const files = [];
  (function find(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) find(p);
      else if (e.name.endsWith('.jsonl') && (e.name.startsWith('hook-blocks') || path.basename(dir) === 'hook-blocks')) files.push(p);
    }
  })(corpus);
  for (const f of files) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const k = `${o.hook || '?'}::${o.event || o.tool || '?'}`;
      out[k] = (out[k] || 0) + 1;
    }
  }
  return out;
}

async function main() {
  const a = parseArgs(process.argv);
  const corpus = path.resolve(a.corpus);
  if (!fs.existsSync(corpus)) { console.error(`corpus not found: ${corpus}`); process.exit(1); }

  const files = walk(corpus);
  process.stderr.write(`extracting from ${files.length} transcripts...\n`);
  const { jobs: all, counts } = extract(files, a);
  let jobs = a.hook ? all.filter((j) => j.route.includes(a.hook)) : all;

  if (a.limit) {
    const perRoute = new Map();
    jobs = jobs.filter((j) => {
      const n = (perRoute.get(j.route) || 0) + 1;
      perRoute.set(j.route, n);
      return n <= a.limit;
    });
  }

  process.stderr.write(`rows ${counts.rows} | tool_use ${counts.toolUse} | stop points ${counts.stops} | prompts ${counts.prompts}\n`);
  process.stderr.write(`unique replay jobs: ${jobs.length}\n`);
  if (a.extractOnly) {
    const byRoute = {};
    for (const j of jobs) byRoute[j.route] = (byRoute[j.route] || 0) + 1;
    for (const [r, n] of Object.entries(byRoute).sort((x, y) => y[1] - x[1])) console.log(String(n).padStart(7), r);
    return;
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-replay-'));
  fs.mkdirSync(path.join(scratch, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'config'), { recursive: true });

  const t0 = Date.now();
  const results = await pool(jobs, a.jobs, scratch, (done, total) =>
    process.stderr.write(`  ${done}/${total} (${Math.round((Date.now() - t0) / 1000)}s)\n`));
  const elapsed = Math.round((Date.now() - t0) / 1000);

  const ALWAYS = new Set(ROUTES.filter((r) => r.always).map((r) => routeId(r)));
  const byRoute = new Map();
  for (const r of results) {
    const s = byRoute.get(r.route) || { route: r.route, always: ALWAYS.has(r.route), replayed: 0, fired: 0, errors: 0, firedKeys: [] };
    s.replayed++;
    if (r.fired) { s.fired++; if (s.firedKeys.length < 25) s.firedKeys.push(r.key.split('|')[1]); }
    if (r.error) s.errors++;
    byRoute.set(r.route, s);
  }
  const rows = [...byRoute.values()].sort((x, y) => x.route.localeCompare(y.route));

  console.log('');
  console.log('| route | replayed | fired | rate | errors | verdict |');
  console.log('|---|---:|---:|---:|---:|---|');
  for (const s of rows) {
    const rate = s.replayed ? (s.fired / s.replayed) * 100 : 0;
    const verdict = s.always ? 'by design (always injects)'
      : s.fired === 0 && UNEXERCISED[s.route] ? 'unexercised (declared)'
      : s.fired === 0 ? '**DEAD**'
      : rate > 5 ? '**REVIEW** - high rate for real traffic'
      : 'live';
    console.log(`| ${s.route} | ${s.replayed} | ${s.fired} | ${rate.toFixed(2)}% | ${s.errors} | ${verdict} |`);
  }
  const dead = rows.filter((s) => s.fired === 0 && !s.always && !UNEXERCISED[s.route]);

  // Cross-check against what the guards actually recorded in the FIELD. The replay is a model of
  // how the hooks run; the ledger is what happened. A route the replay calls dead that the field
  // shows firing means the harness has drifted, not that the gate is dead.
  const field = fieldBlocks(corpus);
  if (Object.keys(field).length) {
    console.log('');
    console.log('Field ledger (hook-blocks rows collected with the bundles):');
    for (const [h, n] of Object.entries(field).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${h}`);
  }
  console.log('');
  console.log(`${rows.length} routes, ${results.length} replays in ${elapsed}s. ${dead.length} dead.`);

  if (a.out) {
    // Hashes only - this file is safe to track. A moved verdict names a hash; look it up locally.
    fs.writeFileSync(a.out, JSON.stringify({
      generated: new Date().toISOString().slice(0, 10),
      corpusTranscripts: counts.files, replays: results.length,
      routes: rows.map((s) => ({ route: s.route, replayed: s.replayed, fired: s.fired, errors: s.errors, sampleFiredHashes: s.firedKeys })),
      fieldLedger: field,
    }, null, 2) + '\n');
    process.stderr.write(`wrote ${a.out}\n`);
  }
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  process.exitCode = dead.length ? 1 : 0;
}

// The test pins ROUTES against the installer's wiring; running as a script still calls main().
module.exports = { ROUTES, UNEXERCISED };
if (require.main === module) main();
