'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildStackGraph } = require('./stack-graph.js');

const graph = buildStackGraph();

test('agent skill edges come from the declared skills: frontmatter', () => {
    const a = graph.agents['aspnet-solution-designer'];
    assert.ok(a, 'aspnet-solution-designer must be in the graph');
    assert.strictEqual(a.skillsSource, 'frontmatter');
    for (const s of ['dotnet', 'dotnet-web-backend', 'dotnet-testing', 'project-solution-design'])
    {
        assert.ok(a.skills.includes(s), `expected agent->skill edge to ${s}`);
    }
});

test('rule skill edges resolve from the rule body', () => {
    const r = graph.rules['csharp-conventions'];
    assert.ok(r, 'csharp-conventions must be in the graph');
    assert.ok(r.skills.includes('csharp'), 'csharp-conventions -> csharp');
    assert.deepStrictEqual(r.paths, ['**/*.cs']);
});

test('body-mentioned skills are no edge at all - naming a skill never reaches an install', () => {
    const r = graph.agents['dotnet-build-error-resolver'];
    assert.strictEqual(r.skillsSource, 'body');
    assert.deepStrictEqual(r.skills, [], 'no skills: frontmatter -> no hard skill edges');
    // the removed `suggests:` mechanism: it put dotnet-aspire on a project with no Aspire
    assert.strictEqual(r.suggests, undefined, 'no suggestion edge is emitted');
    assert.strictEqual(graph.agents['data-implementer'].suggests, undefined, 'not for the data seat either');
    for (const node of Object.values(graph.agents)) assert.ok(!('suggests' in node), 'no agent node carries suggests');
});

test('every edge target exists in a catalog (no dangling references)', () => {
    const skills = new Set(Object.keys(graph.skills));
    const agents = new Set(Object.keys(graph.agents));
    const mcps = new Set(graph.catalog.mcps);
    const plugins = new Set(graph.catalog.plugins);
    for (const [name, node] of Object.entries(graph.agents))
    {
        for (const s of node.skills) assert.ok(skills.has(s), `${name} -> unknown skill ${s}`);
        for (const a of node.agents) assert.ok(agents.has(a), `${name} -> unknown agent ${a}`);
        for (const m of node.mcps) assert.ok(mcps.has(m), `${name} -> unknown mcp ${m}`);
        for (const p of node.plugins) assert.ok(plugins.has(p), `${name} -> unknown plugin ${p}`);
    }
});

test('an agent never lists itself as an agent edge', () => {
    for (const [name, node] of Object.entries(graph.agents))
    {
        assert.ok(!node.agents.includes(name), `${name} lists itself`);
    }
});

const { serialize, readCommitted } = require('./stack-graph.js');

test('the committed stack-graph.json is in sync with a fresh build', () => {
    assert.strictEqual(readCommitted(), serialize(buildStackGraph()),
        'run `node scripts/stack-graph.js --write` and commit the result');
});

test('project-agent-capabilities documents every MCP without pulling a single edge (doc-mention exception)', () => {
    // Its body backticks all 8 servers as the routing map it stamps into the generated
    // rule - treating those as dependencies used to lock the whole MCP baseline into any
    // install that picked it. The graph builder strips the edges for doc-mention skills.
    const s = graph.skills['project-agent-capabilities'];
    assert.ok(s, 'project-agent-capabilities must be in the graph');
    assert.deepStrictEqual(s.mcps, [], 'no skill->mcp edges - the mentions are subject matter, not needs');
    assert.deepStrictEqual(s.plugins, [], 'no skill->plugin edges either');
});

test('the hook catalog carries the installer HOOKS block basenames', () => {
    assert.deepStrictEqual(graph.catalog.hooks,
        ['guard-answer-length', 'guard-catastrophic-rm', 'guard-cross-project-write', 'guard-fresh-session-start', 'guard-protected-force-push', 'guard-read-whole-file', 'guard-secret-value', 'guard-stop-contract', 'guard-unapproved-dispatch', 'guard-ungated-commit', 'instrument-tool-usage'],
        'catalog.hooks mirrors HOOKS=( ... ) sans .js, sorted');
});

test('ci-failure-diagnoser plugins edge resolves from a namespaced plugin:skill frontmatter entry', () => {
    const a = graph.agents['ci-failure-diagnoser'];
    assert.ok(a, 'ci-failure-diagnoser must be in the graph');
    assert.ok(a.plugins.includes('superpowers'), 'expected agent->plugin edge to superpowers');
});
