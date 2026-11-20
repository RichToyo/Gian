import { describe, expect, it, vi } from 'vitest';
import {
  bucketRangeLabel,
  formatExact,
  formatTime,
  formatTokens,
  ongoingBucketIndex,
  sparkAxisLabels,
} from '../src/menubar/format.js';

const DEMO_NOW_PLACEHOLDER = new Date(2026, 9, 21, 17, 37, 0).getTime();

describe('formatTokens', () => {
  it('formats plain numbers below 1K', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(892)).toBe('892');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats K and M with one decimal, trimming trailing .0', () => {
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(36_200)).toBe('36.2K');
    expect(formatTokens(12_800_000)).toBe('12.8M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });
});

describe('formatExact', () => {
  it('uses thousands separators', () => {
    expect(formatExact(792_831)).toBe('792,831');
  });
});

describe('ongoingBucketIndex', () => {
  const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime();
  const buckets = [0, 1, 2].map(i => ({
    from: midnight + i * 3_600_000,
    to: midnight + (i + 1) * 3_600_000,
    tokens: 10,
    coverage: 'complete' as const,
  }));

  it('finds the bucket containing asOf', () => {
    expect(ongoingBucketIndex(buckets, midnight + 3_600_000 + 60_000)).toBe(1);
  });

  it('prefers the later bucket when asOf lands exactly on a boundary', () => {
    expect(ongoingBucketIndex(buckets, midnight + 3_600_000)).toBe(1);
  });

  it('returns -1 when the range lies entirely in the past', () => {
    expect(ongoingBucketIndex(buckets, midnight + 10 * 3_600_000)).toBe(-1);
  });
});

describe('bucketRangeLabel', () => {
  it('labels calendar hour buckets with a bare time range', () => {
    const from = new Date(2026, 9, 21, 17, 0, 0).getTime();
    const label = bucketRangeLabel({ from, to: from + 3_600_000, tokens: 1, coverage: 'complete' }, false,
      { mode: 'calendar', period: 'day' });
    expect(label).toBe('5:00 PM – 6:00 PM');
  });

  it('never claims a future endpoint for the ongoing hour bucket', () => {
    const from = new Date(2026, 9, 21, 17, 0, 0).getTime();
    const label = bucketRangeLabel({ from, to: from + 1_800_000, tokens: 1, coverage: 'complete' }, true,
      { mode: 'calendar', period: 'day' });
    expect(label).toBe('5:00 PM – Now');
  });

  it('labels midnight-aligned calendar day buckets by day name', () => {
    const from = new Date(2026, 9, 21, 0, 0, 0).getTime();
    const label = bucketRangeLabel({ from, to: from + 86_400_000, tokens: 1, coverage: 'complete' }, false,
      { mode: 'calendar', period: 'week' });
    expect(label).toBe('Wed, Oct 21');
  });

  it('marks the ongoing calendar day bucket', () => {
    const from = new Date(2026, 9, 21, 0, 0, 0).getTime();
    const label = bucketRangeLabel({ from, to: from + 63_000_000, tokens: 1, coverage: 'complete' }, true,
      { mode: 'calendar', period: 'week' });
    expect(label).toBe('Wed, Oct 21 · ongoing');
  });

  it('distinguishes the midnight hour from a truncated calendar day with identical endpoints', () => {
    const from = new Date(2026, 9, 21, 0, 0, 0).getTime();
    const bucket = { from, to: from + 1_800_000, tokens: 1, coverage: 'complete' as const };
    expect(bucketRangeLabel(bucket, true, { mode: 'calendar', period: 'day' })).toBe('12:00 AM – Now');
    expect(bucketRangeLabel(bucket, true, { mode: 'calendar', period: 'month' })).toBe('Wed, Oct 21 · ongoing');
    expect(bucketRangeLabel(bucket, true, { mode: 'rolling', period: 'day' })).toBe('Oct 21, 12:00 AM – Now');
  });

  it('keeps natural-day labels across 23-hour and 25-hour DST days', () => {
    vi.stubEnv('TZ', 'America/New_York');
    try {
      for (const [month, date, hours, label] of [[2, 8, 23, 'Sun, Mar 8'], [10, 1, 25, 'Sun, Nov 1']] as const) {
        const from = new Date(2026, month, date).getTime();
        const to = new Date(2026, month, date + 1).getTime();
        expect((to - from) / 3_600_000).toBe(hours);
        expect(bucketRangeLabel({ from, to, tokens: 1, coverage: 'complete' }, false,
          { mode: 'calendar', period: 'month' })).toBe(label);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps exact rolling endpoints even when a 24-hour bucket aligns with midnight', () => {
    const from = new Date(2026, 9, 20).getTime();
    expect(bucketRangeLabel({ from, to: from + 86_400_000, tokens: 1, coverage: 'complete' }, false,
      { mode: 'rolling', period: 'week' })).toBe('Oct 20, 12:00 AM – Oct 21, 12:00 AM');
  });

  it('labels rolling 24h buckets with exact day and time endpoints', () => {
    const from = new Date(2026, 9, 20, 17, 37, 0).getTime();
    const label = bucketRangeLabel({ from, to: from + 86_400_000, tokens: 1, coverage: 'complete' }, false,
      { mode: 'rolling', period: 'week' });
    expect(label).toBe('Oct 20, 5:37 PM – Oct 21, 5:37 PM');
  });

  it('labels rolling hour buckets with day context when misaligned', () => {
    const from = new Date(2026, 9, 20, 17, 37, 0).getTime();
    const label = bucketRangeLabel({ from, to: from + 3_600_000, tokens: 1, coverage: 'complete' }, false,
      { mode: 'rolling', period: 'day' });
    expect(label).toBe('Oct 20, 5:37 PM – 6:37 PM');
  });
});

describe('sparkAxisLabels', () => {
  it('labels calendar day with the first and last hour including minutes', () => {
    const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime();
    const buckets = Array.from({ length: 24 }, (_, i) => ({
      from: midnight + i * 3_600_000,
      to: midnight + (i + 1) * 3_600_000,
      tokens: null,
      coverage: 'complete' as const,
    }));
    expect(sparkAxisLabels({ mode: 'calendar', period: 'day' }, buckets)).toEqual(['12:00 AM', '11:00 PM']);
  });

  it('labels calendar week with day names and dates', () => {
    const monday = new Date(2026, 9, 19, 0, 0, 0).getTime();
    const buckets = Array.from({ length: 7 }, (_, i) => ({
      from: monday + i * 86_400_000,
      to: monday + (i + 1) * 86_400_000,
      tokens: null,
      coverage: 'complete' as const,
    }));
    expect(sparkAxisLabels({ mode: 'calendar', period: 'week' }, buckets)).toEqual(['Mon 19', 'Sun 25']);
  });

  it('labels rolling ranges with ago/Now endpoints', () => {
    const buckets = [{ from: DEMO_NOW_PLACEHOLDER - 86_400_000, to: DEMO_NOW_PLACEHOLDER, tokens: null, coverage: 'complete' as const }];
    expect(sparkAxisLabels({ mode: 'rolling', period: 'day' }, buckets)).toEqual(['24h ago', 'Now']);
    expect(sparkAxisLabels({ mode: 'rolling', period: 'month' }, buckets)).toEqual(['30d ago', 'Now']);
  });

  it('returns empty labels for empty buckets', () => {
    expect(sparkAxisLabels({ mode: 'calendar', period: 'day' }, [])).toEqual(['', '']);
  });
});

describe('formatTime', () => {  it('formats 12-hour clock with AM/PM', () => {
    expect(formatTime(new Date(2026, 9, 21, 0, 0, 0))).toBe('12:00 AM');
    expect(formatTime(new Date(2026, 9, 21, 12, 0, 0))).toBe('12:00 PM');
    expect(formatTime(new Date(2026, 9, 21, 17, 37, 0))).toBe('5:37 PM');
  });
});
