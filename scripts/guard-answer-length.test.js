// Behavior tests for stack/hooks/guard-answer-length.js - the short-answer contract's
// mechanization. A hook that fires on the wrong turn is worse than no hook (it trains the model
// to treat blocks as noise), so both directions are pinned: the wall-of-text block AND every
// exemption that must stay silent.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'stack', 'hooks', 'guard-answer-length.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-length-'));
// The hook appends a block row to `<root>/<docs-path>/hook-blocks/`, and the root falls back to the
// process cwd when CLAUDE_PROJECT_DIR is unset - so a suite run from this checkout wrote its
// fixtures into the repo's own field ledger. Pin a scratch root for the whole run.
process.env.CLAUDE_PROJECT_DIR = fs.mkdtempSync(path.join(TMP, 'root-'));

// A transcript is JSONL: one user turn, then the assistant answer under test.
function transcript(name, userText, assistantBlocks) {
    const p = path.join(TMP, `${name}.jsonl`);
    const rows = [];
    if (userText !== null)
        rows.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: userText }] } });
    rows.push({ type: 'assistant', message: { role: 'assistant', content: assistantBlocks } });
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return p;
}

function run(payload) {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const WALL = 'This sentence exists only to burn prose characters against the cap. '.repeat(40); // ~2600 chars
const SHORT = 'Done - the build is green and the two failing tests now pass.';

test('UserPromptSubmit injects the answer budget as additionalContext', () => {
    const r = run({ hook_event_name: 'UserPromptSubmit', prompt: 'what changed?' });
    assert.strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /3 sentences/, 'the budget names the sentence cap');
    assert.match(ctx, /900 characters/, 'the budget names the character cap');
    assert.match(ctx, /Code, tables and command output are exempt/, 'the exemption travels with the budget');
});

test('Stop blocks a wall-of-text answer when nothing asked for depth', () => {
    const p = transcript('wall', 'did the build pass?', [{ type: 'text', text: WALL }]);
    const r = run({ hook_event_name: 'Stop', transcript_path: p });
    assert.strictEqual(r.status, 2, 'over the hard cap with no depth request must block');
    assert.match(r.stderr, /characters of prose/, 'the block reports the measured length');
    assert.match(r.stderr, /do NOT\s*\n?append the short version/i, 'the block forbids appending a summary to the wall');
});

test('Stop allows a wall of text when the user asked for depth', () => {
    for (const ask of ['walk me through it', 'give me the full breakdown', 'explain in detail', 'write a plan for this']) {
        const p = transcript('depth', ask, [{ type: 'text', text: WALL }]);
        assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 0, `'${ask}' must lift the cap`);
    }
});

test('Stop allows a wall of text when the depth request is Ukrainian or Russian', () => {
    for (const ask of ['розкажи детально', 'опиши покроково', 'розпиши будь ласка', 'напиши план',
        'расскажи подробно', 'объясни развернуто']) {
        const p = transcript('depth-cyr', ask, [{ type: 'text', text: WALL }]);
        assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 0, `'${ask}' must lift the cap`);
    }
});

test('Stop still blocks a Ukrainian question that asked for no depth', () => {
    const p = transcript('short-cyr', 'що робить цей хук?', [{ type: 'text', text: WALL }]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 2);
});

test("Stop still blocks on a bare 'explain' - an explanation is capped like any other answer", () => {
    const p = transcript('explain', 'explain what the hook does', [{ type: 'text', text: WALL }]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 2);
});

test('Stop ignores code blocks, tables, quotes and inline spans when measuring', () => {
    const payload = [
        SHORT,
        '```js\n' + '// a long pasted file\nconst x = 1;\n'.repeat(60) + '```',
        '| col | col |\n|---|---|\n' + '| some fairly wide table cell | another wide cell |\n'.repeat(30),
        '> ' + 'quoted command output line\n> '.repeat(40),
        '`' + 'src/some/very/long/path/to/a/file.ts'.repeat(20) + '`',
    ].join('\n\n');
    const p = transcript('exempt', 'did the build pass?', [{ type: 'text', text: payload }]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 0,
        'a short answer carrying a big payload is not a wall of text');
});

test('Stop leaves a normal short answer alone', () => {
    const p = transcript('short', 'did the build pass?', [{ type: 'text', text: SHORT }]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 0);
});

test('Stop never loops: a continuation we caused passes untouched', () => {
    const p = transcript('loop', 'did the build pass?', [{ type: 'text', text: WALL }]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p, stop_hook_active: true }).status, 0);
});

test('Stop skips a turn that ended on a tool call', () => {
    const p = transcript('tool', 'did the build pass?', [
        { type: 'text', text: WALL },
        { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 0);
});

test('a tool_result user message is not mistaken for the user asking for depth', () => {
    const p = path.join(TMP, 'toolresult.jsonl');
    fs.writeFileSync(p, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'did it pass?' }] } }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'walk me through in detail' }] } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: WALL }] } }),
    ].join('\n') + '\n');
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 2,
        'depth words inside tool output must not lift the cap');
});

// A split turn: one logical answer written as two rows sharing a message.id. Keeping only the
// last row read the wall as an empty fragment and passed it silently - the defect the stop
// contract hit six times before both readers learned to merge by id.
test('a wall of text split across rows sharing one message.id is still blocked', () => {
    const wall = 'x'.repeat(2600);
    const p = transcript('split-id', 'do it', [{ type: 'text', text: wall }]);
    const rows = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const last = rows[rows.length - 1];
    last.message.id = 'm-split';
    rows.push({ type: 'assistant', message: { id: 'm-split', role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } });
    fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: p }), encoding: 'utf8' });
    assert.equal(r.status, 2);
});

test('fails open on a missing transcript, unparseable input, and an unknown event', () => {
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: path.join(TMP, 'nope.jsonl') }).status, 0);
    assert.strictEqual(run({ hook_event_name: 'PreCompact' }).status, 0);
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    // a JSON scalar parses fine and used to throw a TypeError on the first field read (exit 1, stack trace shown as a hook error)
    assert.strictEqual(spawnSync(process.execPath, [HOOK], { input: 'null', encoding: 'utf8' }).status, 0);
});

test('a plain-string user turn asking for depth lifts the cap', () => {
    const p = path.join(TMP, 'string-user.jsonl');
    fs.writeFileSync(p, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'розкажи детально' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: WALL }] } }),
    ].join('\n') + '\n');
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 0);
});

test('the hard cap is a boundary: 1800 characters pass, 1801 block', () => {
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: transcript('cap-at', 'ok?', [{ type: 'text', text: 'x'.repeat(1800) }]) }).status, 0);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: transcript('cap-over', 'ok?', [{ type: 'text', text: 'x'.repeat(1801) }]) }).status, 2);
});

test('last_assistant_message is measured ahead of a lagging transcript', () => {
    // The harness documents the transcript as written asynchronously: here it still holds the
    // previous turn's short answer while the payload field carries this turn's wall of text.
    const p = transcript('lag', 'did the build pass?', [{ type: 'text', text: SHORT }]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p }).status, 0, 'the transcript alone is short');
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: p, last_assistant_message: WALL }).status, 2, 'the field carries the wall');
    const d = transcript('lag-depth', 'walk me through it', [{ type: 'text', text: SHORT }]);
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: d, last_assistant_message: WALL }).status, 0, 'the depth ask still comes from the transcript');
    assert.strictEqual(run({ hook_event_name: 'Stop', transcript_path: path.join(TMP, 'absent.jsonl'), last_assistant_message: WALL }).status, 0,
        'no transcript means no user message to judge - fail open');
});
