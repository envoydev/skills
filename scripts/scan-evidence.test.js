'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'scan-evidence.js');
const CATALOG = path.join(__dirname, '..', 'meta', 'evidence.json');

// One fixture tree exercising every signal kind, the skip-list, and the depth cap.
function buildFixture()
{
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evscan-'));
    const put = (rel, text) =>
    {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
    };
    put('src/Api/Api.csproj', `<Project Sdk="Microsoft.NET.Sdk.Web">
  <ItemGroup>
    <PackageReference Include="MassTransit" Version="8.0.0" />
    <PackageReference Include="Swashbuckle.AspNetCore" Version="6.5.0" />
  </ItemGroup>
</Project>`);
    put('Directory.Packages.props', `<Project>
  <ItemGroup>
    <PackageVersion Include="Npgsql" Version="8.0.0" />
    <PackageVersion Include="Aspire.Hosting" Version="9.0.0" />
  </ItemGroup>
</Project>`);
    // CPM: the version-less PackageReference is the usage signal the central pin corroborates
    put('src/Worker/Worker.csproj', `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Npgsql" />
  </ItemGroup>
</Project>`);
    put('src/Gen/Gen.csproj', `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><IsRoslynComponent>true</IsRoslynComponent></PropertyGroup>
</Project>`);
    put('web/package.json', JSON.stringify({ dependencies: { '@angular/material': '^17.0.0', '@angular/core': '^16.2.0' }, devDependencies: { '@sentry/angular': '^7.0.0' } }));
    put('nx.json', '{}');
    // content signal: a regex over a catalog-named code file (not a manifest)
    put('src/Api/Program.cs', 'app.MapGet("/health", () => "ok");\n');
    // brownfield view controller - no [ApiController], the base class is the signal
    put('src/Web/HomeController.cs', 'public class HomeController : Controller\n{\n}\n');
    // clean-architecture layer naming - a file-existence signal
    put('src/Shop.Domain/Shop.Domain.csproj', '<Project Sdk="Microsoft.NET.Sdk"></Project>');
    // skip-list: a signal that exists ONLY under node_modules must not be found
    put('node_modules/somepkg/somepkg.csproj', '<PackageReference Include="BenchmarkDotNet" Version="0.13.0" />');
    // depth cap: a manifest buried deeper than the cap must not be found
    put('a/b/c/d/e/f/g/Deep.csproj', '<PackageReference Include="Grpc.AspNetCore" Version="2.60.0" />');
    return root;
}

function scan(root)
{
    const out = execFileSync('node', [SCRIPT, '--root', root, '--catalog', CATALOG], { encoding: 'utf8' });
    return JSON.parse(out).found;
}

test('scanner finds package, central-package, csproj-property, npm, and file signals with attribution', () => {
    const root = buildFixture();
    try
    {
        const found = scan(root);
        assert.match(found.skills['dotnet-messaging'], /MassTransit in src\/Api\/Api\.csproj/);
        assert.match(found.skills['dotnet-openapi'], /Swashbuckle\.AspNetCore in src\/Api\/Api\.csproj/);
        assert.match(found.skills['dotnet-data-access'], /Npgsql in src\/Worker\/Worker\.csproj/, 'a CPM version-less PackageReference is the usage signal');
        assert.match(found.skills['dotnet-source-generators'], /IsRoslynComponent/, 'csproj property signal');
        assert.match(found.skills['angular-material'], /@angular\/material in web\/package\.json/, 'npm dependency');
        assert.match(found.mcps['sentry'], /@sentry\/angular in web\/package\.json/, 'scoped npm prefix');
        assert.match(found.skills['nx'], /nx\.json/, 'file-existence signal');
        assert.match(found.skills['dotnet-minimal-api'], /minimal-API Map\* wiring in Program\.cs in src\/Api\/Program\.cs/, 'content signal over a named code file, labeled');
        assert.match(found.skills['dotnet-mvc-controllers'], /ApiController\/Controller classes in src\/Web\/HomeController\.cs/, 'a base-class-only view controller fires the signal');
        assert.match(found.skills['dotnet-architecture'], /Shop\.Domain\.csproj present/, 'clean-architecture layer naming is a file signal');
        assert.strictEqual(found.skills['dotnet-realtime'], undefined, 'the SignalR server regex does not fire on plain Map* endpoints');
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanner honors the skip-list, the depth cap, and reports nothing for absent signals', () => {
    const root = buildFixture();
    try
    {
        const found = scan(root);
        assert.strictEqual(found.skills['dotnet-performance'], undefined, 'a node_modules-only signal is not found');
        assert.strictEqual(found.skills['dotnet-grpc'], undefined, 'a beyond-depth-cap manifest is not read');
        assert.strictEqual(found.skills['dotnet-realtime'], undefined, 'no signal, no entry - absence is empty, not false');
        // under central package management a PackageVersion pin can exist for a package no
        // project references - a pin alone must never count as usage (the knopka false-adds)
        assert.strictEqual(found.skills['dotnet-aspire'], undefined, 'a CPM PackageVersion pin with no PackageReference is not evidence');
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanner with --judgment computes version conflicts from found package majors', () => {
    const JUDGMENT = path.join(__dirname, '..', 'meta', 'judgment.json');
    const root = buildFixture();
    try
    {
        const out = execFileSync('node', [SCRIPT, '--root', root, '--catalog', CATALOG, '--judgment', JUDGMENT], { encoding: 'utf8' });
        const conflicts = JSON.parse(out).judgment.versionConflicts;
        const row = conflicts.find(c => c.item === 'mcp:angular-cli');
        assert.ok(row, '@angular/core ^16 is below the catalog threshold 17');
        assert.strictEqual(row.package, '@angular/core');
        assert.strictEqual(row.version, '^16.2.0');
        assert.strictEqual(row.below, '17');
        assert.match(row.rel, /web\/package\.json/);
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('scanner on an empty project yields an empty found map', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evscan-empty-'));
    try
    {
        const found = scan(root);
        assert.deepStrictEqual(found, { skills: {}, mcps: {}, plugins: {} });
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The lint checks catalog names and labels, not regex syntax - a regex that does not compile must
// skip its one signal with a named warning instead of killing the whole scan.
test('a catalog regex that does not compile is skipped with a named warning, the scan still completes', () => {
    const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evscan-badre-'));
    const catalogFile = path.join(root, 'catalog.json');
    try
    {
        fs.writeFileSync(path.join(root, 'nx.json'), '{}');
        fs.writeFileSync(catalogFile, JSON.stringify({ skills: { csharp: { content: [{ glob: 'Program.cs', regex: '(', label: 'broken' }] }, nx: { files: ['nx.json'] } } }));
        const r = spawnSync('node', [SCRIPT, '--root', root, '--catalog', catalogFile], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, r.stderr);
        assert.match(r.stderr, /invalid regex/, 'the bad signal is named');
        assert.match(JSON.parse(r.stdout).found.skills.nx, /nx\.json/, 'the other signals still match');
    }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('every reported path uses forward slashes, on every platform', () =>
{
    // `path.relative` returns the NATIVE separator, so the same project reported
    // `MassTransit in src\Api\Api.csproj` on Windows and `src/Api/Api.csproj` everywhere else.
    // That string is the evidence reason the guided walk shows the user and attributes a selection
    // by, so it must not change shape with the machine. Caught by running the suite on
    // windows-latest for the first time.
    const root = buildFixture();
    const hits = JSON.stringify(scan(root));
    assert.ok(/src\/Api\/Api\.csproj/.test(hits), 'the reported path is posix-style');
    assert.ok(!/[A-Za-z0-9]\\\\[A-Za-z0-9]/.test(hits), 'no native separator survives into a reported path');
});
