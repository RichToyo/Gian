import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OfficialQuotaSnapshot } from '@gian/shared';
import { QuotaSection } from '../src/menubar/QuotaSection.js';
import { DEMO_NOW, makeQuotaAccount } from './menubar-fixtures.js';

function makeQuota(overrides: Partial<OfficialQuotaSnapshot> = {}): OfficialQuotaSnapshot {
  return {
    asOf: DEMO_NOW,
    accounts: [
      makeQuotaAccount(),
      makeQuotaAccount({
        accountKey: 'acct-dsh',
        agentIds: ['dsh'],
        pluginId: 'dsh',
        label: 'DeepSeek',
        windows: [],
        balances: [{ currency: 'CNY', total: '126.40', granted: null, toppedUp: null }],
      }),
      makeQuotaAccount({
        accountKey: 'acct-kimi',
        agentIds: ['kimi'],
        pluginId: 'kimi',
        label: 'Kimi',
        eligibility: 'auth_required',
        status: 'auth_required',
        fetchedAt: null,
        windows: [],
      }),
    ],
    ...overrides,
  };
}

function renderSection(overrides: Partial<Parameters<typeof QuotaSection>[0]> = {}) {
  const props = {
    quota: makeQuota(),
    expanded: true,
    refreshing: new Set<string>(),
    loadState: 'ready' as const,
    refreshFailed: false,
    onExpandedChange: vi.fn(),
    onRefresh: vi.fn(),
    onRetry: vi.fn(),
    ...overrides,
  };
  return { ...render(<QuotaSection {...props} />), props };
}

describe('QuotaSection', () => {
  it('does not present a missing/loading response as an empty account list', () => {
    const { rerender, props } = renderSection({ quota: null, loadState: 'loading' });
    expect(screen.getByRole('status')).toHaveTextContent('Loading accounts...');
    expect(screen.queryByText('No official accounts on installed agents')).toBeNull();
    rerender(<QuotaSection {...props} loadState="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load accounts.');
    expect(screen.queryByText('No official accounts on installed agents')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading accounts' }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it('keeps previously loaded rows on error, but does not show a previous empty result as current', () => {
    const { rerender, props } = renderSection({ loadState: 'error' });
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded accounts.');
    rerender(<QuotaSection {...props} quota={{ asOf: DEMO_NOW, accounts: [] }} />);
    expect(screen.queryByText('No official accounts on installed agents')).toBeNull();
  });
  it('can be collapsed and reports expansion instead of querying', () => {
    const { props } = renderSection({ expanded: false });
    expect(screen.queryByText('ChatGPT')).toBeNull();
    const head = screen.getByRole('button', { name: /accounts/i });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(head);
    expect(props.onExpandedChange).toHaveBeenCalledWith(true);
  });

  it('renders window and balance rows with real icons and no colored dots', () => {
    const { container } = renderSection();
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('78%')).toBeInTheDocument();
    expect(screen.getByText('5h remaining')).toBeInTheDocument();
    expect(screen.getByText('Weekly remaining 41%')).toBeInTheDocument();
    expect(screen.getByText('¥126.40')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(container.querySelectorAll('.mb-q-ico img').length).toBeGreaterThan(0);
  });

  it('keeps manual refresh available after native sign-in', () => {
    const { props } = renderSection();
    expect(screen.getByText('Sign in required')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /refresh kimi/i }));
    expect(props.onRefresh.mock.calls[0][0].agentIds).toEqual(['kimi']);
  });

  it('shows Not supported without a refresh button for unsupported accounts', () => {
    renderSection({
      quota: makeQuota({
        accounts: [makeQuotaAccount({
          accountKey: 'acct-grok', agentIds: ['grok'], pluginId: 'grok', label: 'Grok',
          eligibility: 'unsupported', status: 'unsupported', fetchedAt: null, windows: [],
        })],
      }),
    });
    expect(screen.getByText('Not supported')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /refresh grok/i })).toBeNull();
  });

  it('keeps the last value and marks Stale after a failed refresh', () => {
    renderSection({
      quota: makeQuota({ accounts: [makeQuotaAccount({ status: 'stale', freshness: 'stale' })] }),
    });
    expect(screen.getByText('Stale')).toBeInTheDocument();
    expect(screen.getByText('78%')).toBeInTheDocument();
  });

  it('shows a skeleton for loading rows and a spinner while refreshing', () => {
    const { container, rerender, props } = renderSection({
      quota: makeQuota({ accounts: [makeQuotaAccount({ status: 'loading', windows: [] })] }),
    });
    expect(container.querySelector('.mb-q-skel')).not.toBeNull();
    rerender(<QuotaSection {...props}
      quota={makeQuota()} refreshing={new Set(['codex'])} />);
    expect(container.querySelector('.mb-spinner')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /refresh chatgpt/i })).toBeNull();
  });

  it('fires refresh only from the row button', () => {
    const { props } = renderSection();
    fireEvent.click(screen.getByRole('button', { name: /refresh chatgpt/i }));
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
    expect(props.onRefresh.mock.calls[0][0].accountKey).toBe('acct-codex');
  });

  it('shows the English empty state when no installed official accounts exist', () => {
    renderSection({ quota: { asOf: DEMO_NOW, accounts: [] } });
    expect(screen.getByText('No official accounts on installed agents')).toBeInTheDocument();
  });

  it('shows the last successful update time in the header', () => {
    renderSection();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
  });
});
