import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { proxyReleaseNotes } from './capture-proxy-release-evidence.mjs';
import { scanPublicEntries } from './public-english.mjs';

test('capture authors English changelog notes and keeps historical RichLogic release URLs', () => {
  const source = readFileSync(new URL('./capture-proxy-release-evidence.mjs', import.meta.url));
  const scanned = scanPublicEntries([{ path: 'scripts/capture-proxy-release-evidence.mjs', bytes: source }], new Map());
  assert.equal(scanned.ok, true, JSON.stringify(scanned.violations));
  assert.equal(source.includes('history-copy'), false);
  assert.match(source.toString(), /const repository = 'RichLogic\/Gian-Proxies'/);
  assert.match(proxyReleaseNotes.codex.text, /0\.161\.0/);
  assert.match(proxyReleaseNotes.claude.text, /2\.1\.296/);
  assert.match(proxyReleaseNotes.dsh.text, /0\.2\.0-rc\.2/);
  assert.match(proxyReleaseNotes.kimi.text, /Proxy Protocol SDK 1\.0\.2/);
  assert.match(proxyReleaseNotes.grok.text, /1\.0\.46/);
  assert.match(proxyReleaseNotes.zcode.text, /0\.16\.9/);
  for (const note of Object.values(proxyReleaseNotes)) {
    assert.equal(typeof note.text, 'string');
    assert.equal(Object.hasOwn(note, 'zh'), false);
    assert.equal(Object.hasOwn(note, 'en'), false);
  }
});
