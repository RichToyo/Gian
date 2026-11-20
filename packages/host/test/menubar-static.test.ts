import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { staticFiles } from '../src/web/static-files.js';

test('missing menubar entry never falls back to the main App bootstrap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-menubar-static-'));
  try {
    writeFileSync(join(root, 'index.html'), '<main>Main App fixture</main>');
    const app = new Hono(); app.use('*', staticFiles(root));
    const missing = await app.request('/menubar.html');
    assert.equal(missing.status, 503);
    assert.equal((await missing.text()).includes('Main App'), false);
    writeFileSync(join(root, 'menubar.html'), '<main>Independent panel fixture</main>');
    assert.equal(await (await app.request('/menubar.html')).text(), '<main>Independent panel fixture</main>');
    assert.equal(await (await app.request('/existing-spa-route')).text(), '<main>Main App fixture</main>');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
