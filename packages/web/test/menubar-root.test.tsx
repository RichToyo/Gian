import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MenubarSnapshot, OfficialQuotaSnapshot, UsageSelection } from '@gian/shared';
import { MenubarRoot } from '../src/menubar/MenubarRoot.js';
import { deferred, makeBridge, makeQuotaAccount, makeSnapshot, makeTodo, USER_AUTHORED_TITLE, type Deferred } from './menubar-fixtures.js';

async function flush(): Promise<void> {
  await act(async () => {});
}

describe('MenubarRoot', () => {
  it('keeps Accounts loading/error separate from a healthy local Host and provides a retry', async () => {
    const waiting = deferred<OfficialQuotaSnapshot>();
    const getQuota = vi.fn().mockImplementationOnce(() => waiting.promise)
      .mockResolvedValue({ asOf: 2, accounts: [makeQuotaAccount()] });
    const { bridge } = makeBridge({ getQuota });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Loading accounts...');
    expect(screen.queryByText('No official accounts on installed agents')).toBeNull();
    waiting.reject(new Error('quota list failed'));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load accounts.');
    expect(screen.queryByText(/can’t reach the gian host/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Rolling' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load accounts.');
    expect(screen.queryByText('No official accounts on installed agents')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading accounts' }));
    await flush();
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(bridge.refreshQuota).not.toHaveBeenCalled();
  });

  it('does not clear local-data failure merely because the quota list succeeds', async () => {
    const { bridge } = makeBridge({ getSnapshot: vi.fn(async () => { throw new Error('local snapshot failed'); }) });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    expect(screen.getByText(/can’t reach the gian host/i)).toBeInTheDocument();
    expect(screen.getByText('No official accounts on installed agents')).toBeInTheDocument();
  });

  it('keeps known account rows when a later cache read fails and ignores superseded read errors', async () => {
    const late = deferred<OfficialQuotaSnapshot>();
    const getQuota = vi.fn().mockResolvedValueOnce({ asOf: 1, accounts: [makeQuotaAccount()] })
      .mockImplementationOnce(() => late.promise)
      .mockResolvedValue({ asOf: 3, accounts: [makeQuotaAccount()] });
    const { bridge, emit } = makeBridge({ getQuota });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    act(() => emit({ type: 'quota' }));
    await flush();
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    act(() => emit({ type: 'quota' }));
    await flush();
    late.reject(new Error('older request failed'));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    getQuota.mockRejectedValueOnce(new Error('new read failed'));
    act(() => emit({ type: 'quota' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Showing previously loaded accounts.');
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.queryByText(/can’t reach the gian host/i)).toBeNull();
  });

  it('does not overwrite a refreshed account list with an older cache response', async () => {
    const cached = deferred<OfficialQuotaSnapshot>();
    const refreshed = deferred<OfficialQuotaSnapshot>();
    const { bridge, emit } = makeBridge({
      getQuota: vi.fn().mockResolvedValueOnce({ asOf: 1, accounts: [makeQuotaAccount({ status: 'unverified',
        eligibility: 'unverified', freshness: 'none', fetchedAt: null, windows: [] })] }).mockImplementation(() => cached.promise),
      refreshQuota: vi.fn(() => refreshed.promise),
    });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh ChatGPT' }));
    await flush();
    act(() => emit({ type: 'quota' }));
    await flush();
    refreshed.resolve({ asOf: 3, accounts: [makeQuotaAccount()] });
    await flush();
    cached.resolve({ asOf: 2, accounts: [] });
    await flush();
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.queryByText('No official accounts on installed agents')).toBeNull();
  });

  it('reports a rejected quota refresh locally and keeps the last known rows', async () => {
    const { bridge } = makeBridge({ getQuota: vi.fn(async () => ({ asOf: 1, accounts: [makeQuotaAccount()] })),
      refreshQuota: vi.fn(async () => { throw new Error('refresh failed'); }) });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh ChatGPT' }));
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Some quotas could not be refreshed.');
    expect(screen.getByText('ChatGPT')).toBeInTheDocument();
    expect(screen.queryByText(/can’t reach the gian host/i)).toBeNull();
  });
  it('loads preferences, appearance and the snapshot on mount', async () => {
    const { bridge } = makeBridge();
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    expect(bridge.getPreferences).toHaveBeenCalledTimes(1);
    expect(bridge.getAppearance).toHaveBeenCalledTimes(1);
    expect(bridge.getSnapshot).toHaveBeenCalledWith({ mode: 'calendar', period: 'day' });
    expect(document.body.dataset.theme).toBe('dark');
    expect(document.body.dataset.accent).toBe('azure');
    expect(document.body.style.getPropertyValue('--frame-opacity')).toBe('100');
  });

  it('discards a late response for a superseded selection', async () => {
    const pending = new Map<string, Deferred<MenubarSnapshot>>();
    const { bridge } = makeBridge({
      getSnapshot: vi.fn((selection: UsageSelection) => {
        const key = `${selection.mode}:${selection.period}`;
        if (!pending.has(key)) pending.set(key, deferred<MenubarSnapshot>());
        return pending.get(key)!.promise;
      }),
    });
    render(<MenubarRoot bridge={bridge} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: 'Rolling' }));
    await flush();
    // The newer request resolves first, then the stale one.
    pending.get('rolling:day')!.resolve(makeSnapshot({ mode: 'rolling', period: 'day' }));
    await flush();
    expect(screen.getByText('Last 24 hours')).toBeInTheDocument();
    pending.get('calendar:day')!.resolve(makeSnapshot({ mode: 'calendar', period: 'day' }));
    await flush();
    // Stale calendar data must not overwrite the newer rolling selection.
    expect(screen.getByText('Last 24 hours')).toBeInTheDocument();
  });

  it('opened resets Todo to collapsed and Accounts to expanded, then reads caches', async () => {
    const snapshot = makeSnapshot(
      { mode: 'calendar', period: 'day' },
      {
        pendingTotal: 5,
        pending: Array.from({ length: 3 }, (_, i) => makeTodo({ sessionId: `s-${i}`, revision: 'r' })),
      },
    );
    const { bridge, emit } = makeBridge({
      getSnapshot: vi.fn(async () => snapshot),
      getPending: vi.fn(async () => ({
        pendingTotal: 5,
        pending: Array.from({ length: 5 }, (_, i) => makeTodo({ sessionId: `s-${i}`, revision: 'r' })),
      })),
    });
    render(<MenubarRoot bridge={bridge} />);
    await flush();

    fireEvent.click(screen.getByRole('button', { name: /all/i }));
    await flush();
    expect(screen.getByRole('button', { name: /less/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /accounts/i }));
    await flush();

    act(() => emit({ type: 'opened' }));
    await flush();
    expect(screen.queryByRole('button', { name: /less/i })).toBeNull();
    expect(screen.getByRole('button', { name: /all/i })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /accounts/i })).toHaveAttribute('aria-expanded', 'true');
    expect(bridge.refreshQuota).not.toHaveBeenCalled();
  });

  it('refetches when navigation reports a stale target', async () => {
    const snapshot = makeSnapshot(
      { mode: 'calendar', period: 'day' },
      { pendingTotal: 1, pending: [makeTodo()] },
    );
    const { bridge } = makeBridge({
      getSnapshot: vi.fn(async () => snapshot),
      navigate: vi.fn(async () => false),
    });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    fireEvent.click(screen.getByText(USER_AUTHORED_TITLE));
    await flush();
    expect(bridge.navigate).toHaveBeenCalledWith({ sessionId: 's-1', revision: 'r1' });
    expect((bridge.getSnapshot as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('opens expanded and reads cache on mount, reopen and expansion without querying accounts', async () => {
    const { bridge, emit } = makeBridge({
      getQuota: vi.fn(async () => ({ asOf: 0, accounts: [makeQuotaAccount({ eligibility: 'unverified', status: 'unverified', freshness: 'none', fetchedAt: null, windows: [] })] })),
      refreshQuota: vi.fn(async () => ({ asOf: 0, accounts: [makeQuotaAccount()] })),
    });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    expect(bridge.getQuota).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /accounts/i })).toHaveAttribute('aria-expanded', 'true');
    expect(bridge.refreshQuota).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /accounts/i }));
    fireEvent.click(screen.getByRole('button', { name: /accounts/i }));
    await flush();
    expect(bridge.getQuota).toHaveBeenCalledTimes(2);
    act(() => emit({ type: 'opened' }));
    await flush();
    expect(bridge.getQuota).toHaveBeenCalledTimes(3);
    expect(bridge.refreshQuota).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh ChatGPT' }));
    await flush();
    expect(bridge.refreshQuota).toHaveBeenCalledWith('codex');
    expect(bridge.refreshQuota).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh quota cache on expansion without a new native query', async () => {
    const { bridge } = makeBridge({ getQuota: vi.fn(async () => ({ asOf: 0, accounts: [makeQuotaAccount()] })) });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /accounts/i }));
    fireEvent.click(screen.getByRole('button', { name: /accounts/i }));
    await flush();
    expect(bridge.refreshQuota).not.toHaveBeenCalled();
  });

  it('rechecks sign-in-required accounts only through their explicit refresh button', async () => {
    const { bridge } = makeBridge({ getQuota: vi.fn(async () => ({ asOf: 0, accounts: [makeQuotaAccount({
      eligibility: 'auth_required', status: 'auth_required', freshness: 'fresh', windows: [],
    })] })) });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    expect(bridge.refreshQuota).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh ChatGPT' }));
    await flush();
    expect(bridge.refreshQuota).toHaveBeenCalledWith('codex');
  });

  it('reads Host background results on local notifications without launching another query', async () => {
    const getQuota = vi.fn().mockResolvedValueOnce({ asOf: 1, accounts: [makeQuotaAccount({
      status: 'unverified', eligibility: 'unverified', fetchedAt: null, freshness: 'none', windows: [],
    })] }).mockResolvedValue({ asOf: 2, accounts: [makeQuotaAccount()] });
    const { bridge, emit } = makeBridge({ getQuota });
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    expect(screen.getByText('Not checked')).toBeInTheDocument();
    act(() => emit({ type: 'local' }));
    await flush();
    expect(screen.queryByText('Not checked')).toBeNull();
    expect(screen.getByText('78%')).toBeInTheDocument();
    expect(bridge.refreshQuota).not.toHaveBeenCalled();
  });

  it('calls hide on Escape', async () => {
    const { bridge } = makeBridge();
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bridge.hide).toHaveBeenCalledTimes(1);
  });

  it('clears stats with the current generation and an idempotency key', async () => {
    const { bridge } = makeBridge();
    render(<MenubarRoot bridge={bridge} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByText('Clear Token Stats…'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await flush();
    expect(bridge.clearUsage).toHaveBeenCalledTimes(1);
    const input = (bridge.clearUsage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(input.generation).toBe(1);
    expect(input.idempotencyKey).toMatch(/^[a-zA-Z0-9_.:-]{1,128}$/);
  });
});
