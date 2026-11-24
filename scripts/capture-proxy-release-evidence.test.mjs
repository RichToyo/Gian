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
  assert.match(proxyReleaseNotes.claude.text, /streaming-input mode/);
  assert.match(proxyReleaseNotes.claude.text, /background/);
  assert.match(proxyReleaseNotes.claude.text, /Claude Code 2\.1\.330/);
  assert.match(proxyReleaseNotes.codex.text, /ChatGPT subscription quota/);
  assert.match(proxyReleaseNotes.antigravity.text, /agy acp/);
  for (const provider of ['claude', 'codex', 'dsh', 'kimi', 'grok', 'zcode', 'antigravity']) {
    assert.match(proxyReleaseNotes[provider].text, /Proxy Protocol SDK 1\.0\.5/);
    assert.match(proxyReleaseNotes[provider].text, /acceptance are not claimed/);
  }
  assert.match(proxyReleaseNotes.zcode.text, /without altering original upstream source or notices/);
  assert.match(proxyReleaseNotes.codex.text, /0\.169\.1 to official 0\.171\.0/);
  assert.match(proxyReleaseNotes.dsh.text, /0\.2\.2-rc\.3 to 0\.2\.2-rc\.5/);
  assert.match(proxyReleaseNotes.kimi.text, /2\.6\.3 to 2\.7\.2/);
  assert.match(proxyReleaseNotes.grok.text, /1\.0\.89 to 1\.0\.92/);
  assert.match(proxyReleaseNotes.zcode.text, /CLI 0\.17\.1/);
  assert.match(proxyReleaseNotes.antigravity.text, /agy 1\.5\.14 to the official Antigravity CLI 1\.5\.16/);
  for (const note of Object.values(proxyReleaseNotes)) {
    assert.equal(typeof note.text, 'string');
    assert.equal(Object.hasOwn(note, 'zh'), false);
    assert.equal(Object.hasOwn(note, 'en'), false);
  }
});
