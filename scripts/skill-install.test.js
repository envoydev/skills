'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SH = path.join(ROOT, 'scripts', 'os', 'claude-stack.sh');
const PS1 = path.join(ROOT, 'scripts', 'os', 'claude-stack.ps1');

// The ps1 twin can only be exercised where PowerShell is installed. Run it if
// pwsh is present; otherwise log a visible SKIP so the gap is never silent.
const hasPwsh = spawnSync('pwsh', ['-v'], { encoding: 'utf8' }).status === 0;
const skipNoPwsh = hasPwsh ? false : 'pwsh not installed - ps1 behavioral test skipped';

// The clone-fallback path is pinned to -b main by design, but the installer under
// test is the WORKING TREE's - pointing the clone at the real repo would couple the
// test to whatever main last released (it broke on a layout change main did not have
// yet). So clone-fallback tests get a local fixture repo whose main IS this HEAD.
const SRC_FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-fixture-'));
const SRC_REPO = path.join(SRC_FIXTURE, 'repo');
execFileSync('git', ['clone', '--no-hardlinks', `file://${ROOT}`, SRC_REPO], { stdio: 'ignore' });
// switch -C, not branch -f: the clone's checked-out branch varies by environment (develop
// locally, main on CI), and branch -f refuses to move the branch that is checked out.
execFileSync('git', ['-C', SRC_REPO, 'switch', '-C', 'main'], { stdio: 'ignore' });
test.after(() => fs.rmSync(SRC_FIXTURE, { recursive: true, force: true }));

// Invoke ONLY the skill-copy logic by sourcing the installer's function in a
// subshell with a stubbed environment, cloning from the LOCAL fixture (no network).
function runSkillCopy(names, extraArgs = []) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-'));
    const sel = path.join(work, 'sel.txt');
    fs.writeFileSync(sel, names.map(n => `skill ${n}`).join('\n') + '\n');
    // Drive the real installer's skill step in an isolated cwd, cloning the fixture repo.
    const out = execFileSync('bash', [SH, 'install', '--scope', 'project', '--selection', sel, '--skills-only', ...extraArgs], {
        cwd: work,
        encoding: 'utf8',
        env: { ...process.env, STACK_SKILLS_REPO: SRC_REPO, HOME: work },
    });
    return { work, out };
}

// Read the stamp's `key: value` lines (comment lines start with '#').
// Split on `\r?\n`, not `\n`: a CRLF file leaves a trailing `\r` on every line, and JS counts
// `\r` as a LINE TERMINATOR, so `.` cannot match it and the `$`-anchored pattern below matches
// NOTHING. That is what a Windows-written stamp used to look like to this reader - every key
// undefined - which read as 'the installer wrote no sha' when the stamp was on disk and correct.
function readStamp(work) {
    const file = path.join(work, '.claude', 'claude-stack.stamp');
    if (!fs.existsSync(file)) return null;
    const stamp = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/))
    {
        const m = /^([a-z]+):\s*(.*)$/.exec(line);
        if (m) stamp[m[1]] = m[2];
    }
    return stamp;
}

test('install copies exactly the selected skills into .claude/skills', () => {
    const { work } = runSkillCopy(['csharp', 'typescript']);
    try
    {
        assert.ok(fs.existsSync(path.join(work, '.claude', 'skills', 'csharp', 'SKILL.md')), 'csharp copied');
        assert.ok(fs.existsSync(path.join(work, '.claude', 'skills', 'typescript', 'SKILL.md')), 'typescript copied');
        assert.ok(!fs.existsSync(path.join(work, '.claude', 'skills', 'dotnet-grpc')), 'unselected skill not copied');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

// The stack has no per-artifact version (Claude Code only reads `version:` in plugin.json), so the
// INSTALL carries the version: one stamp naming the source commit, which /claude-stack:configure
// diffs to report what an update would bring. These lock the properties that make it trustworthy.
test('install stamps the exact source revision it installed from', () => {
    const { work } = runSkillCopy(['csharp']);
    try
    {
        const stamp = readStamp(work);
        assert.ok(stamp, 'a stamp is written');
        // The fallback clone is pinned to main (the release branch) - never the checked-out branch.
        const mainTip = execFileSync('git', ['-C', SRC_REPO, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
        assert.strictEqual(stamp.sha, mainTip, 'stamped sha is the release branch tip, not an approximation');
        // A git source has no RELEASE-SOURCE - the version comes from the plugin manifest at main,
        // the same file the marketplace serves, so stamp == release == marketplace version.
        const mainManifest = JSON.parse(execFileSync('git', ['-C', SRC_REPO, 'show', 'main:setup-plugin/.claude-plugin/plugin.json'], { encoding: 'utf8' }));
        assert.strictEqual(stamp.version, mainManifest.version, 'stamped version is the plugin/marketplace version at main');
        assert.strictEqual(stamp.action, 'install');
        assert.strictEqual(stamp.scope, 'project');
        assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(stamp.installed), `installed is a UTC timestamp: ${stamp.installed}`);
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

test('an unreachable source writes NO stamp (a wrong stamp is worse than none)', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-'));
    const sel = path.join(work, 'sel.txt');
    fs.writeFileSync(sel, 'skill csharp\n');
    try
    {
        execFileSync('bash', [SH, 'install', '--scope', 'project', '--selection', sel, '--skills-only'], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, STACK_SKILLS_REPO: path.join(work, 'nope.git'), HOME: work },
        });
        assert.strictEqual(readStamp(work), null, 'no stamp when no revision was resolved');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

// --source is what keeps a guided (plugin) run at ONE download: the setup/configure skills fetch
// the snapshot once for their own tooling and hand it here instead of making the installer fetch again.
test('--source installs from a caller-provided checkout and never deletes it', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-src-'));
    const checkout = path.join(src, 'repo');
    execFileSync('git', ['clone', '--depth', '1', `file://${ROOT}`, checkout], { stdio: 'ignore' });
    const { work, out } = runSkillCopy(['csharp'], ['--source', checkout]);
    try
    {
        assert.ok(fs.existsSync(path.join(work, '.claude', 'skills', 'csharp', 'SKILL.md')), 'installed from the provided checkout');
        assert.match(out, /\(provided\)/, 'reports the borrowed source rather than cloning its own');
        assert.ok(fs.existsSync(path.join(checkout, 'stack', 'skills')), 'the caller owns the checkout - the installer must not delete it');
        const head = execFileSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        assert.strictEqual(readStamp(work).sha, head, 'stamps the provided checkout revision');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
});

// The release-archive delivery: a run downloads <repo>/releases/latest/download/claude-stack.tar.gz
// and stamps the commit named by the RELEASE-SOURCE file inside - no git involved. The fake release
// lives on disk and is served over file://, so the test proves the archive path end to end offline.
test('installs from the release archive and stamps its RELEASE-SOURCE commit', () => {
    const FAKE_SHA = 'deadbeef'.repeat(5);
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-rel-'));
    const dl = path.join(fake, 'releases', 'latest', 'download');
    fs.mkdirSync(dl, { recursive: true });
    const relSrc = path.join(fake, 'RELEASE-SOURCE');
    fs.writeFileSync(relSrc, `sha: ${FAKE_SHA}\nref: main\nversion: 9.9.9\nbuilt: 2026-07-16T00:00:00Z\n`);
    execFileSync('git', ['-C', ROOT, 'archive', '--format=tar.gz', `--add-file=${relSrc}`, '-o', path.join(dl, 'claude-stack.tar.gz'), 'HEAD'], { stdio: 'ignore' });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-'));
    const sel = path.join(work, 'sel.txt');
    fs.writeFileSync(sel, 'skill csharp\n');
    try
    {
        const out = execFileSync('bash', [SH, 'install', '--scope', 'project', '--selection', sel, '--skills-only'], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, STACK_SKILLS_REPO: `file://${fake}`, HOME: work },
        });
        assert.match(out, /releases\/latest\/download/, 'took the archive route, not the clone fallback');
        assert.ok(fs.existsSync(path.join(work, '.claude', 'skills', 'csharp', 'SKILL.md')), 'installed from the extracted archive');
        assert.strictEqual(readStamp(work).sha, FAKE_SHA, 'stamps the RELEASE-SOURCE commit, no git involved');
        assert.strictEqual(readStamp(work).version, '9.9.9', 'stamps the RELEASE-SOURCE version (the plugin/marketplace version)');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
        fs.rmSync(fake, { recursive: true, force: true });
    }
});

// The plugin path after the switch: setup/configure extract the archive (no .git) and hand the
// dir over with --source - the stamp must come from RELEASE-SOURCE, not silently go missing.
test('--source pointed at an extracted archive stamps from its RELEASE-SOURCE', () => {
    const FAKE_SHA = 'cafebabe'.repeat(5);
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-arc-'));
    const repo = path.join(src, 'repo');
    fs.mkdirSync(path.join(repo, 'stack', 'agents'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'stack', 'skills', 'csharp'), path.join(repo, 'stack', 'skills', 'csharp'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'RELEASE-SOURCE'), `sha: ${FAKE_SHA}\nref: main\nversion: 8.8.8\n`);
    const { work, out } = runSkillCopy(['csharp'], ['--source', repo]);
    try
    {
        assert.match(out, /\(provided\)/, 'reports the borrowed source');
        assert.ok(fs.existsSync(path.join(work, '.claude', 'skills', 'csharp', 'SKILL.md')), 'installed from the extracted archive');
        assert.strictEqual(readStamp(work).sha, FAKE_SHA, 'stamp read from RELEASE-SOURCE when there is no git checkout');
        assert.strictEqual(readStamp(work).version, '8.8.8', 'stamp version read from RELEASE-SOURCE');
        assert.ok(fs.existsSync(path.join(repo, 'stack', 'skills')), 'the caller owns the extracted archive - the installer must not delete it');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
});

test('--source pointed at a non-checkout fails once, clearly', () => {
    const bogus = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-bogus-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-'));
    const sel = path.join(work, 'sel.txt');
    fs.writeFileSync(sel, 'skill csharp\n');
    try
    {
        const out = execFileSync('bash', [SH, 'install', '--scope', 'project', '--selection', sel, '--skills-only', '--source', bogus], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, HOME: work },
        });
        assert.match(out, /is not a claude-stack checkout/, 'one clear diagnosis, not a per-file failure storm');
        assert.strictEqual(readStamp(work), null, 'no stamp when the source was never resolved');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
        fs.rmSync(bogus, { recursive: true, force: true });
    }
});

// The ps1 twin of the two properties above. The pre-existing ps1 test only drives -PrintPlan, which
// exits before installing - so without these the whole Windows source/stamp path ships unexercised.
test('ps1: install stamps the source revision it installed from (pwsh required)', { skip: skipNoPwsh }, () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-ps-'));
    const sel = path.join(work, 'sel.txt');
    fs.writeFileSync(sel, 'skill csharp\n');
    try
    {
        execFileSync('pwsh', ['-NoProfile', '-File', PS1, 'install', '-Scope', 'project', '-Selection', sel, '-SkillsOnly'], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, STACK_SKILLS_REPO: `file://${SRC_REPO}`, HOME: work },
        });
        assert.ok(fs.existsSync(path.join(work, '.claude', 'skills', 'csharp', 'SKILL.md')), 'ps1 copied the selected skill');
        const mainTip = execFileSync('git', ['-C', SRC_REPO, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
        assert.strictEqual(readStamp(work).sha, mainTip, 'ps1 stamps the same release-branch sha the sh would');
        // The twins must write the SAME BYTES: Set-Content emits [Environment]::NewLine, so this
        // stamp came out CRLF on Windows and LF everywhere else. Only a Windows run can fail this
        // assertion - which is exactly why it exists, now that the suite runs on windows-latest.
        const raw = fs.readFileSync(path.join(work, '.claude', 'claude-stack.stamp'), 'utf8');
        assert.ok(!raw.includes('\r'), 'the stamp is LF-terminated on every platform, like the sh twin');
        assert.ok(!raw.startsWith('\uFEFF'), 'no BOM - a stamp is plain text, read by node and by the model');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

test('ps1: -Source pointed at an extracted archive stamps from its RELEASE-SOURCE (pwsh required)', { skip: skipNoPwsh }, () => {
    const FAKE_SHA = 'facefeed'.repeat(5);
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-psarc-'));
    const repo = path.join(src, 'repo');
    fs.mkdirSync(path.join(repo, 'stack', 'agents'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'stack', 'skills', 'csharp'), path.join(repo, 'stack', 'skills', 'csharp'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'RELEASE-SOURCE'), `sha: ${FAKE_SHA}\nref: main\nversion: 7.7.7\n`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-ps-'));
    const sel = path.join(work, 'sel.txt');
    fs.writeFileSync(sel, 'skill csharp\n');
    try
    {
        execFileSync('pwsh', ['-NoProfile', '-File', PS1, 'install', '-Scope', 'project', '-Selection', sel, '-SkillsOnly', '-Source', repo], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, HOME: work },
        });
        assert.strictEqual(readStamp(work).sha, FAKE_SHA, 'ps1 stamp read from RELEASE-SOURCE when there is no git checkout');
        assert.strictEqual(readStamp(work).version, '7.7.7', 'ps1 stamp version read from RELEASE-SOURCE');
        assert.ok(fs.existsSync(path.join(repo, 'stack', 'skills')), 'the caller owns the extracted archive - the ps1 must not delete it');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
});

test('ps1: -Source installs from a caller-provided checkout and never deletes it (pwsh required)', { skip: skipNoPwsh }, () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-pssrc-'));
    const checkout = path.join(src, 'repo');
    execFileSync('git', ['clone', '--depth', '1', `file://${ROOT}`, checkout], { stdio: 'ignore' });
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-ps-'));
    const sel = path.join(work, 'sel.txt');
    fs.writeFileSync(sel, 'skill csharp\n');
    try
    {
        const out = execFileSync('pwsh', ['-NoProfile', '-File', PS1, 'install', '-Scope', 'project', '-Selection', sel, '-SkillsOnly', '-Source', checkout], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, HOME: work },
        });
        assert.match(out, /\(provided\)/, 'ps1 reports the borrowed source rather than cloning its own');
        assert.ok(fs.existsSync(path.join(work, '.claude', 'skills', 'csharp', 'SKILL.md')), 'installed from the provided checkout');
        assert.ok(fs.existsSync(path.join(checkout, 'stack', 'skills')), 'the caller owns the checkout - the ps1 must not delete it');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
        fs.rmSync(src, { recursive: true, force: true });
    }
});

// --- Hook wiring pins (installer audit 2026-09: two reproduced defects) -----------------------
// The settings.json wiring program dedupes PreToolUse entries; keyed on the command alone it never
// wrote guard-read-whole-file's second (Bash) matcher, so the Bash branch of the read guard was dead
// in every install. Pin: every HOOKS entry lands under its own matcher, and a rerun changes nothing.
const hasPython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;
const skipNoPython = hasPython ? false : 'python3 not installed - wiring pin skipped';

function shArray(src, name) {
    const block = new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, 'm').exec(src);
    assert.ok(block, `${name}=( ... ) block found in the sh installer`);
    return [...block[1].matchAll(/^\s*"([^"]*)"/gm)].map(m => m[1]);
}

test('sh wiring: the read guard is wired under BOTH Read and Bash, and a rerun is a no-op', { skip: skipNoPython }, () => {
    const src = fs.readFileSync(SH, 'utf8');
    const prog = /prog=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n/.exec(src);
    assert.ok(prog, 'embedded wiring program found');
    const hooks = shArray(src, 'HOOKS');
    const deny = shArray(src, 'SECRET_DENY');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-wire-'));
    try
    {
        const settings = path.join(work, 'settings.json');
        fs.writeFileSync(settings, '{}\n');
        const run = () => spawnSync('python3', ['-c', prog[1], settings, '--DENY', ...deny, '--MCP', 'context7', 'serena'], { input: hooks.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
        const first = run();
        assert.strictEqual(first.status, 0, first.stderr);
        const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
        const under = (event, matcher) => (wired.hooks[event] || []).filter(e => (e.matcher || '') === matcher).flatMap(e => e.hooks.map(h => h.command));
        assert.ok(under('PreToolUse', 'Read').some(c => c.includes('guard-read-whole-file.js')), 'read guard under Read');
        assert.ok(under('PreToolUse', 'Bash').some(c => c.includes('guard-read-whole-file.js')), 'read guard under Bash (the matcher the command-only dedupe dropped)');
        assert.ok(under('Stop', '').some(c => c.includes('guard-stop-contract.js')), 'stop contract on Stop');
        assert.ok(under('UserPromptSubmit', '').some(c => c.includes('guard-answer-length.js')), 'answer budget on UserPromptSubmit');
        const before = fs.readFileSync(settings, 'utf8');
        const second = run();
        assert.strictEqual(second.status, 0, second.stderr);
        assert.strictEqual(fs.readFileSync(settings, 'utf8'), before, 'second run is byte-identical (idempotent, no duplicate entries)');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

// macOS ships bash 3.2, where `set -u` + an EMPTY array expansion aborts the script. The update
// fast path empties HOOKS when no hooks are on disk - pin that the dry run still completes under
// the oldest bash the README's `bash .claude/claude-stack.sh` can reach.
test('sh update --installed-only with no hooks on disk completes under the system bash (empty-array guard)', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-io-'));
    try
    {
        const skill = path.join(work, '.claude', 'skills', 'csharp');
        fs.mkdirSync(skill, { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'stack', 'skills', 'csharp', 'SKILL.md'), path.join(skill, 'SKILL.md'));
        const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
        const res = spawnSync(bash, [SH, 'update', '--scope', 'project', '--installed-only', '--print-plan'], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, STACK_SKILLS_REPO: SRC_REPO, HOME: work },
        });
        assert.strictEqual(res.status, 0, `exit 0 under ${bash}: ${res.stderr}`);
        assert.match(res.stdout + res.stderr, /csharp/, 'the disk-derived plan names the installed skill');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

// The update fast path used to filter PLUGINS to empty (no 'plugin' lines were ever derived), so
// `claude plugin update` ran on nothing and installed plugins silently stayed on old versions.
// Pin that the derived plan carries the stack plugins, and that a missing CLI still yields them.
test('sh update --installed-only carries plugins into the refresh plan', () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-plug-'));
    try
    {
        const skill = path.join(work, '.claude', 'skills', 'csharp');
        fs.mkdirSync(skill, { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'stack', 'skills', 'csharp', 'SKILL.md'), path.join(skill, 'SKILL.md'));
        fs.writeFileSync(path.join(work, '.mcp.json'), JSON.stringify({ mcpServers: { serena: {}, context7: {} } }));
        // an empty PATH dir stands in for 'no claude CLI reachable' - the manifest fallback path
        const nobin = path.join(work, 'nobin');
        fs.mkdirSync(nobin);
        const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
        // node stays reachable (the .mcp.json read needs it); `claude` must not be. The system
        // half of the PATH is platform-shaped: `:` and /usr/bin:/bin are POSIX spellings, and on
        // Windows they left the child with a PATH holding nothing - not even the bash node was
        // asked to spawn, so spawnSync failed outright and `status` came back null, not an exit
        // code. There the real PATH is kept, minus any directory that actually holds a claude.
        const claudeIn = (d) => ['claude', 'claude.exe', 'claude.cmd', 'claude.ps1'].some((n) => fs.existsSync(path.join(d, n)));
        const system = process.platform === 'win32'
            ? (process.env.PATH || '').split(path.delimiter).filter((d) => d && !claudeIn(d))
            : ['/usr/bin', '/bin'];
        const res = spawnSync(bash, [SH, 'update', '--scope', 'project', '--installed-only', '--print-plan'], {
            cwd: work,
            encoding: 'utf8',
            env: { ...process.env, PATH: [nobin, path.dirname(process.execPath), ...system].join(path.delimiter), STACK_SKILLS_REPO: SRC_REPO, HOME: work },
        });
        assert.strictEqual(res.status, 0, `exit 0: ${res.stderr}`);
        const plan = (res.stdout.split('\n').find((l) => l.startsWith('plan plugins:')) || '');
        assert.match(plan, /superpowers/, 'the plan names the stack plugins even with no CLI to list them');
        assert.match(plan, /claude-hud/, 'including the user-scoped one');
        const mcps = (res.stdout.split('\n').find((l) => l.startsWith('plan mcps:')) || '');
        assert.match(mcps, /serena/, 'mcps still come from .mcp.json');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// serena project.yml seeding - the installers' only write into a project's own
// tooling config, and the one place a wrong shape costs the user their symbol
// navigation. Both twins are exercised through the SAME cases, in isolation:
// the serena block is extracted from each script and called against a scratch
// repo, so no network, no CLI and no full install run.
// ---------------------------------------------------------------------------
function seedRepo(files)
{
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'serena-seed-'));
    execFileSync('git', ['init', '-q', work]);
    for (const [rel, body] of Object.entries(files))
    {
        const dest = path.join(work, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, body);
    }

    return work;
}

function runSeedSh(repo)
{
    const src = fs.readFileSync(SH, 'utf8').split('\n');
    const from = src.findIndex((l) => l.startsWith('_serena_ignores='));
    const to = src.findIndex((l, i) => i > from && l.startsWith('# INSTALL STAMP'));
    assert.ok(from > 0 && to > from, 'the serena block is still delimited as the extractor expects');
    const fns = path.join(repo, 'fns.sh');
    fs.writeFileSync(fns, src.slice(from, to - 1).join('\n'));
    const harness = path.join(repo, 'harness.sh');
    fs.writeFileSync(harness, `log() { echo "LOG: $*"; }\nMCPS=("serena|-- x")\n. "${fns}"\nseed_serena_project\n`);
    const bash = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
    const res = spawnSync(bash, [harness], { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `seed exit 0: ${res.stderr}`);

    return res.stdout;
}

function runSeedPs1(repo)
{
    const src = fs.readFileSync(PS1, 'utf8').split('\n');
    const from = src.findIndex((l) => l.startsWith('$script:SerenaIgnores'));
    const to = src.findIndex((l, i) => i > from && l.startsWith('# INSTALL STAMP'));
    assert.ok(from > 0 && to > from, 'the serena block is still delimited as the extractor expects');
    const fns = path.join(repo, 'fns.ps1');
    fs.writeFileSync(fns, src.slice(from, to - 1).join('\n'));
    const harness = path.join(repo, 'harness.ps1');
    fs.writeFileSync(harness, [
        'function Log { param([string]$m) Write-Host "LOG: $m" }',
        `function Get-RepoRoot { return ${JSON.stringify(repo)} }`,
        "$Mcps = @('serena|-- x')",
        `. ${JSON.stringify(fns)}`,
        'New-SerenaProject',
    ].join('\n'));
    const res = spawnSync('pwsh', ['-NoProfile', '-File', harness], { cwd: repo, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `seed exit 0: ${res.stderr}`);

    return res.stdout;
}

const CFG = path.join('.serena', 'project.yml');
const SEED_CASES = [
    {
        name: 'a config-less C#+TS repo gets both keys, multi-language',
        files: { 'package.json': '{}', 'src/a.ts': 'export const a = 1;', 'src/App.csproj': '<Project/>' },
        check: (yml) =>
        {
            assert.match(yml, /^language_servers: \["csharp", "typescript"\]$/m, 'both detected servers, not just the top one');
            assert.match(yml, /^ignored_paths: \[".serena", ".claude", ".playwright"\]$/m, 'the ignore list lands on a fresh seed');
        },
    },
    {
        name: 'a JavaScript-only repo still gets the typescript server',
        files: { 'package.json': '{}', 'src/app.js': 'module.exports = 1;' },
        check: (yml) => assert.match(yml, /^language_servers: \["typescript"\]$/m, "serena's TS server covers plain JS - a JS repo used to detect nothing"),
    },
    {
        // serena's OWN auto-generated config: both keys present but empty. Appending would make a
        // duplicate YAML key (an error, not an override), so each must be rewritten in place.
        name: "serena's own empty keys are rewritten in place, never duplicated",
        files: {
            'src/a.ts': 'export const a = 1;',
            [CFG]: 'project_name: "x"\nlanguage_servers: []\nignored_paths: []\n',
        },
        check: (yml) =>
        {
            assert.strictEqual(yml.match(/^language_servers:/gm).length, 1, 'exactly one language_servers key');
            assert.strictEqual(yml.match(/^ignored_paths:/gm).length, 1, 'exactly one ignored_paths key');
            assert.match(yml, /^language_servers: \["typescript"\]$/m);
            assert.match(yml, /^ignored_paths: \[".serena", ".claude", ".playwright"\]$/m);
        },
    },
    {
        // The gap this test exists for: before 0.2.35 the ignore list was written only on a FRESH
        // seed, so every install predating it kept indexing serena's own ~327MB server tree.
        name: 'an existing config that names its servers still gains the ignore list',
        files: {
            'src/a.ts': 'export const a = 1;',
            [CFG]: 'project_name: "x"\nlanguages: ["csharp"]\n',
        },
        check: (yml) =>
        {
            assert.match(yml, /^languages: \["csharp"\]$/m, "the user's own language choice is untouched");
            assert.match(yml, /^ignored_paths: \[".serena", ".claude", ".playwright"\]$/m, 'the ignore list is ensured independently');
        },
    },
    {
        name: 'a hand-tuned config is left exactly as it is',
        files: {
            'src/a.ts': 'export const a = 1;',
            [CFG]: 'project_name: "x"\nlanguage_servers: ["python"]\nignored_paths:\n  - "vendor/**"\n',
        },
        check: (yml) => assert.strictEqual(yml, 'project_name: "x"\nlanguage_servers: ["python"]\nignored_paths:\n  - "vendor/**"\n'),
    },
];

for (const shell of ['sh', 'ps1'])
{
    for (const c of SEED_CASES)
    {
        test(`${shell}: serena seed - ${c.name}`, { skip: shell === 'ps1' ? skipNoPwsh : false }, () =>
        {
            const repo = seedRepo(c.files);
            try
            {
                (shell === 'sh' ? runSeedSh : runSeedPs1)(repo);
                c.check(fs.readFileSync(path.join(repo, CFG), 'utf8'));
            }
            finally
            {
                fs.rmSync(repo, { recursive: true, force: true });
            }
        });
    }
}

test('sh: seeding is idempotent - a second run adds no second key', () =>
{
    const repo = seedRepo({ 'package.json': '{}', 'src/a.ts': 'export const a = 1;' });
    try
    {
        runSeedSh(repo);
        runSeedSh(repo);
        const yml = fs.readFileSync(path.join(repo, CFG), 'utf8');
        assert.strictEqual(yml.match(/^language_servers:/gm).length, 1);
        assert.strictEqual(yml.match(/^ignored_paths:/gm).length, 1);
    }
    finally
    {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('sh: a repo with no detectable sources is left to serena, never written half-configured', () =>
{
    // language_servers has no default in serena's schema, so a file carrying only project_name
    // would fail to load - writing nothing is the correct outcome, not a partial config.
    const repo = seedRepo({ 'README.md': '# docs only\n' });
    try
    {
        const out = runSeedSh(repo);
        assert.match(out, /left project\.yml to serena's own detection/);
        assert.strictEqual(fs.existsSync(path.join(repo, CFG)), false, 'no half-written config');
    }
    finally
    {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

test('sh wiring: every hook carries a timeout, and a bare legacy entry is backfilled', { skip: skipNoPython }, () =>
{
    // A `command` hook with no timeout takes Claude Code's 600s default. These hooks run in
    // 22-25ms (measured), but two shell out to git - a stuck index.lock or a slow network mount
    // would otherwise freeze the session for ten minutes on a 2ms gate.
    const src = fs.readFileSync(SH, 'utf8');
    const prog = /prog=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n/.exec(src);
    const hooks = shArray(src, 'HOOKS');
    const deny = shArray(src, 'SECRET_DENY');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-timeout-'));
    try
    {
        const settings = path.join(work, 'settings.json');
        // an install from before the timeout existed: the entry is present, bare
        fs.writeFileSync(settings, JSON.stringify({
            hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-catastrophic-rm.js"' }] }] },
        }));
        const res = spawnSync('python3', ['-c', prog[1], settings, '--DENY', ...deny, '--MCP', 'context7'], { input: hooks.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
        assert.strictEqual(res.status, 0, res.stderr);
        const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
        const all = Object.values(wired.hooks).flat().flatMap((e) => e.hooks);
        assert.ok(all.length >= 10, `every hook wired (${all.length})`);
        const bare = all.filter((h) => h.timeout === undefined);
        assert.deepStrictEqual(bare, [], 'no entry may fall back to the 600s default');
        assert.ok(all.every((h) => h.timeout === 10), 'all wired at 10s');
        const legacy = all.filter((h) => h.command.includes('guard-catastrophic-rm.js'));
        assert.strictEqual(legacy.length, 1, 'the pre-existing entry was backfilled, not duplicated');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

test('sh wiring: OUR hook on a matcher this version does not wire is pruned; a still-wired matcher, a foreign entry and the Stop wiring are kept', { skip: skipNoPython }, () =>
{
    // The script route used to leave a matcher the release had dropped in place on every update and
    // backfill its timeout as if it were current (measured in the 2026-09-04 hooks audit). The prune
    // is keyed on the SELECTED specs, so the same pass must leave a matcher that IS wired alone -
    // guard-stop-contract's AskUserQuestion entry came back in 0.2.55 as an injection-only branch,
    // and a prune keyed on the old list would unwire it in the run that just wired it.
    const src = fs.readFileSync(SH, 'utf8');
    const prog = /prog=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n/.exec(src);
    const hooks = shArray(src, 'HOOKS');
    const deny = shArray(src, 'SECRET_DENY');
    assert.ok(hooks.some((h) => h.startsWith('guard-stop-contract.js::AskUserQuestion::')), 'the injection matcher is wired');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-prune-'));
    try
    {
        const settings = path.join(work, 'settings.json');
        fs.writeFileSync(settings, JSON.stringify({
            hooks: { PreToolUse: [
                { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-stop-contract.js"' }] },
                { matcher: 'WebFetch', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-stop-contract.js"', timeout: 10 }] },
                { matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/my-own-hook.js"' }] },
            ] },
        }));
        const res = spawnSync('python3', ['-c', prog[1], settings, '--DENY', ...deny, '--MCP', 'context7'], { input: hooks.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
        assert.strictEqual(res.status, 0, res.stderr);
        const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
        const under = (m) => (wired.hooks.PreToolUse || []).filter((e) => e.matcher === m).flatMap((e) => e.hooks.map((h) => h.command));
        assert.deepStrictEqual(under('WebFetch'), [], 'a matcher this version does not wire is gone, and its emptied block with it');
        assert.ok(under('AskUserQuestion').some((c) => c.includes('guard-stop-contract.js')), 'a matcher this version DOES wire survives the prune');
        assert.ok(under('Bash').some((c) => c.includes('my-own-hook.js')), 'a hook that is not ours is never touched');
        assert.ok((wired.hooks.Stop || []).flatMap((e) => e.hooks).some((h) => h.command.includes('guard-stop-contract.js')), 'the Stop wiring of the same file is intact');
    }
    finally
    {
        fs.rmSync(work, { recursive: true, force: true });
    }
});

// --- retired rule / hook names: reported 2026-09-04 from a Windows install --------------------
// An update's summary read rules=4 while `ls .claude/rules` showed 14 files, and the run was
// suspected of dropping files. It had not: 3 were generated project-owned, and 7 were rule names
// this release no longer ships (the baseline merges). Skills and agents have pruned their renamed
// names since the lists existed; rules and hooks never did, so a retired always-on rule kept
// loading into every session next to the merged rule that replaced it.
const shFlatArray = (src, name) => {
    const m = new RegExp(`^${name}=\\(([^)]*)\\)`, 'm').exec(src);
    assert.ok(m, `${name}=( ... ) found in the sh installer`);
    return m[1].trim().split(/\s+/).filter(Boolean);
};
const shFunc = (src, name) => {
    const start = src.indexOf(`\n${name}() {`);
    assert.ok(start > 0, `${name}() found in the sh installer`);
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, `${name}() is closed at column 0`);
    return src.slice(start, end + 3);
};
const psFunc = (src, name) => {
    // `function Name {` and `function Name([type]$Arg) {` both - Write-JsonFile takes parameters.
    const m = new RegExp(`^function ${name}[^\\n]*\\{[\\s\\S]*?^\\}`, 'm').exec(src);
    assert.ok(m, `function ${name} found in the ps1 installer`);
    return m[0];
};
const psArray = (src, name) => {
    const m = new RegExp(`^\\$${name} = @\\(([^)]*)\\)`, 'm').exec(src);
    assert.ok(m, `$${name} = @( ... ) found in the ps1 installer`);
    return m[0];
};

function retiredFixture() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-retired-'));
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    fs.mkdirSync(path.join(repo, '.claude', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.claude', 'hooks'), { recursive: true });
    const w = (p) => fs.writeFileSync(path.join(repo, p), 'x\n');
    w('.claude/rules/baseline-communication.md');          // merged into baseline-interaction
    w('.claude/rules/baseline-code-quality.md');           // merged into baseline-quality-gates
    w('.claude/rules/aspnet-conventions.md');              // renamed to csharp-conventions
    w('.claude/rules/baseline-interaction.md');            // current - must survive
    w('.claude/rules/baseline-project-architecture.md');   // GENERATED and project-owned - must survive
    w('.claude/hooks/inject-code-style.js');               // retired for the generated style rule
    w('.claude/hooks/guard-read-whole-file.js');           // current - must survive
    return repo;
}
const stillThere = (repo, rel) => fs.existsSync(path.join(repo, rel));

test('sh update: retired rule and hook FILES are pruned, current and generated ones are kept', () => {
    const src = fs.readFileSync(SH, 'utf8');
    const repo = retiredFixture();
    try {
        const harness = path.join(repo, 'harness.sh');
        fs.writeFileSync(harness, [
            'log() { echo "LOG: $*"; }',
            `RETIRED_RULES=(${shFlatArray(src, 'RETIRED_RULES').join(' ')})`,
            `RETIRED_HOOKS=(${shFlatArray(src, 'RETIRED_HOOKS').join(' ')})`,
            shFunc(src, 'prune_retired_rules'),
            shFunc(src, 'prune_retired_hooks'),
            'prune_retired_rules',
            'prune_retired_hooks',
        ].join('\n'));
        const res = spawnSync(fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash', [harness], { cwd: repo, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, res.stderr);
        assert.strictEqual(stillThere(repo, '.claude/rules/baseline-communication.md'), false, 'a merged-away baseline rule goes');
        assert.strictEqual(stillThere(repo, '.claude/rules/aspnet-conventions.md'), false, 'a renamed rule goes');
        assert.strictEqual(stillThere(repo, '.claude/hooks/inject-code-style.js'), false, 'a retired hook file goes');
        assert.ok(stillThere(repo, '.claude/rules/baseline-interaction.md'), 'the current rule stays');
        assert.ok(stillThere(repo, '.claude/rules/baseline-project-architecture.md'), 'a GENERATED project rule is never touched');
        assert.ok(stillThere(repo, '.claude/hooks/guard-read-whole-file.js'), 'the current hook stays');
        assert.match(res.stdout, /rule pruned \(retired upstream\): baseline-communication\.md/, 'each prune is named');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('ps1 update: the same prune, same fixture (pwsh required)', { skip: skipNoPwsh }, () => {
    const src = fs.readFileSync(PS1, 'utf8');
    const repo = retiredFixture();
    try {
        const harness = path.join(repo, 'harness.ps1');
        fs.writeFileSync(harness, [
            'function Log { param([string]$m) Write-Host "LOG: $m" }',
            `function Get-RepoRoot { return ${JSON.stringify(repo)} }`,
            psArray(src, 'RetiredRules'),
            psArray(src, 'RetiredHooks'),
            psFunc(src, 'Remove-RetiredRules'),
            psFunc(src, 'Remove-RetiredHooks'),
            'Remove-RetiredRules',
            'Remove-RetiredHooks',
        ].join('\n'));
        const res = spawnSync('pwsh', ['-NoProfile', '-File', harness], { cwd: repo, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, res.stderr);
        assert.strictEqual(stillThere(repo, '.claude/rules/baseline-code-quality.md'), false, 'a merged-away baseline rule goes');
        assert.strictEqual(stillThere(repo, '.claude/hooks/inject-code-style.js'), false, 'a retired hook file goes');
        assert.ok(stillThere(repo, '.claude/rules/baseline-interaction.md'), 'the current rule stays');
        assert.ok(stillThere(repo, '.claude/rules/baseline-project-architecture.md'), 'a GENERATED project rule is never touched');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('sh wiring: a retired hook is unwired from EVERY event, not just PreToolUse', { skip: skipNoPython }, () => {
    // inject-code-style ran on a prompt event, so the PreToolUse-only prune left its entry wired -
    // a command spawned on every matching call after its file was deleted.
    const src = fs.readFileSync(SH, 'utf8');
    const prog = /prog=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n/.exec(src);
    const hooks = shArray(src, 'HOOKS');
    const deny = shArray(src, 'SECRET_DENY');
    const retired = shFlatArray(src, 'RETIRED_HOOKS');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-retwire-'));
    try {
        const settings = path.join(work, 'settings.json');
        const cmd = (f) => `"$CLAUDE_PROJECT_DIR/.claude/hooks/${f}"`;
        fs.writeFileSync(settings, JSON.stringify({
            hooks: {
                UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('inject-code-style.js'), timeout: 10 }] }],
                PreToolUse: [
                    { matcher: 'Write', hooks: [{ type: 'command', command: cmd('require-convention-skill.js') }] },
                    { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('my-own-hook.js') }] },
                ],
            },
        }));
        const res = spawnSync('python3', ['-c', prog[1], settings, '--DENY', ...deny, '--MCP', 'context7', '--RETIRED', ...retired],
            { input: hooks.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
        assert.strictEqual(res.status, 0, res.stderr);
        const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
        const all = Object.values(wired.hooks).flat().flatMap((e) => e.hooks).map((h) => h.command);
        assert.ok(!all.some((c) => c.includes('inject-code-style.js')), 'the prompt-event entry is gone');
        assert.ok(!all.some((c) => c.includes('require-convention-skill.js')), 'the PreToolUse entry is gone');
        assert.ok(all.some((c) => c.includes('my-own-hook.js')), 'a hook that is not ours is never touched');
        assert.ok(all.some((c) => c.includes('guard-read-whole-file.js')), 'this release\'s hooks are still wired');
    }
    finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('ps1 wiring: a retired hook is unwired from EVERY event, same as the sh twin (pwsh required)', { skip: skipNoPwsh }, () => {
    const src = fs.readFileSync(PS1, 'utf8');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-retwire-ps-'));
    try {
        fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
        const settings = path.join(repo, '.claude', 'settings.json');
        const cmd = (f) => `"$CLAUDE_PROJECT_DIR/.claude/hooks/${f}"`;
        fs.writeFileSync(settings, JSON.stringify({
            hooks: {
                UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('inject-code-style.js'), timeout: 10 }] }],
                PreToolUse: [
                    { matcher: 'Write', hooks: [{ type: 'command', command: cmd('require-convention-skill.js') }] },
                    { matcher: 'Bash', hooks: [{ type: 'command', command: cmd('my-own-hook.js') }] },
                ],
            },
        }, null, 2));
        const harness = path.join(repo, 'harness.ps1');
        fs.writeFileSync(harness, [
            'function Log { param([string]$m) Write-Host "LOG: $m" }',
            `function Get-RepoRoot { return ${JSON.stringify(repo)} }`,
            "$Hooks = @('guard-read-whole-file.js::Read', 'guard-read-whole-file.js::Bash', 'guard-stop-contract.js::@Stop')",
            "$SecretDeny = @('Read(./.env)')",
            "$Mcps = @('context7|-- x')",
            psArray(src, 'RetiredHooks'),
            psFunc(src, 'Clear-WriteBlockers'),   // Write-JsonFile's dependency - extract both or the write is a no-op
            psFunc(src, 'Write-JsonFile'),
            psFunc(src, 'Set-HookSettings'),
            'Set-HookSettings',
        ].join('\n'));
        const res = spawnSync('pwsh', ['-NoProfile', '-File', harness], { cwd: repo, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, res.stderr);
        const wired = JSON.parse(fs.readFileSync(settings, 'utf8'));
        const all = Object.values(wired.hooks).flat().flatMap((e) => e.hooks).map((h) => h.command);
        assert.ok(!all.some((c) => c.includes('inject-code-style.js')), 'the prompt-event entry is gone');
        assert.ok(!all.some((c) => c.includes('require-convention-skill.js')), 'the PreToolUse entry is gone');
        assert.ok(all.some((c) => c.includes('my-own-hook.js')), 'a hook that is not ours is never touched');
        assert.ok(all.some((c) => c.includes('guard-read-whole-file.js')), 'the selected hooks are still wired');
        assert.ok((wired.hooks.Stop || []).flatMap((e) => e.hooks).some((h) => h.command.includes('guard-stop-contract.js')), 'a lifecycle-event wiring still lands');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// --- the fresh-session gate's env knobs: reported 2026-09-04 from a 1M session ----------------
// CLAUDE_STACK_FRESH_SESSION_PCT was documented as tunable per machine and seeded NOWHERE, so the
// only percentage in the env block was CLAUDE_AUTOCOMPACT_PCT_OVERRIDE - a different knob. The
// reporting user raised that one to 40 and reasonably expected the gate to move; it reads its own
// value, which was absent and defaulted to 40 anyway. Both knobs are now seeded, absent-only.
test('sh env: both fresh-session knobs are seeded, and a hand-edited value is never overwritten', { skip: skipNoPython }, () => {
    const src = fs.readFileSync(SH, 'utf8');
    const prog = /prog=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n/.exec(src);
    const hooks = shArray(src, 'HOOKS');
    const deny = shArray(src, 'SECRET_DENY');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-env-'));
    const wire = (settings) => spawnSync('python3', ['-c', prog[1], settings, '--DENY', ...deny, '--MCP', 'context7'],
        { input: hooks.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
    try {
        const fresh = path.join(work, 'fresh.json');
        assert.strictEqual(wire(fresh).status, 0);
        const env = JSON.parse(fs.readFileSync(fresh, 'utf8')).env;
        assert.strictEqual(env.CLAUDE_STACK_FRESH_SESSION_PCT, '40', 'the gate percentage is seeded at the house default');
        assert.strictEqual(env.CLAUDE_STACK_CONTEXT_WINDOW, 'AUTO', 'the window box is seeded with the AUTO sentinel, not an empty box');
        assert.strictEqual(env.CLAUDE_STACK_DOCS_PATH, '.claude/docs', 'the existing three are untouched');

        // update over a hand-edited install: absent-only, so both stay exactly as the user left them
        const pinned = path.join(work, 'pinned.json');
        fs.writeFileSync(pinned, JSON.stringify({ env: { CLAUDE_STACK_FRESH_SESSION_PCT: '60', CLAUDE_STACK_CONTEXT_WINDOW: '200000' } }));
        assert.strictEqual(wire(pinned).status, 0);
        const kept = JSON.parse(fs.readFileSync(pinned, 'utf8')).env;
        assert.strictEqual(kept.CLAUDE_STACK_FRESH_SESSION_PCT, '60', 'a pinned percentage survives the update');
        assert.strictEqual(kept.CLAUDE_STACK_CONTEXT_WINDOW, '200000', 'a declared window survives the update');

        // ...but the RETIRED 1000000 seed is cleared, because it was never the user's number: it
        // declared a 1M window on every install and put the trigger above anything a 200k session
        // can carry, so no fresh-session offer could ever fire (ten confirmations, four projects).
        const stale = path.join(work, 'stale.json');
        fs.writeFileSync(stale, JSON.stringify({ env: { CLAUDE_STACK_CONTEXT_WINDOW: '1000000' } }));
        assert.strictEqual(wire(stale).status, 0);
        assert.strictEqual(JSON.parse(fs.readFileSync(stale, 'utf8')).env.CLAUDE_STACK_CONTEXT_WINDOW, 'AUTO',
            'the old seed is reset to auto-detect');

        // ...and so is the EMPTY seed that replaced it: same behaviour, but an empty box in the env
        // block reads as a variable nobody filled in rather than as the answer.
        const blank = path.join(work, 'blank.json');
        fs.writeFileSync(blank, JSON.stringify({ env: { CLAUDE_STACK_CONTEXT_WINDOW: '' } }));
        assert.strictEqual(wire(blank).status, 0);
        assert.strictEqual(JSON.parse(fs.readFileSync(blank, 'utf8')).env.CLAUDE_STACK_CONTEXT_WINDOW, 'AUTO',
            'the empty seed becomes the AUTO sentinel');
    }
    finally { fs.rmSync(work, { recursive: true, force: true }); }
});

test('ps1 env: the same two knobs, same rule (pwsh required)', { skip: skipNoPwsh }, () => {
    const src = fs.readFileSync(PS1, 'utf8');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-env-ps-'));
    try {
        fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
        const settings = path.join(repo, '.claude', 'settings.json');
        fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_STACK_FRESH_SESSION_PCT: '60' } }, null, 2));
        const harness = path.join(repo, 'harness.ps1');
        const pass1 = path.join(repo, 'pass1.json');
        fs.writeFileSync(harness, [
            'function Log { param([string]$m) Write-Host "LOG: $m" }',
            `function Get-RepoRoot { return ${JSON.stringify(repo)} }`,
            "$Hooks = @('guard-read-whole-file.js::Read')",
            "$SecretDeny = @('Read(./.env)')",
            "$Mcps = @('context7|-- x')",
            psArray(src, 'RetiredHooks'),
            psFunc(src, 'Clear-WriteBlockers'),   // Write-JsonFile's dependency - extract both or the write is a no-op
            psFunc(src, 'Write-JsonFile'),
            psFunc(src, 'Set-HookSettings'),
            'Set-HookSettings',
            `Copy-Item ${JSON.stringify(settings.replace(/\\/g, '/'))} ${JSON.stringify(pass1.replace(/\\/g, '/'))}`,
            // second pass over a settings file still carrying the RETIRED 1000000 seed
            `Set-Content -Path ${JSON.stringify(settings.replace(/\\/g, '/'))} -Value '{ "env": { "CLAUDE_STACK_CONTEXT_WINDOW": "1000000" } }'`,
            'Set-HookSettings',
        ].join('\n'));
        const res = spawnSync('pwsh', ['-NoProfile', '-File', harness], { cwd: repo, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, res.stderr);
        const first = JSON.parse(fs.readFileSync(pass1, 'utf8')).env;
        assert.strictEqual(first.CLAUDE_STACK_FRESH_SESSION_PCT, '60', 'the hand-edited percentage is left alone');
        assert.strictEqual(first.CLAUDE_STACK_CONTEXT_WINDOW, 'AUTO', 'the absent window is seeded with the AUTO sentinel');
        const env = JSON.parse(fs.readFileSync(settings, 'utf8')).env;
        assert.strictEqual(env.CLAUDE_STACK_INSTRUMENT, '0', 'the existing seeds still land');
        // the first pass proved the absent-only seeds; this is the retired value being cleared
        assert.strictEqual(env.CLAUDE_STACK_CONTEXT_WINDOW, 'AUTO', 'the retired 1000000 seed is reset to the AUTO sentinel');
        assert.strictEqual(env.CLAUDE_STACK_FRESH_SESSION_PCT, '40', 'and the percentage is re-seeded at the house default');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// --- the docs-root env key rename (0.2.43) ---------------------------------------------------
// CLAUDE_DOCS_PATH -> CLAUDE_STACK_DOCS_PATH: every other variable this stack owns is
// CLAUDE_STACK_*, and a bare CLAUDE_DOCS_PATH reads as a Claude Code setting. The rename runs in
// the installers' env pass BEFORE the absent-only seeds, or the seed would write the default over
// a root the user had set under the old name.
test('sh env: the docs-root key is renamed in place, value kept, before the seeds run', { skip: skipNoPython }, () => {
    const src = fs.readFileSync(SH, 'utf8');
    const prog = /prog=\$\(cat <<'PY'\n([\s\S]*?)\nPY\n/.exec(src);
    const hooks = shArray(src, 'HOOKS');
    const deny = shArray(src, 'SECRET_DENY');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-rename-'));
    const wire = (file, before) => {
        const p = path.join(work, file);
        fs.writeFileSync(p, JSON.stringify(before));
        const r = spawnSync('python3', ['-c', prog[1], p, '--DENY', ...deny, '--MCP', 'context7'],
            { input: hooks.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: work } });
        assert.strictEqual(r.status, 0, r.stderr);
        return { env: JSON.parse(fs.readFileSync(p, 'utf8')).env, out: r.stdout };
    };

    const moved = wire('old.json', { env: { CLAUDE_DOCS_PATH: 'team/docs' } });
    assert.strictEqual(moved.env.CLAUDE_STACK_DOCS_PATH, 'team/docs', 'the hand-set root moves to the new key, not back to the default');
    assert.ok(!('CLAUDE_DOCS_PATH' in moved.env), 'the old key is gone - one name, not two');
    assert.match(moved.out, /CLAUDE_DOCS_PATH renamed to CLAUDE_STACK_DOCS_PATH/, 'the rename is narrated, never silent');

    const both = wire('both.json', { env: { CLAUDE_DOCS_PATH: 'stale', CLAUDE_STACK_DOCS_PATH: 'current' } });
    assert.strictEqual(both.env.CLAUDE_STACK_DOCS_PATH, 'current', 'an already-migrated value is never overwritten by the stale one');
    assert.ok(!('CLAUDE_DOCS_PATH' in both.env), 'and the stale key still goes');

    const fresh = wire('fresh.json', {});
    assert.strictEqual(fresh.env.CLAUDE_STACK_DOCS_PATH, '.claude/docs', 'a fresh install just gets the seed');
    assert.ok(!('CLAUDE_DOCS_PATH' in fresh.env), 'and never the retired name');
    fs.rmSync(work, { recursive: true, force: true });
});

test('ps1 env: the same rename, same rules (pwsh required)', { skip: skipNoPwsh }, () => {
    const src = fs.readFileSync(PS1, 'utf8');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'skinst-rename-ps-'));
    try {
        fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
        const settings = path.join(repo, '.claude', 'settings.json');
        fs.writeFileSync(settings, JSON.stringify({ env: { CLAUDE_DOCS_PATH: 'team/docs' } }, null, 2));
        const harness = path.join(repo, 'harness.ps1');
        fs.writeFileSync(harness, [
            'function Log { param([string]$m) Write-Host "LOG: $m" }',
            `function Get-RepoRoot { return ${JSON.stringify(repo)} }`,
            "$Hooks = @('guard-read-whole-file.js::Read')",
            "$SecretDeny = @('Read(./.env)')",
            "$Mcps = @('context7|-- x')",
            psArray(src, 'RetiredHooks'),
            psFunc(src, 'Clear-WriteBlockers'),   // Write-JsonFile's dependency - extract both or the write is a no-op
            psFunc(src, 'Write-JsonFile'),
            psFunc(src, 'Set-HookSettings'),
            'Set-HookSettings',
        ].join('\n'));
        const res = spawnSync('pwsh', ['-NoProfile', '-File', harness], { cwd: repo, encoding: 'utf8' });
        assert.strictEqual(res.status, 0, res.stderr);
        const env = JSON.parse(fs.readFileSync(settings, 'utf8')).env;
        assert.strictEqual(env.CLAUDE_STACK_DOCS_PATH, 'team/docs', 'the hand-set root moves to the new key');
        assert.ok(!('CLAUDE_DOCS_PATH' in env), 'the old key is gone');
        assert.match(res.stdout, /CLAUDE_DOCS_PATH renamed to CLAUDE_STACK_DOCS_PATH/, 'and the rename is narrated');
    }
    finally { fs.rmSync(repo, { recursive: true, force: true }); }
});
