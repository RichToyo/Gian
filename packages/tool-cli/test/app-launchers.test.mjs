import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = fileURLToPath(new URL('../skill/gian-tool/scripts/', import.meta.url));

const launchers = [
  {
    name: 'gianctl',
    entry: 'node_modules/@gian/tool-cli/dist/cli.js',
  },
  {
    name: 'gian-tool-mcp',
    entry: 'node_modules/@gian/tool-mcp/dist/cli.js',
  },
];

const fakeNode = `#!/bin/sh
if [ -n "\${FAKE_NODE_LOG:-}" ]; then
  printf '%s\\n' "$@" > "$FAKE_NODE_LOG"
fi
cat
`;

function runLauncher(name, args, { appPath, input = '', env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(scriptsDir, name), args, {
      env: {
        PATH: '/bin:/usr/bin',
        GIAN_APP_PATH: appPath,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail);
    // The missing-runtime shell can exit before it reads the fixture stdin.
    child.stdin.once('error', error => {
      if (error?.code === 'EPIPE') return;
      fail(error);
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function writeBundle(root, entryRelative, { withNode = true, withEntry = true } = {}) {
  const appPath = join(root, 'Gian Dev.app');
  const runtime = join(appPath, 'Contents/Resources/runtime/node');
  const entry = join(appPath, 'Contents/Resources/app.asar.unpacked', entryRelative);
  mkdirSync(dirname(runtime), { recursive: true });
  mkdirSync(dirname(entry), { recursive: true });
  if (withNode) {
    writeFileSync(runtime, fakeNode);
    chmodSync(runtime, 0o755);
  }
  if (withEntry) writeFileSync(entry, 'fixture entry\n');
  return { appPath, runtime, entry };
}

for (const launcher of launchers) {
  test(`${launcher.name} defaults to /Applications/Gian.app and execs the bundled entry`, () => {
    const source = readFileSync(join(scriptsDir, launcher.name), 'utf8');
    assert.match(source, /\$\{GIAN_APP_PATH:-\/Applications\/Gian\.app\}/);
    assert.match(source, /Contents\/Resources\/runtime\/node/);
    assert.match(source, new RegExp(launcher.entry.replaceAll('/', '\\/')));
    assert.equal(/\beval\b/.test(source), false);
  });

  test(`${launcher.name} forwards override, arguments, stdin, and stdout through a path with spaces`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gian-app-launcher-'));
    const logPath = join(root, 'node-args');
    const bundle = writeBundle(root, launcher.entry);
    try {
      const result = await runLauncher(launcher.name, [
        'call',
        'session.get',
        '--json',
        '{"session_id":"a b"}',
      ], {
        appPath: bundle.appPath,
        input: 'hello stdin\n',
        env: { FAKE_NODE_LOG: logPath },
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, 'hello stdin\n');
      assert.equal(result.stdout.includes('/Applications/Gian.app'), false);
      const lines = readFileSync(logPath, 'utf8').replace(/\n$/, '').split('\n');
      assert.deepEqual(lines, [
        bundle.entry,
        'call',
        'session.get',
        '--json',
        '{"session_id":"a b"}',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${launcher.name} reports a missing bundled Node runtime on stderr`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gian-app-launcher-no-node-'));
    const bundle = writeBundle(root, launcher.entry, { withNode: false });
    try {
      const result = await runLauncher(launcher.name, ['ping'], {
        appPath: bundle.appPath,
        input: 'unused\n',
      });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`${launcher.name}: bundled Node runtime is missing: `));
      assert.match(result.stderr, /Gian Dev\.app\/Contents\/Resources\/runtime\/node/);
      assert.equal(result.stderr.includes('/Applications/Gian.app'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(`${launcher.name} reports a missing bundled CLI entry on stderr`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gian-app-launcher-no-entry-'));
    const logPath = join(root, 'node-args');
    const bundle = writeBundle(root, launcher.entry, { withEntry: false });
    try {
      const result = await runLauncher(launcher.name, ['ping'], {
        appPath: bundle.appPath,
        env: { FAKE_NODE_LOG: logPath },
      });
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, new RegExp(`${launcher.name}: bundled CLI entry is missing: `));
      assert.match(result.stderr, new RegExp(launcher.entry.replaceAll('/', '\\/')));
      assert.equal(result.stderr.includes('/Applications/Gian.app'), false);
      assert.throws(() => readFileSync(logPath));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
