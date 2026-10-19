import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicEnglish, loadMediaReviews } from './public-english.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helpers = ['scripts/gianctl', 'scripts/gian-tool-mcp'];

export function packageGianToolSkill(output, sourceRoot = root) {
  if (!output) throw new Error('Skill output directory is required');
  const skillDir = join(sourceRoot, 'packages/tool-cli/skill/gian-tool');
  const inputs = [
    { path: 'SKILL.md', source: join(skillDir, 'SKILL.md'), helper: false },
    { path: 'INSTALL.md', source: join(sourceRoot, 'skill/gian-tool-install.md'), helper: false },
    ...helpers.map(relative => ({ path: relative, source: join(skillDir, relative), helper: true })),
  ];
  const version = JSON.parse(readFileSync(join(sourceRoot, 'package.json'), 'utf8')).version;
  const loaded = inputs.map(loadInput);
  assertPublicEnglish(loaded.map(item => ({ path: item.path, bytes: item.bytes })), loadMediaReviews());
  const target = resolve(output);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || readdirSync(target).length > 0) {
      throw new Error('Skill output must be a new or empty directory; existing installations are never overwritten');
    }
  }
  mkdirSync(target, { recursive: true });
  const files = {};
  for (const item of loaded) {
    const destination = join(target, item.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, item.bytes, { flag: 'wx', mode: item.mode });
    chmodSync(destination, item.mode);
    files[item.path] = sha256(item.bytes);
  }
  const manifest = {
    name: 'gian-tool',
    version,
    sha256: files['SKILL.md'],
    files,
    mcpConfigured: false,
    command: 'scripts/gianctl',
    mcpCommand: 'scripts/gian-tool-mcp',
  };
  writeFileSync(join(target, 'skill-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}

function loadInput(input) {
  let stat;
  try {
    stat = lstatSync(input.source);
  } catch (error) {
    if (error?.code === 'ENOENT' && input.helper) throw new Error(`Gian tool helper is not in the skill yet: ${input.path}`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(input.helper
      ? `Gian tool helper must be a regular file: ${input.path}`
      : `Skill input must be a regular file: ${input.path}`);
  }
  if (input.helper && (stat.mode & 0o111) === 0) throw new Error(`Gian tool helper must be executable: ${input.path}`);
  return {
    path: input.path,
    bytes: readFileSync(input.source),
    mode: input.helper ? stat.mode & 0o777 : 0o644,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output) throw new Error('Usage: package-gian-tool-skill <output-directory>');
  console.log(JSON.stringify(packageGianToolSkill(output)));
}
