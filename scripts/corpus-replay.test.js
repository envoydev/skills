// The replay harness has to be trustworthy before its verdicts mean anything: a bug here reports a
// live gate as dead, or worse, a dead gate as live. These run it over a SYNTHETIC corpus with a
// known answer, so they need no session data and run in CI.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'corpus-replay.js');

function corpus(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-corpus-'));
  fs.writeFileSync(path.join(dir, 'session.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return dir;
}
const toolRow = (name, input, cwd) => ({
  type: 'assistant', cwd: cwd || '/tmp/some-project',
  message: { content: [{ type: 'tool_use', name, input }] },
});
function run(dir, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--corpus', dir, '--jobs', '4', ...args], { encoding: 'utf8' });
  return { out: r.stdout, err: r.stderr, status: r.status };
}
const rowFor = (out, route) => (out.split('\n').find((l) => l.startsWith(`| ${route} |`)) || '');

test('corpus-replay: one Bash payload fans out to every Bash-wired guard', () => {
  const dir = corpus([toolRow('Bash', { command: 'ls -la' })]);
  const { out } = run(dir, '--extract-only');
  for (const h of ['protected-force-push', 'catastrophic-rm', 'read-whole-file', 'secret-value', 'ungated-commit', 'cross-project-write']) {
    assert.match(out, new RegExp(`guard-${h}\\.js::PreToolUse:Bash`), `${h} must see a Bash payload`);
  }
});

test('corpus-replay: identical payloads are replayed once', () => {
  const dir = corpus([toolRow('Bash', { command: 'git status' }), toolRow('Bash', { command: 'git status' })]);
  const { err } = run(dir, '--extract-only');
  assert.match(err, /tool_use 2\b/, 'both blocks are extracted');
  assert.match(err, /unique replay jobs: 6\b/, 'but dedupe leaves one job per Bash route');
});

test('corpus-replay: a payload the guard must block is counted as fired', () => {
  // A recursive rm of $HOME is the catastrophic-rm guard's whole reason to exist. If the harness
  // cannot see THIS fire, no verdict it prints about any gate is worth reading.
  const dir = corpus([toolRow('Bash', { command: 'rm -rf ~' })]);
  const { out } = run(dir, '--hook', 'catastrophic-rm');
  assert.match(rowFor(out, 'guard-catastrophic-rm.js::PreToolUse:Bash'), /\| 1 \| 100\.00% \| 0 \| /, 'blocked, so fired');
});

test('corpus-replay: a guard that never fires is reported DEAD and exits non-zero', () => {
  const dir = corpus([toolRow('Bash', { command: 'echo hello' })]);
  const { out, status } = run(dir, '--hook', 'catastrophic-rm');
  assert.match(rowFor(out, 'guard-catastrophic-rm.js::PreToolUse:Bash'), /DEAD/, 'a benign echo fires nothing');
  assert.equal(status, 1, 'a dead route fails the run');
});

test('corpus-replay: an always-on injector is not mislabelled as noisy', () => {
  // guard-answer-length injects the budget on EVERY prompt. Reading its 100% as a false-positive
  // rate would send a maintainer to fix a hook that is working exactly as designed.
  const dir = corpus([{ type: 'user', cwd: '/tmp/some-project', message: { content: 'do the thing' } }]);
  const { out } = run(dir, '--hook', 'guard-answer-length.js::UserPromptSubmit');
  assert.match(rowFor(out, 'guard-answer-length.js::UserPromptSubmit'), /by design/, 'labelled by design');
});

test('corpus-replay: a Stop route replays a real transcript prefix', () => {
  const dir = corpus([
    toolRow('Bash', { command: 'ls' }),
    { type: 'assistant', cwd: '/tmp/some-project', message: { content: [{ type: 'text', text: 'x'.repeat(400) }] } },
  ]);
  const { out, err } = run(dir, '--hook', 'guard-stop-contract.js::Stop');
  assert.match(err, /stop points 1\b/, 'the long answer is a stop point');
  assert.match(rowFor(out, 'guard-stop-contract.js::Stop'), /\| 1 \|/, 'and it is replayed');
});

test('corpus-replay: nothing is written outside the scratch dir', () => {
  // The guards append a block row to <docs-path>/hook-blocks and keep session state there. Replaying
  // 120k payloads with that pointed at a real project would forge a field ledger out of history -
  // so the harness points every guard's docs root and config dir at its own scratch. Pin that by
  // making the replayed payload's cwd the corpus itself and checking nothing appeared in it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-corpus-'));
  fs.writeFileSync(path.join(dir, 'session.jsonl'),
    JSON.stringify(toolRow('Bash', { command: 'rm -rf ~' }, dir)) + '\n');
  run(dir, '--hook', 'catastrophic-rm');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['session.jsonl'], 'the project root stays clean');
});

test('corpus-replay: the ROUTES table matches what the installer actually wires', () => {
  // The harness only replays routes it knows about. If a release wires a new matcher and this table
  // is not updated, the new gate is simply never measured - and 'not measured' would read as silence,
  // not as a gap. Pin the two together against the installer, which is the wiring's source of truth.
  const sh = fs.readFileSync(path.join(__dirname, 'os', 'claude-stack.sh'), 'utf8');
  const wired = new Set();
  for (const m of sh.matchAll(/^\s*"(guard-[a-z-]+\.js)::([^:]*)::/gm)) {
    const [, hook, spec] = m;
    // `@Event` / `@Event:matcher` is a lifecycle wiring; a bare matcher list is PreToolUse.
    const event = spec.startsWith('@') ? spec.slice(1).split(':')[0] : 'PreToolUse';
    if (event === 'SessionStart') continue; // replayed by 1c's config matrix, not by liveness
    for (const tool of (event === 'PreToolUse' ? spec.split('|') : [null])) wired.add(`${hook}::${event}${tool ? ':' + tool : ''}`);
  }
  const known = new Set();
  for (const r of require('./corpus-replay.js').ROUTES) {
    for (const tool of (r.tools || [null])) known.add(`${r.hook}::${r.event}${tool ? ':' + tool : ''}`);
  }
  const missing = [...wired].filter((w) => !known.has(w));
  assert.deepEqual(missing, [], `wired but never replayed: ${missing.join(', ')}`);
});

test('corpus-replay: a transcript-reading guard is actually given its transcript', () => {
  // guard-fresh-session-start sizes the session off the transcript. A payload without
  // `transcript_path` leaves it blind, and a blind gate can never fire - the first full corpus run
  // reported this route DEAD for exactly that reason, which was the harness, not the hook.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-corpus-'));
  const big = { cache_read_input_tokens: 190000, input_tokens: 20, output_tokens: 20 };
  fs.writeFileSync(path.join(dir, 'session.jsonl'), [
    { type: 'assistant', cwd: dir, message: { id: 'm1', content: [{ type: 'text', text: 'x'.repeat(300) }], usage: big } },
    toolRow('Skill', { skill: 'project-solve-task' }, dir),
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { out } = run(dir, '--hook', 'guard-fresh-session-start.js::PreToolUse');
  const row = rowFor(out, 'guard-fresh-session-start.js::PreToolUse:Skill');
  assert.doesNotMatch(row, /DEAD/, 'an orchestration run started at 190k must trip the gate');
});

test('corpus-replay: a mid-turn answer is not a stop point', () => {
  // A Stop fires when the TURN ends. Counting every long assistant paragraph fed the gate mid-turn
  // prose - prose that legitimately ends on a question with work still pending, which is what the
  // gate blocks. That definition read 45% on the corpus: a measurement of the harness.
  const answer = (t) => ({ type: 'assistant', cwd: '/tmp/p', message: { content: [{ type: 'text', text: t }] } });
  const dir = corpus([
    answer('a'.repeat(300)),                                  // mid-turn: more work follows
    toolRow('Bash', { command: 'ls' }),
    answer('b'.repeat(300)),                                  // the real end of the turn
    { type: 'user', cwd: '/tmp/p', message: { content: 'next please' } },
    answer('c'.repeat(300)),                                  // the final answer
  ]);
  const { err } = run(dir, '--extract-only');
  assert.match(err, /stop points 2\b/, 'two turn boundaries, not three long paragraphs');
});

test('corpus-replay: a declared-unexercised route does not read as dead, an undeclared one does', () => {
  // Silence has two causes and they are not the same finding: the gate is broken, or the thing it
  // guards never happened. Declaring the second costs one line and a reason; leaving it undeclared
  // must stay loud, or the run trains its reader to skim past DEAD.
  const { UNEXERCISED } = require('./corpus-replay.js');
  assert.ok(UNEXERCISED['guard-protected-force-push.js::PreToolUse:Bash'], 'force-push is declared');
  const dir = corpus([toolRow('Bash', { command: 'echo hi' })]);
  const declared = run(dir, '--hook', 'protected-force-push');
  assert.match(rowFor(declared.out, 'guard-protected-force-push.js::PreToolUse:Bash'), /unexercised \(declared\)/);
  assert.equal(declared.status, 0, 'a declared silence passes');
  const undeclared = run(dir, '--hook', 'catastrophic-rm');
  assert.match(rowFor(undeclared.out, 'guard-catastrophic-rm.js::PreToolUse:Bash'), /DEAD/);
  assert.equal(undeclared.status, 1, 'an undeclared silence fails');
});
