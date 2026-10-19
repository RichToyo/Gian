import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicEntriesFromGit } from './check-public-english.mjs';
import { assertPublicEnglish, loadMediaReviews } from './public-english.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Copied public App metadata must already match the shared owner contract.
 * This does not rewrite desktop, host, or shared source. */
export function assertPublicAppMetadata(files) {
  const text = path => {
    const file = files.get(path);
    if (!file) throw new Error(`Public App export is missing ${path}`);
    return file.bytes.toString('utf8');
  };
  const metadata = JSON.parse(text('packages/desktop/package.json'));
  const publish = (metadata.build?.publish ?? []).filter(item => item?.provider === 'github');
  if (publish.length !== 1 || publish[0].owner !== 'RichToyo' || publish[0].repo !== 'Gian') {
    throw new Error('Desktop publish metadata must already name RichToyo/Gian');
  }
  const main = text('packages/desktop/src/main.ts');
  if (!main.includes('OFFICIAL_APP_REPOSITORY') || main.includes("'RichLogic/Gian'") || main.includes('"RichLogic/Gian"')) {
    throw new Error('Desktop release repository must use OFFICIAL_APP_REPOSITORY');
  }
  const shared = text('packages/shared/src/official-catalog-source.ts');
  for (const expected of [
    "export const OFFICIAL_APP_REPOSITORY = 'RichToyo/Gian'",
    "export const OFFICIAL_PROXY_REPOSITORY = 'RichToyo/Gian-Proxies'",
    "export const LEGACY_OFFICIAL_APP_REPOSITORY = 'RichLogic/Gian'",
    "export const LEGACY_OFFICIAL_PROXY_REPOSITORY = 'RichLogic/Gian-Proxies'",
  ]) {
    if (!shared.includes(expected)) throw new Error(`Shared owner contract is missing ${expected}`);
  }
}

export function exportApp({ source = root, output, revision = 'HEAD' }) {
  if (!output) throw new Error('--output is required');
  const target = resolve(output);
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory() || readdirSync(target).length)) {
    throw new Error('Export target must be new or empty; existing repositories are never overwritten');
  }
  const tree = publicEntriesFromGit(source, revision, true);
  const files = new Map(tree.entries.map(entry => [entry.path, {
    bytes: entry.bytes,
    mode: entry.mode === '100755' ? 0o755 : 0o644,
  }]));
  assertPublicAppMetadata(files);
  const provenance = {
    schema: 1,
    product: 'Gian',
    repository: 'RichToyo/Gian',
    sourceRepository: 'RichLogic/Gian-Dev',
    sourceCommit: tree.commit,
    workingTree: false,
    files: [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, file]) => ({
      path,
      mode: file.mode,
      sha256: createHash('sha256').update(file.bytes).digest('hex'),
    })),
  };
  files.set('.gian-source.json', { bytes: Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`), mode: 0o644 });
  assertPublicEnglish([...files].map(([path, file]) => ({ path, bytes: file.bytes })), loadMediaReviews());
  mkdirSync(target, { recursive: true });
  for (const [path, file] of files) {
    mkdirSync(dirname(join(target, path)), { recursive: true });
    writeFileSync(join(target, path), file.bytes, { flag: 'wx', mode: file.mode });
  }
  return { output: target, commit: tree.commit, files: files.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output') options.output = args[++index];
    else if (args[index] === '--ref') options.revision = args[++index];
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  if (spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }).status !== 0) {
    throw new Error('App export requires a git source');
  }
  console.log(JSON.stringify(exportApp(options)));
}
