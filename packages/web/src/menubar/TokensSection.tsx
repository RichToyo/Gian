import type { UsageSelection, UsageSummary } from '@gian/shared';
import { formatTokens, PERIOD_LABELS, RANGE_SUBTITLES, sparkAxisLabels } from './format.js';
import { ICON, SvgIcon } from './icons.js';
import { Sparkline } from './Sparkline.js';

const MODES: readonly UsageSelection['mode'][] = ['calendar', 'rolling'];
const PERIODS: readonly UsageSelection['period'][] = ['day', 'week', 'month'];

/** Tokens section: big number for the selected range, mode/period segmented
 * controls, compact trend with axis labels, and coverage notes. A summary
 * whose selection no longer matches is stale — the section shows its loading
 * skeleton until the matching summary arrives. */
export function TokensSection({
  summary,
  selection,
  onSelectSelection,
  onOpenDetail,
}: {
  summary: UsageSummary | null;
  selection: UsageSelection;
  onSelectSelection: (selection: UsageSelection) => void;
  onOpenDetail: () => void;
}) {
  const current = summary
    && summary.selection.mode === selection.mode
    && summary.selection.period === selection.period
    ? summary
    : null;
  const justStarted = current != null && current.trackingStartedAt > current.from;
  const partial = current != null && current.coverage === 'partial';
  const totalText = current ? formatTokens(current.totalTokens) : null;
  const totalMatch = totalText?.match(/^([\d.]+)([KM]?)$/);
  const axis = current ? sparkAxisLabels(selection, current.buckets) : null;

  return (
    <section className="mb-sec">
      <div className="mb-sec-head">
        <span className="mb-sec-label">Tokens</span>
        <span className="mb-spacer" />
        <div className="mb-segm mini" role="group" aria-label="Range mode">
          {MODES.map(mode => (
            <button
              key={mode}
              type="button"
              className={`mb-segm-item${selection.mode === mode ? ' active' : ''}`}
              onClick={() => onSelectSelection({ mode, period: selection.period })}
            >
              {mode === 'calendar' ? 'Calendar' : 'Rolling'}
            </button>
          ))}
        </div>
        <button type="button" className="mb-iconbtn sm" title="Token details" aria-label="Token details" onClick={onOpenDetail}>
          <SvgIcon d={ICON.caretRight} size={13} />
        </button>
      </div>

      <button type="button" className="mb-tnum-btn" title="Token details" onClick={onOpenDetail}>
        <span className="mb-tnum-main">
          {current && totalMatch ? (
            <span className="mb-tnum">
              {totalMatch[1]}
              {totalMatch[2] && <span className="mb-tnum-unit">{totalMatch[2]}</span>}
            </span>
          ) : (
            <span className="mb-tnum-skel" aria-label="Loading token total" />
          )}
          <span className="mb-tnum-sub">
            {RANGE_SUBTITLES[selection.mode][selection.period]}
            {justStarted ? ' · Just started' : ''}
          </span>
        </span>
        <span className="mb-spark-wrap">
          {current
            ? <Sparkline buckets={current.buckets} asOf={current.asOf} selection={current.selection} />
            : <span className="mb-spark-skel" aria-hidden="true" />}
          <span className="mb-spark-axis">
            <span>{axis?.[0] ?? ''}</span>
            <span>{axis?.[1] ?? ''}</span>
          </span>
        </span>
      </button>

      <div className="mb-segm full" role="group" aria-label="Range period">
        {PERIODS.map(period => (
          <button
            key={period}
            type="button"
            className={`mb-segm-item${selection.period === period ? ' active' : ''}`}
            onClick={() => onSelectSelection({ mode: selection.mode, period })}
          >
            {PERIOD_LABELS[selection.mode][period]}
          </button>
        ))}
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
    </section>
  );
}
