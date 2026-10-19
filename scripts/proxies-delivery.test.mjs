import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { protocolCoordinates } from '../delivery/proxies/scripts/protocol-dependency.mjs';
import { exportProxies, externalProxyLockfile, proxiesExportPath, standaloneRuntimeVerifier } from './export-proxies.mjs';
import { proxyProbeCoordinate, verifyProxyRuntimeCandidate } from './verify-managed-runtime-candidates.mjs';

const worktree = fileURLToPath(new URL('..', import.meta.url));

test('source Proxy packages use the workspace protocol dependency', () => {
  const root = new URL('../packages/proxies/', import.meta.url);
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifest = new URL(`${directory.name}/package.json`, root);
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (metadata.dependencies?.['@gian/proxy-protocol']) {
      assert.equal(metadata.dependencies['@gian/proxy-protocol'], 'workspace:*', directory.name);
    }
  }
});

test('Proxy product excludes App and private protocol source and reuses the exact runtime extractor', () => {
  for (const path of ['AGENTS.md', '.ai/MEMORY.md', 'packages/host/package.json', 'packages/desktop/src/main.ts',
    'packages/web/package.json', 'packages/proxy-protocol/src/index.ts', 'packages/shared/test/identity.test.mjs']) {
    assert.equal(proxiesExportPath(path), null);
  }
  assert.equal(proxiesExportPath('packages/proxies/dsh-proxy/package.json'), 'packages/proxies/dsh-proxy/package.json');
  assert.equal(proxiesExportPath('packages/host/src/runtime/safe-extract.ts'), 'support/runtime-extractor/src/safe-extract.ts');
  assert.equal(proxiesExportPath('delivery/proxies/.github/workflows/catalog.yml'), '.github/workflows/catalog.yml');
  assert.equal(proxiesExportPath('scripts/check-node.js'), 'scripts/check-node.cjs');
  assert.equal(proxiesExportPath('catalog/proxy-information/claude/tutorial.md'), 'catalog/proxy-information/claude/tutorial.md');
  assert.equal(proxiesExportPath('packages/proxies/zcode-proxy/evidence/wp0/raw/g0-methods.ndjson'), null);
  assert.equal(proxiesExportPath('packages/proxies/cc-proxy/evidence/README.md'), null);
  assert.equal(proxiesExportPath('packages/proxies/zcode-proxy/probes/wp0/probe-g0-methods.mjs'), 'packages/proxies/zcode-proxy/probes/wp0/probe-g0-methods.mjs');
  assert.equal(proxiesExportPath('packages/proxies/codex-proxy/test/fixtures/customization-inventory/p0-evidence/sample.json'), 'packages/proxies/codex-proxy/test/fixtures/customization-inventory/p0-evidence/sample.json');
  assert.equal(proxiesExportPath('scripts/check-public-english.mjs'), 'scripts/check-public-english.mjs');
  assert.equal(proxiesExportPath('scripts/media-review.json'), 'scripts/media-review.json');
  for (const path of ['scripts/build-zcode-runtime.mjs', 'scripts/zcode-runtime-source.mjs',
    'scripts/build-antigravity-runtime.mjs',
    'scripts/build-antigravity-runtime.test.mjs',
    'scripts/verify-zcode-runtime-protocol.mjs',
    'scripts/zcode-runtime-integration.mjs',
    'scripts/build-managed-runtime-candidates.test.mjs', 'scripts/proxy-release-metadata.test.mjs',
    'packages/proxies/zcode-proxy/src/runtime/source.json']) {
    assert.equal(proxiesExportPath(path), path, 'Standalone release must retain ZCode source lock and build dependencies');
  }
});

test('standalone Runtime builder and verifier import with no private Host tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-standalone-import-'));
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  try {
    put('package.json', '{"type":"module"}');
    // A fake build dependency proves cold imports only; no build/Runtime is executed.
    put('node_modules/esbuild/package.json', '{"type":"module","exports":"./index.js"}');
    put('node_modules/esbuild/index.js', 'export function build() { throw Error("unexpected build"); }');
    for (const path of ['scripts/verify-managed-runtime-candidates.mjs', 'scripts/build-proxy-artifacts.mjs',
      'scripts/build-managed-runtime-candidates.mjs', 'scripts/proxy-release-metadata.mjs',
      'scripts/build-antigravity-runtime.mjs', 'scripts/build-zcode-runtime.mjs',
      'scripts/verify-zcode-runtime-protocol.mjs', 'scripts/zcode-runtime-source.mjs', 'scripts/zcode-runtime-integration.mjs',
      'packages/proxies/zcode-proxy/src/runtime/source.json', 'packages/host/src/runtime/dev-runtime-coordinates.json']) {
      const destination = proxiesExportPath(path);
      assert.ok(destination, `Missing standalone dependency: ${path}`);
      const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
      put(destination, path.endsWith('/verify-managed-runtime-candidates.mjs') ? standaloneRuntimeVerifier(bytes.toString()) : bytes);
    }
    assert.equal(existsSync(join(root, 'packages/host')), false);
    assert.doesNotMatch(readFileSync(join(root, 'scripts/verify-managed-runtime-candidates.mjs'), 'utf8'), /packages\/host\//);
    const verifier = await import(pathToFileURL(join(root, 'scripts/verify-managed-runtime-candidates.mjs')).href);
    const builder = await import(pathToFileURL(join(root, 'scripts/build-managed-runtime-candidates.mjs')).href);
    assert.equal(typeof verifier.verifyManagedRuntimeCandidates, 'function');
    assert.equal(typeof builder.buildManagedRuntimeCandidates, 'function');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package-owned qualification retains pin checks and rejects probe identity/layout drift', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-owned-probe-'));
  const directory = join(root, 'packages/proxies/fixture-proxy');
  const statePath = join(directory, 'state.json');
  const home = join(root, 'isolated-home');
  const entryPath = join(root, 'runtime/server');
  const definition = { pluginId: 'io.fixture.probe', directory: 'fixture-proxy',
    runtime: { id: 'fixture-runtime', displayName: 'Fixture ACP' }, runtimeQualification: { module: 'probe.mjs', export: 'probe' } };
  const coordinate = { pluginId: definition.pluginId, runtimeId: definition.runtime.id, version: '1.3.0', format: 'tar.gz',
    entryRelativePath: 'server', probe: { kind: 'proxy' }, asset: { sha256: 'a'.repeat(64), size: 123 } };
  const candidate = { provider: 'fixture', ...coordinate, asset: { ...coordinate.asset } };
  const definitions = [{ ...definition, id: 'fixture' }];
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'probe.mjs'), `import { readFile } from 'node:fs/promises';
export async function probe(path, env) {
  if (env.HOME !== env.GEMINI_HOME || env.HOME !== env.GIAN_AGENT_HOME) throw Error('unisolated probe');
  return { runtimeId: 'fixture-runtime', displayName: 'Fixture ACP', path, version: '1.3.0', configHome: env.HOME,
    contentRoots: [{ path, mode: 'file' }], ...JSON.parse(await readFile(new URL('./state.json', import.meta.url), 'utf8')) };
}`);
    writeFileSync(statePath, '{}');
    assert.ok(proxyProbeCoordinate(candidate, [coordinate], definitions));
    for (const changed of [{ ...candidate, entryRelativePath: 'other' }, { ...candidate, format: 'raw' },
      { ...candidate, asset: { ...candidate.asset, sha256: 'b'.repeat(64) } }, { ...candidate, asset: { ...candidate.asset, size: 124 } }]) {
      assert.throws(() => proxyProbeCoordinate(changed, [coordinate], definitions), /differs/);
    }
    const input = { candidate, definition, entryPath, home, repositoryRoot: root };
    assert.equal(await verifyProxyRuntimeCandidate(input), '1.3.0');
    for (const changed of [{ runtimeId: 'other' }, { version: '9.0.0' }, { displayName: 'Other' },
      { path: '/other/server' }, { configHome: '/other/home' }, { contentRoots: [{ path: entryPath, mode: 'directory' }] },
      { contentRoots: [{ path: entryPath, mode: 'file' }, { path: '/outside/harness', mode: 'file' }] }]) {
      writeFileSync(statePath, JSON.stringify(changed));
      await assert.rejects(verifyProxyRuntimeCandidate(input), /differs|escapes/);
    }
    await assert.rejects(verifyProxyRuntimeCandidate({ ...input, definition: { ...definition, runtimeQualification: null } }), /package-owned/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('standalone lock retains exact registry snapshots and removes private protocol importers', () => {
  const coordinate = { url: 'https://github.com/RichLogic/Gian/releases/download/proxy-protocol-v1.0.0/gian-proxy-protocol-1.0.0.tgz',
    integrity: 'fixture-integrity', version: '1.0.0', dependencies: { zod: '4.4.3' } };
  const lock = { lockfileVersion: '9.0', importers: {
    '.': { devDependencies: { typescript: { specifier: '^5.9.0', version: '5.9.3' }, '@playwright/test': {} } },
    'packages/proxies/fixture': { dependencies: { '@gian/proxy-protocol': { specifier: 'workspace:*', version: 'link:../../proxy-protocol' } } },
    'packages/proxy-protocol': {}, 'packages/host': {},
  }, packages: { 'zod@4.4.3': { resolution: { integrity: 'registry-fixture' } } }, snapshots: { 'zod@4.4.3': {} } };
  const result = externalProxyLockfile(lock, coordinate, ['packages/proxies/fixture'], { typescript: '^5.9.0' });
  assert.deepEqual(Object.keys(result.importers), ['.', 'packages/proxies/fixture']);
  assert.equal(result.importers['packages/proxies/fixture'].dependencies['@gian/proxy-protocol'].specifier, coordinate.url);
  assert.deepEqual(result.packages['zod@4.4.3'], lock.packages['zod@4.4.3']);
  assert.equal(result.importers['.'].devDependencies['@playwright/test'], undefined);
  assert.equal(result.packages[`@gian/proxy-protocol@${coordinate.url}`].resolution.integrity, coordinate.integrity);
  assert.throws(() => externalProxyLockfile(lock, { ...coordinate, dependencies: { zod: '99.0.0' } }, [], {}), /absent from the source lock/);
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function writeTree(root, files) {
  for (const [path, value] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }
}

function assertClosure(root) {
  const files = new Set();
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else files.add(relative);
    }
  };
  walk(root, '');
  const specifier = /(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const relative of files) {
    if (!relative.endsWith('.mjs')) continue;
    const text = readFileSync(join(root, relative), 'utf8');
    for (const match of text.matchAll(specifier)) {
      const spec = (match[1] ?? match[2]).split('?')[0];
      if (spec.includes('/dist/')) continue;
      const target = normalize(join(dirname(relative), spec)).replaceAll('\\', '/');
      assert.equal(files.has(target), true, `${relative} -> ${spec}`);
    }
  }
}

test('fresh Proxies export keeps the RichLogic pin, English gate, and public workflow', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'gian-proxies-export-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source');
  mkdirSync(source);
  const pinBytes = Buffer.from('fixture protocol archive bytes; never publish');
  const pin = {
    schema: 1, name: '@gian/proxy-protocol', repository: 'RichLogic/Gian', version: '1.0.2',
    ...protocolCoordinates('1.0.2'), sourceCommit: 'a'.repeat(40), size: pinBytes.length,
    sha256: createHash('sha256').update(pinBytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(pinBytes).digest('base64')}`,
    dependencies: { zod: '4.4.3' },
  };
  const files = {
    'package.json': JSON.stringify({ packageManager: 'pnpm@10.33.2', engines: { node: '>=24 <25' }, devDependencies: { typescript: '^5.9.0' } }),
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
    'pnpm-lock.yaml': JSON.stringify({
      lockfileVersion: '9.0',
      importers: {
        '.': { devDependencies: { typescript: { specifier: '^5.9.0', version: '5.9.3' } } },
        'packages/proxies/fixture': { dependencies: { '@gian/proxy-protocol': { specifier: 'workspace:*', version: 'link:../../proxy-protocol' } } },
      },
      packages: { 'zod@4.4.3': { resolution: { integrity: 'registry-fixture' } } },
      snapshots: { 'zod@4.4.3': {} },
    }),
    'delivery/proxies/protocol-package.json': JSON.stringify(pin),
    'packages/proxies/fixture/package.json': JSON.stringify({ name: '@gian/fixture-proxy', version: '0.0.0', dependencies: { '@gian/proxy-protocol': 'workspace:*' } }),
    'packages/proxies/fixture/tsconfig.json': '{}\n',
    'scripts/verify-managed-runtime-candidates.mjs': "import { extractManagedRuntimeArchive } from '../packages/host/dist/runtime/safe-extract.js';\nexport const fixture = true;\n",
    'scripts/build-managed-runtime-candidates.mjs': "export const template = 'https://github.com/RichLogic/Gian/releases/download/example';\n",
    'packages/proxies/zcode-proxy/evidence/wp0/note.txt': `historical ${String.fromCodePoint(0x4e2d)}\n`,
    'packages/proxies/codex-proxy/test/fixtures/customization-inventory/p0-evidence/sample.json': '{"ok":true}\n',
  };
  for (const relative of ['scripts/public-english.mjs', 'scripts/check-public-english.mjs', 'scripts/media-review.json', 'delivery/proxies/.github/workflows/public-english.yml']) {
    files[relative] = readFileSync(join(worktree, relative));
  }
  writeTree(source, files);
  git(source, ['init', '-q']);
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const output = join(temporary, 'out');
  exportProxies({ source, output });
  const manifest = JSON.parse(readFileSync(join(output, '.gian-source.json'), 'utf8'));
  const exportedPin = JSON.parse(readFileSync(join(output, 'protocol-package.json'), 'utf8'));
  assert.equal(manifest.sourceRepository, 'RichLogic/Gian-Dev');
  assert.equal(manifest.product, 'Gian-Proxies');
  assert.equal(exportedPin.repository, 'RichLogic/Gian');
  assert.equal(exportedPin.url, pin.url);
  assert.match(readFileSync(join(output, 'scripts/build-managed-runtime-candidates.mjs'), 'utf8'), /https:\/\/github.com\/RichToyo\/Gian-Proxies\/releases\/download\//);
  const verifier = readFileSync(join(output, 'scripts/verify-managed-runtime-candidates.mjs'), 'utf8');
  assert.match(verifier, /\.\.\/support\/runtime-extractor\/dist\/safe-extract\.js/);
  assert.doesNotMatch(verifier, /packages\/host\/dist\/runtime\/safe-extract\.js/);
  assert.equal(existsSync(join(output, 'packages/proxies/zcode-proxy/evidence/wp0/note.txt')), false);
  assert.equal(existsSync(join(output, 'packages/proxies/codex-proxy/test/fixtures/customization-inventory/p0-evidence/sample.json')), true);
  assert.equal(existsSync(join(output, '.github/workflows/public-english.yml')), true);
  assert.equal(existsSync(join(output, '.git')), false);
  const cli = readFileSync(join(output, 'scripts/check-public-english.mjs'), 'utf8');
  assert.equal(cli.includes('delivery-certificate'), false);
  const imported = await import(pathToFileURL(join(output, 'scripts/check-public-english.mjs')).href);
  assert.equal(typeof imported.publicEntriesFromGit, 'function');
  assertClosure(output);
  const product = readFileSync(join(worktree, 'delivery/proxies/scripts/release-product.mjs'), 'utf8');
  assert.match(product, /repository = PUBLICATION_CATALOG_REPOSITORY/);
  const catalogPolicy = readFileSync(join(worktree, 'delivery/proxies/scripts/catalog-docs-policy.mjs'), 'utf8');
  assert.match(catalogPolicy, /PUBLICATION_CATALOG_REPOSITORY = 'RichToyo\/Gian-Proxies'/);

  writeTree(source, { 'packages/proxies/fixture/readme.txt': `${String.fromCodePoint(0x4e2d)}\n` });
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'han']);
  const han = join(temporary, 'han');
  assert.throws(() => exportProxies({ source, output: han }), /Public English gate failed/);
  assert.equal(existsSync(han), false);
});
