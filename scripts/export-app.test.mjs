import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPublicAppMetadata, exportApp } from './export-app.mjs';
import { isPublicPath } from './public-english.mjs';

const worktree = fileURLToPath(new URL('..', import.meta.url));
const shared = [
  "export const OFFICIAL_APP_REPOSITORY = 'RichToyo/Gian';",
  "export const OFFICIAL_PROXY_REPOSITORY = 'RichToyo/Gian-Proxies';",
  "export const LEGACY_OFFICIAL_APP_REPOSITORY = 'RichLogic/Gian';",
  "export const LEGACY_OFFICIAL_PROXY_REPOSITORY = 'RichLogic/Gian-Proxies';",
  '',
].join('\n');
const main = "export const releaseRepository = () => process.env['GIAN_RELEASE_REPOSITORY']?.trim() || OFFICIAL_APP_REPOSITORY;\n";
const desktop = `${JSON.stringify({ name: 'gian', build: { publish: [{ provider: 'github', owner: 'RichToyo', repo: 'Gian' }] } }, null, 2)}\n`;

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

function commitAll(root) {
  git(root, ['add', '.']);
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
}

function scannerBytes() {
  return Object.fromEntries(['scripts/public-english.mjs', 'scripts/check-public-english.mjs', 'scripts/media-review.json', '.github/workflows/public-english.yml']
    .map(path => [path, readFileSync(join(worktree, path))]));
}

function appFiles(desktopBytes = desktop) {
  return {
    ...scannerBytes(),
    'packages/desktop/package.json': desktopBytes,
    'packages/desktop/src/main.ts': main,
    'packages/shared/src/official-catalog-source.ts': shared,
    'packages/proxies/zcode-proxy/test/capabilities.test.ts': 'export const capabilities = true;\n',
    'packages/proxies/zcode-proxy/evidence/wp0/note.txt': `historical ${String.fromCodePoint(0x4e2d)}\n`,
    '.github/workflows/ci.yml': 'name: private\n',
    'AGENTS.md': 'private\n',
  };
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

test('app metadata validation copies owner bytes unchanged', () => {
  const files = new Map([
    ['packages/desktop/package.json', { bytes: Buffer.from(desktop) }],
    ['packages/desktop/src/main.ts', { bytes: Buffer.from(main) }],
    ['packages/shared/src/official-catalog-source.ts', { bytes: Buffer.from(shared) }],
  ]);
  assertPublicAppMetadata(files);
  assert.equal(files.get('packages/desktop/package.json').bytes.toString('utf8'), desktop);
  assert.equal(files.get('packages/desktop/src/main.ts').bytes.toString('utf8'), main);
  const broken = new Map(files);
  broken.set('packages/desktop/package.json', { bytes: Buffer.from(desktop.replace('RichToyo', 'RichLogic')) });
  assert.throws(() => assertPublicAppMetadata(broken), /RichToyo\/Gian/);
  assert.equal(isPublicPath('packages/proxies/zcode-proxy/evidence/wp0/note.txt'), false);
  assert.equal(isPublicPath('packages/proxies/zcode-proxy/test/capabilities.test.ts'), true);
  assert.equal(isPublicPath('.github/workflows/ci.yml'), false);
  assert.equal(isPublicPath('.github/workflows/public-english.yml'), true);
});

test('fresh app export keeps provenance, public tests, and the English gate', async t => {
  const temporary = mkdtempSync(join(tmpdir(), 'gian-app-export-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = join(temporary, 'source');
  mkdirSync(source);
  writeTree(source, appFiles());
  git(source, ['init', '-q']);
  commitAll(source);
  const output = join(temporary, 'out');
  const exported = exportApp({ source, output });
  const manifest = JSON.parse(readFileSync(join(output, '.gian-source.json'), 'utf8'));
  assert.equal(exported.commit, manifest.sourceCommit);
  assert.equal(manifest.repository, 'RichToyo/Gian');
  assert.equal(manifest.sourceRepository, 'RichLogic/Gian-Dev');
  assert.equal(manifest.workingTree, false);
  assert.equal(existsSync(join(output, '.git')), false);
  assert.equal(readFileSync(join(output, 'packages/desktop/package.json'), 'utf8'), desktop);
  assert.equal(readFileSync(join(output, 'packages/desktop/src/main.ts'), 'utf8'), main);
  assert.equal(readFileSync(join(output, 'packages/shared/src/official-catalog-source.ts'), 'utf8'), shared);
  assert.equal(existsSync(join(output, 'packages/proxies/zcode-proxy/test/capabilities.test.ts')), true);
  assert.equal(existsSync(join(output, 'packages/proxies/zcode-proxy/evidence/wp0/note.txt')), false);
  assert.equal(existsSync(join(output, '.github/workflows/ci.yml')), false);
  assert.equal(existsSync(join(output, '.github/workflows/public-english.yml')), true);
  assert.equal(existsSync(join(output, 'AGENTS.md')), false);
  const cli = readFileSync(join(output, 'scripts/check-public-english.mjs'), 'utf8');
  assert.equal(cli.includes('delivery-certificate'), false);
  const imported = await import(pathToFileURL(join(output, 'scripts/check-public-english.mjs')).href);
  assert.equal(typeof imported.publicEntriesFromGit, 'function');
  assertClosure(output);

  const rejected = join(temporary, 'rejected');
  writeTree(source, { 'packages/desktop/package.json': desktop.replace('RichToyo', 'RichLogic') });
  commitAll(source);
  assert.throws(() => exportApp({ source, output: rejected }), /RichToyo\/Gian/);
  assert.equal(existsSync(rejected), false);

  writeTree(source, appFiles());
  writeTree(source, { 'README.md': `${String.fromCodePoint(0x4e2d)}\n` });
  commitAll(source);
  const han = join(temporary, 'han');
  assert.throws(() => exportApp({ source, output: han }), /Public English gate failed/);
  assert.equal(existsSync(han), false);
});
