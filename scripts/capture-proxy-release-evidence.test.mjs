import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { proxyReleaseNotes } from './capture-proxy-release-evidence.mjs';
import { scanPublicEntries } from './public-english.mjs';

test('capture authors English RichToyo release notes without rewriting historical evidence', () => {
  const source = readFileSync(new URL('./capture-proxy-release-evidence.mjs', import.meta.url));
  const scanned = scanPublicEntries([{ path: 'scripts/capture-proxy-release-evidence.mjs', bytes: source }], new Map());
  assert.equal(scanned.ok, true, JSON.stringify(scanned.violations));
  assert.equal(source.includes('history-copy'), false);
  assert.match(source.toString(), /const repository = 'RichToyo\/Gian-Proxies'/);
  assert.match(source.toString(), /assert.equal\(certificate.repository, repository\)/);
  assert.match(proxyReleaseNotes.claude.text, /SDK 1\.32\.0.*bounded HTTP input/);
  assert.match(proxyReleaseNotes.zcode.text, /without altering original upstream source or notices/);
  assert.match(proxyReleaseNotes.codex.text, /0\.163\.0/);
  assert.match(proxyReleaseNotes.claude.text, /2\.1\.304/);
  assert.match(proxyReleaseNotes.dsh.text, /0\.2\.1-rc\.2/);
  assert.match(proxyReleaseNotes.kimi.text, /2\.2\.0/);
  assert.match(proxyReleaseNotes.grok.text, /1\.0\.62/);
  assert.match(proxyReleaseNotes.zcode.text, /0\.17\.0/);
  assert.match(proxyReleaseNotes.antigravity.text, /1\.4\.1/);
  for (const note of Object.values(proxyReleaseNotes)) {
    assert.equal(typeof note.text, 'string');
    assert.equal(Object.hasOwn(note, 'zh'), false);
    assert.equal(Object.hasOwn(note, 'en'), false);
  }
});
