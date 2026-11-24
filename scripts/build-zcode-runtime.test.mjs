import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { stageZcodeCredentialKeyring, ZCODE_KEYRING_PACKAGES } from './build-zcode-runtime.mjs';

function put(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

/** pnpm layout: packages/shared sees only @napi-rs/keyring; the platform
 * binding sits beside it in the store, not beside packages/shared. */
function fakeCheckout(root, { native = true } = {}) {
  const store = join(root, 'checkout/node_modules/.pnpm/@napi-rs+keyring@2.1.2/node_modules/@napi-rs');
  put(join(store, 'keyring/package.json'), JSON.stringify({ name: '@napi-rs/keyring', version: '2.1.2', main: 'index.js' }));
  put(join(store, 'keyring/index.js'), 'module.exports = require("@napi-rs/keyring-darwin-arm64");\n');
  put(join(store, 'keyring/node_modules/nested/package.json'), '{}');
  put(join(store, 'keyring-darwin-arm64/package.json'), JSON.stringify({
    name: '@napi-rs/keyring-darwin-arm64', version: '2.1.2', main: 'keyring.darwin-arm64.node',
  }));
  if (native) put(join(store, 'keyring-darwin-arm64/keyring.darwin-arm64.node'), 'native');
  put(join(root, 'checkout/packages/shared/package.json'), '{"name":"@zcode/shared"}');
  // pnpm links the direct dependency only.
  mkdirSync(join(root, 'checkout/packages/shared/node_modules/@napi-rs'), { recursive: true });
  return { checkout: join(root, 'checkout'), store };
}

test('ZCode Runtime staging ships the darwin-arm64 key-store binding next to zcode.cjs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-keyring-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { checkout, store } = fakeCheckout(root);
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(store, 'keyring'), join(checkout, 'packages/shared/node_modules/@napi-rs/keyring'));
  const agent = join(root, 'runtime/zcode/agent');
  put(join(agent, 'zcode.cjs'), '');

  assert.deepEqual(ZCODE_KEYRING_PACKAGES, ['@napi-rs/keyring', '@napi-rs/keyring-darwin-arm64']);
  await stageZcodeCredentialKeyring(checkout, agent);
  assert.equal(readFileSync(join(agent, 'node_modules/@napi-rs/keyring-darwin-arm64/keyring.darwin-arm64.node'), 'utf8'), 'native');
  assert.ok(existsSync(join(agent, 'node_modules/@napi-rs/keyring/index.js')));
  assert.equal(existsSync(join(agent, 'node_modules/@napi-rs/keyring/node_modules')), false,
    'nested dependency trees are not copied');
  // A tree that already resolves the binding is left untouched.
  await stageZcodeCredentialKeyring(checkout, agent);
});

test('ZCode Runtime staging fails closed when the native binding is missing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'zcode-keyring-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { checkout, store } = fakeCheckout(root, { native: false });
  const { symlinkSync } = await import('node:fs');
  symlinkSync(join(store, 'keyring'), join(checkout, 'packages/shared/node_modules/@napi-rs/keyring'));
  const agent = join(root, 'runtime/zcode/agent');
  put(join(agent, 'zcode.cjs'), '');
  await assert.rejects(stageZcodeCredentialKeyring(checkout, agent), /ENOENT/);
});
