#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// PreToolUse gate (matchers: Read + Bash), plus a CLI mode: baseline-security.md's rule that a
// credential is read for its PRESENCE, never its value - mechanized. Measured: the rule held only
// as prose, and a session checking whether SENTRY_ACCESS_TOKEN was set printed the whole env block
// with `console.log(JSON.stringify(s.env))` on its first attempt (the value landed in the tool
// result and the transcript; the presence-only phrasing came on the second). The settings.json
// permissions.deny covers the Read TOOL on the ACCOUNT files only - a project settings.json that
// wrongly holds the token, and every shell route (cat, jq, grep, an inline node/python read, an
// `echo $VAR`, a bare `env`), passed every guard in the stack. This gate judges CONTENT, not paths:
// a dump verb on a JSON or dotenv file holding a credential-shaped key with a live value, a print
// of a credential-shaped variable, a whole-environment dump, and a credential-shaped literal typed
// into a command. The sanctioned read is this file's own CLI mode, so a denial always names a
// route that exists wherever the guard does:
//   node guard-secret-value.js --presence <file> [KEY ...]   ->   KEY=set (N chars) | KEY=absent
// exit 2 = block (stderr fed back); exit 0 = allow.
'use strict';
const fs = require('fs');
const os = require('os');
const pathMod = require('path');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving.
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';

// Keys whose value is a credential - the SAME string as meta/environment.json `secret_key_pattern`
// (npm run lint fails when the two differ), matched case-insensitively so `apiKey` and `API_KEY`
// judge alike. The hook ships without meta/, hence the copy.
const SECRET_KEY_SOURCE = '(TOKEN|SECRET|KEY|PASSWORD|PASSWD|DSN|CREDENTIAL|AUTH)$';
const SECRET_KEY_RE = new RegExp(SECRET_KEY_SOURCE, 'i');
// The value shapes the stack's credentials take - copied from guard-stop-contract.js; keep identical.
const SECRET_SHAPE = /\b(sntryu_[0-9a-f]{16,}|ctx7sk-[0-9a-f-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
const MAX_BYTES = 512 * 1024; // a credential file is small; anything larger is not one

// A `${VAR}` placeholder or a blank is not a live value - .mcp.json carries `${SENTRY_ACCESS_TOKEN}`
// by design, and an installer seeds `"SENTRY_ACCESS_TOKEN": ""` for the user to fill in.
const isPlaceholder = (v) => typeof v === 'string' && /^\$\{[^}]*\}$/.test(v.trim());
const isLive = (v) => typeof v === 'string' && v.trim() !== '' && !isPlaceholder(v);

// CONTENT tells that a credential-shaped KEY is not holding a credential - the false positives the
// key name alone cannot separate (measured on real projects): an i18n bundle's `"password":
// "Password"`, an MV3 manifest's `"key": "MIIB..."` (a PUBLIC key), a `.env.example`'s
// `API_KEY=your-api-key-here`. A value that repeats its own key, carries whitespace (a label, not a
// token), reads as placeholder vocabulary, or starts with `MII` (DER/base64 public key) is a sample.
// These apply to the FILE judgement only - `--presence` still reports a placeholder as such, since
// there the placeholder IS the answer. Accepted gap: a test fixture holding a fake credential under
// a credential-shaped key (`"apiKey": "test-key-1234"`) has no content tell and still blocks - read
// it through `--presence`, or rename the key.
const TEMPLATE_VALUE = /^(?:your[-_]|<[^>]+>$|changeme|x{3,}$|\.\.\.$|todo|replace|example|dummy|placeholder)/i;
const isSampleValue = (key, v) => {
  const s = String(v).trim();
  return s.toLowerCase() === String(key).toLowerCase() || /\s/.test(s) || TEMPLATE_VALUE.test(s) || s.startsWith('MII');
};
const holdsCredential = (key, v) => isLive(v) && !isSampleValue(key, v);
// A file-SHAPE tell: a basename ending .example / .sample / .template / .dist ships the KEYS, never
// the values - judging it blocks the one file a session legitimately reads to learn what to fill in.
const TEMPLATE_FILE = /\.(?:example|sample|template|dist)$/i;

// The dotted path of the first credential-shaped key holding a live string, or null. Depth-capped:
// a settings file is shallow, and the cap keeps a pathological JSON from costing the call.
function secretKeyIn(node, prefix, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    const here = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') { if (SECRET_KEY_RE.test(k) && holdsCredential(k, v)) return here; }
    else { const hit = secretKeyIn(v, here, depth + 1); if (hit) return hit; }
  }
  return null;
}
const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
function secretLineIn(text) {
  for (const line of text.split('\n')) {
    const m = line.match(DOTENV_LINE);
    if (m && SECRET_KEY_RE.test(m[1]) && holdsCredential(m[1], unquote(m[2]))) return m[1];
  }
  return null;
}
// Judge one file by CONTENT: the key that makes it a credential file, or null. JSON first (a
// settings.json, .mcp.json, appsettings.json), dotenv second; anything else - source code, docs -
// is never a credential file here (source dumps are guard-read-whole-file's concern).
function secretIn(file) {
  let text;
  if (TEMPLATE_FILE.test(pathMod.basename(String(file)))) return null;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch { return null; }
  try { return secretKeyIn(JSON.parse(text), '', 0); } catch { /* not JSON */ }
  const first = text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || '';
  return DOTENV_LINE.test(first) ? secretLineIn(text) : null;
}

// Git Bash / MSYS spell a Windows path in POSIX mount form (`/c/Users/...`), which node on win32
// resolves against the CURRENT drive instead. Translate before resolving; off Windows the spelling
// is a real POSIX path and is never touched.
const MOUNT_RE = /^(?:\/cygdrive)?\/([A-Za-z])(?=\/|$)/;
const nativePath = (p) => (process.platform === 'win32' ? String(p).replace(MOUNT_RE, (m, d) => `${d.toUpperCase()}:\\`) : String(p));
const HOME = os.homedir() || '';
// Expand the few variables a credential path is spelled with (`~`, $HOME, $CLAUDE_PROJECT_DIR,
// $CLAUDE_CONFIG_DIR - also in the `${VAR:-default}` form). Any other `$` is an unexpanded variable
// this guard cannot judge (the cross-project guard's rule) and the token is skipped.
const KNOWN_VARS = () => ({
  HOME,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || '',
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || pathMod.join(HOME, '.claude'),
});
function expandPath(token) {
  const known = KNOWN_VARS();
  let p = String(token).replace(/^["'`]|["'`]$/g, '').replace(/^~(?=\/|$)/, HOME);
  p = p.replace(/\$\{(\w+)(?::-[^}]*)?\}|\$(\w+)/g, (m, a, b) => (known[a || b] != null ? known[a || b] : m));
  // `my\ dir/settings.json` is one token the shell hands over with the space intact.
  return /\$/.test(p) ? null : nativePath(p.replace(/\\ /g, ' '));
}
let payload; // set below; resolveFile reads its cwd
// The anchors a relative path is tried against. A payload field is attacker-shaped input, not a
// promise: a non-string `cwd` reached pathMod.join and threw ERR_INVALID_ARG_TYPE, and a hook that
// exits 1 fails OPEN - the dump it was judging ran (review finding, reproduced with `"cwd": 5`).
const anchorDirs = () => [process.env.CLAUDE_PROJECT_DIR, payload && payload.cwd, process.cwd()]
  .filter((d) => typeof d === 'string' && d);
function resolveFile(token) {
  const p = expandPath(token);
  if (!p || p === '' ) return null;
  const cands = pathMod.isAbsolute(p) ? [p] : anchorDirs().map((d) => pathMod.join(d, p));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next anchor */ } }
  return null;
}

// ---- CLI mode: the sanctioned presence-only read --------------------------------------------
// `node guard-secret-value.js --presence <file> [KEY ...]` - what the denials and the guided
// commands name. Prints a length or `absent`, never a value; a missing file is reported, not thrown.
if (process.argv[2] === '--presence') {
  const fileArg = String(process.argv[3] || '');
  const keys = process.argv.slice(4);
  const file = nativePath(fileArg.replace(/^~(?=\/|$)/, HOME));
  const out = [];
  let text = null;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { out.push(`# ${fileArg}: not found`); }
  let entries = {};
  if (text != null) {
    try {
      const j = JSON.parse(text);
      entries = (j && typeof j.env === 'object' && j.env) ? j.env : (j && typeof j === 'object' && !Array.isArray(j) ? j : {});
    } catch {
      for (const line of text.split('\n')) { const m = line.match(DOTENV_LINE); if (m) entries[m[1]] = unquote(m[2]); }
    }
  }
  const names = keys.length ? keys : Object.keys(entries).filter((k) => typeof entries[k] === 'string');
  for (const k of names) {
    const v = entries[k];
    out.push(isLive(v) ? `${k}=set (${v.length} chars)` : isPlaceholder(v) ? `${k}=absent (placeholder ${v.trim()})` : `${k}=absent`);
  }
  process.stdout.write(out.length ? out.join('\n') + '\n' : '');
  process.exit(0);
}

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

const input = payload.tool_input || {};
const block = (msg) => { process.stderr.write(msg); process.exit(2); };
const presenceHint = (file) =>
  `Per baseline-security.md a credential is read for PRESENCE only:\n` +
  `  node "${__filename}" --presence "${file}" [KEY ...]   ->  KEY=set (N chars) | KEY=absent\n` +
  `Never echo the value, never pass it to a tool, never ask for it in the chat - the user sets it in\n` +
  `the file by hand. A credential in a PROJECT settings.json belongs in the ACCOUNT file\n` +
  `(~/.claude/settings.json, or the space's): only that env reaches .mcp.json expansion.\n`;

// A heredoc body is DATA, not shell: a plan that merely DESCRIBES `cat ~/.claude/settings.json` is
// inert text (reproduced against the sibling guards). Blank the payload spans, keeping the character
// count so any index into the command still holds.
const stripHeredocsOf = (c) => c.replace(
  /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
  (m) => m.replace(/[^\n]/g, ' '),
);
// The verbs that print a file, and the runtimes whose inline reads do the same with a different
// spelling. `grep` is a dump verb: `grep -n SENTRY settings.json` prints the value's whole line.
const DUMP_VERB = /\b(?:cat|head|tail|sed|less|more|awk|jq|bat|strings|grep|rg|egrep|fgrep)\b/;
const RUNTIME = /\b(?:node|python3?|perl|ruby|deno|bun|pwsh|powershell)\b/;
// A pipeline that reduces to PRESENCE - a count, a length, a key list, names without values - is
// the read the rule asks for; the segment passes as a whole.
const PRESENCE_SHAPE = /\bwc\b|\b(?:grep|rg|egrep|fgrep)\s+(?:-\w*[clLq]\b|--count\b|--files-with-matches\b|--quiet\b)|\bjq\b[^\n]*\b(?:keys|length|has\()|\bcut\s+-d\s*=|\bawk\s+-F\s*=|\bsed\s+['"]s\/=\.\*\/\//;

// Split `text` at the separators `sepAt` reports (their length at position i, 0 for none),
// honouring quotes: an escaped char outside quotes and inside double quotes is skipped, single
// quotes take no escapes (bash semantics). FAIL SAFE: a quote left open at the end (a typo, a
// truncated input, a `\` before a closing quote) would otherwise swallow the rest into one piece,
// where any exemption substring could excuse a real dump (review finding) - so an unbalanced scan
// falls back to the quote-blind `blind` split, which judges every operator-separated piece.
function splitOutsideQuotes(text, sepAt, blind) {
  const parts = [];
  let cur = '';
  let quote = null; // the quote character we are inside, or null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { cur += text[++i]; continue; } // an escaped char inside double quotes
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) { cur += ch + text[++i]; continue; } // an escaped char outside quotes
    if (ch === '"' || ch === '\'') { quote = ch; cur += ch; continue; }
    const n = sepAt(text, i);
    if (n) { parts.push(cur); cur = ''; i += n - 1; continue; }
    cur += ch;
  }
  parts.push(cur);
  return quote ? blind(text) : parts;
}
// Segments split on `&&`, `||`, `;` and newline OUTSIDE quotes: a runtime's inline code carries
// `;` inside its quoted argument (`python3 -c "import json;print(...)"`), and a naive split
// separated the runtime word from the segment holding the file path, so neither half matched.
const splitSegments = (cmd) => splitOutsideQuotes(cmd,
  (t, i) => ((t[i] === '\n' || t[i] === ';') ? 1 : ((t[i] === '&' || t[i] === '|') && t[i + 1] === t[i]) ? 2 : 0),
  (t) => t.split(/&&|\|\||;|\n/));
// A segment is a PIPELINE: its stages split on a single `|` (`||` never reaches here - splitSegments
// consumed it), and a print verb's arguments end at its own stage.
const splitPipes = (seg) => splitOutsideQuotes(seg, (t, i) => (t[i] === '|' ? 1 : 0), (t) => t.split('|'));
// Words split on whitespace OUTSIDE quotes: a naive `\s+` split cut `cat "<project>/my dir/x.json"`
// into three tokens, none of them a path, and CLAUDE.md supports a project path with a space - so
// that was an environment condition, not a chosen bypass.
const shellTokens = (s) => splitOutsideQuotes(s, (t, i) => (/\s/.test(t[i]) ? 1 : 0), (t) => t.split(/\s+/)).filter(Boolean);

// A runtime reads the environment in its own spelling - the same leak as `echo $SECRET`, which the
// file-path scan never looked for (review finding: every shape below passed). A NAMED read is
// judged by the name; a whole-environment object beside a print is the env dump.
const ENV_NAMED = [
  /process\.env(?:\.|\[\s*['"])(\w+)/g,
  /os\.environ(?:\.get\()?\s*\[?\s*['"](\w+)/g,
  /\bENV\[\s*['"](\w+)/g,
  /\$ENV\{\s*['"]?(\w+)/g,
];
const ENV_BARE = /process\.env(?![.[\w])|os\.environ(?![.[\w(])|%ENV\b|\bENV\.(?:to_h|each)\b/;
// Names without values is the presence read, in a runtime as much as in a shell pipeline.
const ENV_REDUCED = /Object\.keys\(\s*process\.env\s*\)|os\.environ\.keys\(\s*\)|\bENV\.keys\b/g;
const RUNTIME_PRINT = /console\.log|JSON\.stringify|\bprint\s*\(|\bputs\b|(?:^|\s)-p(?=\s|$)|--print\b/;

// ---- Bash matcher ----
if (payload.tool_name === 'Bash') {
  const raw = String(input.command || '');
  // A credential-shaped literal typed into a command is already in the transcript as the call's own
  // input; blocking still keeps it out of a file, a header and a remote, and names the rule. Judged
  // on the RAW text: a heredoc that writes the value into a file is the same leak. The denial names
  // the shape only - the value is never repeated.
  if (SECRET_SHAPE.test(raw)) {
    block('Blocked: the command carries a credential-shaped literal (a token / key / JWT).\n' +
      'Per baseline-security.md a secret never passes through a tool call or the chat: the user puts it\n' +
      'in the file by hand, or runs a copy-ready command in their own terminal (getpass, not an argument).\n');
  }
  const command = stripHeredocsOf(raw);
  for (const seg of splitSegments(command)) {
    if (/\s>>?\s*[^&\s>]/.test(seg)) continue; // output into a file never reaches the context
    if (PRESENCE_SHAPE.test(seg)) continue;
    if (/\bsed\s+(?:-\w*i|--in-place)\b/.test(seg)) continue; // an edit, not a dump
    // The sanctioned read is exempt by name - it is this file.
    if (/guard-secret-value\.js["']?\s+--presence\b/.test(seg)) continue;

    // Printing a credential-shaped VARIABLE: echo / printf with $NAME or ${NAME...}, printenv NAME.
    // `${#NAME}` is a length - the presence idiom - and `[ -n "$NAME" ]` is a test, so only the
    // arguments of a PRINT verb are judged - and only within the verb's own pipeline STAGE: a
    // variable in a later `grep -v "$X"` stage is not printed, and a `curl -d "$TOKEN"` stage is a
    // use, not a print (the value never enters the transcript).
    for (const stage of splitPipes(seg)) {
      const pr = stage.match(/(?:^|[\s(])(echo|printf|printenv)\b([^\n]*)/);
      if (!pr) continue;
      const names = [...pr[2].matchAll(/\$\{?(?!#)([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
      if (pr[1] === 'printenv') names.push(...pr[2].trim().split(/\s+/).filter((w) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w)));
      const hit = names.find((n) => SECRET_KEY_RE.test(n));
      if (hit) {
        block(`Blocked: \`${hit}\` is a credential-shaped variable and this prints its value.\n` +
          `Presence only: [ -n "$${hit}" ] && echo "${hit}=set (\${#${hit}} chars)" || echo "${hit}=absent"\n`);
      }
    }
    // A whole-environment dump prints every exported credential. `env` as a command PREFIX
    // (`env FOO=bar cmd`) runs a command; only a bare `env` / `printenv` (or one piped onward) dumps -
    // and a prefix word of its own (`sudo env`, `command printenv`, `FOO=bar env`) changes nothing.
    if (/^\s*(?:(?:sudo|command|nice|time|exec|builtin|nohup|\w+=\S*)\s+)*(?:env|printenv)\s*(?:\||$)/.test(seg)) {
      block('Blocked: a whole-environment dump (env / printenv) prints every exported credential.\n' +
        'Names only: env | cut -d= -f1. One non-secret variable: printenv NAME. A credential: presence only,\n' +
        '[ -n "$NAME" ] && echo "NAME=set (${#NAME} chars)" || echo "NAME=absent".\n');
    }

    // A runtime reading the environment - `node -e "console.log(process.env.SENTRY_ACCESS_TOKEN)"`
    // is `echo $SENTRY_ACCESS_TOKEN` with more syntax. The denial names the VARIABLE, never a value.
    if (RUNTIME.test(seg)) {
      for (const re of ENV_NAMED) {
        for (const m of seg.matchAll(re)) {
          if (SECRET_KEY_RE.test(m[1])) {
            block(`Blocked: \`${m[1]}\` is a credential-shaped variable and this prints its value.\n` +
              `Presence only: [ -n "$${m[1]}" ] && echo "${m[1]}=set (\${#${m[1]}} chars)" || echo "${m[1]}=absent"\n`);
          }
        }
      }
      if (ENV_BARE.test(seg.replace(ENV_REDUCED, ' keys ')) && RUNTIME_PRINT.test(seg)) {
        block('Blocked: a whole-environment dump (env / printenv) prints every exported credential.\n' +
          'Names only: env | cut -d= -f1. One non-secret variable: printenv NAME. A credential: presence only,\n' +
          '[ -n "$NAME" ] && echo "NAME=set (${#NAME} chars)" || echo "NAME=absent".\n');
      }
    }

    // A dump verb or a runtime read on a file that HOLDS a credential - judged by content, not path.
    const candidates = [];
    if (DUMP_VERB.test(seg)) for (const tok of shellTokens(seg)) if (!tok.startsWith('-') && /[\/.~$]/.test(tok)) candidates.push(tok);
    if (RUNTIME.test(seg)) for (const m of seg.matchAll(/(["'])([^"'\n]{2,300})\1/g)) candidates.push(m[2]);
    for (const tok of candidates) {
      const file = resolveFile(tok);
      if (!file) continue;
      const key = secretIn(file);
      if (!key) continue;
      block(`Blocked: ${file} holds a credential under \`${key}\` - this dumps its value into the transcript.\n` + presenceHint(file));
    }
  }
  process.exit(0);
}

// ---- Read matcher ----
// The settings.json permissions.deny already stops a Read of the ACCOUNT files by path; this is the
// content-judged complement for everything the path list cannot name - a project settings.json
// holding a misplaced token, a dotenv, an appsettings.json.
if (payload.tool_name === 'Read') {
  const file = resolveFile(String(input.file_path || ''));
  const key = file && secretIn(file);
  if (key) block(`Blocked: Read of ${file}, which holds a credential under \`${key}\`.\n` + presenceHint(file));
}
process.exit(0);
