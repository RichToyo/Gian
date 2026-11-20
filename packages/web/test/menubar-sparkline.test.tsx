import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UsageBucket } from '@gian/shared';
import { Sparkline } from '../src/menubar/Sparkline.js';
import { hourBuckets, DEMO_NOW } from './menubar-fixtures.js';

describe('Sparkline', () => {
  it('paints only buckets with data — null buckets stay gaps, never fake zeros', () => {
    const buckets = hourBuckets(DEMO_NOW, 17);
    const { container } = render(<Sparkline buckets={buckets} asOf={DEMO_NOW} selection={{ mode: 'calendar', period: 'day' }} />);
    // Hours 0..17 have data, 18..23 are null and must not render.
    expect(container.querySelectorAll('rect')).toHaveLength(18);
  });

  it('marks the current bucket', () => {
    const buckets = hourBuckets(DEMO_NOW, 17);
    const { container } = render(<Sparkline buckets={buckets} asOf={DEMO_NOW} selection={{ mode: 'calendar', period: 'day' }} />);
    const current = container.querySelectorAll('rect.cur');
    expect(current).toHaveLength(1);
  });

  it('labels each bar with the exact range and thousands-separated value', () => {
    const buckets = hourBuckets(DEMO_NOW, 17);
    const { container } = render(<Sparkline buckets={buckets} asOf={DEMO_NOW} selection={{ mode: 'calendar', period: 'day' }} />);
    const first = container.querySelector('rect')!;
    expect(first.getAttribute('aria-label')).toBe('12:00 AM – 1:00 AM · 1,000 tokens (1K)');
    const labels = [...container.querySelectorAll('rect')].map(r => r.getAttribute('aria-label'));
    expect(labels.some(l => l?.endsWith('– Now · 18,000 tokens (18K)'))).toBe(true);
  });

  it('renders a zero bucket as a covered-but-empty bar, not a gap', () => {
    const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime();
    const buckets: UsageBucket[] = [
      { from: midnight, to: midnight + 3_600_000, tokens: 0, coverage: 'complete' },
      { from: midnight + 3_600_000, to: midnight + 7_200_000, tokens: 5000, coverage: 'complete' },
    ];
    const { container } = render(<Sparkline buckets={buckets} asOf={midnight + 10_000_000} selection={{ mode: 'calendar', period: 'day' }} />);
    expect(container.querySelectorAll('rect')).toHaveLength(2);
  });

  it('renders nothing for an all-null range', () => {
    const midnight = new Date(2026, 9, 21, 0, 0, 0).getTime();
    const buckets: UsageBucket[] = [
      { from: midnight, to: midnight + 3_600_000, tokens: null, coverage: 'no_data' },
    ];
    const { container } = render(<Sparkline buckets={buckets} asOf={midnight} selection={{ mode: 'calendar', period: 'day' }} />);
    expect(container.querySelectorAll('rect')).toHaveLength(0);
  });
});
