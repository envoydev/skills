'use strict';

// analyze-usage.test.js - the analyzer's accounting invariants against a synthetic
// transcript: per-message usage dedup (fold-max), tool-result volume, per-skill
// attribution incl. cache-read, --from/--to windowing, and flag-before-target parsing.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'analyze-usage.js');

const line = (o) => JSON.stringify(o) + '\n';
const usage = (input, cc, cr, out) => ({
  input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out,
});

function writeFixture(dir) {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file,
    // msg m1, duplicated line with identical usage - must count ONCE
    line({ type: 'assistant', timestamp: '2026-07-15T07:00:00.000Z', message: { id: 'm1', model: 'claude-sonnet-5', usage: usage(10, 100, 1000, 50), content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x.cs' } }] } }) +
    line({ type: 'assistant', timestamp: '2026-07-15T07:00:01.000Z', message: { id: 'm1', model: 'claude-sonnet-5', usage: usage(10, 100, 1000, 50), content: [] } }) +
    line({ type: 'user', timestamp: '2026-07-15T07:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'abcd'.repeat(100) }] } }) +
    // msg m2, attributed to a skill
    line({ type: 'assistant', timestamp: '2026-07-15T07:10:00.000Z', attributionSkill: 'csharp', message: { id: 'm2', model: 'claude-sonnet-5', usage: usage(5, 0, 2000, 30), content: [] } }) +
    // msg m3, outside the test window
    line({ type: 'assistant', timestamp: '2026-07-15T09:00:00.000Z', message: { id: 'm3', model: 'claude-sonnet-5', usage: usage(1, 0, 5000, 10), content: [] } }),
  );
  return file;
}

function run(args) {
  return JSON.parse(execFileSync('node', [SCRIPT, ...args, '--json'], { encoding: 'utf8' }));
}

test('full report: dedups per message.id, measures results, attributes skill cache-read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-usage-'));
  const file = writeFixture(dir);
  const { main } = run([file]);
  assert.strictEqual(main.total.msgs, 3);
  assert.strictEqual(main.total.output, 90);
  assert.strictEqual(main.total.cacheRead, 8000);
  assert.strictEqual(main.toolCalls.Read.calls, 1);
  assert.strictEqual(main.toolCalls.Read.resultChars, 400);
  // m3 carries no stamp: sticky carry-forward attributes it to the last active skill and
  // counts it separately as carried (the stamp drops at task-notifications mid-run - measured)
  assert.deepStrictEqual(main.skillAttribution.csharp, { msgs: 2, output: 40, cacheRead: 7000, carriedMsgs: 1, maxCarryRun: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compaction pairs count once; guard denials bucket as hookBlocks, not errors; workflows/ nests are scanned', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-usage-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file,
    line({ type: 'assistant', timestamp: '2026-07-15T07:00:00.000Z', message: { id: 'm1', model: 'claude-sonnet-5', usage: usage(1, 0, 100, 5), content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'Big.cs' } }] } }) +
    line({ type: 'user', timestamp: '2026-07-15T07:00:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Blocked: whole-file Read of Big.cs (300 lines) - locate the symbol first.' }] } }) +
    // one real compaction emits BOTH markers - must count once
    line({ type: 'system', timestamp: '2026-07-15T07:01:00.000Z', compactMetadata: { trigger: 'auto' } }) +
    line({ type: 'user', timestamp: '2026-07-15T07:01:00.001Z', isCompactSummary: true, message: { content: 'summary' } }) +
    line({ type: 'assistant', timestamp: '2026-07-15T07:02:00.000Z', message: { id: 'm2', model: 'claude-sonnet-5', usage: usage(1, 0, 100, 5), content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'x.txt' } }] } }) +
    line({ type: 'user', timestamp: '2026-07-15T07:02:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'File does not exist.' }] } }),
  );
  const wfDir = path.join(dir, 'subagents', 'workflows', 'wf_1');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'agent-w1.jsonl'),
    line({ type: 'assistant', timestamp: '2026-07-15T07:03:00.000Z', message: { id: 'w1', model: 'claude-sonnet-5', usage: usage(1, 0, 50, 7), content: [] } }),
  );
  const { main, agents } = run([file]);
  assert.strictEqual(main.compactions, 1, 'dual-marker compaction counts once');
  assert.strictEqual(main.toolCalls.Read.hookBlocks, 1, 'guard denial bucketed');
  assert.strictEqual(main.toolCalls.Read.errors, 1, 'real error still counted');
  assert.strictEqual(agents.length, 1, 'nested workflow transcript found');
  assert.strictEqual(agents[0].meta.agentType, 'workflow-subagent');
  assert.strictEqual(agents[0].group, 'workflows/wf_1');
  assert.strictEqual(agents[0].stats.total.output, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--from/--to windows the accounting to the run inside a long session', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-usage-'));
  const file = writeFixture(dir);
  const report = run([file, '--from', '2026-07-15T06:59:00Z', '--to', '2026-07-15T08:00:00Z']);
  assert.strictEqual(report.window.to, '2026-07-15T08:00:00Z');
  assert.strictEqual(report.main.total.msgs, 2);
  assert.strictEqual(report.main.total.output, 80);
  assert.strictEqual(report.main.total.cacheRead, 3000);
  assert.strictEqual(report.main.lastTs, '2026-07-15T07:10:00.000Z');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--report-md emits the machine-written skeleton with tables and fill-in sections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-usage-'));
  const file = writeFixture(dir);
  const md = execFileSync('node', [SCRIPT, file, '--report-md'], { encoding: 'utf8' });
  assert.ok(md.startsWith('# Stack usage report - session `session`'));
  // machine-written numbers: deduped msgs and the skill attribution row
  assert.ok(md.includes('| main session | 16 | 100 | 8.0k | 90 | 3 |'), 'tokens table row present');
  assert.ok(md.includes('| csharp |  | 0 | ~0 | 2 (1 carried) | 40 | 7.0k |'), 'skills attribution row present (sticky carry labeled)');
  assert.ok(md.includes('| Read | 1 | ~100 | 0 |  |'), 'tools table row present');
  // judgment surface is fill-in only
  assert.ok(md.includes('## Waste analysis - FILL IN'));
  assert.ok(md.includes('## Protocol check - FILL IN'));
  assert.ok(md.includes('## Verdict - FILL IN'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a flag value before the target is not mistaken for the target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-usage-'));
  const file = writeFixture(dir);
  const { main } = run(['--to', '2026-07-15T08:00:00Z', file]);
  assert.strictEqual(main.total.msgs, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the audit's analyzer defects: each test pins a number a shipped report got wrong ---

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'analyze-usage-')); }
function fixture(dir, records) {
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, records.map(line).join(''));
  return file;
}
const bash = (id, command) => ({
  type: 'assistant', timestamp: '2026-07-15T07:00:00.000Z',
  message: { id: `m-${id}`, model: 'claude-sonnet-5', usage: usage(1, 0, 10, 1), content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});
const result = (id, extra) => ({
  type: 'user', timestamp: '2026-07-15T07:00:01.000Z',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(extra || {}) }] },
});

test('user prompts: one typed turn counts once; echoes, stdout siblings and compact summaries do not', () => {
  const dir = tmp();
  const file = fixture(dir, [
    { type: 'user', timestamp: '2026-07-15T07:00:00.000Z', parentUuid: 'p1', origin: { kind: 'human' }, message: { content: 'run the audit' } },
    // the same typed turn's sibling records share the parentUuid - they are not new prompts
    { type: 'user', timestamp: '2026-07-15T07:00:00.100Z', parentUuid: 'p1', origin: { kind: 'human' }, message: { content: '<local-command-stdout>done</local-command-stdout>' } },
    { type: 'user', timestamp: '2026-07-15T07:01:00.000Z', parentUuid: 'p2', origin: { kind: 'slash_command' }, message: { content: '<command-name>/claude-stack:setup</command-name>' } },
    { type: 'user', timestamp: '2026-07-15T07:02:00.000Z', parentUuid: 'p3', isCompactSummary: true, message: { content: 'summary' } },
    // no origin at all: the exclusion list is the fallback
    { type: 'user', timestamp: '2026-07-15T07:03:00.000Z', parentUuid: 'p4', message: { content: '<task-notification>agent done</task-notification>' } },
  ]);
  const { main } = run([file]);
  assert.strictEqual(main.userPrompts, 1, 'prompt count was inflated up to 500% by echoes and siblings');
  assert.strictEqual(main.commandInvocations['claude-stack:setup'], 1, 'the slash command is still stamped');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('git acts: a quoted or heredoc mention is prose, a denied commit never ran, a real one counts', () => {
  const dir = tmp();
  const file = fixture(dir, [
    bash('q1', 'echo "git commit -m x" >> notes.txt'),
    result('q1'),
    bash('q2', "cat <<'EOF' > plan.md\ngit commit -m y\ngh pr merge 42\nEOF"),
    result('q2'),
    bash('q3', 'git add -A && git commit -m "the real one"'),
    result('q3'),
    bash('q4', 'git commit -m "denied"'),
    result('q4', { is_error: true, content: 'Blocked: no COMMIT-GATE receipt. Do NOT retry this command yet.' }),
  ]);
  const { main } = run([file]);
  assert.strictEqual(main.gitCommits, 1, 'quoted, heredoc and denied commits must not count');
  assert.strictEqual(main.prMerges, 0, 'a heredoc gh pr merge is documentation');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('doc touches: assignments and globs open no row, rm clears, a heredoc mention is not a write', () => {
  const dir = tmp();
  const file = fixture(dir, [
    bash('d1', 'D=.claude/docs/architecture/ARCHITECTURE.md'),
    result('d1'),
    bash('d2', 'cat .claude/docs/architecture/ARCHITECTURE.md'),
    result('d2'),
    bash('d3', 'rm -f .claude/docs/flow/COMMIT-GATE.md'),
    result('d3'),
    bash('d4', "cat <<'EOF' > /dev/null\nsee .claude/docs/architecture/ASSESSMENT.md\nEOF"),
    result('d4'),
    bash('d5', 'ls .claude/docs/*.md; head -5 .claude/docs/PROJECT-CODE-STYLE.md.'),
    result('d5'),
  ]);
  const { main } = run([file]);
  const docs = main.docTouches;
  assert.strictEqual(docs['architecture/ARCHITECTURE.md'].bashReads, 1, 'the cat is the only read; the binding is neither');
  assert.strictEqual(docs['architecture/ARCHITECTURE.md'].bashWrites, undefined);
  assert.strictEqual(docs['flow/COMMIT-GATE.md'].cleared, 1, 'an rm clears a receipt, it does not write one');
  assert.strictEqual(docs['flow/COMMIT-GATE.md'].bashWrites, undefined);
  assert.ok(!('architecture/ASSESSMENT.md' in docs), 'a heredoc body is data, not doc I/O');
  assert.ok(!Object.keys(docs).some((k) => k.includes('*')), 'a glob names no one document');
  assert.strictEqual(docs['PROJECT-CODE-STYLE.md'].bashReads, 1, 'trailing punctuation is not part of the name');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('peak and floor context, and one row per compaction with its dropped tokens', () => {
  const dir = tmp();
  const msg = (id, ts, cr) => ({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-sonnet-5', usage: usage(0, 0, cr, 1), content: [] } });
  const file = fixture(dir, [
    msg('a1', '2026-07-15T07:00:00.000Z', 60000),
    msg('a2', '2026-07-15T07:10:00.000Z', 390000),
    { type: 'system', timestamp: '2026-07-15T07:15:00.000Z', compactMetadata: { trigger: 'auto', preTokens: 390000, postTokens: 12000, durationMs: 122000 } },
    { type: 'user', timestamp: '2026-07-15T07:15:00.100Z', isCompactSummary: true, message: { content: 'summary' } },
    msg('a3', '2026-07-15T07:20:00.000Z', 12000),
  ]);
  const { main } = run([file]);
  assert.strictEqual(main.peakCtx, 390000, 'reports that quoted the LAST context understated the peak by 17-43%');
  assert.strictEqual(main.peakCtxAt, '2026-07-15T07:10:00.000Z');
  assert.strictEqual(main.floorCtx, 12000, 'the cold floor is the standing inventory');
  assert.strictEqual(main.compactions, 1);
  assert.deepStrictEqual(main.compactionEvents, [{
    ts: '2026-07-15T07:15:00.000Z', pre: 390000, post: 12000, dropped: 378000, durationMs: 122000, trigger: 'auto',
  }], 'the dropped tokens and the wall clock were read and never printed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cost-state carries the thinking tokens and the model id the transcript strips', () => {
  const dir = tmp();
  const file = fixture(dir, [
    { type: 'assistant', timestamp: '2026-07-15T07:00:00.000Z', message: { id: 'a1', model: 'claude-opus-5', usage: usage(1, 0, 100, 5), content: [] } },
    { type: 'cost-state', timestamp: '2026-07-15T07:05:00.000Z', totalCostUSD: 4.5, modelUsage: { 'claude-opus-5[1m]': { thinkingTokens: 1000 } } },
    // cumulative and written more than once - the largest wins
    { type: 'cost-state', timestamp: '2026-07-15T07:09:00.000Z', totalCostUSD: 10.42, modelUsage: { 'claude-opus-5[1m]': { thinkingTokens: 2691 }, 'claude-haiku-4-5-20251001': { thinkingTokens: 0 } } },
  ]);
  const { main } = run([file]);
  assert.strictEqual(main.thinkingTokens, 2691, 'billed thinking is attributable to no message and was never printed');
  assert.deepStrictEqual(main.modelIdsFull, ['claude-opus-5[1m]', 'claude-haiku-4-5-20251001'], 'only cost-state keeps the [1m] suffix the fresh-session threshold keys off');
  assert.strictEqual(main.totalCostUSD, 10.42);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('denials: a Stop-hook string, a colon-less Blocked, and a user DECLINE are three different things', () => {
  const dir = tmp();
  const file = fixture(dir, [
    { type: 'user', timestamp: '2026-07-15T07:00:00.000Z', isMeta: true, message: { content: 'Stop hook feedback:\n- ["/p/.claude/hooks/guard-stop-contract.js"]: Blocked: the turn ends on a question.' } },
    bash('b1', 'git push origin develop'),
    // the JSON permission-decision route: no colon after Blocked, and no hooks bracket at all
    result('b1', { is_error: true, content: 'Bash operation blocked by hook. Blocked because no PUSH-GATE receipt. Do NOT retry this command yet.' }),
    { type: 'assistant', timestamp: '2026-07-15T07:02:00.000Z', message: { id: 'm-a1', model: 'claude-sonnet-5', usage: usage(1, 0, 10, 1), content: [{ type: 'tool_use', id: 'a1', name: 'AskUserQuestion', input: {} }] } },
    result('a1', { is_error: true, content: "The user doesn't want to proceed with this tool use." }),
  ]);
  const { main } = run([file]);
  assert.strictEqual(main.stopHookBlocks, 1, 'a Stop denial is meta user TEXT and was structurally invisible');
  assert.strictEqual(main.toolCalls.Bash.hookBlocks, 1, 'the colon is not part of the denial contract');
  assert.strictEqual(main.toolCalls.Bash.errors, 0, 'a gate working is not a tool failure');
  assert.strictEqual(main.toolCalls.AskUserQuestion.declines, 1, 'a decline is the user answering, not an error');
  assert.strictEqual(main.toolCalls.AskUserQuestion.errors, 0);
  assert.deepStrictEqual(main.denialsByHook, { 'guard-stop-contract.js': 1, '(unattributed)': 1 }, 'the bracket attributes; its absence still counts');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an attachment and a post-compaction cache-write both reach the spike accumulator', () => {
  const dir = tmp();
  const file = fixture(dir, [
    { type: 'assistant', timestamp: '2026-07-15T07:00:00.000Z', message: { id: 'a1', model: 'claude-sonnet-5', usage: usage(0, 0, 1000, 1), content: [] } },
    { type: 'user', timestamp: '2026-07-15T07:00:30.000Z', origin: { kind: 'human' }, attachments: [{ type: 'edited_text_file', content: 'x'.repeat(4000) }], message: { content: 'here it is' } },
    { type: 'assistant', timestamp: '2026-07-15T07:01:00.000Z', message: { id: 'a2', model: 'claude-sonnet-5', usage: usage(0, 0, 51000, 1), content: [] } },
    // after a reset the context DROPS, so the re-cache has a negative delta and was invisible
    { type: 'assistant', timestamp: '2026-07-15T07:10:00.000Z', message: { id: 'a3', model: 'claude-sonnet-5', usage: usage(0, 40000, 0, 1), content: [] } },
  ]);
  const { main } = run([file]);
  const att = main.spikes.find((sp) => sp.ts === '2026-07-15T07:01:00.000Z');
  assert.ok(att && /attachment:edited_text_file/.test(att.causes || ''), 'the largest spike printed as (prompt/attachment only)');
  const cw = main.spikes.find((sp) => sp.kind === 'cache-write');
  assert.ok(cw && cw.delta === 40000, 'a post-compaction re-cache is a cost class of its own');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--hook-blocks reaches --json and the markdown report, with the false-positive caveat', () => {
  const dir = tmp();
  const file = writeFixture(dir);
  const blocks = path.join(dir, 'hook-blocks');
  fs.mkdirSync(blocks);
  fs.writeFileSync(path.join(blocks, 'sess.jsonl'),
    line({ ts: '2026-07-15T07:00:00.000Z', hook: 'guard-read-whole-file.js', event: 'PreToolUse', tool: 'Read', reason: 'whole-file Read of Big.cs' }) +
    line({ ts: '2026-07-15T07:05:00.000Z', hook: 'guard-read-whole-file.js', event: 'PreToolUse', tool: 'Bash', reason: 'cat of Big.cs' }),
  );
  const report = JSON.parse(execFileSync('node', [SCRIPT, file, '--hook-blocks', blocks, '--json'], { encoding: 'utf8' }));
  assert.strictEqual(report.hookBlocks.rows, 2);
  assert.strictEqual(report.hookBlocks.byHook['guard-read-whole-file.js'].blocks, 2);
  const md = execFileSync('node', [SCRIPT, file, '--hook-blocks', blocks, '--report-md'], { encoding: 'utf8' });
  assert.ok(md.includes('guard-read-whole-file.js'), 'the ledger was dropped from --report-md entirely');
  assert.ok(/false positive/i.test(md), 'a denial may be a false positive - the old gloss scored every block as a success');
  fs.rmSync(dir, { recursive: true, force: true });
});
