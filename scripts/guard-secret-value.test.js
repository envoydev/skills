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

// Fake by construction, and deliberately NOT a run of one character: a value that is just `xxx...`
// is a placeholder by content, which the guard's own template tells now read as 'not live'.
const FAKE_TOKEN = 'x0'.repeat(20); // 40 chars; the KEY name is what the guard judges
const SECRET_JSON = JSON.stringify({ env: { SENTRY_SLUG: 'acme', SENTRY_ACCESS_TOKEN: FAKE_TOKEN }, hooks: {} }, null, 2);

// A project tree under the pinned CLAUDE_PROJECT_DIR - the anchor a relative path, a `cd` and a
// glob resolve against.
const ROOT = process.env.CLAUDE_PROJECT_DIR;
fs.mkdirSync(path.join(ROOT, '.claude'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '.claude', 'settings-secret.json'), SECRET_JSON);
fs.writeFileSync(path.join(ROOT, '.claude', 'clean.json'), JSON.stringify({ env: { CLAUDE_STACK_DOCS_PATH: '.claude/docs' } }, null, 2));
fs.mkdirSync(path.join(ROOT, 'my dir'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'my dir', 'settings.json'), SECRET_JSON);
fs.writeFileSync(path.join(ROOT, '.env'), 'API_KEY=abc123\n');
fs.mkdirSync(path.join(ROOT, 'sub'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'sub', 'settings.json'), SECRET_JSON);
// A FAKE account dir. The real ~/.claude holds live credentials and is never read by this suite -
// CLAUDE_CONFIG_DIR is what the hook resolves an account-dir path against, so pin it here.
const ACCOUNT = fs.mkdtempSync(path.join(TMP, 'account-'));
fs.writeFileSync(path.join(ACCOUNT, 'settings.json'), SECRET_JSON);
process.env.CLAUDE_CONFIG_DIR = ACCOUNT;

function fixtures() {
  const dir = fs.mkdtempSync(path.join(TMP, 'fx-'));
  const w = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content); return p; };
  const wd = (sub, name, content) => { fs.mkdirSync(path.join(dir, sub), { recursive: true }); const p = path.join(dir, sub, name); fs.writeFileSync(p, content); return p; };
  return {
    dir,
    secret: w('settings.json', SECRET_JSON),
    spaced: wd('my dir', 'settings.json', SECRET_JSON),
    // The ordinary project files the content test must NOT read as credential files.
    i18n: w('en.json', JSON.stringify({ login: { password: 'Password', apiKey: 'API key' } }, null, 2)),
    manifest: w('manifest.json', JSON.stringify({ manifest_version: 3, key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA' }, null, 2)),
    envExample: w('.env.example', 'API_KEY=your-api-key-here\nDB_PASSWORD=<your-password>\nSMTP_SECRET=changeme\n'),
    envSample: w('config.json.sample', JSON.stringify({ apiKey: 'abc123' }, null, 2)),
    testFixture: w('client.json', JSON.stringify({ apiKey: 'test-key-1234' }, null, 2)),
    clean: w('clean-settings.json', JSON.stringify({ env: { CLAUDE_STACK_DOCS_PATH: '.claude/docs', CLAUDE_STACK_PUSH_GATE: '1' }, hooks: {} }, null, 2)),
    mcp: w('.mcp.json', JSON.stringify({ mcpServers: { context7: { env: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' } } } }, null, 2)),
    dotenv: w('.env', 'DB_HOST=localhost\nAPI_KEY=abc123\n'),
    crlf: w('crlf.env', 'DB_HOST=localhost\r\nAPI_KEY=abc123\r\nSMTP_SECRET="changeme"\r\n'),
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
  assert.equal(run({ tool_name: 'Read', tool_input: { file_path: f.secret, offset: 1, limit: 2 }, session_id: 'suite' }).status, 2, 'a ranged Read reads the same value');
  assert.equal(read(path.join('.claude', 'settings-secret.json')), 2, 'a relative file_path resolves against CLAUDE_PROJECT_DIR');
});

test('guard-secret-value: a runtime printing an environment variable is the same leak as echo $VAR', () => {
  assert.equal(bash('node -e "console.log(process.env.SENTRY_ACCESS_TOKEN)"'), 2, 'process.env.NAME');
  assert.equal(bash('node -p process.env.SENTRY_ACCESS_TOKEN'), 2, 'node -p of one variable');
  assert.equal(bash('node -p process.env'), 2, 'node -p of the whole environment');
  assert.equal(bash('python3 -c "import os;print(os.environ.get(\'SENTRY_ACCESS_TOKEN\'))"'), 2, 'os.environ.get');
  assert.equal(bash('python3 -c "import os;print(os.environ[\'SENTRY_ACCESS_TOKEN\'])"'), 2, 'os.environ[NAME]');
  assert.equal(bash('python3 -c "import os;print(os.environ)"'), 2, 'the whole environment through python');
  assert.equal(bash('ruby -e \'puts ENV["SENTRY_ACCESS_TOKEN"]\''), 2, 'ruby ENV[NAME]');
  assert.equal(bash('perl -e \'print $ENV{SENTRY_ACCESS_TOKEN}\''), 2, 'perl $ENV{NAME}');
  assert.equal(bash('node -e "console.log(process.env.HOME)"'), 0, 'a non-credential variable');
  assert.equal(bash('node -e "console.log(Object.keys(process.env))"'), 0, 'names only is presence');
});

test('guard-secret-value: a quoted or escaped path with a space stays one token', () => {
  const f = fixtures();
  assert.equal(bash(`cat "${f.spaced}"`), 2, 'double-quoted');
  assert.equal(bash(`cat '${f.spaced}'`), 2, 'single-quoted');
  assert.equal(bash(`cat ${f.spaced.replace(/ /g, '\\ ')}`), 2, 'backslash-escaped');
  assert.equal(bash('cat "$CLAUDE_PROJECT_DIR/my dir/settings.json"'), 2, 'a variable expanding to a path with a space');
});

test('guard-secret-value: a label, a template value and a public key are not live credentials', () => {
  const f = fixtures();
  assert.equal(bash(`cat ${f.i18n}`), 0, 'an i18n bundle whose value repeats its key');
  assert.equal(read(f.i18n), 0, 'the same through Read');
  assert.equal(bash(`cat ${f.manifest}`), 0, 'the MV3 manifest key is a PUBLIC key');
  assert.equal(read(f.manifest), 0, 'the same through Read');
  assert.equal(bash(`cat ${f.envExample}`), 0, 'a .env.example is a template by name and by value');
  assert.equal(read(f.envExample), 0, 'the same through Read');
  assert.equal(bash(`cat ${f.envSample}`), 0, 'a .sample basename is a template');
  assert.equal(bash(`cat ${f.testFixture}`), 2, 'accepted: no content tell separates a fake test credential from a real one - the --presence route reads it');
});

test('guard-secret-value: a malformed cwd never crashes the gate', () => {
  const rel = path.join('.claude', 'settings-secret.json');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: `cat ${rel}` }, cwd: 5, session_id: 'suite' }).status, 2, 'a numeric cwd - judged against the remaining anchors');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: `cat ${rel}` }, cwd: { a: 1 }, session_id: 'suite' }).status, 2, 'an object cwd');
});

const presence = (...args) => spawnSync(process.execPath, [HOOK, '--presence', ...args], { encoding: 'utf8' });

test('guard-secret-value --presence: reports set (N chars) or absent, never a value', () => {
  const f = fixtures();
  const r = presence(f.secret, 'SENTRY_ACCESS_TOKEN', 'SENTRY_SLUG', 'CONTEXT7_API_KEY');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'SENTRY_ACCESS_TOKEN=set (40 chars)\nSENTRY_SLUG=set (4 chars)\nCONTEXT7_API_KEY=absent\n');
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(FAKE_TOKEN));
  assert.equal(presence(f.secret).stdout, 'SENTRY_SLUG=set (4 chars)\nSENTRY_ACCESS_TOKEN=set (40 chars)\n', 'no keys: every env key, in file order');
  assert.equal(presence(f.dotenv, 'API_KEY', 'DB_HOST').stdout, 'API_KEY=set (6 chars)\nDB_HOST=set (9 chars)\n', 'dotenv');
  assert.equal(presence(f.emptyDotenv, 'API_KEY').stdout, 'API_KEY=absent\n', 'an empty value is absent');
  assert.equal(presence(f.mcp, 'CONTEXT7_API_KEY').stdout, 'CONTEXT7_API_KEY=absent\n', 'no env block and no top-level key');
  const missing = presence(path.join(f.dir, 'nope.json'), 'SENTRY_SLUG');
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout, `# ${path.join(f.dir, 'nope.json')}: not found\nSENTRY_SLUG=absent\n`);
  const tilde = presence('~/.this-file-does-not-exist-guard-secret-value.json', 'X');
  assert.match(tilde.stdout, /^# .*\.this-file-does-not-exist-guard-secret-value\.json: not found\nX=absent\n$/, '~ is expanded');
});

test('guard-secret-value: a CRLF dotenv file - the Windows-authored spelling - is read like an LF one', () => {
  // `DOTENV_LINE` ends in `(.*)$`, and `.` never crosses a line terminator, so a line split on `\n`
  // alone leaves a `\r` that no line matched: a CRLF .env was never judged (a live key passed) and
  // --presence reported every key absent.
  const f = fixtures();
  assert.equal(bash(`cat ${f.crlf}`), 2, 'a live key in a CRLF file blocks');
  assert.equal(presence(f.crlf, 'API_KEY', 'SMTP_SECRET', 'DB_HOST').stdout,
    'API_KEY=set (6 chars)\nSMTP_SECRET=set (8 chars)\nDB_HOST=set (9 chars)\n', 'lengths count no \\r');
});

test('guard-secret-value: the shell\'s own variable dumps are whole-environment dumps', () => {
  assert.equal(bash('set | grep -i sentry'), 2, 'set prints every variable, exported or not');
  assert.equal(bash('export | grep -i sentry'), 2, 'export with no argument lists values');
  assert.equal(bash('export -p'), 2, 'the portable spelling');
  assert.equal(bash('declare -p | grep TOKEN'), 2, 'declare -p is the same list');
  assert.equal(bash('declare -p SENTRY_ACCESS_TOKEN'), 2, 'a NAME argument is judged like printenv NAME');
  assert.equal(bash('typeset -p'), 2, 'the ksh/zsh spelling');
  assert.equal(bash('set -e'), 0, 'a shell option carries an argument - not a dump');
  assert.equal(bash('set -- x'), 0, 'positional parameters');
  assert.equal(bash('export FOO=1'), 0, 'an assignment');
  assert.equal(bash('declare -a arr'), 0, 'a declaration');
  assert.equal(bash('declare -p CLAUDE_STACK_INSTRUMENT'), 0, 'a non-credential name');
});

test('guard-secret-value: a runtime handed the credential file, or building its path, is judged', () => {
  const f = fixtures();
  assert.equal(bash(`python3 -m json.tool ${f.secret}`), 2, 'the file as a bare argument');
  assert.equal(bash(`perl -ne 'print' ${f.secret}`), 2, 'perl -ne');
  assert.equal(bash(`perl -pe '' ${f.secret}`), 2, 'perl -pe');
  assert.equal(bash(`python3 -c "import sys;print(open(sys.argv[1]).read())" ${f.secret}`), 2, 'argv[1]');
  assert.equal(bash(`node -e "console.log(require('fs').readFileSync(process.argv[1],'utf8'))" ${f.secret}`), 2, 'process.argv[1]');
  assert.equal(bash('node -e "const p=require(\'path\').join(require(\'os\').homedir(),\'.claude\',\'settings.json\');console.log(require(\'fs\').readFileSync(p,\'utf8\'))"'), 2, 'the account dir built at runtime - CLAUDE_CONFIG_DIR is the FAKE account this suite pins');
  assert.equal(bash('python3 -c "import os;print(open(os.path.join(os.path.expanduser(\'~\'),\'.claude\',\'settings.json\')).read())"'), 2, 'the same in python');
  assert.equal(bash('node -e "console.log(require(\'fs\').readFileSync(`' + f.secret + '`,\'utf8\'))"'), 2, 'a template literal');
  assert.equal(bash(`node -e "console.log(require('fs').readFileSync('${f.clean}','utf8'))"`), 0, 'a clean file still passes');
});

test('guard-secret-value: a cd moves the anchor, and a heredoc feeding a runtime or a shell is code', () => {
  const f = fixtures();
  assert.equal(bash('cd .claude && cat settings-secret.json'), 2, 'a relative cd');
  assert.equal(bash('cd sub && cat settings.json'), 2, 'the same file name lives in two directories');
  assert.equal(bash(`cd ${ROOT}/sub; cat settings.json`), 2, 'an absolute cd, ; separated');
  assert.equal(bash(`python3 - <<'EOF'\nimport json;print(json.load(open('${f.secret}')))\nEOF`), 2, 'a python heredoc');
  assert.equal(bash(`node <<'EOF'\nconsole.log(require('fs').readFileSync('${f.secret}','utf8'))\nEOF`), 2, 'a node heredoc');
  assert.equal(bash(`bash <<'EOF'\ncat ${f.secret}\nEOF`), 2, 'a shell heredoc');
  assert.equal(bash('node - <<\'EOF\'\nconsole.log(process.env.SENTRY_ACCESS_TOKEN)\nEOF'), 2, 'a heredoc reading the environment');
  assert.equal(bash(`cat <<'EOF' > ${path.join(f.dir, 'plan2.md')}\nStep 1: cat ${f.secret} to check the env block\nEOF`), 0, 'a document that MENTIONS a dump is still prose');
});

test('guard-secret-value: a glob and a path held in a shell variable resolve to the same file', () => {
  const f = fixtures();
  assert.equal(bash('cat .env*'), 2, 'a glob with no directory');
  assert.equal(bash('cat .claude/*.json'), 2, 'a glob in the last component');
  assert.equal(bash(`cat ${ROOT}/.claude/settings-*.json`), 2, 'an absolute glob');
  assert.equal(bash(`cat ${ROOT}/.claude/settings-secret.js?n`), 2, 'a single-character glob');
  assert.equal(bash(`cat ${ROOT}/.claude/{settings-secret,x}.json`), 2, 'brace alternatives');
  assert.equal(bash(`f=${f.secret}; cat $f`), 2, 'a variable set one segment earlier');
  assert.equal(bash(`f=${f.secret}; cat "$f"`), 2, 'quoted');
  assert.equal(bash(`f=${f.secret}\ncat "$f"`), 2, 'across a newline');
  assert.equal(bash('for f in .claude/*.json; do cat "$f"; done'), 2, 'a loop variable');
  assert.equal(bash(`cat ${path.join(ROOT, '.claude', 'clean*.json')}`), 0, 'a glob matching only clean files');
});

test('guard-secret-value: brace expansion is bounded - a pathological pattern costs one capped pass, never the hook timeout', () => {
  fixtures();
  const t0 = Date.now();
  assert.equal(bash(`cat ${ROOT}/${'{a,b}'.repeat(26)}.json`), 0, 'no such file');
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `took ${ms}ms - the brace recursion is unbounded (measured 4.8s at 24 groups before the cap)`);
});

test('guard-secret-value: a redirect to a terminal device is a dump, not a write into a file', () => {
  const f = fixtures();
  assert.equal(bash(`cat ${f.secret} > /dev/stdout`), 2, '/dev/stdout is the transcript');
  assert.equal(bash(`cat ${f.secret} > /dev/stderr`), 2, '/dev/stderr too');
  assert.equal(bash(`cat ${f.secret} >/dev/tty`), 2, '/dev/tty too');
  assert.equal(bash(`cat ${f.secret} | tee /dev/stderr | wc -l`), 2, 'a tee stage prints before the reducer');
  assert.equal(bash(`cat ${f.secret} | tee /dev/stderr > /dev/null`), 2, 'the same behind a /dev/null redirect');
  assert.equal(bash(`cat ${f.secret} > ${path.join(f.dir, 'out.txt')}`), 0, 'a real file never reaches the context');
  assert.equal(bash(`cat ${f.secret} 2>/dev/null`), 2, 'a stderr redirect leaves stdout in the transcript (re-review regression)');
  assert.equal(bash(`cat ${f.secret} 2>${path.join(f.dir, 'err.log')}`), 2, 'stderr into a file, the same');
  assert.equal(bash('printenv SENTRY_ACCESS_TOKEN 2>/dev/null'), 2, 'a print verb behind a stderr redirect');
  assert.equal(bash(`cat ${f.secret} 1>${path.join(f.dir, 'out.txt')}`), 0, 'fd 1 into a file is a write');
});

test('guard-secret-value: an exemption counts in its own stage only, never in a comment or an argument', () => {
  const f = fixtures();
  assert.equal(bash(`cat ${f.secret} # wc`), 2, 'a reducer named in a comment');
  assert.equal(bash(`cat ${f.secret} # via guard-secret-value.js --presence`), 2, 'the accessor named in a comment');
  assert.equal(bash(`cat ${f.secret} | grep -v wc`), 2, 'a reducer named in an argument');
  assert.equal(bash(`node "${HOOK}" --presence ${f.secret} | cat ${f.secret}`), 2, 'a dump piped after the accessor');
  assert.equal(bash(`cat ${f.secret} | wc -l`), 0, 'the reducer itself');
  assert.equal(bash(`cat ${f.secret} | jq '.env | keys'`), 0, 'keys only');
  assert.equal(bash(`grep -c TOKEN ${f.secret}`), 0, 'a count');
});

test('guard-secret-value: only a reduction to names or a count is presence', () => {
  const f = fixtures();
  assert.equal(bash('env | cut -d= -f2'), 2, 'field 2 is the value');
  assert.equal(bash('env | cut -d= -f1-'), 2, 'f1- is every field');
  assert.equal(bash("env | awk -F= '{print $2}'"), 2, 'awk field 2');
  assert.equal(bash(`jq 'keys, .' ${f.secret}`), 2, 'a comma prints the document beside the keys');
  assert.equal(bash(`jq '.env | length, .' ${f.secret}`), 2, 'the same behind a length');
  assert.equal(bash('echo $(printenv SENTRY_ACCESS_TOKEN)'), 2, 'the second print verb in the stage');
  assert.equal(bash('echo "$(printenv SENTRY_ACCESS_TOKEN)"'), 2, 'quoted substitution');
  assert.equal(bash('env | cut -d= -f1 | sort'), 0, 'names only');
  assert.equal(bash("env | awk -F= '{print $1}'"), 0, 'awk field 1');
  assert.equal(bash(`jq -r 'keys[]' ${f.secret}`), 0, 'keys[] is names, one per line');
  assert.equal(bash(`jq -r '.env | keys[]' ${f.secret}`), 0, 'the same behind a path');
});

test('guard-secret-value: the dump verbs outside the cat/head list print the same bytes', () => {
  const f = fixtures();
  assert.equal(bash(`tac ${f.secret}`), 2, 'tac');
  assert.equal(bash(`nl ${f.secret}`), 2, 'nl');
  assert.equal(bash(`base64 ${f.secret}`), 2, 'base64 is a reversible print');
  assert.equal(bash(`xxd ${f.secret}`), 2, 'xxd');
  assert.equal(bash(`tee /dev/stdout < ${f.secret}`), 2, 'tee reading a redirect');
  assert.equal(bash(`while read l; do echo "$l"; done < ${f.secret}`), 2, 'a read loop over the file');
  assert.equal(bash(`cp ${f.secret} ${path.join(f.dir, 'settings.bak')}`), 0, 'a backup is not a dump');
});

test("guard-secret-value: a block ends in an ask, and the user's allow is honoured through a session receipt", () => {
  // Remote use: the user cannot run the copy-ready command in their own terminal, so a bare denial
  // took the decision away from them. The denial now mandates ONE AskUserQuestion, and the 'show or
  // use' answer is a receipt this guard reads - a file, a variable NAME or `*`, this session only.
  const f = fixtures();
  const receipt = path.join(LEDGER, 'flow', 'SECRET-READ-ALLOW');
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  try {
    const denied = run({ tool_name: 'Bash', tool_input: { command: `cat ${f.secret}` }, session_id: 'suite' });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /ONE AskUserQuestion/, 'the denial mandates the ask');
    assert.match(denied.stderr, /Presence only \(Recommended\)/, 'presence is the recommended option');
    assert.match(denied.stderr, /flow[\\/]SECRET-READ-ALLOW/, 'the denial names the receipt');
    assert.doesNotMatch(denied.stderr, /stale/, 'no receipt, no staleness talk');
    const deniedVar = run({ tool_name: 'Bash', tool_input: { command: 'echo $SENTRY_ACCESS_TOKEN' }, session_id: 'suite' });
    assert.match(deniedVar.stderr, /ONE AskUserQuestion/, 'the variable denial carries the ask too');
    // a file entry opens that file - by any dump verb and by Read - and nothing else
    fs.writeFileSync(receipt, `# allowed by the user in this session\n${f.secret}\n`);
    assert.equal(bash(`cat ${f.secret}`), 0, 'the listed file');
    assert.equal(bash(`jq -r .env.SENTRY_ACCESS_TOKEN ${f.secret}`), 0, 'any dump verb');
    assert.equal(read(f.secret), 0, 'and the Read tool');
    assert.equal(bash(`cat ${f.dotenv}`), 2, 'an unlisted file stays blocked');
    assert.equal(bash('echo $SENTRY_ACCESS_TOKEN'), 2, 'a file entry is not a variable');
    // a NAME entry opens that variable's print
    fs.writeFileSync(receipt, 'SENTRY_ACCESS_TOKEN\n');
    assert.equal(bash('echo $SENTRY_ACCESS_TOKEN'), 0, 'the listed variable');
    assert.equal(bash('echo $API_KEY'), 2, 'another variable stays blocked');
    assert.equal(bash('env'), 2, 'a whole-environment dump is not one variable');
    // `*` opens everything for the session - the remote user's 'just do the work'
    fs.writeFileSync(receipt, '*\n');
    assert.equal(bash(`cat ${f.dotenv}`), 0, 'any file');
    assert.equal(bash('env'), 0, 'the environment');
    assert.equal(bash(`echo 'TOKEN=${'ghp_' + 'A'.repeat(24)}' >> ${path.join(f.dir, '.env')}`), 0, 'a literal placed into a file');
    // stale: older than 8h reads as absent, and the denial says so
    const old = (Date.now() - 9 * 3600 * 1000) / 1000; fs.utimesSync(receipt, old, old);
    const aged = run({ tool_name: 'Bash', tool_input: { command: `cat ${f.secret}` }, session_id: 'suite' });
    assert.equal(aged.status, 2, 'a 9h-old receipt is absent');
    assert.match(aged.stderr, /stale/, 'and the denial says so');
  } finally {
    fs.rmSync(receipt, { force: true });
  }
});
