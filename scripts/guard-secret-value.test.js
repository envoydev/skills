#!/usr/bin/env node
// Suite for stack/hooks/guard-secret-value.js. Runs with `npm test` (node --test).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'stack', 'hooks', 'guard-secret-value.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-secret-'));
// Every guard appends a block row under `<root>/<docs-path>/hook-blocks/`, and the root falls back
// to the process cwd - pin a scratch root so this suite never writes into the repo's own ledger.
process.env.CLAUDE_PROJECT_DIR = fs.mkdtempSync(path.join(TMP, 'root-'));
const LEDGER = path.join(TMP, 'ledger');
process.env.CLAUDE_STACK_DOCS_PATH = LEDGER;

const FAKE_TOKEN = 'x'.repeat(40); // obviously not a credential shape; the KEY name is what the guard judges

function fixtures() {
  const dir = fs.mkdtempSync(path.join(TMP, 'fx-'));
  const w = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
  return {
    dir,
    secret: w('settings.json', JSON.stringify({ env: { SENTRY_SLUG: 'acme', SENTRY_ACCESS_TOKEN: FAKE_TOKEN }, hooks: {} }, null, 2)),
    clean: w('clean-settings.json', JSON.stringify({ env: { CLAUDE_STACK_DOCS_PATH: '.claude/docs', CLAUDE_STACK_PUSH_GATE: '1' }, hooks: {} }, null, 2)),
    mcp: w('.mcp.json', JSON.stringify({ mcpServers: { context7: { env: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' } } } }, null, 2)),
    dotenv: w('.env', 'DB_HOST=localhost\nAPI_KEY=abc123\n'),
    emptyDotenv: w('empty.env', 'API_KEY=\nDB_HOST=localhost\n'),
    nested: w('appsettings.json', JSON.stringify({ ConnectionStrings: { Default: 'Server=x' }, Smtp: { Password: 'p@ss' } })),
    code: w('index.js', 'const TOKEN = process.env.TOKEN;\nmodule.exports = TOKEN;\n'),
  };
}

const run = (payload, env = {}) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });
const bash = (command, env) => run({ tool_name: 'Bash', tool_input: { command }, session_id: 'suite' }, env).status;
const read = (file_path, env) => run({ tool_name: 'Read', tool_input: { file_path }, session_id: 'suite' }, env).status;

test('guard-secret-value: a dump verb on a file that holds a credential is blocked, judged by content', () => {
  const f = fixtures();
  assert.equal(bash(`cat ${f.secret}`), 2, 'cat of a settings.json with a live token');
  assert.equal(bash(`jq .env ${f.secret}`), 2, 'jq of the env block');
  assert.equal(bash(`head -20 ${f.secret}`), 2, 'head shows the first lines, token included');
  assert.equal(bash(`grep -n SENTRY ${f.secret}`), 2, 'grep prints the matching line, value included');
  assert.equal(bash(`cat ${f.dotenv}`), 2, 'a dotenv file with API_KEY=value');
  assert.equal(bash(`cat ${f.nested}`), 2, 'a nested Smtp.Password in appsettings.json');
  assert.equal(bash(`cat ${f.clean}`), 0, 'the same shape with no credential-shaped key passes');
  assert.equal(bash(`cat ${f.mcp}`), 0, 'a ${VAR} placeholder is not a live value');
  assert.equal(bash(`cat ${f.emptyDotenv}`), 0, 'an empty KEY= is not a live value');
  assert.equal(bash(`cat ${f.code}`), 0, 'source code is never a credential file');
  assert.equal(bash(`cat ${path.join(f.dir, 'missing.json')}`), 0, 'a missing file has nothing to judge');
});

test('guard-secret-value: the denial names the key path and the presence route, never the value', () => {
  const f = fixtures();
  const r = run({ tool_name: 'Bash', tool_input: { command: `cat ${f.secret}` }, session_id: 'suite' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /env\.SENTRY_ACCESS_TOKEN/, 'the key path');
  assert.match(r.stderr, /--presence/, 'the sanctioned read');
  assert.doesNotMatch(r.stderr, new RegExp(FAKE_TOKEN), 'the value never appears');
});

test('guard-secret-value: a block appends one ledger row naming the hook and never the value', () => {
  const f = fixtures();
  const ledger = path.join(TMP, 'ledger-' + Date.now());
  assert.equal(bash(`cat ${f.secret}`, { CLAUDE_STACK_DOCS_PATH: ledger }), 2);
  const rows = fs.readFileSync(path.join(ledger, 'hook-blocks', 'suite.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hook, 'guard-secret-value.js');
  assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(FAKE_TOKEN));
});

test('guard-secret-value: copies, in-place edits, presence-shaped pipelines and prose stay silent', () => {
  const f = fixtures();
  assert.equal(bash(`cat ${f.secret} > ${path.join(f.dir, 'copy.json')}`), 0, 'output into a file never reaches the context');
  assert.equal(bash(`sed -i '' 's/acme/acme2/' ${f.secret}`), 0, 'an in-place sed edits, it does not print');
  assert.equal(bash(`grep -c SENTRY_ACCESS_TOKEN ${f.secret}`), 0, 'a count is presence');
  assert.equal(bash(`jq '.env | keys' ${f.secret}`), 0, 'keys only is presence');
  assert.equal(bash(`jq '.env.SENTRY_ACCESS_TOKEN | length' ${f.secret}`), 0, 'a length is presence');
  assert.equal(bash(`cat <<'EOF' > ${path.join(f.dir, 'plan.md')}\nStep 1: cat ${f.secret} to check the env block\nEOF`), 0, 'a heredoc body is prose');
  assert.equal(bash(`cat ${f.secret} | wc -l`), 0, 'a line count is presence');
  assert.equal(bash('cat "$SOME_UNSET_DIR/settings.json"'), 0, 'an unexpanded variable is never judged');
});
