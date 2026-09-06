#!/usr/bin/env node
// Build the stack dependency graph (meta/stack-graph.json) from the same
// sources the lint reads. Edges are directional and skills never pull skills:
//   agent  -> skill (declared skills: frontmatter, else body backtick mentions)
//   rule   -> skill / agent (body backtick mentions) + paths from frontmatter
//   skill/agent/rule -> mcp / plugin (body backtick mentions)
// Mentions are BACKTICKED tokens only (the same reliable signal the lint uses),
// so prose words like the English 'memory' never create a false edge.
'use strict';
const fs = require('fs');
// --- CRLF normalization, once, at the boundary --------------------------------------------------
// A Windows checkout has CRLF line endings (git's autocrlf converts on the way out), and JS treats
// `\r` as a LINE TERMINATOR: `.` does not match it. So a pattern ending `(#.*)?$` fails on every
// commented line, and the installer parity check reported the ENTIRE MCP block missing from the
// .ps1 twin - eight false findings, on a repo where the twins were in perfect sync. Text read here
// is never sensitive to which bytes end a line, so normalize every utf8 read and let every regex
// below stay written for `\n`.
const _readFileSync = fs.readFileSync;
fs.readFileSync = (p, o) => ((o === 'utf8' || (o && o.encoding === 'utf8'))
    ? String(_readFileSync(p, o)).replace(/\r\n/g, '\n')
    : _readFileSync(p, o));

const path = require('path');
const yaml = require('js-yaml');
const lint = require('./lint-skills.js');

const { ROOT, SKILLS_DIR, AGENTS_DIR, CLAUDE_RULES_DIR, CLAUDE_SH } = lint.paths;
const GRAPH_FILE = path.join(ROOT, 'meta', 'stack-graph.json');

function frontmatterBlock(text)
{
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return m ? m[1] : null;
}

function bodyAfterFrontmatter(text)
{
    const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    return m ? m[1] : text;
}

// Every distinct backticked token in the text (content between a pair of
// backticks, trimmed). Catalog membership - not a shape regex - decides what is
// an edge, so single-word MCPs (`serena`, `context7`) resolve as well as
// hyphenated ones (`angular-cli`). Tokenized LINE BY LINE - a markdown inline-code
// span never crosses a line, so scanning each line independently prevents a stray
// or odd backtick count (including a ```` ```bash ```` fence line) from desyncing
// the open/close pairing into later lines.
function backtickedTokens(text)
{
    const tokens = new Set();
    for (const line of text.split(/\r?\n/))
    {
        for (const m of line.matchAll(/`([^`]+)`/g)) tokens.add(m[1].trim());
    }

    return tokens;
}

// Resolve the owning plugin for a token: either the token itself is a plugin
// catalog name, or its colon prefix (`plugin:skill` namespacing) is.
function pluginFromToken(token, plugins)
{
    if (plugins.has(token)) return token;
    const i = token.indexOf(':');
    if (i === -1) return null;
    const prefix = token.slice(0, i);
    return plugins.has(prefix) ? prefix : null;
}

function catalogs()
{
    const skills = new Set(lint.localSkillDirs());
    const agents = new Set(fs.existsSync(AGENTS_DIR)
        ? fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md')).map(f => f.replace(/\.md$/, ''))
        : []);
    const mcpBlock = lint.parseFlatBlock(CLAUDE_SH, '"', 'MCPS=(', '|');
    const pluginBlock = lint.parseFlatBlock(CLAUDE_SH, '"', 'PLUGINS=(', '@');
    const mcps = new Set([...mcpBlock.active, ...mcpBlock.commented]);
    const plugins = new Set([...pluginBlock.active, ...pluginBlock.commented]);
    return { skills, agents, mcps, plugins, hooks: hookCatalog() };
}

// The hook catalog: the HOOKS=( ... ) block in the sh installer - entries are
// "filename.js::matcher::args" - as basenames sans .js. Hooks are leaf picks in
// the selection (nothing pulls them, they pull nothing), so they only need to
// exist in the catalog for the guided walk's hooks layer and the unknown check.
function hookCatalog()
{
    const m = fs.readFileSync(CLAUDE_SH, 'utf8').match(/^HOOKS=\(\n([\s\S]*?)^\)/m);
    const hooks = [];
    for (const line of (m ? m[1] : '').split('\n'))
    {
        const e = line.match(/^\s*"([^:"]+)\.js::/);
        if (e) hooks.push(e[1]);
    }

    // dedupe: one hook wired on two tools (two matcher entries) is still one catalog hook
    return [...new Set(hooks)].sort();
}

// Skills whose backticked MCP/plugin mentions are SUBJECT MATTER, not dependencies.
// project-agent-capabilities documents the house routing map for every server so the
// generated rule can be stamped from it - selecting it must never lock the whole MCP
// baseline into an install (the skill inventories what IS installed; it calls nothing).
const DOC_MENTION_SKILLS = new Set(['project-agent-capabilities']);

// Rule body mentions that are NOT dependencies: conditional loads ('in an Ionic
// workspace also load `ionic`') and routing-away prose ('EF logic routes through
// `csharp` instead'). A rule's hard skill edges are the skills it exists to attach;
// these mentions describe when to reach elsewhere, so promoting them blocks valid
// selections (a plain Angular install must not require the ionic skill).
const RULE_MENTION_EXCLUDES = {
    'angular-conventions': new Set(['ionic']),
    'sql-conventions': new Set(['csharp', 'dotnet-data-access']),
    // the dependency is one-way by design: typescript stacks on javascript, never the
    // reverse - a plain-JS install must not be forced to carry the type layer
    'javascript-conventions': new Set(['typescript']),
};

function categorize(tokens, cat)
{
    const pick = set => [...tokens].filter(t => set.has(t)).sort();
    const plugins = new Set();
    for (const t of tokens)
    {
        const p = pluginFromToken(t, cat.plugins);
        if (p) plugins.add(p);
    }

    return { skills: pick(cat.skills), agents: pick(cat.agents), mcps: pick(cat.mcps), plugins: [...plugins].sort() };
}

function skillFiles(name)
{
    const files = [path.join(SKILLS_DIR, name, 'SKILL.md')];
    const refs = path.join(SKILLS_DIR, name, 'references');
    if (fs.existsSync(refs))
    {
        files.push(...fs.readdirSync(refs).filter(f => f.endsWith('.md')).map(f => path.join(refs, f)));
    }

    return files.filter(fs.existsSync);
}

function buildStackGraph()
{
    const cat = catalogs();
    const graph = {
        generatedBy: 'stack-graph',
        skills: {},
        agents: {},
        rules: {},
        catalog: { mcps: [...cat.mcps].sort(), plugins: [...cat.plugins].sort(), hooks: cat.hooks },
    };

    for (const name of [...cat.skills].sort())
    {
        const tokens = new Set();
        for (const f of skillFiles(name))
        {
            for (const t of backtickedTokens(fs.readFileSync(f, 'utf8'))) tokens.add(t);
        }

        const c = categorize(tokens, cat);
        graph.skills[name] = DOC_MENTION_SKILLS.has(name) ? { mcps: [], plugins: [] } : { mcps: c.mcps, plugins: c.plugins };
    }

    for (const name of [...cat.agents].sort())
    {
        const text = fs.readFileSync(path.join(AGENTS_DIR, name + '.md'), 'utf8');
        const fmText = frontmatterBlock(text);
        let declared = [];
        let source = 'none';
        const fmPlugins = new Set();
        if (fmText)
        {
            let meta = null;
            try { meta = yaml.load(fmText); } catch { meta = null; }
            if (meta && Array.isArray(meta.skills))
            {
                declared = meta.skills.filter(s => cat.skills.has(s));
                source = 'frontmatter';
                for (const s of meta.skills)
                {
                    const p = pluginFromToken(s, cat.plugins);
                    if (p) fmPlugins.add(p);
                }
            }
        }

        const c = categorize(backtickedTokens(bodyAfterFrontmatter(text)), cat);
        const plugins = [...new Set([...fmPlugins, ...c.plugins])].sort();
        // A skill mentioned only in the BODY is a conditional load ('load X when the failure
        // touches Y') - an OPTION, not a requirement. Hard skill edges come solely from the
        // declared frontmatter skills (a preload must exist on disk), and an OPTION produces
        // NO edge at all: an agent must never put a skill into a project's install because its
        // own prose or frontmatter names one. That was the `suggests:` mechanism, removed - it
        // shipped `dotnet-aspire` to a devops project with no Aspire in it and `angular-security`
        // to a WinForms one. What a project actually uses is proven by meta/evidence.json against
        // the project's own manifests; what its stack always needs is a recommendations.json seed.
        if (source !== 'frontmatter' && c.skills.length) source = 'body';
        const skills = source === 'frontmatter' ? declared : [];

        graph.agents[name] = {
            skills: [...skills].sort(),
            skillsSource: source,
            agents: c.agents.filter(a => a !== name),
            mcps: c.mcps,
            plugins,
        };
    }

    if (fs.existsSync(CLAUDE_RULES_DIR))
    {
        for (const file of fs.readdirSync(CLAUDE_RULES_DIR).filter(f => f.endsWith('.md')).sort())
        {
            const name = file.replace(/\.md$/, '');
            const text = fs.readFileSync(path.join(CLAUDE_RULES_DIR, file), 'utf8');
            const fmText = frontmatterBlock(text);
            let paths = [];
            if (fmText)
            {
                try
                {
                    const meta = yaml.load(fmText);
                    if (meta && Array.isArray(meta.paths)) paths = meta.paths;
                }
                catch { /* check 18 in the lint already flags bad rule YAML */ }
            }

            const c = categorize(backtickedTokens(bodyAfterFrontmatter(text)), cat);
            const excl = RULE_MENTION_EXCLUDES[name];
            const skills = excl ? c.skills.filter(t => !excl.has(t)) : c.skills;
            graph.rules[name] = { skills, agents: c.agents, mcps: c.mcps, plugins: c.plugins, paths };
        }
    }

    return graph;
}

function serialize(graph)
{
    return JSON.stringify(graph, null, 2) + '\n';
}

function readCommitted()
{
    return fs.existsSync(GRAPH_FILE) ? fs.readFileSync(GRAPH_FILE, 'utf8') : null;
}

module.exports = { buildStackGraph, serialize, GRAPH_FILE, readCommitted };

if (require.main === module)
{
    const out = serialize(buildStackGraph());
    if (process.argv.includes('--write'))
    {
        fs.writeFileSync(GRAPH_FILE, out);
        console.log(`stack-graph: wrote ${path.relative(ROOT, GRAPH_FILE)}`);
    }
    else if (readCommitted() !== out)
    {
        console.error('stack-graph: committed meta/stack-graph.json is stale - run `node scripts/stack-graph.js --write`');
        process.exit(1);
    }
    else
    {
        console.log('stack-graph: committed graph is in sync.');
    }
}
