#!/usr/bin/env node
// Repo lint: keep the registration surfaces and all cross-skill references in
// sync. The installer is split into two manifests: claude-stack.{sh,ps1}.
// SKILLS and MCPS must be identical across both twins - and they are ALSO shared
// with the Cursor stack (the separate cursor-stack repo, whose installers clone
// this repo for skills); that cross-repo parity is held by discipline (a baseline
// change is a two-repo commit), each repo linting its own twins.
// Catches the failure modes that actually happen:
//   1. a skill directory exists but is missing from a manifest or the HTML
//      inventory (it would silently never install);
//   2. a SKILL.md references a skill name that does not exist anywhere (typo or
//      rename rot, e.g. `vertical-slice` vs `vertical-slice-architecture`);
//   3. a SKILL.md frontmatter block that a strict YAML parser (js-yaml here)
//      cannot load, which silently drops the skill from the registry, e.g. an
//      unquoted `description:` containing `Companion: ` (colon-space);
//   4. drift between the two manifests, or between them and the stack HTML;
//   5. headline Skills/Plugins/MCP/Hooks/Agents/Rules counts in the
//      README drifting from the actual installer/on-disk set sizes (those prose
//      numbers can no longer lie);
//   6. a backticked skill name that resolves to nothing - scanned in skill files,
//      agents/*.md subagents, AND the base template + claude rules
//      (CLAUDE.template.md / rules/*.md), where a renamed skill would
//      otherwise rot silently; tokens there resolve against
//      skills + plugins + MCPs + agent names + NON_SKILL_TOKENS;
//   7. a false 'Vendored from' label on a house dotnet-* skill (they are
//      original work; honest 'Adapted from'/attribution is allowed);
//   8. the two installers listing the SKILLS block in a DIFFERENT
//      ORDER (not just a different set);
//   9. the on-disk agents/*.md set diverging from the agents the
//      installers fetch (the AGENTS manifest array);
//  10. a LOAD directive naming a skill the install can legitimately lack - an
//      optional skill (evidence-gated or opt-in, so unreachable from any seed
//      closure) cited with no availability guard, which makes the model call a
//      skill that is not there and take an 'Unknown skill' error;
//  11. the CROSS-STACK case of the same defect - a load directive naming a skill
//      absent from a stack the CITING artifact itself ships into (an always-on
//      agent naming `angular-security`, which a .NET-only install never has).
// Also verifies that every NON_SKILL_TOKENS allowlist entry is still actually used (no dead
// config), that rules/*.md + agents/*.md frontmatter parses as
// strict YAML with the required keys (an unquoted ': ' scalar breaks GitHub
// rendering and strict parsers - the skills already get this via check 1),
// that every copy of a deliberate multi-home rule still matches its marker in
// meta/shared-rules.json (edit one copy without syncing the others = red),
// and warns (soft) on over-long SKILL.md descriptions.
// Needs js-yaml (run `npm install` once). Run: node scripts/lint-skills.js
//   -> exit 0 clean (warnings allowed), 1 with findings.
'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const SKILLS_DIR = path.join(ROOT, 'stack', 'skills');
const CLAUDE_SH = path.join(ROOT, 'scripts', 'os', 'claude-stack.sh');
const CLAUDE_PS1 = path.join(ROOT, 'scripts', 'os', 'claude-stack.ps1');
const README = path.join(ROOT, 'README.md');
const CLAUDE_README = README;   // merged into the root README at the repo flatten
const STACK_HTML = path.join(ROOT, 'docs', 'claude-stack.html');
const AGENTS_DIR = path.join(ROOT, 'stack', 'agents');
const CLAUDE_TEMPLATE = path.join(ROOT, 'stack', 'CLAUDE.template.md');
const CLAUDE_RULES_DIR = path.join(ROOT, 'stack', 'rules');
const PLUGIN_MARKETPLACE_URLS = new Set([
    'https://github.com/anthropics/claude-plugins-official',
    'https://github.com/jarrodwatts/claude-hud',
    'https://github.com/DietrichGebert/ponytail',
]);

// Backticked kebab-case tokens that look like skill names but are not
// (code identifiers, example selectors). Extend when lint flags a false positive.
// Every entry here MUST appear as a backtick in some skill file (check 11 fails
// any dead entry), so this stays an exact, self-pruning allowlist.
const NON_SKILL_TOKENS = new Set([
    // the CLAUDE.template.md rules table's slash-only-capture notation - a marker, not a skill.
    'user-run',
    // the commit-gate hook, referenced by name from baseline-git.md and project-verify-code - a hook, not a skill.
    'guard-ungated-commit',
    // npm flags, npmrc keys, and package names in the npm skill - tool identifiers, not skills.
    'ignore-scripts',
    'min-release-age',
    'default-days',
    'run-s',
    'run-p',
    // CSP directive + npm package named in the browser-extension skill - identifiers, not skills.
    'unsafe-eval',
    'chrome-types',
    // lint rule, npm packages, and a CSS property named in the typescript skill's references.
    'no-floating-promises',
    'ts-pattern',
    'web-vitals',
    'aspect-ratio',
    // webpack plugin/loader/devtool/mode identifiers named in the webpack skill - tools, not skills.
    'fork-ts-checker-webpack-plugin',
    'hidden-source-map',
    'thread-loader',
    'speed-measure-webpack-plugin',
    'write-dts',
    'tsconfig-paths-webpack-plugin',
    'app-order-list', // Angular selector example in angular-conventions
    'order-list',     // Angular selector example in angular-conventions
    'axe-core',       // a11y testing package in angular-conventions, not a skill
    'jest-axe',       // a11y testing package in angular-conventions, not a skill
    'vitest-axe',     // its Vitest twin, same runner-conditional a11y line
    // old Angular Material button directive selectors named in angular-material's
    // v20 migration note (matButton replaced them) - code identifiers, not skills.
    'mat-button',
    'mat-raised-button',
    'mat-flat-button',
    'mat-stroked-button',
    // Claude Code SKILL.md frontmatter field (manual-only skills), backticked in
    // prose in project-solve-cross-task + the base template - a field name, not a skill.
    'disable-model-invocation',
    // the two GENERATED per-project awareness rules (written by the capture skills,
    // never in the installer manifest) - rule file names, not skills; referenced by
    // project-solve-cross-task's in-session scoping step.
    'baseline-project-architecture',
    'baseline-project-related-context',
    // MCP server names stamped by project-agent-capabilities' routing map - servers, not skills.
    'angular-cli',
    'chrome-devtools',
    'appium-mcp',
    // built-in Claude Code agent type named in the base template's navigation
    // guidance (don't delegate single-symbol lookups to it) - not a house skill.
    'general-purpose',
    // real .NET CLI diagnostic tools (global tools), backticked as code identifiers
    // in dotnet-diagnostics/references/dumps.md - not house skills.
    'dotnet-dump',
    'dotnet-gcdump',
    'dotnet-counters',
    'dotnet-trace',
    // PostgreSQL extension module named in database-conventions' SQL style reference
    // (pre-v13 UUID generation) - a Postgres module, not a house skill.
    'uuid-ossp',
    // file-naming style term backticked in the typescript style reference - a
    // convention name, not a house skill.
    'kebab-case',
]);

const findings = [];
const warnings = [];   // soft (printed, never fail the build)

function flag(message)
{
    findings.push(message);
}

function warn(message)
{
    warnings.push(message);
}

// Parse "repo|skill" entries from the SKILLS block of an installer manifest
// (MCP entries share the same "a|b" line format, so scope to the block).
// Commented entries are still inventory (resolvable references), not installs.
function parseManifest(file, quote, blockStart)
{
    const active = new Map();    // skill -> repo
    const commented = new Map();
    const entry = new RegExp(`^\\s*(#?)\\s*${quote}([^|${quote}]+)\\|([^${quote}]+)${quote}`);
    let inBlock = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n'))
    {
        if (!inBlock)
        {
            inBlock = line.trimEnd().endsWith(blockStart);
            continue;
        }

        if (line.trim() === ')')
        {
            break;
        }

        const m = line.match(entry);
        if (m)
        {
            (m[1] === '#' ? commented : active).set(m[3], m[2]);
        }
    }

    return { active, commented };
}

// Count/collect the active (uncommented) quoted entries of a simple string-array
// block (AGENTS / HOOKS / RULES) - one quoted token per line, block ends at ')'.
// For HOOK/RULE entries that carry a '::'/'|' tail, the leading token is taken.
// Returns the ordered list of active entry names; commented lines are skipped.
function parseStringArray(file, quote, blockStart)
{
    const names = [];
    const quoted = new RegExp(`^\\s*(#?)\\s*${quote}([^${quote}]+)${quote}`);
    let inBlock = false;
    for (const line of fs.readFileSync(file, 'utf8').split('\n'))
    {
        if (!inBlock)
        {
            inBlock = line.trimEnd().endsWith(blockStart);
            continue;
        }

        if (line.trim() === ')')
        {
            break;
        }

        const m = line.match(quoted);
        if (m && m[1] !== '#')
        {
            names.push(m[2].split(/::|\|/)[0]);
        }
    }

    return names;
}

function localSkillDirs()
{
    return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);
}

// Parse a flat installer block (PLUGINS / MCPS) of quoted entries. The entry's
// name is the part before `sep` ('@' for plugins, '|' for MCPs). Bare variable
// lines (e.g. "$MEMORY_ENTRY" / $MemoryEntry) are resolved by locating the
// variable's assignment elsewhere in the file. Returns empty sets if the block
// is absent.
function parseFlatBlock(file, quote, blockStart, sep)
{
    const text = fs.readFileSync(file, 'utf8');
    const active = new Set();
    const commented = new Set();
    const quoted = new RegExp(`^\\s*(#?)\\s*${quote}([^${quote}]+)${quote}`);
    const variable = /^\s*(#?)\s*"?\$([A-Za-z_][A-Za-z0-9_]*)"?\s*(#.*)?$/;
    let inBlock = false;
    for (const line of text.split('\n'))
    {
        if (!inBlock)
        {
            inBlock = line.trimEnd().endsWith(blockStart);
            continue;
        }

        if (line.trim() === ')')
        {
            break;
        }

        const resolveVar = varName =>
            text.match(new RegExp(`^\\$?${varName}\\s*=\\s*${quote}([a-z0-9-]+)\\${sep}`, 'm'))?.[1] ?? null;

        let name = null;
        let isCommented = false;
        const q = line.match(quoted);
        const v = line.match(variable);
        if (q)
        {
            name = q[2].startsWith('$') ? resolveVar(q[2].slice(1)) : q[2].split(sep)[0];
            isCommented = q[1] === '#';
        }
        else if (v)
        {
            name = resolveVar(v[2]);
            isCommented = v[1] === '#';
        }

        if (name)
        {
            (isCommented ? commented : active).add(name);
        }
    }

    return { active, commented };
}

// Lint the evidence catalog (meta/evidence.json) against the
// artifact rosters: a typo'd key silently never matches (the scan just skips it),
// and a regex signal without a label surfaces as raw regex in the guided commands'
// consent tables. Pure - main() feeds it the real catalog and rosters; the test
// file exercises it with synthetic ones.
function lintEvidenceCatalog(catalog, rosters)
{
    const out = [];
    const layers = { skills: 'skill', mcps: 'mcp', plugins: 'plugin' };
    for (const key of Object.keys(catalog))
    {
        if (key !== '_comment' && !(key in layers))
        {
            out.push(`evidence.json has unknown layer '${key}' - the scan reads only skills/mcps/plugins, so its entries would silently never match`);
        }
    }

    for (const [layer, singular] of Object.entries(layers))
    {
        for (const [name, entry] of Object.entries(catalog[layer] || {}))
        {
            if (!rosters[layer].has(name))
            {
                out.push(`evidence.json names ${singular} '${name}' which is not in the ${layer} roster - the signal would silently never match`);
            }

            for (const kind of ['csprojContent', 'content'])
            {
                for (const signal of entry[kind] || [])
                {
                    if (typeof signal.label !== 'string' || signal.label.trim() === '')
                    {
                        out.push(`evidence.json ${singular} '${name}' has a ${kind} signal without a label - consent tables would show the raw regex`);
                    }
                }
            }
        }
    }

    return out;
}

// Lint the judgment catalog (meta/judgment.json) against the artifact
// rosters: refs are '<category>:<name>' and a typo'd ref silently never fires; every overlap
// item needs its unique gap (the keep decision hinges on it); versionConflicts need an integer
// threshold; occasionBound cadences must be non-empty. Pure, like lintEvidenceCatalog.
function lintJudgmentCatalog(catalog, rosters)
{
    const out = [];
    const plural = { skill: 'skills', agent: 'agents', mcp: 'mcps', plugin: 'plugins' };
    const known = ref =>
    {
        const i = ref.indexOf(':');
        const layer = plural[ref.slice(0, i)];
        return layer && rosters[layer] && rosters[layer].has(ref.slice(i + 1));
    };
    const checkRef = (ref, where) => { if (!known(ref)) out.push(`judgment.json ${where} names '${ref}' which resolves to no known artifact - it would silently never fire`); };

    for (const o of catalog.overlaps || [])
    {
        const items = o.items || [];
        if (items.length < 2) out.push('judgment.json has an overlap with fewer than 2 items - nothing to overlap');
        if (typeof o.shared !== 'string' || o.shared.trim() === '') out.push(`judgment.json overlap [${items.join(', ')}] has no shared capability text`);
        for (const ref of items)
        {
            checkRef(ref, 'overlap');
            if (typeof (o.gaps || {})[ref] !== 'string' || !o.gaps[ref].trim()) out.push(`judgment.json overlap item '${ref}' has no gap - the keep decision hinges on each side's unique gap`);
        }
    }

    for (const c of catalog.versionConflicts || [])
    {
        checkRef(c.item, 'versionConflicts');
        for (const field of ['package', 'conflict', 'survives'])
        {
            if (typeof c[field] !== 'string' || !c[field].trim()) out.push(`judgment.json versionConflicts '${c.item}' is missing '${field}'`);
        }
        if (!/^\d+$/.test(String(c.below || ''))) out.push(`judgment.json versionConflicts '${c.item}' has non-integer below '${c.below}'`);
    }

    for (const [ref, cadence] of Object.entries(catalog.occasionBound || {}))
    {
        checkRef(ref, 'occasionBound');
        if (typeof cadence !== 'string' || cadence.trim() === '') out.push(`judgment.json occasionBound '${ref}' has an empty cadence - the cadence IS the citation`);
    }

    return out;
}

// Lint the shared-rules registry (meta/shared-rules.json): each entry is ONE rule whose text
// deliberately lives in several stack files (a canonical owner + inline restatements, no prose
// cross-mentions). Every copy is pinned by a marker phrase from that file's own wording,
// matched whitespace-normalized so md line wrapping cannot break it. A copy edited or deleted
// breaks its marker -> the finding lists every other copy, forcing the sync mechanically.
// 30. A CAPABILITY SENTENCE in the stack's own source needs a live probe or it does not ship.
// Three artifacts were caught asserting a harness capability nobody had tested: a deny-list claim
// that the account settings.json `Read(**/config.json)` rule also stops a Bash `cat` (refuted live -
// two cats returned content, is_error:false, zero denial strings in the transcript), a brief handing
// a git-drift question to a seat with no Bash, and the installer comment resting the whole
// SECRET_DENY mechanism on the first claim. A false claim in the SOURCE propagates to every install.
// So: a sentence that says what the harness DOES with a tool, a permission, a hook or a config file
// must carry its evidence within the same comment block - `measured`, `replayed`, `reproduced`,
// `probed`, `verified`, `confirmed` or `proven`. Deliberately narrow: it is the assertion shape that
// shipped false three times, not every sentence with the word 'hook' in it.
const CAP_NOUN = /(deny (list|rule)|denial|permission|PreToolUse|PostToolUse|SessionStart|UserPromptSubmit|Stop hook|matcher|settings\.json|additionalContext|subagent|\.mcp\.json|allowlist)/i;
const CAP_VERB = /(reaches|does not reach|never reaches|blocks|does not block|cannot|is not consulted|expands|does not expand|takes effect|inherits|does not inherit|propagates|never fires)/i;
const CAP_PROOF = /\b(measured|replayed|reproduced|probed|verified|confirmed|proven|proved)\b/i;
function lintCapabilityClaims(files)
{
    const out = [];
    for (const { path: rel, text } of files)
    {
        for (const m of text.matchAll(/[^.\n]{40,400}\./g))
        {
            const sentence = m[0];
            // a function header or a banner comment names the mechanism, it does not assert about it
            // a banner comment ('# INSTALL + UPDATE: ...') or a function header names the mechanism,
            // it does not assert anything about how the harness behaves
            if (/^\s*(#|\/\/)\s*[A-Z][A-Z +_-]{2,}:/.test(sentence)) continue;
            if (/^\s*\w[\w-]*\s*\(\)\s*\{/.test(sentence)) continue;
            if (/^\s*function\s+[\w-]+/.test(sentence)) continue;
            if (!CAP_NOUN.test(sentence) || !CAP_VERB.test(sentence)) continue;
            const ctx = text.slice(Math.max(0, m.index - 800), m.index + sentence.length + 800);
            if (CAP_PROOF.test(ctx)) continue;
            const line = text.slice(0, m.index).split('\n').length;
            out.push(`${rel}:${line} asserts a harness capability with no probe in its comment block - cite the measurement or do not claim it: '${sentence.trim().slice(0, 90)}'`);
        }
    }
    return out;
}

// 29. Every DELIBERATE-ONLY skill must be in guard-fresh-session-start.js's ORCHESTRATION list.
// `disable-model-invocation: true` is the skill saying it only ever starts because a person asked
// for it - which is exactly the run that must not start on another finished run's carried history.
// The list was hand-maintained and drifted: four such runs were missing from the live regex, so the
// fresh-session offer never fired for them. Generated from the roster instead of trusted.
function lintOrchestrationRoster(deliberateSkills, hookSrc)
{
    const m = /^const ORCHESTRATION = (\/.*\/);$/m.exec(hookSrc);
    if (!m) return ['guard-fresh-session-start.js: no `const ORCHESTRATION = /.../;` line to check the roster against'];
    let re;
    try { re = new RegExp(m[1].slice(1, m[1].lastIndexOf('/'))); }
    catch (err) { return [`guard-fresh-session-start.js: ORCHESTRATION is not a usable regex (${err.message})`]; }
    return deliberateSkills
        .filter((name) => !re.test(name))
        .map((name) => `${name} declares disable-model-invocation but is absent from guard-fresh-session-start.js's ORCHESTRATION list - the fresh-session offer will never fire for it`);
}

// 28. The plugin-settings catalog (meta/plugin-settings.json) - the same silent-miss class as
// evidence.json, one layer out: a row for a plugin the stack does not install is never offered,
// and a key the plugin does not read is a no-op the user still gets asked about. The version the
// keys were read from is part of the row, so an upstream rename is traceable rather than silent.
// Pure, like lintEvidenceCatalog.
function lintPluginSettings(catalog, pluginRoster)
{
    const out = [];
    for (const key of Object.keys(catalog))
    {
        if (key !== '_comment' && key !== 'plugins') out.push(`plugin-settings.json has unknown top-level key '${key}' - the tool reads only 'plugins'`);
    }

    for (const [name, entry] of Object.entries(catalog.plugins || {}))
    {
        if (!pluginRoster.has(name)) out.push(`plugin-settings.json names plugin '${name}', which is not in the plugins roster - its settings would never be offered`);
        if (!/\S+ \d+\.\d+\.\d+/.test(String(entry.verified || ''))) out.push(`plugin-settings.json '${name}' needs a \`verified\` note naming the plugin VERSION its keys were read from - a key the plugin does not read is a silent no-op`);
        if (!Array.isArray(entry.targets) || !entry.targets.length) { out.push(`plugin-settings.json '${name}' has no targets`); continue; }
        for (const t of entry.targets)
        {
            if (!t.file || path.isAbsolute(t.file) || t.file.includes('..')) out.push(`plugin-settings.json '${name}' target file must be a relative path inside the account config dir, got '${t.file}'`);
            if (!t.settings || typeof t.settings !== 'object') { out.push(`plugin-settings.json '${name}' target '${t.file}' has no settings object`); continue; }
            for (const group of Object.keys(t.settings))
            {
                if (!((t.why || {})[group])) out.push(`plugin-settings.json '${name}' target '${t.file}' changes '${group}' with no \`why\` - a recommendation the user cannot weigh is not one`);
            }
        }
    }

    return out;
}

// Pure, like lintEvidenceCatalog: readFile is injected for testability.
function lintSharedRules(registry, readFile)
{
    const out = [];
    const squash = s => s.replace(/\s+/g, ' ');
    for (const [name, rule] of Object.entries(registry.rules || {}))
    {
        const copies = [
            ...(rule.owner ? [{ ...rule.owner, role: 'owner' }] : []),
            ...(rule.sites || []).map(s => ({ ...s, role: 'site' })),
        ];
        if (!rule.owner) out.push(`shared-rules '${name}' has no owner - the canonical copy must be named`);
        if (copies.length < 2) out.push(`shared-rules '${name}' lists fewer than 2 copies - nothing shared to sync`);

        for (const copy of copies)
        {
            if (typeof copy.marker !== 'string' || copy.marker.trim() === '')
            {
                out.push(`shared-rules '${name}' ${copy.role} ${copy.file} has an empty marker`);
                continue;
            }

            let content;
            try
            {
                content = readFile(copy.file);
            }
            catch
            {
                out.push(`shared-rules '${name}' ${copy.role} names missing file ${copy.file}`);
                continue;
            }

            if (!squash(content).includes(squash(copy.marker)))
            {
                const others = copies.filter(c => c !== copy).map(c => c.file).join(', ');
                out.push(`shared-rules '${name}': marker not found in ${copy.file} - the copy was edited or removed; sync the other copies (${others}), then update the markers`);
            }
        }
    }

    return out;
}


// The skills an install can legitimately LACK: every local skill NOT reachable
// from the guided commands' seeds (meta/recommendations.json) through the
// dependency graph (agent -> skill, rule -> skill). Everything else arrives with
// its stack; these arrive only on an evidence match or a deliberate opt-in.
function optionalSkills(recs, graph, skillDirs)
{
    const reachable = new Set();
    for (const [, c] of Object.entries(seedClosures(recs, graph)))
    {
        for (const s of c.skills) if (skillDirs.has(s)) reachable.add(s);
    }

    return new Set([...skillDirs].filter(s => !reachable.has(s)));
}

// What each SEED installs, closed over the graph (an agent or rule pulls its skills).
// `general` is the opt-in list no stack owns, so it seeds nothing: a skill reachable only
// from there is absent unless the user deliberately adds it.
function seedClosures(recs, graph)
{
    const out = {};
    for (const [tag, seed] of [['ALWAYS', recs.always || {}], ...Object.entries(recs.stacks || {})])
    {
        const c = { skills: new Set(seed.skills || []), agents: new Set(seed.agents || []), rules: new Set(seed.rules || []) };
        for (const kind of ['agents', 'rules'])
        {
            for (const name of c[kind])
            {
                for (const s of (((graph[kind] || {})[name] || {}).skills || [])) c.skills.add(s);
            }
        }

        out[tag] = c;
    }

    // ALWAYS ships into every project, so every stack's closure contains it too - without this
    // union an always-on skill reads as 'absent everywhere' and the cross-stack check inverts.
    for (const [tag, c] of Object.entries(out))
    {
        if (tag === 'ALWAYS') continue;
        for (const kind of ['skills', 'agents', 'rules']) for (const n of out.ALWAYS[kind]) c[kind].add(n);
    }

    return out;
}

// The stacks a given artifact is installed in. ALWAYS means every project, so an artifact
// seeded there may cite only skills that are ALSO everywhere.
function hostStacks(closures, kind, name)
{
    const stacks = Object.keys(closures).filter(t => t !== 'ALWAYS');
    if ((closures.ALWAYS[kind] || new Set()).has(name)) return new Set(stacks);

    return new Set(stacks.filter(t => closures[t][kind].has(name)));
}

// The skills a given artifact must NOT direct a load of without a guard: those missing from at
// least one stack the artifact itself ships into. This is the general case of optionalSkills -
// a cross-cutting seat (the always-on agents) citing a stack skill is the same defect as citing
// an evidence-gated one, and it is the shape that actually bit: `angular-security` named by an
// agent installed in every project, .NET-only ones included.
function absentSkillsFor(closures, kind, name, skillDirs)
{
    const host = hostStacks(closures, kind, name);
    if (host.size === 0) return new Set();          // artifact itself is opt-in - nothing to prove

    return new Set([...skillDirs].filter(s => [...host].some(t => !closures[t].skills.has(s))));
}

// 27. No artifact may put a skill into a project's install by NAMING it. The `suggests:`
// frontmatter did exactly that: the guided walk offered `dotnet-aspire` on a devops project with
// no Aspire in it, `dotnet-authentication` on a browser extension, `angular-security` on a
// WinForms install. The mechanism is removed - a need is proven, never suggested. What a project
// actually uses comes from meta/evidence.json matched against ITS OWN manifests; what a stack
// always needs is a meta/recommendations.json seed. What a seat loads at RUNTIME stays a body
// matter, by description (checks 25 and 26), and reaches no install decision.
function lintSuggestionEdges(label, text)
{
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
    if (!fm || !/^suggests:/m.test(fm[1])) return [];

    return [`${label} declares \`suggests:\` in its frontmatter - that mechanism is removed, because an `
        + `artifact naming a skill must never put it into a project's install (measured: dotnet-aspire offered `
        + `to a project with no Aspire). Prove the need with a meta/evidence.json signal against the project's `
        + `own manifests, or seed it per stack in meta/recommendations.json`];
}

// A backticked cite of an OPTIONAL skill inside a load directive must carry an
// availability guard, or the model calls Skill(<name>) in a project that never
// installed it and gets 'Unknown skill: <name>' (measured 2026-09-04 in a
// consuming project: project-architecture-analyzer told the session to load
// `dotnet-architecture-tests`, which meta/evidence.json installs only when
// NetArchTest/ArchUnitNET is in the manifests). A cite that merely POINTS at a
// skill ('boundary enforcement lives in `x`') is not a directive and is not
// flagged - only an instruction to load it.
//
// Two directive shapes are scanned:
//   A. prose - a load verb in the SAME SENTENCE before the token ('load `x` when
//      judging fit'); scoping to the sentence keeps an earlier 'Load when ...'
//      about the file itself from flagging a later pointer on the same line
//   B. a router-table row - the token sits in the last cell of a row under a
//      '| ... | Load |' header (or '| Also load |' - any header cell whose last WORD is
//      'load'; 'Payload' is not one), which is the house routing shape
//
// The remedy is NOT a guard phrase next to the name. A skill is selected by matching
// what it says it covers against the installed inventory, so a directive that must
// survive a trimmed install DESCRIBES the capability ('the skill covering Angular
// hardening') instead of naming it: the name only works where the skill exists, while
// the description also tells a seat without it what to do. Naming stays correct for a
// skill guaranteed alongside the citing artifact - a frontmatter preload, an own-stack
// skill - which is why the check is scoped to the ones that can be absent.
//
// One escape: a file opening with an explicit '**Availability**' callout blankets its
// cites. That is for the ROUTER HUBS, whose whole content is a name -> area table and
// which are stack-scoped anyway.
// `re-enter` / `re-invoke` are the flow twins' spelling ('re-enter `x`' measured unflagged in three
// always-on skills). `run` / `runs` / `see` were tried and rejected: 'Run migrations (mechanics in
// `x`)' and 'see `x`' are pointers, and the trial flagged 11 of them for zero directives.
const LOAD_VERB = /\b(?:load|loads|invoke|invokes|reach for|pull in|add|consult|open|re-enter|re-invoke)\b/i;
const AVAILABILITY_GUARD = /\b(?:in (?:your|the) skill list|not installed|never installed|is absent|are absent|installed only (?:where|when|if)|(?:when|where|if) installed)\b/i;
// A blanket guard covers every cite in its file, and it must be DELIBERATE: an explicit
// '**Availability**' callout carrying a guard phrase. The earlier form also accepted any
// line pairing a guard phrase with a common word ('every', 'rows', 'below'), which silenced
// 13 of 263 files by accident - project-architecture-analyzer/SKILL.md among them, the very
// file whose unguarded cite produced the measured 'Unknown skill' error. Proven by mutation:
// a fresh unguarded load directive added to a blanketed file was not flagged.
const AVAILABILITY_BLANKET = /\*\*Availability\b/;

function lintOptionalCites(file, text, optional)
{
    const findings = [];
    const lines = text.split(/\r?\n/);
    const blanket = lines.some(l => AVAILABILITY_BLANKET.test(l) && AVAILABILITY_GUARD.test(l));
    if (blanket) return findings;

    let loadColumn = false;   // inside a table whose last header cell is 'Load'
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i];
        const cells = line.trim().startsWith('|') ? line.split('|').map(c => c.trim()).filter(Boolean) : null;
        if (!cells)
        {
            loadColumn = false;
        }
        else if (/^\|?[\s:-]+\|/.test(line.trim()) === false && /(?:^|\s)load$/i.test(cells[cells.length - 1] || ''))
        {
            loadColumn = true;
        }

        for (const m of line.matchAll(/`([a-z][a-z0-9-]*)`/g))
        {
            if (!optional.has(m[1])) continue;

            const lastCell = cells ? cells[cells.length - 1] : '';
            const inLoadCell = loadColumn && cells && lastCell.includes('`' + m[1] + '`');
            const before = line.slice(0, m.index);
            const sentence = before.slice(before.lastIndexOf('. ') + 1);
            if (inLoadCell || LOAD_VERB.test(sentence))
            {
                findings.push(`${file}:${i + 1} directs a load of \`${m[1]}\` BY NAME, and that skill can be absent here `
                    + `(evidence-gated or opt-in). Describe what the skill covers instead, so it is matched from the `
                    + `installed inventory and a project without it still knows what to do - or open the file with an `
                    + `'**Availability**' callout if it is a router hub`);
            }
        }
    }

    return findings;
}

// Extract the stack HTML's view of the inventory: house skill names,
// third-party repo skill names, plugin names (from plugin-URL skill rows and
// "/plugin install X@" install cells), and MCP server names.
// An agent body claiming a skill is preloaded must have that skill in the
// frontmatter skills: block. The measured regression: a body claimed four
// preloads, the frontmatter carried one, and 56 of 58 production dispatches
// built without conventions loaded. Two claim shapes are checked; 'Load X on
// demand' text AFTER the claim keyword on the same line is deliberately not
// scanned - it is the opposite of a preload claim:
//   A. '`x`, `y` are preloaded ...' - the skills named BEFORE the keyword
//   B. 'the preloaded `x` skill/hub/recipe' - the skill right after it
function lintPreloadClaims(agentFile, text, skillDirs)
{
    const findings = [];
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    let declared = [];
    try
    {
        const meta = fm ? yaml.load(fm[1]) : null;
        if (meta && Array.isArray(meta.skills))
        {
            // frontmatter entries may be plugin-namespaced ('superpowers:x')
            declared = meta.skills.map(s => String(s).split(':').pop());
        }
    }
    catch
    {
        // broken agent frontmatter is check 18's finding, not this one's
    }

    const claimed = (token) =>
    {
        if (skillDirs.has(token) && !declared.includes(token))
        {
            findings.push(`agents/${agentFile} claims \`${token}\` is preloaded but the frontmatter skills: block does not list it`);
        }
    };

    for (const bodyLine of text.split('\n'))
    {
        const keyword = bodyLine.match(/\b(?:are|is)\s+preloaded\b/i);
        if (keyword)
        {
            // scope to the claim's own sentence - an earlier sentence on the same
            // line ('Load the domain router (`dotnet`, ...) ...') is not a claim
            const before = bodyLine.slice(0, keyword.index);
            const claimSeg = before.slice(before.lastIndexOf('. ') + 1);
            for (const m of claimSeg.matchAll(/`([a-z][a-z0-9-]*)`/g))
            {
                claimed(m[1]);
            }
        }

        for (const m of bodyLine.matchAll(/\bpreloaded\s+`([a-z][a-z0-9-]*)`/gi))
        {
            claimed(m[1]);
        }
    }

    return findings;
}

function parseStackHtml()
{
    const html = fs.readFileSync(STACK_HTML, 'utf8');
    const house = new Set([...html.split('const house = {')[1].split('};')[0]
        .matchAll(/\["([a-z0-9-]+)","/g)].map(m => m[1]));
    const houseManual = new Set([...html.split('const house = {')[1].split('};')[0]
        .matchAll(/\["([a-z0-9-]+)",[^\n]*"manual"\]/g)].map(m => m[1]));

    const repoBlock = html.split('const repository = [')[1].split('\n];')[0];
    const repoSkills = new Set();
    const plugins = new Set();
    for (const m of repoBlock.matchAll(/\["([a-zA-Z0-9:_-]+)","[^"]*","([^"]+)"/g))
    {
        if (PLUGIN_MARKETPLACE_URLS.has(m[2]))
        {
            plugins.add(m[1].split(':')[0]);
        }
        else
        {
            repoSkills.add(m[1]);
        }
    }

    const otherBlock = html.split('const otherTools = [')[1].split('\n];')[0];
    const mcps = new Set();
    for (const m of otherBlock.matchAll(/\["([a-z0-9-]+)", "([^"]+)", "[^"]*", "([^"]*)"/g))
    {
        if (m[2].startsWith('MCP server'))
        {
            mcps.add(m[1]);
        }

        const install = m[3].match(/\/plugin install ([a-z0-9-]+)@/);
        if (install)
        {
            plugins.add(install[1]);
        }
    }

    const hooksBlock = (html.split('const hooks = [')[1] ?? '').split('\n];')[0];
    const hooks = new Set([...hooksBlock.matchAll(/\["([a-z0-9-]+)"/g)].map(m => m[1]));

    return { house, houseManual, repoSkills, plugins, mcps, hooks };
}

// Every manifest in `manifests` ({label -> Set}) must hold the same entries as
// the reference (the first). Flags both-direction diffs against the reference,
// which transitively proves all four agree.
function assertSameSet(what, manifests)
{
    const labels = Object.keys(manifests);
    const [refLabel, refSet] = [labels[0], manifests[labels[0]]];
    for (const label of labels.slice(1))
    {
        const set = manifests[label];
        for (const name of refSet)
        {
            if (!set.has(name))
            {
                flag(`${what} '${name}' is in ${refLabel} but not ${label}`);
            }
        }

        for (const name of set)
        {
            if (!refSet.has(name))
            {
                flag(`${what} '${name}' is in ${label} but not ${refLabel}`);
            }
        }
    }
}

function main()
{
    const dirs = localSkillDirs();

    // SKILLS are shared across both manifests (and, cross-repo, with the
    // cursor-stack twins). Parse each; claude-stack.sh is the reference for the
    // dir/README/HTML checks, and a parity check proves the ps1 matches it.
    const skills = {
        'claude-stack.sh':  parseManifest(CLAUDE_SH, '"', 'SKILLS=('),
        'claude-stack.ps1': parseManifest(CLAUDE_PS1, "'", '$Skills = @('),
    };
    const primary = skills['claude-stack.sh'];   // canonical SKILLS view (both are identical)

    // 1. Every skill dir has a SKILL.md whose YAML frontmatter loads cleanly,
    //    names the skill after its directory, and carries a non-empty description.
    //    Also collects the manual-only set (disable-model-invocation) for check 19.
    const manualSkills = new Set();
    for (const dir of dirs)
    {
        const skillFile = path.join(SKILLS_DIR, dir, 'SKILL.md');
        if (!fs.existsSync(skillFile))
        {
            flag(`skills/${dir}/ has no SKILL.md`);
            continue;
        }

        const fm = fs.readFileSync(skillFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!fm)
        {
            flag(`skills/${dir}/SKILL.md has no YAML frontmatter block`);
            continue;
        }

        let meta;
        try
        {
            meta = yaml.load(fm[1]);
        }
        catch (err)
        {
            flag(`skills/${dir}/SKILL.md frontmatter is not valid YAML: ${err.reason || err.message}`);
            continue;
        }

        if (meta === null || typeof meta !== 'object' || Array.isArray(meta))
        {
            flag(`skills/${dir}/SKILL.md frontmatter did not parse to a mapping`);
            continue;
        }

        if (meta.name !== dir)
        {
            flag(`skills/${dir}/SKILL.md frontmatter name is '${meta.name}', expected '${dir}'`);
        }

        if (typeof meta.description !== 'string' || meta.description.trim() === '')
        {
            flag(`skills/${dir}/SKILL.md frontmatter has no non-empty 'description'`);
        }

        if (meta['disable-model-invocation'] === true)
        {
            manualSkills.add(dir);
        }
    }

    // 2. Every local skill is registered (uncommented) in the manifests. (The README no
    //    longer carries a skills list - the HTML inventory is the browsable catalog and
    //    its own checks below keep it in sync; the README keeps only the headline counts.)
    for (const dir of dirs)
    {
        if (!primary.active.has(dir))
        {
            flag(`skills/${dir} is not registered in the installer SKILLS block`);
        }
    }

    // 3. Every active envoydev manifest entry has a local directory.
    for (const [skill, repo] of primary.active)
    {
        if (repo === 'envoydev/claude-stack' && !dirs.includes(skill))
        {
            flag(`SKILLS registers envoydev/claude-stack|${skill} but skills/${skill}/ does not exist`);
        }
    }

    // 4. Both manifests agree on the active SKILLS set.
    assertSameSet('skill', Object.fromEntries(
        Object.entries(skills).map(([label, m]) => [label, new Set(m.active.keys())])));

    // 4b. The manifests must list the active SKILLS in the SAME ORDER, not
    //     just the same set - the installers were aligned so a diff/review of one
    //     against another stays line-for-line. parseManifest's Map preserves
    //     insertion order, so the active keys ARE the install order. Compare each
    //     against claude-stack.sh and report the first divergence per manifest.
    const refOrder = [...primary.active.keys()];
    for (const [label, m] of Object.entries(skills))
    {
        if (label === 'claude-stack.sh')
        {
            continue;
        }

        const order = [...m.active.keys()];
        const n = Math.min(refOrder.length, order.length);
        for (let i = 0; i < n; i++)
        {
            if (order[i] !== refOrder[i])
            {
                flag(`${label} SKILLS order diverges from claude-stack.sh at position ${i + 1}: '${order[i]}' vs '${refOrder[i]}'`);
                break;
            }
        }
    }

    // 5. The ps1 'every skill (N)' inventory count matches active + commented entries.
    for (const [label, file, parsed] of [['claude-stack.ps1', CLAUDE_PS1, skills['claude-stack.ps1']]])
    {
        const counted = fs.readFileSync(file, 'utf8').match(/every skill \((\d+)\)/);
        if (counted)
        {
            const inventory = parsed.active.size + parsed.commented.size;
            if (Number(counted[1]) !== inventory)
            {
                flag(`${label} says 'every skill (${counted[1]})' but lists ${inventory} entries`);
            }
        }
    }

    // 6. Every backticked hyphenated token in skill files resolves to a known
    //    skill (any manifest entry, active or commented, or a local dir) or the
    //    explicit non-skill allowlist. The regex now also accepts a leading
    //    uppercase letter and PascalCase/UPPER segments, so a real skill like
    //    `OpenTelemetry-NET-Instrumentation` is validated instead of skipped.
    //    Capitalized tokens unrelated to any skill (HTTP headers like
    //    `Content-Type`, ticket IDs like `PROJ7-4521`) are left alone; a
    //    capitalized token is only flagged when it case-insensitively COLLIDES
    //    with a known skill but the exact casing is wrong (a real reference typo).
    const known = new Set(dirs);
    for (const m of Object.values(skills))
    {
        for (const k of m.active.keys()) known.add(k);
        for (const k of m.commented.keys()) known.add(k);
    }
    const knownLower = new Map([...known].map(k => [k.toLowerCase(), k]));
    const matchedNonSkill = new Set();   // for check 11 (dead-allowlist reverse check)
    for (const dir of dirs)
    {
        const files = [path.join(SKILLS_DIR, dir, 'SKILL.md')];
        const refsDir = path.join(SKILLS_DIR, dir, 'references');
        if (fs.existsSync(refsDir))
        {
            files.push(...fs.readdirSync(refsDir).filter(f => f.endsWith('.md')).map(f => path.join(refsDir, f)));
        }

        for (const file of files)
        {
            if (!fs.existsSync(file))
            {
                continue;
            }

            const text = fs.readFileSync(file, 'utf8');
            for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)`/g))
            {
                const token = m[1];
                if (NON_SKILL_TOKENS.has(token))
                {
                    matchedNonSkill.add(token);
                    continue;
                }

                if (known.has(token))
                {
                    continue;   // exact match - a real skill reference, incl. PascalCase names
                }

                // Not an exact known skill. A lowercase token that is not known
                // is a typo/rename-rot. A capitalized token is only a finding
                // when it collides case-insensitively with a real skill (a
                // casing typo); otherwise it is an unrelated identifier/header.
                const collision = knownLower.get(token.toLowerCase());
                if (token === token.toLowerCase())
                {
                    flag(`${path.relative(ROOT, file)} references \`${token}\` - not a known skill (typo? add to NON_SKILL_TOKENS if intentional)`);
                }
                else if (collision)
                {
                    flag(`${path.relative(ROOT, file)} references \`${token}\` - wrong casing for skill '${collision}'`);
                }
            }
        }
    }


    // 8-10. The agent scripts are the source of truth for EVERYTHING in use:
    // skills, plugins, and MCPs (claude-stack.sh == claude-stack.ps1 for all
    // three blocks). The stack HTML must agree with claude-stack.sh.
    const html = parseStackHtml();
    const pluginsClaudeSh = parseFlatBlock(CLAUDE_SH, '"', 'PLUGINS=(', '@');
    const pluginsClaudePs1 = parseFlatBlock(CLAUDE_PS1, "'", '$Plugins = @(', '@');
    const mcps = {
        'claude-stack.sh':  parseFlatBlock(CLAUDE_SH, '"', 'MCPS=(', '|'),
        'claude-stack.ps1': parseFlatBlock(CLAUDE_PS1, "'", '$Mcps = @(', '|'),
    };

    // 18. Backticked skill names in the base template + claude rules must
    //     resolve too, or a renamed skill rots silently there (the gap check 6
    //     left open). Unlike a skill file, a template/rule legitimately names
    //     plugins (`csharp-lsp`, `claude-hud`), MCPs (`angular-cli`,
    //     `chrome-devtools`), subagents (`ng-build-error-resolver`), and the
    //     superpowers workflow skills - so resolve against the full registration
    //     surface (skills + plugins + MCPs + agent names) plus NON_SKILL_TOKENS,
    //     and only flag a token that matches NONE of them. The same case-collision
    //     rule as check 6: a capitalized token is a finding only when it
    //     case-insensitively collides with a known skill (a casing typo).
    const mcpsRef = mcps['claude-stack.sh'];   // shared set; canonical view
    const resolvable = new Set(known);   // all skills (dirs + every manifest selector)
    for (const s of [...pluginsClaudeSh.active, ...pluginsClaudeSh.commented]) resolvable.add(s);
    for (const s of [...mcpsRef.active, ...mcpsRef.commented]) resolvable.add(s);
    if (fs.existsSync(AGENTS_DIR))
    {
        for (const f of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'))) resolvable.add(f.replace(/\.md$/, ''));
    }

    const resolvableLower = new Map([...resolvable].map(k => [k.toLowerCase(), k]));
    const templateFiles = [CLAUDE_TEMPLATE];
    if (fs.existsSync(CLAUDE_RULES_DIR))
    {
        templateFiles.push(...fs.readdirSync(CLAUDE_RULES_DIR).filter(f => f.endsWith('.md')).map(f => path.join(CLAUDE_RULES_DIR, f)));
    }

    for (const file of templateFiles.filter(fs.existsSync))
    {
        const text = fs.readFileSync(file, 'utf8');
        for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)`/g))
        {
            const token = m[1];
            if (NON_SKILL_TOKENS.has(token))
            {
                matchedNonSkill.add(token);
                continue;
            }

            if (resolvable.has(token))
            {
                continue;
            }

            const collision = resolvableLower.get(token.toLowerCase());
            if (token === token.toLowerCase())
            {
                flag(`${path.relative(ROOT, file)} references \`${token}\` - not a known skill/plugin/MCP/agent (typo? add to NON_SKILL_TOKENS if intentional)`);
            }
            else if (collision)
            {
                flag(`${path.relative(ROOT, file)} references \`${token}\` - wrong casing for '${collision}'`);
            }
        }
    }

    // 8. HTML skills vs manifests (house section vs dirs; repo rows vs third-party inventory).
    for (const name of html.house)
    {
        if (!dirs.includes(name))
        {
            flag(`HTML house row '${name}' has no skills/${name}/ directory`);
        }
    }

    for (const dir of dirs)
    {
        if (!html.house.has(dir))
        {
            flag(`skills/${dir} is missing from the HTML house section`);
        }
    }

    const thirdPartyActive = new Set([...primary.active.keys()].filter(s => primary.active.get(s) !== 'envoydev/claude-stack'));
    const inventory = new Set([...thirdPartyActive, ...primary.commented.keys()]);
    for (const name of thirdPartyActive)
    {
        if (!html.repoSkills.has(name))
        {
            flag(`manifest skill '${name}' is missing from the HTML repository section`);
        }
    }

    for (const name of html.repoSkills)
    {
        if (!inventory.has(name))
        {
            flag(`HTML repository row '${name}' is not in the installer manifests (active or commented)`);
        }
    }

    // 9. Plugins: claude-stack.sh == claude-stack.ps1; every active plugin
    //    appears in the HTML (and vice versa).
    assertSameSet('plugin', { 'claude-stack.sh': pluginsClaudeSh.active, 'claude-stack.ps1': pluginsClaudePs1.active });
    for (const name of pluginsClaudeSh.active)
    {
        if (!html.plugins.has(name))
        {
            flag(`active plugin '${name}' is missing from the HTML inventory`);
        }
    }

    for (const name of html.plugins)
    {
        if (!pluginsClaudeSh.active.has(name) && !pluginsClaudeSh.commented.has(name))
        {
            flag(`HTML references plugin '${name}' which is not in the installer PLUGINS block (active or commented)`);
        }
    }

    // 10. MCPs: both twins agree, and the HTML MCP rows equal the manifest set exactly.
    assertSameSet('MCP', Object.fromEntries(
        Object.entries(mcps).map(([label, m]) => [label, m.active])));
    const mcpsPrimary = mcps['claude-stack.sh'];
    for (const name of mcpsPrimary.active)
    {
        if (!html.mcps.has(name))
        {
            flag(`active MCP '${name}' is missing from the HTML inventory`);
        }
    }

    for (const name of html.mcps)
    {
        if (!mcpsPrimary.active.has(name) && !mcpsPrimary.commented.has(name))
        {
            flag(`HTML lists MCP '${name}' which is not in the installer MCPS block (active or commented)`);
        }
    }

    // 11. Reverse allowlist check: every NON_SKILL_TOKENS entry must actually
    //     appear as a backtick in some scanned surface - a skill file (check 6)
    //     or the base template / a claude rule (check 18), both of which
    //     record matches. A never-matched entry is dead config (e.g. a `dev-log` left
    //     behind after the trigger word stopped being backticked) - prune it.
    for (const token of NON_SKILL_TOKENS)
    {
        if (!matchedNonSkill.has(token))
        {
            flag(`NON_SKILL_TOKENS lists '${token}' but no skill file / template / rule backticks it - dead allowlist entry, remove it`);
        }
    }

    // 12. The active manifest set sizes (and the installer's HOOKS/AGENTS/RULES
    //     arrays) are the single source of truth; the headline counts in the
    //     claude README must equal them so the prose cannot silently drift.
    //     The README spells the count two ways: a table cell ('| 67 |') and an
    //     inline '(67)'. Hook / agent / rule counts come from the installer
    //     array sizes; the Rules count is validated against CLAUDE_RULES.
    const skillCount = primary.active.size;
    const pluginCount = pluginsClaudeSh.active.size;
    const mcpCount = mcpsPrimary.active.size;
    // Count unique hook FILES, not matcher entries - one hook wired on two tools
    // (guard-read-whole-file on Read + Bash) is still one hook.
    const claudeHookCount = new Set(parseStringArray(CLAUDE_SH, '"', 'HOOKS=(').map(n => n.split('::')[0])).size;
    const claudeAgentCount = parseStringArray(CLAUDE_SH, '"', 'AGENTS=(').length;
    const claudeRuleCount = parseStringArray(CLAUDE_SH, '"', 'CLAUDE_RULES=(').length;

    // 12b. Stack hooks in claude-stack.html: the 'Stack hooks' section rows and the
    //      c-hooks count must match the installer HOOKS=() array (names stripped of
    //      their .js, both directions; count tied to the array size - same rigor as
    //      the README hook count above).
    const installerHooks = new Set(parseStringArray(CLAUDE_SH, '"', 'HOOKS=(').map(n => n.split('::')[0].replace(/\.js$/, '')));
    for (const name of installerHooks)
    {
        if (!html.hooks.has(name))
        {
            flag(`active hook '${name}' is missing from the claude-stack.html Stack hooks section`);
        }
    }

    for (const name of html.hooks)
    {
        if (!installerHooks.has(name))
        {
            flag(`claude-stack.html Stack hooks row '${name}' is not in the installer HOOKS block`);
        }
    }

    const htmlHookCount = (fs.readFileSync(STACK_HTML, 'utf8').match(/id="c-hooks">(\d+)</) || [])[1];
    if (htmlHookCount == null)
    {
        flag('claude-stack.html: no c-hooks count element found to verify against the HOOKS array');
    }
    else if (Number(htmlHookCount) !== claudeHookCount)
    {
        flag(`claude-stack.html: c-hooks count is ${htmlHookCount} but the installer holds ${claudeHookCount} hooks`);
    }

    const readmeCount = (file, label, rowLabel) =>
    {
        const text = fs.readFileSync(file, 'utf8');
        // '| **Skills** | 67 |' (table cell) or '| **Skills** (67) |' (inline).
        const m = text.match(new RegExp(`\\*\\*${rowLabel}[^*]*\\*\\*\\s*(?:\\((\\d+)\\)|\\|\\s*(\\d+))`));
        if (!m)
        {
            flag(`${label}: no headline '${rowLabel}' count found to verify against the manifests`);
            return null;
        }

        return Number(m[1] ?? m[2]);
    };

    for (const [rowLabel, expected] of [
        ['Skills', skillCount],
        ['MCP servers', mcpCount],
        ['Plugins', pluginCount],
        ['Hooks', claudeHookCount],
        ['Agents', claudeAgentCount],
        ['Rules', claudeRuleCount],
    ])
    {
        const got = readmeCount(CLAUDE_README, 'README.md', rowLabel);
        if (got !== null && got !== expected)
        {
            flag(`README.md: headline ${rowLabel} count is ${got} but the installer holds ${expected}`);
        }
    }

    // 12b. The on-disk agents/*.md set must equal the agents the installers
    //      fetch (the AGENTS manifest array - both claude shells agree). A drift
    //      means a committed subagent never installs, or the installer fetches an
    //      agent that no longer exists in-repo.
    const agentManifestSh = new Set(parseStringArray(CLAUDE_SH, '"', 'AGENTS=('));
    const agentManifestPs1 = new Set(parseStringArray(CLAUDE_PS1, "'", '$Agents = @('));
    assertSameSet('agent', { 'claude-stack.sh': agentManifestSh, 'claude-stack.ps1': agentManifestPs1 });
    const agentDiskSet = fs.existsSync(AGENTS_DIR)
        ? new Set(fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')))
        : new Set();
    assertSameSet('agent file', { 'agents/': agentDiskSet, 'claude-stack.sh AGENTS': agentManifestSh });

    // 12d. Same parity for the CLAUDE rules: the on-disk rules/*.md set must equal the
    //      CLAUDE_RULES manifest array in BOTH claude shells (both shells agree first, then the
    //      on-disk set equals them). A drift means a committed rule never installs, or the
    //      installer fetches a rule that no longer exists in-repo.
    const ruleManifestSh = new Set(parseStringArray(CLAUDE_SH, '"', 'CLAUDE_RULES=('));
    const ruleManifestPs1 = new Set(parseStringArray(CLAUDE_PS1, "'", '$ClaudeRules = @('));
    assertSameSet('rule', { 'claude-stack.sh': ruleManifestSh, 'claude-stack.ps1': ruleManifestPs1 });
    assertSameSet('rule file', {
        'rules/': new Set(fs.existsSync(CLAUDE_RULES_DIR) ? fs.readdirSync(CLAUDE_RULES_DIR).filter(f => f.endsWith('.md')) : []),
        'claude-stack.sh CLAUDE_RULES': ruleManifestSh,
    });

    // 13. The Claude subagents reference house skills by backticked name (e.g.
    //     `csharp`, `dotnet-testing`). Each backticked hyphenated token must
    //     resolve to a local skill dir or a manifest selector. Tool names
    //     (`Edit`, `Read`) and code identifiers (`fakeAsync`, `setTimeout`) are
    //     single words, not hyphenated, so they are not scanned here.
    if (fs.existsSync(AGENTS_DIR))
    {
        for (const agentFile of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')))
        {
            const text = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf8');
            for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g))
            {
                const token = m[1];
                if (!known.has(token) && !NON_SKILL_TOKENS.has(token))
                {
                    flag(`agents/${agentFile} references skill \`${token}\` - not a local skill dir or a manifest selector`);
                }
            }
        }
    }

    // 13b. Preload claims must match the frontmatter skills: block (see
    //      lintPreloadClaims for the measured regression this guards).
    if (fs.existsSync(AGENTS_DIR))
    {
        const skillDirSet = new Set(dirs);
        for (const agentFile of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')))
        {
            const text = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf8');
            for (const finding of lintPreloadClaims(agentFile, text, skillDirSet))
            {
                flag(finding);
            }
        }
    }

    // 14. House dotnet-* skills are original work, not vendored copies. Guard
    //     against the CONTRADICTORY 'Vendored from <kit>' inventory label
    //     reappearing on a dotnet-* SKILL.md (or its references) or the stack
    //     HTML in a dotnet-* context. Scoped to the false 'vendored from' label
    //     only - an honest 'Adapted from' / third-party notice is NOT blocked, so
    //     a future genuinely-incorporated skill can still carry its MIT credit.
    //     (The ponytail row's vendoring note is unrelated and lives on a
    //     non-dotnet row, so scope the HTML scan to dotnet-* lines.)
    const provenance = /\bvendored from\b/i;
    for (const dir of dirs.filter(d => d.startsWith('dotnet')))
    {
        const files = [path.join(SKILLS_DIR, dir, 'SKILL.md')];
        const refsDir = path.join(SKILLS_DIR, dir, 'references');
        if (fs.existsSync(refsDir))
        {
            files.push(...fs.readdirSync(refsDir).filter(f => f.endsWith('.md')).map(f => path.join(refsDir, f)));
        }

        for (const file of files.filter(fs.existsSync))
        {
            if (provenance.test(fs.readFileSync(file, 'utf8')))
            {
                flag(`${path.relative(ROOT, file)} contains a 'Vendored from' label - house dotnet-* skills are original work, drop the provenance note`);
            }
        }
    }

    for (const line of fs.readFileSync(STACK_HTML, 'utf8').split('\n'))
    {
        if (/dotnet-/.test(line) && provenance.test(line))
        {
            flag(`claude-stack.html has a dotnet-* line with a 'Vendored from' label - house dotnet-* skills are original work`);
        }
    }

    // 15. Soft warning: an OUTLIER-length SKILL.md description. The house style
    //     deliberately packs routing into descriptions (Companions + version floor +
    //     negative scope) so the rich .NET/router skills legitimately run 800-1050;
    //     warning at 800 fired on half the corpus and just flagged the house norm.
    //     The cap is set above that norm to catch a genuinely bloated outlier (the
    //     1300-char case), not the intentional routing prose. Not a failure - a nudge.
    const DESC_SOFT_LIMIT = 1100;
    for (const dir of dirs)
    {
        const skillFile = path.join(SKILLS_DIR, dir, 'SKILL.md');
        if (!fs.existsSync(skillFile))
        {
            continue;
        }

        const fm = fs.readFileSync(skillFile, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!fm)
        {
            continue;
        }

        let meta;
        try
        {
            meta = yaml.load(fm[1]);
        }
        catch
        {
            continue;   // check 1 already flagged the YAML failure
        }

        if (meta && typeof meta.description === 'string' && meta.description.length > DESC_SOFT_LIMIT)
        {
            warn(`skills/${dir}/SKILL.md description is ${meta.description.length} chars (> ${DESC_SOFT_LIMIT}) - consider tightening`);
        }
    }

    // 16. An agent told to invoke the Skill tool must carry 'Skill' in its tools:
    //     allowlist - otherwise it deadlocks on the very convention gate the
    //     instruction exists to satisfy (the exact regression this guards against).
    if (fs.existsSync(AGENTS_DIR))
    {
        for (const agentFile of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')))
        {
            const text = fs.readFileSync(path.join(AGENTS_DIR, agentFile), 'utf8');
            const toolsLine = text.match(/^tools:\s*(.+)$/m);
            const tools = toolsLine ? toolsLine[1].split(',').map(t => t.trim()) : [];
            if (/invoke the Skill tool/i.test(text) && !tools.includes('Skill'))
            {
                flag(`agents/${agentFile} tells the agent to invoke the Skill tool but 'Skill' is not in its tools: allowlist - it would deadlock on the convention gate`);
            }
        }
    }

    // 18. rules/*.md and agents/*.md frontmatter must be strict
    //     YAML - the same failure mode check 1 guards for skills: an unquoted
    //     scalar containing ': ' breaks GitHub rendering AND any strict
    //     frontmatter parser. Rules need a non-empty description (pathless
    //     baseline) or a paths string array (path-scoped). Agents need
    //     name (= filename) plus the house keys: description, model, effort, tools.
    let rulesChecked = 0;
    let agentsChecked = 0;
    for (const target of [
        { dir: path.join(ROOT, 'stack', 'rules'), kind: 'rule' },
        { dir: path.join(ROOT, 'stack', 'agents'), kind: 'agent' },
    ])
    {
        for (const file of fs.readdirSync(target.dir).filter(f => f.endsWith('.md')).sort())
        {
            const rel = `${target.kind === 'rule' ? 'rules' : 'agents'}/${file}`;
            if (target.kind === 'rule') rulesChecked++; else agentsChecked++;
            const fm = fs.readFileSync(path.join(target.dir, file), 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fm)
            {
                flag(`${rel} has no YAML frontmatter block`);
                continue;
            }

            let meta;
            try
            {
                meta = yaml.load(fm[1]);
            }
            catch (err)
            {
                flag(`${rel} frontmatter is not valid YAML: ${err.reason || err.message}`);
                continue;
            }

            if (meta === null || typeof meta !== 'object' || Array.isArray(meta))
            {
                flag(`${rel} frontmatter did not parse to a mapping`);
                continue;
            }

            if (target.kind === 'rule')
            {
                const hasDesc = typeof meta.description === 'string' && meta.description.trim() !== '';
                const hasPaths = Array.isArray(meta.paths) && meta.paths.length > 0 && meta.paths.every(p => typeof p === 'string');
                if (!hasDesc && !hasPaths)
                {
                    flag(`${rel} frontmatter needs a non-empty 'description' (pathless) or a 'paths' string array (path-scoped)`);
                }
            }
            else
            {
                const expected = file.replace(/\.md$/, '');
                if (meta.name !== expected)
                {
                    flag(`${rel} frontmatter name is '${meta.name}', expected '${expected}'`);
                }

                for (const key of ['description', 'model', 'effort', 'tools'])
                {
                    if (typeof meta[key] !== 'string' || meta[key].trim() === '')
                    {
                        flag(`${rel} frontmatter has no non-empty '${key}'`);
                    }
                }
            }
        }
    }

    // 19. The HTML house-skills invocation column must match frontmatter:
    //     every disable-model-invocation skill carries the "manual" row flag,
    //     and no auto-invoked skill claims it.
    for (const name of manualSkills)
    {
        if (!html.houseManual.has(name))
        {
            flag(`claude-stack.html house row for '${name}' misses the "manual" invocation flag (its SKILL.md sets disable-model-invocation)`);
        }
    }

    for (const name of html.houseManual)
    {
        if (!manualSkills.has(name))
        {
            flag(`claude-stack.html marks '${name}' manual but its SKILL.md does not set disable-model-invocation`);
        }
    }

    // 20. The committed dependency graph (meta/stack-graph.json) must match a
    //     fresh build from the current skills/agents/rules/manifests. Lazy-require
    //     avoids a load-time cycle (stack-graph.js requires this module back).
    const stackGraph = require('./stack-graph.js');
    if (stackGraph.readCommitted() !== stackGraph.serialize(stackGraph.buildStackGraph()))
    {
        flag('stack-graph: meta/stack-graph.json is stale - run `node scripts/stack-graph.js --write` and commit it');
    }

    // 21. ONE version everywhere: the plugin manifest (what the marketplace serves from
    //     main) and the marketplace metadata must agree - the release workflow tags each
    //     release v<version> from the plugin manifest, so a mismatch here would ship a
    //     release whose version differs from the marketplace's.
    const pluginManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'setup-plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    const marketplaceManifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const marketplaceVersion = marketplaceManifest.metadata && marketplaceManifest.metadata.version;
    if (!pluginManifest.version)
    {
        flag('setup-plugin/.claude-plugin/plugin.json has no version - the release workflow tags each release from it');
    }
    else if (pluginManifest.version !== marketplaceVersion)
    {
        flag(`version drift: setup-plugin plugin.json '${pluginManifest.version}' vs .claude-plugin/marketplace.json metadata '${marketplaceVersion}' - the plugin, the marketplace, and the release must carry ONE version`);
    }

    // 22. The evidence catalog names only real artifacts, and every regex signal
    //     carries a display label. Rosters: skill dirs; MCPs/plugins from the
    //     installer blocks (active + commented - a commentable entry is still real).
    const evidencePath = path.join(ROOT, 'meta', 'evidence.json');
    let evidenceCatalog = null;
    try
    {
        evidenceCatalog = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    }
    catch (err)
    {
        flag(`meta/evidence.json is unreadable: ${err.message}`);
    }

    if (evidenceCatalog)
    {
        const rosters = {
            skills: new Set(dirs),
            mcps: new Set([...mcpsPrimary.active, ...mcpsPrimary.commented]),
            plugins: new Set([...pluginsClaudeSh.active, ...pluginsClaudeSh.commented]),
        };
        for (const finding of lintEvidenceCatalog(evidenceCatalog, rosters))
        {
            flag(finding);
        }

        // 28. The plugin-settings catalog - rows must name an installed plugin and carry a why.
        const pluginSettingsPath = path.join(ROOT, 'meta', 'plugin-settings.json');
        try
        {
            const pluginSettings = JSON.parse(fs.readFileSync(pluginSettingsPath, 'utf8'));
            for (const finding of lintPluginSettings(pluginSettings, rosters.plugins)) flag(finding);
        }
        catch (err)
        {
            flag(`meta/plugin-settings.json is unreadable: ${err.message}`);
        }

        // 30. Capability sentences in the stack's own source carry their probe.
        try
        {
            const capFiles = [];
            const walk = (dir, rel) =>
            {
                for (const e of fs.readdirSync(dir, { withFileTypes: true }))
                {
                    if (e.name.startsWith('.')) continue;
                    const full = path.join(dir, e.name);
                    const r = `${rel}/${e.name}`;
                    if (e.isDirectory()) walk(full, r);
                    else if (/\.(md|js|sh|ps1)$/.test(e.name)) capFiles.push({ path: r, text: fs.readFileSync(full, 'utf8') });
                }
            };
            for (const d of ['stack/rules', 'stack/hooks', 'scripts/os', 'setup-plugin']) walk(path.join(ROOT, d), d);
            for (const finding of lintCapabilityClaims(capFiles)) flag(finding);
        }
        catch (err)
        {
            flag(`the capability-claim sweep could not run: ${err.message}`);
        }

        // 29. The deliberate-only roster vs the fresh-session hook's ORCHESTRATION list.
        try
        {
            const deliberate = localSkillDirs()
                .filter((d) => /^\s*disable-model-invocation:\s*true\s*$/m.test(fs.readFileSync(path.join(SKILLS_DIR, d, 'SKILL.md'), 'utf8')));
            const hookSrc = fs.readFileSync(path.join(ROOT, 'stack', 'hooks', 'guard-fresh-session-start.js'), 'utf8');
            for (const finding of lintOrchestrationRoster(deliberate, hookSrc)) flag(finding);
        }
        catch (err)
        {
            flag(`the deliberate-only roster check could not run: ${err.message}`);
        }

        // 23. The judgment catalog (meta/judgment.json) - same silent-miss
        //     class: refs must resolve, overlaps carry both gaps, thresholds parse.
        const judgmentPath = path.join(ROOT, 'meta', 'judgment.json');
        let judgmentCatalog = null;
        try
        {
            judgmentCatalog = JSON.parse(fs.readFileSync(judgmentPath, 'utf8'));
        }
        catch (err)
        {
            flag(`meta/judgment.json is unreadable: ${err.message}`);
        }

        if (judgmentCatalog)
        {
            const agentNames = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''));
            for (const finding of lintJudgmentCatalog(judgmentCatalog, { ...rosters, agents: new Set(agentNames) }))
            {
                flag(finding);
            }
        }
    }

    // 24. The shared-rules registry (meta/shared-rules.json) - the sanctioned multi-home
    //     rules. Any copy edited without its marker (and its sibling copies) updated fails
    //     here, so the multi-home sync is mechanical, not remembered.
    const sharedRulesPath = path.join(ROOT, 'meta', 'shared-rules.json');
    let sharedRules = null;
    try
    {
        sharedRules = JSON.parse(fs.readFileSync(sharedRulesPath, 'utf8'));
    }
    catch (err)
    {
        flag(`meta/shared-rules.json is unreadable: ${err.message}`);
    }

    // 27. The environment catalog (meta/environment.json) against what the installers actually
    //     seed - both directions, both twins - plus the rename targets migrations.json names.
    //     (25 and 26 are the optional-cite checks CLAUDE.md names by number - do not renumber those.)
    try
    {
        const envCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'environment.json'), 'utf8'));
        const shSrc = fs.readFileSync(CLAUDE_SH, 'utf8');
        const ps1Src = fs.readFileSync(CLAUDE_PS1, 'utf8');
        let migrationsCatalog = null;
        try { migrationsCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'migrations.json'), 'utf8')); }
        catch { /* its own lint reports an unreadable migrations.json */ }
        const commandSrc = {};
        for (const cmd of ['setup.md', 'configure.md', 'validate.md'])
        {
            commandSrc[`commands/${cmd}`] = fs.readFileSync(path.join(ROOT, 'setup-plugin', 'commands', cmd), 'utf8');
        }
        for (const finding of lintEnvironmentCatalog(envCatalog, shSrc, ps1Src, migrationsCatalog, commandSrc))
        {
            flag(finding);
        }
    }
    catch (err)
    {
        flag(`meta/environment.json is unreadable: ${err.message}`);
    }

    let sharedRuleCount = 0;
    let sharedRuleCopies = 0;
    if (sharedRules)
    {
        sharedRuleCount = Object.keys(sharedRules.rules || {}).length;
        sharedRuleCopies = Object.values(sharedRules.rules || {}).reduce((n, r) => n + (r.owner ? 1 : 0) + (r.sites || []).length, 0);
        for (const finding of lintSharedRules(sharedRules, f => fs.readFileSync(path.join(ROOT, f), 'utf8')))
        {
            flag(finding);
        }
    }

    // 25. Cross-skill LOAD directives must not name a skill the install can lack.
    //     Optional skills (not reachable from any seed closure - evidence-gated or
    //     opt-in only) are absent in most projects, so an unguarded 'load `x`' makes
    //     the model call a skill that is not there and take an 'Unknown skill' error.
    try
    {
        const recs = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'recommendations.json'), 'utf8'));
        const graph = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta', 'stack-graph.json'), 'utf8'));
        const skillDirs = new Set(dirs);
        const optional = optionalSkills(recs, graph, skillDirs);
        const closures = seedClosures(recs, graph);
        // each scanned file with the artifact that OWNS it, so check 26 can ask which stacks
        // ship it: a skill's references belong to the skill, an agent/rule to itself.
        const scanned = [];
        for (const dir of dirs)
        {
            const skillFile = path.join(SKILLS_DIR, dir, 'SKILL.md');
            if (fs.existsSync(skillFile)) scanned.push([`skills/${dir}/SKILL.md`, skillFile, 'skills', dir]);
            const refDir = path.join(SKILLS_DIR, dir, 'references');
            if (fs.existsSync(refDir))
            {
                for (const f of fs.readdirSync(refDir).filter(f => f.endsWith('.md')))
                {
                    scanned.push([`skills/${dir}/references/${f}`, path.join(refDir, f), 'skills', dir]);
                }
            }
        }

        if (fs.existsSync(AGENTS_DIR))
        {
            for (const f of fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')))
            {
                scanned.push([`agents/${f}`, path.join(AGENTS_DIR, f), 'agents', f.replace(/\.md$/, '')]);
            }
        }

        if (fs.existsSync(CLAUDE_RULES_DIR))
        {
            for (const f of fs.readdirSync(CLAUDE_RULES_DIR).filter(f => f.endsWith('.md')))
            {
                scanned.push([`rules/${f}`, path.join(CLAUDE_RULES_DIR, f), 'rules', f.replace(/\.md$/, '')]);
            }
        }

        scanned.push(['CLAUDE.template.md', CLAUDE_TEMPLATE, null, null]);

        for (const [label, file, kind, owner] of scanned)
        {
            const text = fs.readFileSync(file, 'utf8');
            for (const finding of lintOptionalCites(label, text, optional)) flag(finding);

            // 27. No install edge from a name: the removed `suggests:` frontmatter must not return.
            for (const finding of lintSuggestionEdges(label, text)) flag(finding);

            // 26. Cross-stack coupling: a load directive naming a skill that is absent from at
            //     least one stack the CITING artifact itself ships into. Check 25 is the special
            //     case where the skill reaches no stack at all; this is the one that bit in
            //     practice - a cross-cutting agent installed in every project naming
            //     `angular-security`, which a .NET-only install never has.
            if (!kind) continue;
            const absent = absentSkillsFor(closures, kind, owner, skillDirs);
            for (const s of absent) if (optional.has(s)) absent.delete(s);   // already reported above
            for (const finding of lintOptionalCites(label, text, absent))
            {
                flag(finding.replace(/ BY NAME[\s\S]*$/,
                    ` BY NAME, and it is absent in ${[...hostStacks(closures, kind, owner)].filter(t => !closures[t].skills.has(finding.match(/`([a-z0-9-]+)`/)[1])).join(', ')}, `
                    + `where this ${kind === 'skills' ? 'skill' : kind.replace(/s$/, '')} is still installed. Describe what the skill `
                    + `covers instead of naming it, so it is matched from the installed inventory`));
            }
        }
    }
    catch (err)
    {
        flag(`optional-cite check could not run: ${err.message}`);
    }

    if (warnings.length > 0)
    {
        for (const warning of warnings)
        {
            console.error(`WARN: ${warning}`);
        }

        console.error('');
    }

    if (findings.length > 0)
    {
        for (const finding of findings)
        {
            console.error(`LINT: ${finding}`);
        }

        console.error(`\n${findings.length} finding(s).`);
        process.exit(1);
    }

    console.log(`lint-skills: clean (${dirs.length} skills, ${primary.active.size} active manifest entries, `
        + `${pluginsClaudeSh.active.size} plugins, ${mcpsPrimary.active.size} MCPs; both manifests + HTML in sync; `
        + `${rulesChecked} rules + ${agentsChecked} agents frontmatter-clean; `
        + `${sharedRuleCount} shared rule(s), ${sharedRuleCopies} copies in sync).`);
}

// The environment catalog (meta/environment.json) is the ONE list the three guided commands read
// for the settings.json `env` block - and the installers are what actually seed it. A key in the
// catalog that no installer seeds is a promise the walk cannot keep; a key an installer seeds that
// the catalog omits is invisible to setup, configure and validate. Both directions fail here, per
// twin, so the drift cannot ship.
function lintEnvironmentCatalog(catalog, shSrc, ps1Src, migrations, commandSrc)
{
    const out = [];
    // The three guided commands must READ the catalog, not a list typed into their prose - that is
    // the whole point of having one: a variable a release adds is asked about, shown and reconciled
    // without touching three command files.
    for (const [name, src] of Object.entries(commandSrc || {}))
    {
        if (!src.includes('meta/environment.json'))
        {
            out.push(`${name} does not read meta/environment.json - its environment step would go stale the next time a variable is added`);
        }
    }
    const rows = Array.isArray(catalog.env) ? catalog.env : null;
    if (!rows)
    {
        return ['environment.json has no `env` array - the guided commands would read an empty environment layer'];
    }

    const seededSh = new Set([...shSrc.matchAll(/env\["(CLAUDE_[A-Z0-9_]+)"\]\s*=/g)].map(m => m[1]));
    const seededPs1 = new Set([...ps1Src.matchAll(/Add-Member -NotePropertyName (CLAUDE_[A-Z0-9_]+)/g)].map(m => m[1]));
    const keys = new Set();
    for (const row of rows)
    {
        if (!row.key) { out.push('environment.json has a row with no `key`'); continue; }
        if (keys.has(row.key)) { out.push(`environment.json lists ${row.key} twice`); }
        keys.add(row.key);
        if (typeof row.default !== 'string') { out.push(`environment.json ${row.key} has no string \`default\` - the seed value and the walk's shown default come from it`); }
        if (!row.what) { out.push(`environment.json ${row.key} has no \`what\` - the walks print it, so a row without one cannot be asked about`); }
        if (!seededSh.has(row.key)) { out.push(`environment.json ${row.key} is not seeded by claude-stack.sh - the catalog promises a key no install writes`); }
        if (!seededPs1.has(row.key)) { out.push(`environment.json ${row.key} is not seeded by claude-stack.ps1 - the twins must seed the same set`); }
    }
    for (const key of seededSh)
    {
        if (!keys.has(key)) { out.push(`claude-stack.sh seeds ${key}, which environment.json does not list - setup/configure/validate would never show it`); }
    }
    for (const key of seededPs1)
    {
        if (!keys.has(key)) { out.push(`claude-stack.ps1 seeds ${key}, which environment.json does not list - setup/configure/validate would never show it`); }
    }
    // setup asks the `ask: true` rows on ONE AskUserQuestion screen, and the tool caps a call at four
    // questions; a row with `asked_with` rides along with another row's question. Past four, the
    // fifth question is silently dropped by the tool - so the cap is enforced here, at authoring time.
    const asked = rows.filter(r => r.ask && !r.asked_with).length;
    if (asked > 4) { out.push(`environment.json asks ${asked} questions on setup's environment screen - the AskUserQuestion cap is 4; fold one row into another with asked_with, or stop asking it`); }
    // A rename in migrations.json must land on a key the catalog owns, or validate would offer to
    // migrate a value into a variable nothing reads.
    for (const m of (migrations && migrations.migrations) || [])
    {
        const r = m.rename_settings_env;
        if (!r) { continue; }
        if (!keys.has(r.to)) { out.push(`migrations.json '${m.id}' renames ${r.from} to ${r.to}, which environment.json does not list`); }
        const row = rows.find(x => x.key === r.to);
        if (row && row.renamed_from !== r.from) { out.push(`environment.json ${r.to} does not record renamed_from '${r.from}' - validate reads it to spot the old spelling on disk`); }
    }

    return out;
}

module.exports = {
    paths: { ROOT, SKILLS_DIR, CLAUDE_SH, CLAUDE_PS1, AGENTS_DIR, CLAUDE_RULES_DIR },
    parseManifest,
    parseStringArray,
    parseFlatBlock,
    localSkillDirs,
    lintEvidenceCatalog,
    lintPluginSettings,
    lintOrchestrationRoster,
    lintCapabilityClaims,
    lintJudgmentCatalog,
    lintEnvironmentCatalog,
    lintSharedRules,
    lintPreloadClaims,
    lintOptionalCites,
    optionalSkills,
    lintSuggestionEdges,
    seedClosures,
    hostStacks,
    absentSkillsFor,
    NON_SKILL_TOKENS,
};

if (require.main === module)
{
    main();
}
