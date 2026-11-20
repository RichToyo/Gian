import type { OfficialQuotaAccount, OfficialQuotaBalance, OfficialQuotaWindow } from '@gian/shared';

/* Pure mapping from the official-quota DTO to a display row. No window or
 * balance is ever synthesized: accounts show exactly what the official source
 * reported. Amounts stay decimal strings — display prepends the currency
 * symbol without float arithmetic. */

export interface QuotaRowModel {
  key: string;
  pluginId: string;
  name: string;
  subtitle: string;
  status: OfficialQuotaAccount['status'];
  primary: string | null;
  primaryUnit: string | null;
  /** Remaining ratio 0..1 for the thin bar; null when not applicable. */
  barRatio: number | null;
  /** Dimmed neutral text (auth required / unsupported / unavailable). */
  dim: boolean;
  refreshable: boolean;
  stale: boolean;
  loading: boolean;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  EUR: '€',
  GBP: '£',
};

export function formatBalance(balance: OfficialQuotaBalance): string {
  const symbol = CURRENCY_SYMBOLS[balance.currency];
  return symbol ? `${symbol}${balance.total}` : `${balance.currency} ${balance.total}`;
}

function remainingPercent(window: OfficialQuotaWindow): number | null {
  if (window.usedRatio == null) return null;
  return Math.round((1 - window.usedRatio) * 100);
}

/** Refresh calls are per Agent id; accounts with several linked Agents refresh
 * through the first one. */
export function quotaRefreshKey(account: OfficialQuotaAccount): string {
  return account.agentIds[0] ?? account.accountKey;
}

export function buildQuotaRow(account: OfficialQuotaAccount): QuotaRowModel {
  const accountLabel = account.source === 'cli' ? 'CLI account' : 'Official account';
  const subtitle = (detail: string) => account.source === 'cli' ? `CLI account · ${detail}` : detail;
  const base = {
    key: account.accountKey,
    pluginId: account.pluginId,
    name: account.label,
    status: account.status,
    stale: account.status === 'stale',
    loading: account.status === 'loading',
  };

  if (account.status === 'auth_required') {
    return {
      ...base, subtitle: accountLabel, primary: 'Sign in required',
      primaryUnit: null, barRatio: null, dim: true, refreshable: true,
    };
  }
  if (account.status === 'unsupported') {
    return {
      ...base, subtitle: accountLabel, primary: 'Not supported',
      primaryUnit: null, barRatio: null, dim: true, refreshable: false,
    };
  }
  if (account.status === 'not_implemented') {
    return {
      ...base, subtitle: accountLabel, primary: 'Not available yet',
      primaryUnit: null, barRatio: null, dim: true, refreshable: false,
    };
  }

  const windows = account.windows;
  const balances = account.balances;
  const refreshable = account.eligibility === 'eligible' || account.eligibility === 'unverified';
  if (account.status === 'unverified') {
    return { ...base, subtitle: accountLabel, primary: 'Not checked', primaryUnit: null,
      barRatio: null, dim: true, refreshable: true };
  }

  const primaryWindow = windows[0];
  if (primaryWindow) {
    const pct = remainingPercent(primaryWindow);
    const secondary = windows[1] ? remainingPercent(windows[1]) : null;
    const details = windows[1]
      ? subtitle(`${windows[1].label} remaining${secondary == null ? '' : ` ${secondary}%`}`)
      : balances.length > 0 ? subtitle(`Balance ${balances.map(formatBalance).join(' · ')}`) : accountLabel;
    return {
      ...base,
      subtitle: details,
      primary: pct == null ? null : `${pct}%`,
      primaryUnit: `${primaryWindow.label} remaining`,
      barRatio: pct == null ? null : pct / 100,
      dim: false,
      refreshable,
    };
  }

  if (balances.length > 0) {
    return {
      ...base,
      subtitle: subtitle('Balance'),
      primary: balances.map(formatBalance).join(' · '),
      primaryUnit: null,
      barRatio: null,
      dim: false,
      refreshable,
    };
  }

  // Error (or not yet fetched) with no retained values: honest unknown, never 0.
  return {
    ...base,
    subtitle: accountLabel,
    primary: account.error === 'timeout' ? 'Timed out' : account.error === 'rate_limited' ? 'Rate limited' : 'Unavailable',
    primaryUnit: null,
    barRatio: null,
    dim: true,
    refreshable,
  };
}
