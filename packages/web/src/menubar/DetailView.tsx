import type { UsageGroup, UsageSummary } from '@gian/shared';
import { formatTokens } from './format.js';
import { AgentMark, agentBarColor } from './identity.js';
import { ICON, SvgIcon } from './icons.js';

/** Secondary view: token breakdown by Agent and by model for the selected
 * range. Rows render in Host order; icons are real brand marks, with the
 * generic bot for unknown/mixed identity. */
export function DetailView({
  summary,
  periodLabel,
  onBack,
}: {
  summary: UsageSummary | null;
  periodLabel: string;
  onBack: () => void;
}) {
  const justStarted = summary != null && summary.trackingStartedAt > summary.from;
  const partial = summary != null && summary.coverage === 'partial';
  return (
    <div className="mb-view">
      <div className="mb-d-head">
        <button type="button" className="mb-iconbtn" title="Back" aria-label="Back" onClick={onBack}>
          <SvgIcon d={ICON.chevronLeft} size={15} />
        </button>
        <span className="mb-d-title">Token details</span>
        <span className="mb-d-period">{periodLabel}</span>
      </div>
      <div className="mb-d-body">
        <div className="mb-d-sec">
          <div className="mb-sec-head"><span className="mb-sec-label">By agent</span></div>
          {summary ? <BreakdownRows groups={summary.byAgent} total={summary.totalTokens} branded /> : null}
        </div>
        <div className="mb-d-sec">
          <div className="mb-sec-head"><span className="mb-sec-label">By model</span></div>
          {summary ? <BreakdownRows groups={summary.byModel} total={summary.totalTokens} branded={false} /> : null}
        </div>
        {partial && (
          <div className="mb-state-note">
            <SvgIcon d={ICON.info} size={13} />
            <span>Some sources aren’t reporting; actual usage may be higher</span>
          </div>
        )}
        {!partial && justStarted && (
          <div className="mb-state-note calm">
            <SvgIcon d={ICON.info} size={13} />
            <span>Just started — data still incomplete</span>
          </div>
        )}
      </div>
    </div>
  );
}

function BreakdownRows({
  groups,
  total,
  branded,
}: {
  groups: readonly UsageGroup[];
  total: number;
  branded: boolean;
}) {
  if (groups.length === 0) {
    return <div className="mb-d-empty">No usage in this range</div>;
  }
  return (
    <>
      {groups.map(group => {
        const pct = total > 0 ? Math.round((group.totalTokens / total) * 100) : 0;
        return (
          <div className="mb-d-row" key={group.id ?? 'unknown'}>
            <span className="mb-d-line">
              <AgentMark pluginId={group.pluginId} size={16} className="mb-d-ico" />
              <span className="mb-d-name">{group.label}</span>
              <span className="mb-d-pct">{pct}%</span>
              <span className="mb-d-val">{formatTokens(group.totalTokens)}</span>
            </span>
            <span className="mb-d-track">
              <i style={{ width: `${pct}%`, background: branded ? agentBarColor(group.pluginId) : 'var(--accent)' }} />
            </span>
          </div>
        );
      })}
    </>
  );
}
