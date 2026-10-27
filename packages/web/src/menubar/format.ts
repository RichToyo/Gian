import type { UsageBucket, UsageSelection } from '@gian/shared';

/* Number and time formatting for the menubar panel. All times arrive as UTC
 * epoch milliseconds and are rendered in the Host's local timezone via Date. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Compact token count: 892 / 36.2K / 12.8M — one decimal, trailing .0 trimmed. */
export function formatTokens(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '');
  if (n >= 1e6) return `${trim(n / 1e6)}M`;
  if (n >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

/** Thousands-separated exact value for tooltips: 792,831. */
export function formatExact(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatTime(d: Date): string {
  let h = d.getHours();
  const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`;
}

export function formatDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function formatDayName(d: Date): string {
  return `${DAYS[d.getDay()]}, ${formatDay(d)}`;
}

export function formatDayTime(d: Date): string {
  return `${formatDay(d)}, ${formatTime(d)}`;
}

const DAY_MS = 86_400_000;

function isLocalMidnight(ms: number): boolean {
  const d = new Date(ms);
  return d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

function isHourAligned(ms: number): boolean {
  const d = new Date(ms);
  return d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
}

/** Index of the in-progress bucket: the Host truncates the current bucket at
 * asOf, so it is the last bucket whose [from, to) contains asOf. -1 when the
 * selection lies entirely in the past. */
export function ongoingBucketIndex(buckets: readonly UsageBucket[], asOf: number): number {
  let found = -1;
  for (const [i, b] of buckets.entries()) {
    if (b.from <= asOf && asOf <= b.to) found = i;
  }
  return found;
}

/** Accurate bucket time range for the bar tooltip. Calendar day buckets are
 * midnight-aligned and read "Wed, Oct 21"; rolling 24h buckets carry their
 * exact times; sub-day buckets show a time range. The ongoing bucket never
 * claims a future endpoint. */
export function bucketRangeLabel(bucket: UsageBucket, ongoing: boolean): string {
  const from = new Date(bucket.from);
  const to = new Date(bucket.to);
  const span = bucket.to - bucket.from;
  if (span >= DAY_MS && isLocalMidnight(bucket.from) && isLocalMidnight(bucket.to)) {
    return ongoing ? `${formatDayName(from)} · ongoing` : formatDayName(from);
  }
  if (span >= DAY_MS) {
    return ongoing
      ? `${formatDayTime(from)} – Now`
      : `${formatDayTime(from)} – ${formatDayTime(to)}`;
  }
  if (ongoing) {
    return isHourAligned(bucket.from)
      ? `${formatTime(from)} – Now`
      : `${formatDayTime(from)} – Now`;
  }
  if (isHourAligned(bucket.from) && isHourAligned(bucket.to)) {
    return `${formatTime(from)} – ${formatTime(to)}`;
  }
  return formatDay(from) === formatDay(to)
    ? `${formatDay(from)}, ${formatTime(from)} – ${formatTime(to)}`
    : `${formatDayTime(from)} – ${formatDayTime(to)}`;
}

export const PERIOD_LABELS: Record<UsageSelection['mode'], Record<UsageSelection['period'], string>> = {
  calendar: { day: 'Today', week: 'This Week', month: 'This Month' },
  rolling: { day: '24h', week: '7d', month: '30d' },
};

/** Big-number subtitle under the total: "Today", "Last 24 hours", … */
export const RANGE_SUBTITLES: Record<UsageSelection['mode'], Record<UsageSelection['period'], string>> = {
  calendar: { day: 'Today', week: 'This Week', month: 'This Month' },
  rolling: { day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days' },
};

/** Compact first/last axis labels under the sparkline. */
export function sparkAxisLabels(selection: UsageSelection, buckets: readonly UsageBucket[]): [string, string] {
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (!first || !last) return ['', ''];
  if (selection.mode === 'rolling') {
    const ago = { day: '24h ago', week: '7d ago', month: '30d ago' }[selection.period];
    return [ago, 'Now'];
  }
  if (selection.period === 'day') {
    return [formatTime(new Date(first.from)), formatTime(new Date(last.from))];
  }
  if (selection.period === 'week') {
    const label = (ms: number) => {
      const d = new Date(ms);
      return `${DAYS[d.getDay()]} ${d.getDate()}`;
    };
    return [label(first.from), label(last.from)];
  }
  return [formatDay(new Date(first.from)), formatDay(new Date(last.from))];
}
