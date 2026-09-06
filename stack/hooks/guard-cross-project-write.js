#!/usr/bin/env node
// installer-managed - update overwrites local edits; put project policy in a separate hook file.
// PreToolUse gate (matchers: Write + Edit + NotebookEdit + Bash): a session belongs to ONE
// project. Work in project A that turns out to need a change in project B - a sibling repo, a
// consumed package, a related service - is HANDED OFF, never applied: the session writes a task
// card for B and stops there. Reading and investigating B is untouched (no Read/Grep/Glob
// matcher), because deciding what B must do requires reading B.
//
// Why a hook and not prose: a cross-repo edit is a discrete event with a decidable test (does
// the write target resolve inside this project's root?), and the cost of getting it wrong is
// the expensive kind - a change landing in a repo whose tests, conventions, review and release
// this session never ran, invisible to the project that owns it.
//
// Reads pass. Writes inside the project root pass. Writes to the session's own scratch (the OS
// temp dir), to the Claude account dirs (~/.claude and the ~/.claude-<space> siblings - settings,
// memory, plugins), and to /dev pass. Everything else is blocked with the task-card instruction.
// On Bash the write-shaped verbs are judged where they actually land: a `cd`/`pushd` earlier in
// the same command moves the anchor for every relative path and every bare `git <mutating>` after
// it (`cd ../other && git commit` is the same write as `git -C ../other commit` - reproduced
// passing before this existed), while a `>` or a verb INSIDE a quoted string is prose, not a
// write (a commit message reading 'pipe > /other/f' blocked the commit - reproduced).
// exit 2 = block (stderr fed back); exit 0 = allow. Fail-open on anything unparseable, on a root
// that cannot be resolved, and on a target that cannot be judged (an unexpanded variable, a
// relative path after `cd -` or `cd $DIR`).
// Out of scope (same honesty as the sibling guards): a write hidden from a flat scan -
// `--git-dir=`/`--work-tree=`, `bash -c '...'`, `eval`, `xargs rm`, `find ... -delete`, a
// wrapper script - is NOT caught here; this guard reads the literal command.
const fs = require('fs');
// The docs root env value. CLAUDE_STACK_DOCS_PATH is the name; CLAUDE_DOCS_PATH is the pre-0.2.43
// spelling, still read so a project whose settings.json has not been migrated yet keeps resolving
// (the installers rename the key in place on the next install/update).
const docsRootEnv = () => process.env.CLAUDE_STACK_DOCS_PATH || process.env.CLAUDE_DOCS_PATH || '.claude/docs';
const os = require('os');
const path = require('path');
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

// The project root is CLAUDE_PROJECT_DIR (the harness sets it for every hook). Without it - a
// manual wiring, a test - the nearest ancestor of the session cwd holding a .git is the root,
// because the cwd itself may be a SUBDIRECTORY the session cd-ed into, and taking that as the
// root called the project's own sibling folder 'outside' (reproduced).
function nearestRepoRoot(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
  return null;
}
const cwd0 = payload.cwd || process.cwd();
const root = process.env.CLAUDE_PROJECT_DIR || nearestRepoRoot(cwd0) || cwd0;
if (!root || !fs.existsSync(root)) process.exit(0); // no resolvable root - nothing to compare against
// Compare REAL paths on both sides or the gate misfires: on macOS /tmp is a symlink to
// /private/tmp and os.tmpdir() reports the /var/folders form of an already-/private path, so a
// raw string comparison calls the project's own file 'outside' and an allowed temp dir 'unknown'
// (both reproduced by this hook's tests before this existed). A target that does not exist yet
// has no realpath, so resolve the deepest ancestor that does and re-attach the remainder.
// Git Bash / MSYS spell a Windows path in POSIX MOUNT form - `/c/Users/...`, or `/cygdrive/c/...`.
// node on win32 does not know that spelling: path.resolve turns `/c/Users/u/AppData/Local/Temp/x`
// into a path on the CURRENT drive (`\c\Users\...`), which is neither the project nor the temp
// allowance, so a session cleaning up its own scratch was blocked (reported from a Windows session;
// the mis-resolve is pinned in this hook's tests through path.win32). Translate the mount form to
// the drive form before ANY resolution. Off Windows that same spelling is a real POSIX path and is
// never touched.
const MOUNT_RE = /^(?:\/cygdrive)?\/([A-Za-z])(?=\/|$)/;
const nativePath = (p) => (process.platform === 'win32'
  ? String(p).replace(MOUNT_RE, (m, d) => `${d.toUpperCase()}:\\`)
  : String(p));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
function realish(p) {
  let dir = path.resolve(nativePath(p));
  const rest = [];
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(dir)) return path.join(real(dir), ...rest);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    rest.unshift(path.basename(dir));
    dir = parent;
  }

  return path.resolve(nativePath(p));
}
const ROOT = real(root);
const HOME = os.homedir() || '';
// `~\\x` is the Windows spelling of the same thing, and CLAUDE_STACK_ALLOW_WRITE_OUTSIDE is
// where a user writes one by hand - unexpanded, the allowance stays a literal `~...` string,
// matches no path, and the tree the project genuinely owns is blocked (measured on windows-latest).
const expandTilde = (p) => (p === '~' || p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\')))
  && HOME ? path.join(HOME, p.slice(1)) : p;

// Anything under one of these may be written even though it is outside the project: the
// session's own scratch, the account-level Claude config (memory writes land here - blocking
// them breaks the memory system), the hook log dir, and device files. CLAUDE_STACK_ALLOW_WRITE_OUTSIDE
// is the deliberate escape hatch: a list of extra roots (colon-separated, semicolon on Windows; a
// leading ~ expands) for the rare project that really does own a second tree (a generated-output
// dir, a deploy checkout).
const allowRoots = [
  os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/dev',
  process.env.CLAUDE_STACK_HOOK_LOG_DIR,
  ...(HOME ? [path.join(HOME, '.claude')] : []),
  ...(process.env.CLAUDE_STACK_ALLOW_WRITE_OUTSIDE || '').split(path.delimiter).map((s) => s.trim()),
].filter(Boolean).map(expandTilde).map(nativePath).map(real);

function inside(target, dir) {
  const t = realish(target);
  return t === dir || t.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
}
// An allowance that CONTAINS the project root would swallow the whole gate - every sibling
// repo would sit inside it too. On macOS os.tmpdir() is under /var/folders, so a project
// worked on from a temp dir is exactly that case (it is how this hook's own tests run).
const effectiveAllow = allowRoots.filter((d) => !inside(ROOT, d));
// ~/.claude-<space> account dirs are siblings of ~/.claude, matched by prefix. The prefix is
// dropped only when the project itself sits under such a dir (the containment rule above) -
// checking whether the project sat under HOME instead disabled it for every real project, and a
// --space install's memory writes were blocked (reproduced).
const spacePrefix = HOME ? real(HOME) + path.sep + '.claude-' : null;
const spaceOk = spacePrefix && !ROOT.startsWith(spacePrefix);
function allowed(target) {
  const t = realish(target);
  if (inside(t, ROOT)) return true;
  if (effectiveAllow.some((d) => inside(t, d))) return true;
  if (spaceOk && t.startsWith(spacePrefix)) return true;

  return false;
}
// Resolve the way the session sees it: the hook subprocess's cwd is not the Bash tool's
// persisted cwd, so a relative path is anchored to the project root first (same anchor the
// sibling guards use). A relative path that stays inside the root is the normal case and passes.
function resolveTarget(p, base) {
  const n = nativePath(p);
  if (path.isAbsolute(n)) return n;

  return path.resolve(base || ROOT, n);
}

const docsRoot = docsRootEnv();
// Name the other PROJECT, not the file: its repo root when one is findable (the nearest
// ancestor holding a .git), else the first path segment that diverges from this project.
function otherProjectName(target) {
  let dir = path.dirname(realish(target));
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.basename(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const parts = realish(target).split(path.sep);
  const rootParts = ROOT.split(path.sep);
  let i = 0;
  while (i < parts.length && i < rootParts.length && parts[i] === rootParts[i]) i++;
  // On win32 the DRIVE LETTER is the root segment - the analogue of the empty string POSIX
  // absolute paths start with - so a target on another drive diverges at index 0 and 'D:' was
  // reported as the other project's name. That also hid the glob bail-out below from a target
  // like `/run*.log`, which resolves onto the cwd's drive: the divergence was the drive, not the
  // glob, so a session cleaning its own scratch was blocked and told to hand off to 'D:'.
  if (parts[i] === '' || /^[A-Za-z]:$/.test(parts[i] || '')) i++;

  return parts[i] || path.basename(path.dirname(realish(target)));
}
function block(what, target) {
  const other = otherProjectName(target);
  process.stderr.write(
    `Blocked: ${what} targets '${target}', which is outside this session's project\n` +
    `(${ROOT}). A session belongs to ONE project - a change another repo needs is HANDED OFF,\n` +
    `not applied here, because a change landing there skips that repo's tests, conventions,\n` +
    `review and release, and its own project never sees it.\n\n` +
    `Write a task card instead, inside THIS project:\n` +
    `  ${path.join(docsRoot.replace(/^\//, ''), 'cross-project-tasks', '<other-project>.md')}\n` +
    `naming the target repo and, per task: what must change and where (file + symbol, from your\n` +
    `investigation), why this project needs it, the contract both sides must agree on, and how\n` +
    `the other side can verify it. Then finish YOUR side against the current behaviour of\n` +
    `${other}, or say plainly what is blocked until that task lands.\n\n` +
    `Reading and investigating ${other} stays open - that is how the card gets specific.\n` +
    `If this project genuinely owns that tree, add its root to CLAUDE_STACK_ALLOW_WRITE_OUTSIDE.`,
  );
  process.exit(2);
}

const input = payload.tool_input || {};
const tool = payload.tool_name;

if (tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') {
  const target = input.file_path || input.notebook_path;
  if (!target) process.exit(0);
  const abs = resolveTarget(String(target));
  if (!allowed(abs)) block(`${tool} of a file`, String(target));
  process.exit(0);
}

if (tool !== 'Bash') process.exit(0);

// A heredoc BODY is DATA, not shell - a plan that DESCRIBES a command is inert text, and
// matching it blocks a document write for its own prose. Blank the body, keep the length. The
// heredoc's own first line stays: `cat <<'EOF' > ../other/f.txt` carries its redirect THERE, and
// blanking the whole match let that classic shell write through (reproduced).
const rawCommand = String(input.command || '');
const command = rawCommand.replace(
  /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm,
  (m) => { const nl = m.indexOf('\n'); return nl === -1 ? m : m.slice(0, nl) + m.slice(nl).replace(/[^\n]/g, ' '); },
);
if (!command.trim()) process.exit(0);

// Quoted spans: a `>` or a verb inside '...' / "..." is text an outer command carries (a commit
// message, an echo, a grep pattern), never a write of its own. The write TARGET may still be
// quoted - the patterns below capture it - only the verb's own position is checked.
const quoted = [];
{
  let q = null; let start = 0;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\' && q !== "'") { i++; continue; }
    if (!q && (c === '"' || c === "'")) { q = c; start = i; }
    else if (q && c === q) { quoted.push([start, i + 1]); q = null; }
  }
  if (q) quoted.push([start, command.length]);
}
const inQuotes = (i) => quoted.some(([a, b]) => i > a && i < b);
const unquote = (s) => s.replace(/^["']|["']$/g, '');
const isVar = (s) => /\$\{?[A-Za-z_]/.test(s);
// Split an argument list into SHELL WORDS, joining adjacent quoted and unquoted runs into one
// word before the quotes come off. A regex alternation of quoted-span-or-\S+ split
// `rm -f "$SP"/run*.log` into `"$SP"` and `/run*.log`, and that second fragment reads as an
// absolute path to the filesystem root - a session cleaning its OWN scratch was denied in 3
// bundles, while the identical command fully quoted or fully unquoted passed.
function shellWords(text) {
  const out = [];
  let cur = '';
  let q = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) q = null; else cur += c;
      started = true;
      continue;
    }
    if (c === '"' || c === "'") { q = c; started = true; continue; }
    if (/\s/.test(c)) { if (started) { out.push(cur); cur = ''; started = false; } continue; }
    cur += c; started = true;
  }
  if (started) out.push(cur);
  return out;
}
// A variable assigned to a LITERAL earlier in the same command is not unknowable - `SP=/tmp/x`
// then `rm -rf "$SP"/*` is judgeable, and reading it as unjudgeable is how a real out-of-tree
// write would have walked through. Only literal values are taken; anything carrying another
// expansion stays unresolved, and an unresolved variable is still never judged.
const assigns = new Map();
for (const a of command.matchAll(/(?:^|[;&|(\n]|\s)([A-Za-z_]\w*)=("[^"\n]*"|'[^'\n]*'|[^\s;|&()]*)/g)) {
  const v = unquote(a[2]);
  if (v && !/[$`]/.test(v)) assigns.set(a[1], v);
}
const expandVars = (t) => t.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g,
  (m, br, bare) => (assigns.has(br || bare) ? assigns.get(br || bare) : m));
// A sed/perl SCRIPT is not a path: `sed -i '' '/^DIVIDER$/d' <file>` had its address form read as
// an absolute path and denied (replayed: exit 2, while `'s/a/b/'` exit 0 - it is not explicit, so
// it never reached the check). A leading-slash token whose body carries a regex metacharacter and
// which ends in sed command letters is a script; `/abs/path` has no metacharacter and stays a path.
const SED_SCRIPT = /^\/(?=[^/]*[\^$*+?\[\]\\.])[^/]*\/[a-zA-Z]*$/;

// `cd` / `pushd` earlier in the command move the anchor for everything after them. A target
// that cannot be followed (`cd -`, `cd $DIR`, a relative cd from an unknown place) makes the
// anchor unknown, and an unknown anchor judges nothing relative - never guess.
const CD_RE = /(?:^|&&|\|\||;|\n|\(|\|)\s*(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;|&()]+)/g;
const cds = [...command.matchAll(CD_RE)].filter((c) => !inQuotes(c.index + c[0].search(/(?:cd|pushd)\s/)));
function anchorAt(index) {
  let cwd = ROOT;
  for (const c of cds) {
    if (c.index >= index) break;
    const t = nativePath(expandTilde(unquote(c[1])));
    if (t === '-' || isVar(t) || (cwd === null && !path.isAbsolute(t))) { cwd = null; continue; }
    cwd = path.resolve(cwd, t);
  }
  return cwd;
}
// Judge one path token found at `index` in the command: only a token that can land out of tree
// is resolved at all - an explicitly out-of-tree spelling (absolute, ~-rooted, reaching up with
// `..`), or any relative path once a `cd` has moved the anchor. A bare relative path with the
// anchor still at the project root is this project's own file - the case that must never block.
function judge(rawIn, index, what) {
  const raw = expandVars(rawIn);
  if (isVar(raw)) return; // an unexpanded variable - cannot judge, don't guess
  const base = anchorAt(index);
  // `C:\\other\\f.txt` and `\\\\server\\share\\f.txt` are as explicit as a leading `/`, but neither
  // matches the POSIX spellings - so on Windows EVERY shell write to an absolute path fell
  // through this early return unjudged, while the same reach through Write/Edit was blocked
  // (measured on windows-latest: 5 of the guard's own shell cases passed the write through).
  const WIN_ABS = /^(?:[A-Za-z]:[\\/]|\\\\)/;
  const explicit = /^([~/]|\.\.[/\\])/.test(raw) || (process.platform === 'win32' && WIN_ABS.test(raw))
    || raw.includes('/../') || raw === '..';
  if (!explicit && base === ROOT) return;
  const expanded = nativePath(expandTilde(raw));
  if (!path.isAbsolute(expanded) && base === null) return; // relative from an unknown anchor
  const abs = resolveTarget(expanded, base);
  // A target whose own leading segment is a GLOB names no project, and the denial then built its
  // remedy out of the fabricated name - 'finish YOUR side against the current behaviour of `*`'.
  // Nothing can be handed off to a repo that cannot be named, so this passes rather than blocks.
  if (/[*?\[]/.test(otherProjectName(abs))) return;
  // name the token the session wrote unless a cd moved it - then the resolved path says where it lands
  if (!allowed(abs)) block(what, explicit ? raw : abs);
}
const judgeAll = (list, index, what) => {
  for (const tok of shellWords(list)) {
    if (tok.startsWith('-')) continue; // a flag (or `--`), never a path
    if (!tok || SED_SCRIPT.test(tok)) continue; // an empty -i suffix, or a sed address form
    judge(tok, index, what);
  }
};

// Only WRITE-shaped commands are considered, and only the paths they actually write to. A path
// that resolves inside the project - the overwhelming majority, relative paths included - never
// reaches the check, so the false-positive surface is limited to commands genuinely writing out
// of tree. Read-shaped commands (cat, grep, ls, find, git log/diff/show) are not listed at all.
const TARGET = `("[^"]+"|'[^']+'|[^\\s;|&<>()]+)`;
const SEG = '[^;|&\\n]';
const GIT_MUTATING = 'commit|add|checkout|switch|merge|rebase|reset|revert|restore|push|pull|apply|am|cherry-pick'
  // `stash list`/`stash show` and the listing forms of `tag` (bare, -l, -n) are reads - flagging
  // them as writes blocked honest investigation of the other repo (reproduced).
  + '|stash(?!\\s+(?:list|show)\\b)|clean|rm|mv|tag\\s+(?!-l\\b|--list\\b|-n\\b)(?:-\\S+\\s+)*[^-\\s]\\S*|branch\\s+-[dDm]';
const WRITE_PATTERNS = [
  // shell redirection into a file, `>>` included; `2>&1` and `>&2` are not file targets
  { re: new RegExp(`>>?\\s*(?!&)${TARGET}`, 'g'), what: 'a shell redirection' },
  { re: new RegExp(`\\btee\\s+(?:-\\w+\\s+)*${TARGET}`, 'g'), what: 'a `tee` write' },
  // in-place edits: every path argument, not just the last - `sed -i 's/a/b/' ../other/f x`
  // dodged a last-argument rule, and perl's usual `-pi` cluster dodged a literal `-i` (both reproduced)
  { re: new RegExp(`\\b(?:sed|perl)\\s+((?:${SEG}*?\\s)?-[A-Za-z]*i\\b\\S*\\s${SEG}*)`, 'g'), what: 'an in-place edit', all: true },
  { re: new RegExp(`\\b(?:cp|mv|ln|install|rsync)\\s+${SEG}*?\\s${TARGET}\\s*(?:;|\\||&|$)`, 'g'), what: 'a copy/move destination' },
  // every argument counts: `rm -f a ../other/b`, `chmod +x ../other/x` and `truncate -s 0 ../other/log`
  // all put the out-of-tree path AFTER a non-flag token a first-argument rule stopped at (reproduced)
  { re: new RegExp(`\\b(?:rm|rmdir|mkdir|touch|truncate|chmod|chown)\\s+(${SEG}+)`, 'g'), what: 'a filesystem change', all: true },
  // `mv` REMOVES its source, so an out-of-tree source is a write to that tree even when the
  // destination is local - the destination-only rule above would have waved it through.
  { re: new RegExp(`\\bmv\\s+(?:-\\S+\\s+)*${TARGET}`, 'g'), what: 'a move OUT of another project' },
  // `git -C <dir> <mutating subcommand>` is a write to that dir even with no path argument
  { re: new RegExp(`\\bgit\\s+-C\\s+${TARGET}\\s+(?:${GIT_MUTATING})(?![\\w-])`, 'g'), what: 'a git write in another checkout' },
];
for (const { re, what, all } of WRITE_PATTERNS) {
  let m;
  while ((m = re.exec(command)) !== null) {
    if (inQuotes(m.index)) continue; // prose inside a quoted string
    if (all) judgeAll(m[1], m.index, what);
    else judge(unquote(m[1]), m.index, what);
  }
}
// An INTERPRETER with an inline script is a write route the loop above CANNOT see, and the
// reason is structural: a script body is always inside quotes (`node -e "…"`), which `inQuotes`
// skips as prose, or inside a heredoc, whose body is blanked as data before the loop runs. So it
// is judged HERE, on the raw text, the way GIT_BARE is judged separately below. Measured as a
// blocked/allowed PAIR on one operation five seconds apart in the same session - the shell
// `rm -f "$B"/*/x` denied, the identical unlink through `python3 - <<'PY' … f.unlink()` allowed -
// and under a Bash-first harness the heredoc IS the write route (23 of 23 writes in one bundle,
// 17 sibling mutations in another). Mirrors guard-read-whole-file.js's `runtimeDump`.
// Only a body actually FED to an interpreter is read: a heredoc going to `cat > plan.md` stays
// inert prose, which is what keeps a document write from blocking on its own text. And only a
// LITERAL path is judged - an interpolated or computed one is left alone for the same reason an
// unexpanded shell variable is never judged anywhere else in this guard. Heredoc blanking keeps
// the command's LENGTH, so an index into the raw text still anchors correctly through `anchorAt`.
const INTERP = String.raw`(?:python[\d.]*|node|nodejs|ruby|perl|php|deno|bun|osascript|pwsh|powershell)`;
const scripts = [];
{
  const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([\s\S]*?)^\s*\2\s*$/gm;
  const isInterp = new RegExp(`\\b${INTERP}\\b`);
  let h;
  while ((h = HEREDOC.exec(rawCommand)) !== null) {
    const header = rawCommand.slice(rawCommand.lastIndexOf('\n', h.index) + 1, h.index);
    if (isInterp.test(header)) scripts.push({ body: h[3], index: h.index });
  }
  // `node -e "…"` / `python3 -c '…'` - the same script, spelled as one argument
  const INLINE = new RegExp(`\\b${INTERP}\\b[^\\n;|&]*?\\s-(?:e|c|-eval|-command)\\s+("[\\s\\S]*?"|'[\\s\\S]*?')`, 'g');
  let e;
  while ((e = INLINE.exec(rawCommand)) !== null) scripts.push({ body: e[1].slice(1, -1), index: e.index });
}
if (scripts.length) {
  const LIT = String.raw`(["'])([^"'\n]+)\1`;
  const DESTRUCTIVE = 'write_text|write_bytes|unlink|mkdir|rmdir|rename|replace|touch|chmod';
  const WRITE_CALLS = [
    // a write verb whose FIRST argument is the path
    new RegExp(String.raw`\b(?:writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|unlinkSync|unlink|rmSync|rmdirSync|rmdir|mkdirSync|mkdir|makedirs|removedirs|renameSync|rename|copyFileSync|copyfile|copy2|truncateSync|truncate|chmodSync|chmod|remove|rmtree|move|touch)\s*\(\s*${LIT}`, 'g'),
    // `open(path, 'w')` - a bare `open(path)` is a READ, and reading another repo stays open
    new RegExp(String.raw`\b(?:open|fopen)\s*\(\s*${LIT}\s*,\s*["'][^"']*[wax+][^"']*["']`, 'g'),
    // pathlib, chained: `Path('…').write_text(…)`
    new RegExp(String.raw`\bPath\s*\(\s*${LIT}\s*\)\s*\.\s*(?:${DESTRUCTIVE})\b`, 'g'),
  ];
  // `f = Path('…')` … `f.unlink()` - the measured shape: the literal and the destructive call are
  // statements apart, so the binding is followed by NAME. Pairing them is what keeps a script that
  // READS another repo and writes in-project from blocking.
  // spelled out rather than reusing LIT: the leading capture shifts LIT's own backreference
  const PATH_BIND = /(\w+)\s*=\s*(?:pathlib\.)?Path\s*\(\s*(["'])([^"'\n]+)\2/g;
  const judgeLiteral = (raw, index) => {
    if (/[${]/.test(raw)) return; // interpolated - the path is computed, don't guess
    judge(raw, index, 'an interpreter write');
  };
  for (const { body, index } of scripts) {
    for (const re of WRITE_CALLS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body)) !== null) judgeLiteral(m[2], index);
    }
    PATH_BIND.lastIndex = 0;
    let b;
    while ((b = PATH_BIND.exec(body)) !== null) {
      if (new RegExp(String.raw`\b${b[1]}\s*\.\s*(?:${DESTRUCTIVE})\b`).test(body)) judgeLiteral(b[3], index);
    }
  }
}

// A bare `git <mutating>` after a `cd` out of tree writes THAT checkout - the same event as
// `git -C <dir>`, spelled the way a session actually spells it (reproduced: passed).
const GIT_BARE = new RegExp(`\\bgit\\s+(?:-c\\s+\\S+\\s+|--\\S+\\s+)*(?:${GIT_MUTATING})(?![\\w-])`, 'g');
let g;
while ((g = GIT_BARE.exec(command)) !== null) {
  if (inQuotes(g.index)) continue;
  const base = anchorAt(g.index);
  if (base && base !== ROOT && !allowed(base)) block('a git write in another checkout', base);
}
process.exit(0);
