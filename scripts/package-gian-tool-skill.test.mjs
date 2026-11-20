import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { packageGianToolSkill } from './package-gian-tool-skill.mjs';

const worktree = fileURLToPath(new URL('..', import.meta.url));

function writeFixture(root, { helpers = true, mode = 0o755 } = {}) {
  const skillDir = join(root, 'packages/tool-cli/skill/gian-tool');
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'skill'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), 'Run scripts/gianctl from this directory.\n');
  writeFileSync(join(root, 'skill/gian-tool-install.md'), 'GIAN_APP_PATH defaults to /Applications/Gian.app\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.6.6' }));
  if (!helpers) return;
  for (const name of ['gianctl', 'gian-tool-mcp']) {
    const path = join(skillDir, 'scripts', name);
    writeFileSync(path, `#!/bin/sh\n# ${name} fixture\n`);
    chmodSync(path, name === 'gian-tool-mcp' ? mode : 0o755);
  }
}

test('packaged gian-tool skill keeps helper modes and does not configure MCP', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-tool-source-'));
  const output = mkdtempSync(join(tmpdir(), 'gian-tool-skill-'));
  try {
    writeFixture(root, { mode: 0o754 });
    const manifest = packageGianToolSkill(output, root);
    const skill = readFileSync(join(output, 'SKILL.md'), 'utf8');
    const guide = readFileSync(join(output, 'INSTALL.md'));
    assert.equal(manifest.name, 'gian-tool');
    assert.equal(manifest.version, '0.6.6');
    assert.equal(manifest.mcpConfigured, false);
    assert.equal(manifest.command, 'scripts/gianctl');
    assert.equal(manifest.mcpCommand, 'scripts/gian-tool-mcp');
    assert.equal(manifest.files['INSTALL.md'], manifest.files['INSTALL.md']);
    assert.equal(guide.toString('utf8'), readFileSync(join(root, 'skill/gian-tool-install.md'), 'utf8'));
    assert.match(skill, /scripts\/gianctl/);
    assert.doesNotMatch(skill, /Gian-Dev\/packages/);
    assert.equal(lstatSync(join(output, 'scripts/gianctl')).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(output, 'scripts/gian-tool-mcp')).mode & 0o777, 0o754);
    assert.equal(JSON.parse(readFileSync(join(output, 'skill-manifest.json'), 'utf8')).mcpConfigured, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('skill packaging fails closed until both helpers are regular files', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-tool-source-'));
  const output = mkdtempSync(join(tmpdir(), 'gian-tool-skill-'));
  try {
    writeFixture(root, { helpers: false });
    writeFileSync(join(output, 'sentinel.txt'), 'keep');
    assert.throws(() => packageGianToolSkill(output, root), /Gian tool helper is not in the skill yet: scripts\/gianctl/);
    assert.equal(readFileSync(join(output, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(join(output, 'SKILL.md')), false);
    assert.equal(existsSync(join(output, 'INSTALL.md')), false);
    assert.equal(existsSync(join(output, 'skill-manifest.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('skill packaging refuses a nonempty or linked output before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-tool-source-'));
  const output = mkdtempSync(join(tmpdir(), 'gian-tool-skill-'));
  const linked = join(tmpdir(), `gian-tool-link-${Date.now()}`);
  try {
    writeFixture(root);
    writeFileSync(join(output, 'sentinel.txt'), 'keep');
    assert.throws(() => packageGianToolSkill(output, root), /existing installations are never overwritten/);
    assert.equal(readFileSync(join(output, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(join(output, 'SKILL.md')), false);
    symlinkSync(output, linked);
    assert.throws(() => packageGianToolSkill(linked, root), /existing installations are never overwritten/);
    assert.equal(readFileSync(join(output, 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    rmSync(linked, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('skill packaging rejects non-executable helpers and Han before writing', () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-tool-source-'));
  const output = mkdtempSync(join(tmpdir(), 'gian-tool-skill-'));
  try {
    writeFixture(root, { mode: 0o644 });
    writeFileSync(join(output, 'sentinel.txt'), 'keep');
    assert.throws(() => packageGianToolSkill(output, root), /must be executable: scripts\/gian-tool-mcp/);
    assert.equal(readFileSync(join(output, 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(existsSync(join(output, 'SKILL.md')), false);
    writeFixture(root, { mode: 0o755 });
    writeFileSync(join(root, 'packages/tool-cli/skill/gian-tool/SKILL.md'), `label ${String.fromCodePoint(0x4e2d)}\n`);
    const empty = mkdtempSync(join(tmpdir(), 'gian-tool-empty-'));
    try {
      assert.throws(() => packageGianToolSkill(empty, root), /Public English gate failed/);
      assert.equal(existsSync(join(empty, 'SKILL.md')), false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});

test('source skill copy uses the installed app bundle and skill-local commands', () => {
  const skill = readFileSync(join(worktree, 'packages/tool-cli/skill/gian-tool/SKILL.md'), 'utf8');
  const guide = readFileSync(join(worktree, 'skill/gian-tool-install.md'), 'utf8').replace(/\s+/g, ' ');
  assert.match(skill, /scripts\/gianctl/);
  assert.match(skill, /scripts\/gian-tool-mcp/);
  assert.match(skill, /does not configure MCP/);
  assert.doesNotMatch(skill, /command name on `PATH`/);
  assert.match(guide, /GIAN_APP_PATH/);
  assert.match(guide, /\/Applications\/Gian\.app/);
  assert.match(guide, /Contents\/Resources\/runtime\/node/);
  assert.match(guide, /app\.asar\.unpacked\/node_modules\/@gian\/tool-cli\/dist\/cli\.js/);
  assert.match(guide, /app\.asar\.unpacked\/node_modules\/@gian\/tool-mcp\/dist\/cli\.js/);
  assert.match(guide, /gian-tool-v1\.sock/);
  assert.match(guide, /does not configure MCP/);
  assert.match(guide, /ping`, `schema`, `call`, and `wait/);
  assert.doesNotMatch(guide, /gian_mcp_v1|Authorization:/);
  assert.match(guide, /at Session start and resume/);
  assert.match(guide, /not written into the Agent Home/);
  assert.match(guide, /not done for every Provider/);
  assert.match(guide, /Unix socket and on stdio/);
  assert.doesNotMatch(guide, /inside an agent home/i);
});
