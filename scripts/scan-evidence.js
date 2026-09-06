#!/usr/bin/env node
// Deterministic evidence scan (Component A of the evidence layer): read the project's
// package manifests and catalog-named files, match them against the signal definitions in
// meta/evidence.json, and emit the `found` map the selection engine and
// the guided commands consume. Text over checked-in files only - no restore, no network.
// The conclusions are computed per run; the catalog ships only signal DEFINITIONS.
'use strict';
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'out', '.serena', '.claude']);
const MAX_DEPTH = 6;
const MAX_CONTENT_BYTES = 512 * 1024;
const LAYERS = ['skills', 'mcps', 'plugins'];

function walk(root)
{
    const files = [];
    (function rec(dir, depth)
    {
        if (depth > MAX_DEPTH) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries)
        {
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) rec(path.join(dir, e.name), depth + 1); }
            else files.push(path.join(dir, e.name));
        }
    })(root, 0);
    return files.sort();
}

function readCapped(file)
{
    try
    {
        if (fs.statSync(file).size > MAX_CONTENT_BYTES) return null;
        return fs.readFileSync(file, 'utf8');
    }
    catch { return null; }
}

// A trailing '.' (NuGet namespace) or '/' (npm scope) marks a prefix; anything else is exact.
function matchesPackage(signal, pkg)
{
    return signal.endsWith('.') || signal.endsWith('/') ? pkg.startsWith(signal) : pkg === signal;
}

// Basename glob with '*' only (the catalog's file/content globs are basename patterns).
function basenameMatches(glob, file)
{
    const pattern = glob.replace(/^\*\*\//, '');
    const re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(path.basename(file));
}

function isDotnetManifest(file)
{
    const base = path.basename(file);
    return base.endsWith('.csproj') || base === 'Directory.Build.props' || base === 'Directory.Packages.props';
}

// Ordered [{pkg, rel}] across every manifest - first catalog match wins, so order is stable.
// A repo-relative path that goes into REPORTED text is written with forward slashes on every
// platform. `path.relative` hands back the native separator, so on Windows the same project
// produced `src\\Api\\Api.csproj` where every other machine produced `src/Api/Api.csproj` - the
// evidence reason the guided walk shows the user, and the string a selection is attributed by.
// The separator is presentation here, never a lookup: nothing reads these back as a path.
const relPosix = (root, file) => path.relative(root, file).split(path.sep).join('/');

function collectPackages(root, files)
{
    const out = [];
    for (const file of files)
    {
        const rel = relPosix(root, file);
        if (isDotnetManifest(file))
        {
            const text = readCapped(file);
            if (text === null) continue;
            // PackageReference ONLY - under central package management a Directory.Packages.props
            // <PackageVersion> pin can exist for a package no project references, so a pin alone
            // is never usage; the version-less CPM PackageReference carries the name.
            for (const t of text.matchAll(/<PackageReference\b[^>]*>/g))
            {
                const inc = /Include="([^"]+)"/.exec(t[0]);
                if (!inc) continue;
                const ver = /Version="([^"]+)"/.exec(t[0]);
                out.push({ pkg: inc[1], rel, version: ver ? ver[1] : undefined });
            }
        }
        else if (path.basename(file) === 'package.json')
        {
            const text = readCapped(file);
            if (text === null) continue;
            let json;
            try { json = JSON.parse(text); }
            catch { continue; }
            for (const section of ['dependencies', 'devDependencies'])
            {
                for (const [pkg, version] of Object.entries(json[section] || {})) out.push({ pkg, rel, version });
            }
        }
    }
    return out;
}

// A catalog regex that does not compile must not take the whole scan down with a stack trace (the
// lint checks names and labels, not regex syntax): name it on stderr and skip that one signal.
function safeRegex(source, where)
{
    try { return new RegExp(source); }
    catch (e) { console.error(`scan-evidence: skipping ${where} - invalid regex /${source}/ (${e.message})`); return null; }
}

function scan(root, catalog)
{
    const files = walk(root);
    const packages = collectPackages(root, files);
    const dotnetManifests = files.filter(isDotnetManifest);

    const found = { skills: {}, mcps: {}, plugins: {} };
    for (const layer of LAYERS)
    {
        for (const [name, entry] of Object.entries(catalog[layer] || {}))
        {
            let hit = null;
            for (const signal of entry.packages || [])
            {
                const p = packages.find(x => matchesPackage(signal, x.pkg));
                if (p) { hit = `${p.pkg} in ${p.rel}`; break; }
            }
            if (!hit) for (const glob of entry.files || [])
            {
                const f = files.find(x => basenameMatches(glob, x));
                if (f) { hit = `${relPosix(root, f)} present`; break; }
            }
            if (!hit) for (const c of entry.csprojContent || [])
            {
                const re = safeRegex(c.regex, `${layer} ${name} csprojContent`);
                if (!re) continue;
                const f = dotnetManifests.find(x => { const t = readCapped(x); return t !== null && re.test(t); });
                if (f) { hit = `${c.label || c.regex} in ${relPosix(root, f)}`; break; }
            }
            if (!hit) for (const c of entry.content || [])
            {
                const re = safeRegex(c.regex, `${layer} ${name} content`);
                if (!re) continue;
                const f = files.find(x => basenameMatches(c.glob, x) && (t => t !== null && re.test(t))(readCapped(x)));
                if (f) { hit = `${c.label || c.regex} in ${relPosix(root, f)}`; break; }
            }
            if (hit) found[layer][name] = hit;
        }
    }
    return found;
}

// First integer in a version string ('^16.2.0' -> 16); null when none is parseable.
function majorOf(version)
{
    const m = /\d+/.exec(String(version || ''));
    return m ? parseInt(m[0], 10) : null;
}

// Component of the judgment catalog the scan can decide deterministically: an item whose
// guidance targets a newer major than the project runs. No version found = no claim.
function findVersionConflicts(root, judgment)
{
    const packages = collectPackages(root, walk(root));
    const out = [];
    for (const c of judgment.versionConflicts || [])
    {
        const p = packages.find(x => x.pkg === c.package && majorOf(x.version) !== null);
        if (p && majorOf(p.version) < parseInt(c.below, 10))
        {
            out.push({ item: c.item, package: c.package, version: p.version, below: c.below, conflict: c.conflict, survives: c.survives, rel: p.rel });
        }
    }
    return out;
}

function main(argv)
{
    const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
    const root = arg('--root');
    const catalogPath = arg('--catalog');
    if (!root || !catalogPath) { console.error('usage: scan-evidence.js --root <project> --catalog <evidence.json> [--out <file>]'); process.exit(2); }
    let catalog;
    try { catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); }
    catch (e) { console.error(`scan-evidence: cannot read catalog ${catalogPath}: ${e.code || e.message}`); process.exit(1); }
    if (!fs.existsSync(root)) { console.error(`scan-evidence: no such root ${root}`); process.exit(1); }

    const payload = { found: scan(root, catalog) };
    const judgmentPath = arg('--judgment');
    if (judgmentPath)
    {
        let judgment;
        try { judgment = JSON.parse(fs.readFileSync(judgmentPath, 'utf8')); }
        catch (e) { console.error(`scan-evidence: cannot read judgment catalog ${judgmentPath}: ${e.code || e.message}`); process.exit(1); }
        payload.judgment = { versionConflicts: findVersionConflicts(root, judgment) };
    }

    const result = JSON.stringify(payload, null, 2);
    const out = arg('--out');
    if (out) fs.writeFileSync(out, result);
    else process.stdout.write(result + '\n');
}

module.exports = { scan, matchesPackage, basenameMatches, majorOf, findVersionConflicts };

if (require.main === module) main(process.argv.slice(2));
