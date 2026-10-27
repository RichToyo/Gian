import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MENUBAR_PREFERENCES, FileMenubarPreferences, formatTrayTitle, formatTrayTokens, isLocalMenubarOrigin, isMenubarResource, menubarBounds, menubarRequestTimeout, MENUBAR_MAX_HEIGHT, MENUBAR_WIDTH } from '../src/menubar-state.js';

describe('menubar Desktop local policy', () => {
  it('lets quota refresh finish its Host budget without slowing local snapshot failures', () => {
    assert.equal(menubarRequestTimeout('/api/agents/saved-codex/official-quota/refresh', 'POST'), 40_000);
    assert.equal(menubarRequestTimeout('/api/agents/saved-codex/official-quota/refresh', 'GET'), 12_000);
    for (const path of ['/api/menubar/snapshot', '/api/agents/official-quota', '/api/usage/clear',
      '/api/agents/a/official-quota/refresh/extra']) assert.equal(menubarRequestTimeout(path, 'POST'), 12_000);
  });
  it('clamps the content-sized panel to the design cap and available work area', () => {
    const area = { x: -1440, y: 24, width: 1440, height: 696 };
    for (const x of [-1500, -1440, -800, -20, 200]) {
      const bounds = menubarBounds({ x, y: 0, width: 20, height: 24 }, area);
      assert.ok(bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width);
      assert.ok(bounds.y >= area.y && bounds.y + bounds.height <= area.y + area.height);
    }
    assert.deepEqual(menubarBounds({ x: 0, y: 0, width: 20, height: 24 }, { x: 0, y: 24, width: 320, height: 500 }),
      { x: 0, y: 24, width: 320, height: 500 });
    assert.equal(menubarBounds({ x: 0, y: 0, width: 20, height: 24 }, area, 280).height, 280);
    assert.equal(menubarBounds({ x: 0, y: 0, width: 20, height: 24 }, area, 2_000).height, MENUBAR_MAX_HEIGHT);
    assert.equal(menubarBounds({ x: -800, y: 0, width: 20, height: 24 }, area, 280).width, MENUBAR_WIDTH);
    assert.equal(MENUBAR_WIDTH, 392);
    assert.equal(menubarBounds({ x: -800, y: 0, width: 20, height: 24 }, area, Number.NaN).height, 640);
  });
  it('uses tokens and a bare Todo count separated by the approved middle dot', () => {
    assert.equal(formatTrayTitle(12_800_000, 8, DEFAULT_MENUBAR_PREFERENCES), '12.8M \u00b7 8');
    assert.equal(formatTrayTitle(0, 2, DEFAULT_MENUBAR_PREFERENCES), '0 \u00b7 2');
    assert.equal(formatTrayTitle(12_800_000, 0, DEFAULT_MENUBAR_PREFERENCES), '12.8M');
    assert.equal(formatTrayTitle(12_800_000, 8, { ...DEFAULT_MENUBAR_PREFERENCES, showTokens: false }), '8');
    assert.equal(formatTrayTitle(12_800_000, 8, { ...DEFAULT_MENUBAR_PREFERENCES, showTodoCount: false }), '12.8M');
    assert.equal(formatTrayTitle(12_800_000, 8, { ...DEFAULT_MENUBAR_PREFERENCES, showTokens: false, showTodoCount: false }), '');
  });
  it('ships the dedicated 20pt and Retina template PNGs with the Desktop', () => {
    for (const scale of [1, 2]) {
      const name = `gian-menubarTemplate${scale === 2 ? '@2x' : ''}.png`;
      const png = readFileSync(new URL(`../resources/${name}`, import.meta.url));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      assert.equal(png.readUInt32BE(16), 20 * scale);
      assert.equal(png.readUInt32BE(20), 20 * scale);
      assert.equal(png[25], 6, 'template PNG keeps an alpha channel');
    }
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(manifest.build.files.includes('resources/gian-menubarTemplate*.png'));
  });
  it('allows the independent page/assets/icons but no Host API, WebSocket or arbitrary origin', () => {
    assert.equal(isLocalMenubarOrigin('http://127.0.0.1:8992'), true);
    assert.equal(isLocalMenubarOrigin('https://example.com'), false);
    assert.equal(isLocalMenubarOrigin('http://user:secret@localhost'), false);
    const entry = new URL('http://127.0.0.1:8992/menubar.html');
    for (const path of ['/menubar.html', '/assets/menubar.js', '/api/proxies/codex/logo/dark']) assert.equal(isMenubarResource(new URL(path, entry).href, entry), true);
    for (const url of ['http://127.0.0.1:8992/api/sessions', 'http://127.0.0.1:8992/', 'http://127.0.0.1:8990/menubar.html',
      'https://example.com/menubar.html', 'file:///etc/passwd', 'ws://127.0.0.1:8992/ws', 'http://user:secret@127.0.0.1:8992/menubar.html']) {
      assert.equal(isMenubarResource(url, entry), false);
    }
  });
  it('persists menu preferences separately and formats only safe integer totals', () => {
    const root = mkdtempSync(join(tmpdir(), 'gian-menubar-prefs-'));
    try {
      const store = new FileMenubarPreferences(join(root, 'prefs.json'));
      assert.deepEqual(store.load(), DEFAULT_MENUBAR_PREFERENCES);
      const prefs = { showTokens: false, showTodoCount: true, selection: { mode: 'rolling', period: 'month' } } as const;
      store.save(prefs);
      assert.deepEqual(store.load(), prefs);
      assert.equal(formatTrayTokens(999), '999');
      assert.equal(formatTrayTokens(1_200), '1.2K');
      assert.equal(formatTrayTokens(Number.MAX_SAFE_INTEGER + 1), '?');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
