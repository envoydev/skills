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

// The dotted path of the first credential-shaped key holding a live string, or null. Depth-capped:
// a settings file is shallow, and the cap keeps a pathological JSON from costing the call.
function secretKeyIn(node, prefix, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    const here = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') { if (SECRET_KEY_RE.test(k) && isLive(v)) return here; }
    else { const hit = secretKeyIn(v, here, depth + 1); if (hit) return hit; }
  }
  return null;
}
const DOTENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const unquote = (v) => v.trim().replace(/^(["'])(.*)\1$/, '$2');
function secretLineIn(text) {
  for (const line of text.split('\n')) {
    const m = line.match(DOTENV_LINE);
    if (m && SECRET_KEY_RE.test(m[1]) && isLive(unquote(m[2]))) return m[1];
  }
  return null;
}
// Judge one file by CONTENT: the key that makes it a credential file, or null. JSON first (a
// settings.json, .mcp.json, appsettings.json), dotenv second; anything else - source code, docs -
// is never a credential file here (source dumps are guard-read-whole-file's concern).
function secretIn(file) {
  let text;
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
  let p = String(token).replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, HOME);
  p = p.replace(/\$\{(\w+)(?::-[^}]*)?\}|\$(\w+)/g, (m, a, b) => (known[a || b] != null ? known[a || b] : m));
  return /\$/.test(p) ? null : nativePath(p);
}
let payload; // set below; resolveFile reads its cwd
function resolveFile(token) {
  const p = expandPath(token);
  if (!p || p === '' ) return null;
  const anchors = [process.env.CLAUDE_PROJECT_DIR, payload && payload.cwd, process.cwd()].filter(Boolean);
  const cands = pathMod.isAbsolute(p) ? [p] : anchors.map((d) => pathMod.join(d, p));
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next anchor */ } }
  return null;
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

// Segments split on `&&`, `||`, `;` and newline OUTSIDE quotes: a runtime's inline code carries
// `;` inside its quoted argument (`python3 -c "import json;print(...)"`), and a naive split
// separated the runtime word from the segment holding the file path, so neither half matched.
// FAIL SAFE: a quote left open at the end of the command (a typo, a truncated input, a `\` before
// a closing quote) would otherwise swallow the rest of the command into one blob, where any
// exemption substring could excuse a real dump (review finding) - so an unbalanced scan falls
// back to the quote-blind split, which judges every operator-separated piece on its own.
function splitSegments(cmd) {
  const segs = [];
  let cur = '';
  let quote = null; // the quote character we are inside, or null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; } // an escaped char inside double quotes
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) { cur += ch + cmd[++i]; continue; } // an escaped char outside quotes
    if (ch === '"' || ch === '\'') { quote = ch; cur += ch; continue; }
    if (ch === '\n' || ch === ';') { segs.push(cur); cur = ''; continue; }
    if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) { segs.push(cur); cur = ''; i++; continue; }
    cur += ch;
  }
  segs.push(cur);
  return quote ? cmd.split(/&&|\|\||;|\n/) : segs;
}

// ---- Bash matcher ----
if (payload.tool_name === 'Bash') {
  const raw = String(input.command || '');
  const command = stripHeredocsOf(raw);
  for (const seg of splitSegments(command)) {
    if (/\s>>?\s*[^&\s>]/.test(seg)) continue; // output into a file never reaches the context
    if (PRESENCE_SHAPE.test(seg)) continue;
    if (/\bsed\s+(?:-\w*i|--in-place)\b/.test(seg)) continue; // an edit, not a dump
    // The sanctioned read is exempt by name - it is this file.
    if (/guard-secret-value\.js["']?\s+--presence\b/.test(seg)) continue;

    // A dump verb or a runtime read on a file that HOLDS a credential - judged by content, not path.
    const candidates = [];
    if (DUMP_VERB.test(seg)) for (const tok of seg.split(/\s+/)) if (tok && !tok.startsWith('-') && /[\/.~$]/.test(tok)) candidates.push(tok);
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
process.exit(0);
