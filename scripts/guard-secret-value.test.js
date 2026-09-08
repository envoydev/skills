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

test('guard-secret-value: the --presence exemption covers its own segment only', () => {
  const f = fixtures();
  assert.equal(bash(`node "${HOOK}" --presence "${f.secret}" SENTRY_ACCESS_TOKEN`), 0, 'the accessor alone');
  assert.equal(bash(`true && node "${HOOK}" --presence "${f.secret}" && cat ${f.secret}`), 2, 'a dump chained after the accessor is still a dump');
});

test('guard-secret-value: an inline runtime read of a credential file is the same dump, spelled differently', () => {
  const f = fixtures();
  assert.equal(bash(`node -e "const s=JSON.parse(require('fs').readFileSync('${f.secret}','utf8'));console.log(JSON.stringify(s.env||{},null,2))"`), 2, 'the measured leak');
  assert.equal(bash(`node -e "console.log(Object.keys(require('${f.secret}').env))"`), 2, 'keys-only through a runtime still resolves the file - the sanctioned route is --presence');
  assert.equal(bash(`python3 -c "import json;print(json.load(open('${f.secret}')))"`), 2, 'python json.load');
  assert.equal(bash(`ruby -e "puts File.read('${f.secret}')"`), 2, 'ruby File.read');
  assert.equal(bash(`node -e "console.log(require('${f.clean}').env)"`), 0, 'a clean file through a runtime passes');
  assert.equal(bash(`node -e "console.log(require('fs').existsSync('${f.secret}'))"`), 2, 'existence through a runtime resolves the file too - use --presence, which is exempt by name');
  assert.equal(bash(`node "${HOOK}" --presence "${f.secret}" SENTRY_ACCESS_TOKEN`), 0, 'the accessor itself is the sanctioned read');
});

test('guard-secret-value: quoting never hides a dump - operators inside quotes do not split, an unbalanced quote falls back to the quote-blind split', () => {
  const f = fixtures();
  assert.equal(bash(`echo "1 > 2 is true && cat ${f.secret}`), 2, 'an unterminated double quote cannot excuse the cat behind it');
  assert.equal(bash(`echo 'it's fine && cat ${f.secret}`), 2, 'an unbalanced apostrophe');
  assert.equal(bash(`echo "C:\\dir\\" && cat ${f.secret}`), 2, 'a backslash before the closing quote leaves it open - still judged');
  assert.equal(bash(`echo "1 > 2 is true" && cat ${f.secret}`), 2, 'a balanced quote holding operators still splits at the real &&');
  assert.equal(bash(`printf '%s;%s' a b; cat ${f.secret}`), 2, 'a ; inside quotes is data, the ; outside splits');
  assert.equal(bash(`echo 'it'\\''s' && cat ${f.secret}`), 2, 'the shell apostrophe idiom');
  assert.equal(bash(`python3 -c "import json;print(json.load(open('${f.clean}')))"`), 0, 'a clean file through a runtime with ; inside quotes');
});

test('guard-secret-value: printing a credential-shaped variable is blocked; a length or a test is presence', () => {
  assert.equal(bash('echo $SENTRY_ACCESS_TOKEN'), 2, 'bare $VAR');
  assert.equal(bash('echo "${CONTEXT7_API_KEY}"'), 2, 'braced');
  assert.equal(bash('echo "${DB_PASSWORD:-none}"'), 2, 'with a default');
  assert.equal(bash("printf '%s\\n' \"$SMTP_SECRET\""), 2, 'printf');
  assert.equal(bash('printenv SENTRY_ACCESS_TOKEN'), 2, 'printenv NAME');
  assert.equal(bash('[ -n "$SENTRY_ACCESS_TOKEN" ] && echo "SENTRY_ACCESS_TOKEN=set (${#SENTRY_ACCESS_TOKEN} chars)" || echo "SENTRY_ACCESS_TOKEN=absent"'), 0, 'the presence idiom: a test and a length');
  assert.equal(bash('echo $PATH'), 0, 'a non-secret variable');
  assert.equal(bash('echo "$CLAUDE_STACK_DOCS_PATH"'), 0, 'PATH suffix is not a credential');
  assert.equal(bash('printenv CLAUDE_STACK_INSTRUMENT'), 0, 'printenv of a non-secret');
  assert.equal(bash('echo "token count: 3"'), 0, 'a word, not a variable');
});

test('guard-secret-value: a whole-environment dump is blocked unless reduced to names', () => {
  assert.equal(bash('env'), 2, 'bare env');
  assert.equal(bash('printenv'), 2, 'bare printenv');
  assert.equal(bash('env | grep -i sentry'), 2, 'filtered by a prefix still prints the value');
  assert.equal(bash('env | grep PATH'), 2, 'any value filter prints values - the denial names printenv NAME for a non-secret');
  assert.equal(bash('env | cut -d= -f1 | sort'), 0, 'names only');
  assert.equal(bash("env | sed 's/=.*//'"), 0, 'names only, sed form');
  assert.equal(bash('env | wc -l'), 0, 'a count');
  assert.equal(bash('env | grep -c SENTRY'), 0, 'a count');
  assert.equal(bash('env FOO=bar node script.js'), 0, 'env as a command prefix is not a dump');
  assert.equal(bash('dotenv -e .env -- npm start'), 0, 'a word containing env is not env');
});

test('guard-secret-value: print verbs are judged per pipeline stage, and a prefix word does not hide an environment dump', () => {
  assert.equal(bash('echo "processing" | grep -v "$SOME_TOKEN"'), 0, 'a variable in a later grep stage is not printed by the echo');
  assert.equal(bash('echo ok | curl -d "$API_TOKEN" https://example.test'), 0, 'a variable handed to curl is used, not printed - the value never enters the transcript');
  assert.equal(bash('true | echo "$API_TOKEN"'), 2, 'the print verb in a later stage is still judged');
  assert.equal(bash('echo "a|b $API_TOKEN"'), 2, 'a quoted pipe does not end the stage');
  assert.equal(bash('sudo echo $DB_PASSWORD'), 2, 'a prefix word before the print verb');
  assert.equal(bash('sudo env'), 2, 'a prefix word before env');
  assert.equal(bash('FOO=bar env'), 2, 'an assignment before env');
  assert.equal(bash('command printenv | head'), 2, 'command printenv piped onward');
  assert.equal(bash('sudo env | cut -d= -f1'), 0, 'names only, prefixed');
  assert.equal(bash('env -i sh -c true'), 0, 'env running a command');
});

// A fake JWT: three base64url segments. Built by concatenation so no scanner reads a real shape off this file.
const FAKE_JWT = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnopqrstuvwxyz0123'].join('.');

test('guard-secret-value: a credential-shaped literal in the command is blocked, heredoc bodies included', () => {
  assert.equal(bash(`curl -H "Authorization: Bearer ${FAKE_JWT}" https://example.test/api`), 2, 'a token in a header');
  assert.equal(bash(`cat <<'EOF' > ${path.join(TMP, 'out.json')}\n{ "env": { "SENTRY_ACCESS_TOKEN": "${FAKE_JWT}" } }\nEOF`), 2, 'writing the value into a file through a heredoc is the same leak');
  assert.equal(bash('curl -H "Authorization: Bearer $API_TOKEN" https://example.test/api'), 0, 'a variable reference in a non-print verb is not a literal (and not printed)');
  assert.equal(bash('echo "the token format is eyJ...header.payload.signature"'), 0, 'prose about the shape is not the shape');
});

test('guard-secret-value: the Read tool on a file that holds a credential is blocked by content, not path', () => {
  const f = fixtures();
  assert.equal(read(f.secret), 2, 'a project settings.json the deny list leaves open');
  assert.equal(read(f.dotenv), 2, 'a dotenv file');
  assert.equal(read(f.clean), 0, 'a clean settings.json - the hook wiring a session legitimately inspects');
  assert.equal(read(f.mcp), 0, 'placeholders');
  assert.equal(read(f.code), 0, 'source');
  assert.equal(read(path.join(f.dir, 'missing.json')), 0, 'missing - let Read surface its own error');
  const r = run({ tool_name: 'Read', tool_input: { file_path: f.secret }, session_id: 'suite' });
  assert.match(r.stderr, /env\.SENTRY_ACCESS_TOKEN/);
  assert.doesNotMatch(r.stderr, new RegExp(FAKE_TOKEN));
});
