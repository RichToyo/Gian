import { describe, expect, it } from 'vitest';
import { buildQuotaRow, formatBalance, quotaRefreshKey } from '../src/menubar/quota-row.js';
import { DEMO_NOW, makeQuotaAccount } from './menubar-fixtures.js';

describe('formatBalance', () => {
  it('prefixes the currency symbol without float arithmetic', () => {
    expect(formatBalance({ currency: 'CNY', total: '126.40', granted: null, toppedUp: null })).toBe('¥126.40');
    expect(formatBalance({ currency: 'USD', total: '5.00', granted: null, toppedUp: null })).toBe('$5.00');
  });

  it('falls back to the currency code for unknown currencies', () => {
    expect(formatBalance({ currency: 'CHF', total: '9.90', granted: null, toppedUp: null })).toBe('CHF 9.90');
  });
});

describe('buildQuotaRow', () => {
  it('always distinguishes CLI quota from the session Runtime account', () => {
    const ready = buildQuotaRow(makeQuotaAccount({ source: 'cli' }));
    expect(ready.subtitle).toBe('CLI account · Weekly remaining 41%');
    for (const status of ['unverified', 'auth_required', 'unsupported', 'error'] as const) {
      const row = buildQuotaRow(makeQuotaAccount({ source: 'cli', status, windows: [], balances: [] }));
      expect(row.subtitle).toBe('CLI account');
    }
  });
  it('does not label a missing Gian reader as an unsupported provider', () => {
    const row = buildQuotaRow(makeQuotaAccount({ eligibility: 'not_implemented', status: 'not_implemented', windows: [], balances: [] }));
    expect(row.primary).toBe('Not available yet');
    expect(row.refreshable).toBe(false);
    expect(row.barRatio).toBeNull();
  });
  it('keeps a prepaid balance visible alongside a single quota window', () => {
    const account = makeQuotaAccount();
    const row = buildQuotaRow({ ...account, windows: account.windows.slice(0, 1),
      balances: [{ currency: 'USD', total: '12.34', granted: null, toppedUp: null }] });
    expect(row.primary).toBe('78%');
    expect(row.subtitle).toBe('Balance $12.34');
  });
  it('keeps an installed unchecked Agent visible without inventing quota', () => {
    const row = buildQuotaRow(makeQuotaAccount({ eligibility: 'unverified', status: 'unverified',
      freshness: 'none', fetchedAt: null, windows: [], balances: [] }));
    expect(row.primary).toBe('Not checked');
    expect(row.barRatio).toBeNull();
    expect(row.refreshable).toBe(true);
  });
  it('shows the first window as primary and demotes the second to the subtitle', () => {
    const row = buildQuotaRow(makeQuotaAccount());
    expect(row.primary).toBe('78%');
    expect(row.primaryUnit).toBe('5h remaining');
    expect(row.subtitle).toBe('Weekly remaining 41%');
    expect(row.barRatio).toBeCloseTo(0.78);
    expect(row.refreshable).toBe(true);
    expect(row.dim).toBe(false);
  });

  it('shows a single real window without inventing a second one', () => {
    const row = buildQuotaRow(makeQuotaAccount({
      windows: [{ id: '5h', label: '5h', usedRatio: 0.5, resetAt: null, windowDurationMinutes: 300 }],
    }));
    expect(row.primary).toBe('50%');
    expect(row.subtitle).toBe('Official account');
  });

  it('shows balances with currency separation and no percentage bar', () => {
    const row = buildQuotaRow(makeQuotaAccount({
      pluginId: 'dsh',
      label: 'DeepSeek',
      windows: [],
      balances: [
        { currency: 'CNY', total: '126.40', granted: null, toppedUp: null },
        { currency: 'USD', total: '5.00', granted: null, toppedUp: null },
      ],
    }));
    expect(row.primary).toBe('¥126.40 · $5.00');
    expect(row.subtitle).toBe('Balance');
    expect(row.barRatio).toBeNull();
  });

  it('keeps a refresh button for manual recovery after native sign-in', () => {
    const row = buildQuotaRow(makeQuotaAccount({
      eligibility: 'auth_required',
      status: 'auth_required',
      windows: [],
    }));
    expect(row.primary).toBe('Sign in required');
    expect(row.dim).toBe(true);
    expect(row.refreshable).toBe(true);
  });

  it('renders unsupported as a dim state without a refresh button', () => {
    const row = buildQuotaRow(makeQuotaAccount({
      eligibility: 'unsupported',
      status: 'unsupported',
      windows: [],
    }));
    expect(row.primary).toBe('Not supported');
    expect(row.dim).toBe(true);
    expect(row.refreshable).toBe(false);
  });

  it('distinguishes a timed out query from a missing balance', () => {
    const row = buildQuotaRow(makeQuotaAccount({
      status: 'error',
      error: 'timeout',
      fetchedAt: null,
      windows: [],
    }));
    expect(row.primary).toBe('Timed out');
    expect(row.dim).toBe(true);
    expect(row.refreshable).toBe(true);
  });

  it('keeps retained values on a failed refresh and marks the row stale', () => {
    const row = buildQuotaRow(makeQuotaAccount({ status: 'stale', freshness: 'stale' }));
    expect(row.primary).toBe('78%');
    expect(row.stale).toBe(true);
    expect(row.dim).toBe(false);
  });

  it('marks loading rows', () => {
    const row = buildQuotaRow(makeQuotaAccount({ status: 'loading', windows: [] }));
    expect(row.loading).toBe(true);
  });
});

describe('quotaRefreshKey', () => {
  it('refreshes through the first linked Agent id', () => {
    expect(quotaRefreshKey(makeQuotaAccount())).toBe('codex');
    expect(quotaRefreshKey(makeQuotaAccount({ agentIds: [] }))).toBe('acct-codex');
  });
});
