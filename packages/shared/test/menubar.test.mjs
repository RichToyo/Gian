import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isMenubarAppearance, isMenubarChange, isMenubarNavigation, isMenubarPending, isMenubarPreferences, isOfficialQuotaData, isOfficialQuotaSnapshot, isUsageClearRequest, isUsageSelection, sessionNeedsAttention } from '../dist/index.js';

describe('menubar request contract', () => {
  it('accepts six ranges and rejects unknown keys and modes', () => {
    for (const mode of ['calendar', 'rolling']) for (const period of ['day', 'week', 'month']) {
      assert.equal(isUsageSelection({ mode, period }), true);
    }
    assert.equal(isUsageSelection({ mode: 'calendar', period: 'year' }), false);
    assert.equal(isUsageSelection({ mode: 'calendar', period: 'day', url: 'https://example.com' }), false);
  });
  it('bounds navigation, preferences and confirmed clear parameters', () => {
    assert.equal(isMenubarNavigation({ sessionId: 's-1', revision: 'opaque:1' }), true);
    assert.equal(isMenubarNavigation({ sessionId: '../../secret', revision: '1' }), false);
    assert.equal(isMenubarPreferences({ showTokens: true, showTodoCount: true, selection: { mode: 'rolling', period: 'day' } }), true);
    assert.equal(isUsageClearRequest({ generation: 1, idempotencyKey: 'clear-1' }), true);
    assert.equal(isUsageClearRequest({ generation: Number.MAX_SAFE_INTEGER + 1, idempotencyKey: 'clear-1' }), false);
  });
  it('requires the existing SystemConfig accent in getter and change appearance', () => {
    for (const accent of ['rose', 'ember', 'citron', 'moss', 'teal', 'azure', 'ink', 'plum']) {
      const appearance = { theme: 'dark', accent, frameOpacity: 20 };
      assert.equal(isMenubarAppearance(appearance), true);
      assert.equal(isMenubarChange({ type: 'appearance', appearance }), true);
    }
    for (const appearance of [
      { theme: 'dark', frameOpacity: 100 },
      { theme: 'dark', accent: 'blue', frameOpacity: 100 },
      { theme: 'dark', accent: 'plum', frameOpacity: 19 },
      { theme: 'dark', accent: 'plum', frameOpacity: 101 },
      { theme: 'dark', accent: 'plum', frameOpacity: 20, token: 'forbidden' },
    ]) {
      assert.equal(isMenubarAppearance(appearance), false);
      assert.equal(isMenubarChange({ type: 'appearance', appearance }), false);
    }
    assert.equal(isMenubarChange({ type: 'opened' }), true);
    assert.equal(isMenubarChange({ type: 'quota', url: 'forbidden' }), false);
  });
  it('shares existing attention rules and permits domain interaction facts', () => {
    assert.equal(sessionNeedsAttention({ status: 'pending', unread: 0 }), true);
    assert.equal(sessionNeedsAttention({ status: 'pending', unread: 0 }, false), false);
    assert.equal(sessionNeedsAttention({ status: 'running', unread: 0 }, true), true);
    assert.equal(sessionNeedsAttention({ status: 'done', unread: 1 }, false), true);
    assert.equal(sessionNeedsAttention({ status: 'error', unread: 0 }, false), false);
  });
  it('rejects secret-bearing responses and does not fabricate missing quota windows', () => {
    assert.equal(isOfficialQuotaData({ windows: [], balances: [] }), true);
    assert.equal(isOfficialQuotaData({ windows: [], balances: [], token: 'forbidden' }), false);
    assert.equal(isMenubarPending({ pendingTotal: 0, pending: [] }), true);
    assert.equal(isMenubarPending({ pendingTotal: 0, pending: [{ sessionId: 's1' }] }), false);
  });
  it('keeps unimplemented, unsupported and unchecked states empty', () => {
    for (const status of ['unverified', 'not_implemented', 'unsupported', 'auth_required']) {
      const account = { accountKey: 'scope', agentIds: ['saved-agent'], pluginId: 'claude', label: 'Claude',
        eligibility: status, status, fetchedAt: null, freshness: 'none', error: null, windows: [], balances: [] };
      assert.equal(isOfficialQuotaSnapshot({ asOf: 1, accounts: [account] }), true);
      assert.equal(isOfficialQuotaSnapshot({ asOf: 1, accounts: [{ ...account, source: 'cli' }] }), true);
      assert.equal(isOfficialQuotaSnapshot({ asOf: 1, accounts: [{ ...account, source: 'unknown' }] }), false);
      assert.equal(isOfficialQuotaSnapshot({ asOf: 1, accounts: [{ ...account, source: 'cli', email: 'private@example.invalid' }] }), false);
      assert.equal(isOfficialQuotaSnapshot({ asOf: 1, accounts: [{ ...account,
        balances: [{ currency: 'USD', total: '1.00', granted: null, toppedUp: null }] }] }), false);
    }
  });
});
