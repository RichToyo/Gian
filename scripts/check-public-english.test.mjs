import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { publicEntriesFromGit } from './check-public-english.mjs';
import { scanPublicEntries } from './public-english.mjs';

const cli = fileURLToPath(new URL('./check-public-english.mjs', import.meta.url));
const medium = 400_000;

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('padded blob sizes stay readable and a root AGENTS.md cannot hide Han', t => {
  const source = mkdtempSync(join(tmpdir(), 'gian-english-size-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  const han = String.fromCodePoint(0x4e2d);
  const files = {
    'README.md': 'English readme\n',
    'AGENTS.md': `private ${han}\n`,
    'docs/hidden.txt': `hidden ${han}\n`,
    'scripts/tool.sh': '#!/bin/sh\necho ready\n',
    'payload/a.txt': Buffer.alloc(medium, 0x61),
    'payload/b.txt': Buffer.alloc(medium, 0x62),
    'payload/c.txt': Buffer.alloc(medium, 0x63),
  };
  for (const [path, value] of Object.entries(files)) {
    const target = join(source, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, value);
  }
  chmodSync(join(source, 'scripts/tool.sh'), 0o755);
  git(source, ['init', '-q']);
  git(source, ['add', '--', '.']);
  git(source, ['update-index', '--chmod=+x', '--', 'scripts/tool.sh']);
  git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  const listed = git(source, ['ls-tree', '-l', 'HEAD', '--', 'payload/a.txt']);
  assert.match(listed, / {2,}\d+\tpayload\/a\.txt/);
  assert.ok(medium < 1_000_000);
  assert.ok(medium * 3 > 1024 * 1024);

  const tree = publicEntriesFromGit(source, 'HEAD');
  assert.equal(tree.curated, false);
  const byPath = new Map(tree.entries.map(entry => [entry.path, entry]));
  for (const path of ['AGENTS.md', 'docs/hidden.txt', 'payload/a.txt', 'payload/b.txt', 'payload/c.txt', 'scripts/tool.sh']) {
    assert.equal(byPath.has(path), true, path);
  }
  assert.equal(byPath.get('payload/a.txt').bytes.length, medium);
  assert.equal(byPath.get('payload/b.txt').bytes.length, medium);
  assert.equal(byPath.get('payload/c.txt').bytes.length, medium);
  assert.equal(byPath.get('payload/a.txt').mode, '100644');
  assert.equal(byPath.get('scripts/tool.sh').mode, '100755');
  assert.equal(byPath.get('scripts/tool.sh').bytes.toString('utf8'), '#!/bin/sh\necho ready\n');
  const violations = scanPublicEntries(tree.entries, new Map()).violations;
  assert.equal(violations.some(item => item.path === 'AGENTS.md' && item.kind === 'han-text'), true);
  assert.equal(violations.some(item => item.path === 'docs/hidden.txt' && item.kind === 'han-text'), true);

  const curated = publicEntriesFromGit(source, 'HEAD', true);
  assert.equal(curated.curated, true);
  assert.equal(curated.entries.some(entry => entry.path === 'AGENTS.md' || entry.path === 'docs/hidden.txt'), false);
  assert.equal(curated.entries.find(entry => entry.path === 'scripts/tool.sh').mode, '100755');

  const cliResult = spawnSync(process.execPath, [cli, '--root', source, '--ref', 'HEAD'], { encoding: 'utf8' });
  assert.equal(cliResult.status, 1);
  assert.match(cliResult.stderr, /AGENTS\.md/);
  assert.match(cliResult.stderr, /docs\/hidden\.txt/);
});
