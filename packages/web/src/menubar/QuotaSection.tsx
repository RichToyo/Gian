import type { OfficialQuotaAccount, OfficialQuotaSnapshot } from '@gian/shared';
import { formatTime } from './format.js';
import { AgentMark, agentBarColor } from './identity.js';
import { ICON, SvgIcon } from './icons.js';
import { buildQuotaRow, quotaRefreshKey } from './quota-row.js';

export type QuotaLoadState = 'idle' | 'loading' | 'ready' | 'error';

function updatedLabel(quota: OfficialQuotaSnapshot): string | null {
  const fetched = quota.accounts
    .map(a => a.fetchedAt)
    .filter((t): t is number => t != null);
  if (fetched.length === 0) return null;
  const latest = Math.max(...fetched);
  return Date.now() - latest < 45_000
    ? 'Updated just now'
    : `Updated ${formatTime(new Date(latest))}`;
}

/** Accounts opens expanded and reads the Host cache. Only a row's refresh
 * action initiates a query from this panel; background polling is Host-owned. */
export function QuotaSection({
  quota,
  expanded,
  refreshing,
  loadState,
  refreshFailed,
  onExpandedChange,
  onRefresh,
  onRetry,
}: {
  quota: OfficialQuotaSnapshot | null;
  expanded: boolean;
  refreshing: ReadonlySet<string>;
  loadState: QuotaLoadState;
  refreshFailed: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onRefresh: (account: OfficialQuotaAccount) => void;
  onRetry: () => void;
}) {
  const updated = expanded && quota && loadState === 'ready' ? updatedLabel(quota) : null;
  const failed = loadState === 'error' || refreshFailed;
  return (
    <section className="mb-sec">
      <button
        type="button"
        className="mb-q-head"
        aria-expanded={expanded}
        aria-controls="mb-quota-body"
        onClick={() => onExpandedChange(!expanded)}
      >
        <span className="mb-q-caret">
          <SvgIcon d={expanded ? ICON.caretDown : ICON.caretRight} size={13} />
        </span>
        <span className="mb-q-title">Accounts</span>
        {updated && <span className="mb-q-updated">{updated}</span>}
      </button>
      {expanded && (
        <div className="mb-q-body" id="mb-quota-body">
          {failed && (
            <div className="mb-q-notice" role="alert">
              <span>{loadState === 'error'
                ? quota?.accounts.length ? 'Could not load accounts. Showing previously loaded accounts.' : 'Could not load accounts.'
                : 'Some quotas could not be refreshed.'}</span>
              <button type="button" className="mb-iconbtn sm" title="Retry loading accounts" aria-label="Retry loading accounts"
                disabled={loadState === 'loading'} onClick={onRetry}>
                <SvgIcon d={ICON.refresh} size={13} />
              </button>
            </div>
          )}
          {(loadState === 'loading' || loadState === 'idle') && (
            <div className="mb-q-notice" role="status">{quota?.accounts.length ? 'Updating accounts...' : 'Loading accounts...'}</div>
          )}
          {quota && quota.accounts.length === 0 && loadState === 'ready' ? (
            <div className="mb-q-empty">No official accounts on installed agents</div>
          ) : (
            quota?.accounts.map(account => (
              <QuotaRow
                key={account.accountKey}
                account={account}
                refreshing={refreshing.has(quotaRefreshKey(account))}
                onRefresh={() => onRefresh(account)}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function QuotaRow({
  account,
  refreshing,
  onRefresh,
}: {
  account: OfficialQuotaAccount;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const row = buildQuotaRow(account);
  return (
    <div className={`mb-q-row${row.loading ? ' loading' : ''}`} data-quota-row={row.key}>
      <AgentMark pluginId={row.pluginId} size={16} className="mb-q-ico" />
      <span className="mb-q-main">
        <span className="mb-q-name">{row.name}</span>
        <span className="mb-q-sub" title={account.source === 'cli' && account.status === 'auth_required'
          ? 'AGY CLI authentication needs attention.' : undefined}>{row.subtitle}</span>
      </span>
      {row.stale && !refreshing && <span className="mb-q-tag">Stale</span>}
      <span className="mb-q-val">
        {row.loading ? (
          <span className="mb-q-skel" aria-label={`Loading ${row.name} quota`} />
        ) : refreshing ? (
          <span className="mb-spinner" aria-label={`Refreshing ${row.name}`} />
        ) : (
          <>
            {row.primary != null && (
              <span className={`mb-q-num${row.dim ? ' dim' : ''}`}>{row.primary}</span>
            )}
            {row.primaryUnit && !row.dim && <span className="mb-q-unit">{row.primaryUnit}</span>}
            {row.barRatio != null && !row.dim && (
              <span className="mb-q-bar">
                <i style={{ width: `${Math.round(row.barRatio * 100)}%`, background: agentBarColor(row.pluginId) }} />
              </span>
            )}
          </>
        )}
      </span>
      {row.refreshable && !row.loading && !refreshing && (
        <button
          type="button"
          className="mb-iconbtn sm mb-q-refresh"
          title={account.fetchedAt === null ? 'Refresh' : `Refresh. Last checked: ${new Date(account.fetchedAt).toLocaleString('en')}`}
          aria-label={`Refresh ${row.name}`}
          onClick={onRefresh}
        >
          <SvgIcon d={ICON.refresh} size={13} />
        </button>
      )}
    </div>
  );
}
