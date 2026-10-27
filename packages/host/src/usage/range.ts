import type { UsageSelection } from '@gian/shared';
import { normalizeTimezone } from '../schedule/trigger.js';

const HOUR = 3_600_000;
/** Calendar arithmetic delegates DST/offset transitions to the Host's Date
 * implementation. The product uses this Host's current local zone only. */
export function usageRange(selection: UsageSelection, now: number): {
  from: number; to: number; timezone: string; boundaries: number[];
} {
  const timezone = normalizeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const end = now;
  let from: number;
  const boundaries: number[] = [];
  if (selection.mode === 'rolling') {
    const hours = selection.period === 'day' ? 24 : selection.period === 'week' ? 168 : 720;
    from = now - hours * HOUR;
    const step = selection.period === 'day' ? HOUR : 24 * HOUR;
    for (let at = from; at < end; at += step) boundaries.push(at);
  } else {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (selection.period === 'week') start.setDate(start.getDate() - (start.getDay() + 6) % 7);
    if (selection.period === 'month') start.setDate(1);
    from = start.getTime();
    if (selection.period === 'day') {
      // Real elapsed hours preserve both occurrences of a repeated DST hour.
      for (let at = from; at < end; at += HOUR) boundaries.push(at);
    } else {
      for (const day = new Date(from); day.getTime() < end; day.setDate(day.getDate() + 1)) {
        boundaries.push(day.getTime());
      }
    }
  }
  if (boundaries.length === 0) boundaries.push(from);
  boundaries.push(end);
  return { from, to: end, timezone, boundaries };
}
