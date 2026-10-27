import type { UsageBucket } from '@gian/shared';
import { bucketRangeLabel, formatExact, formatTokens, ongoingBucketIndex } from './format.js';

/* Compact trend: each bar is the tokens newly consumed inside its time bucket
 * (not cumulative, never quota). Buckets with null tokens are not painted —
 * no-data is a gap, not a fake zero. Bar tooltips give the exact range and
 * thousands-separated value. */
export function Sparkline({
  buckets,
  asOf,
  width = 132,
  height = 30,
}: {
  buckets: readonly UsageBucket[];
  asOf: number;
  width?: number;
  height?: number;
}) {
  const gap = 1.5;
  const n = buckets.length;
  const barWidth = n > 0 ? (width - (n - 1) * gap) / n : 0;
  const max = Math.max(1, ...buckets.map(b => b.tokens ?? 0));
  const current = ongoingBucketIndex(buckets, asOf);
  return (
    <svg className="mb-spark" width={width} height={height} role="img" aria-label="Tokens added per time bucket">
      {buckets.map((bucket, i) => {
        if (bucket.tokens == null) return null;
        const h = bucket.tokens <= 0 ? 1.5 : Math.max(1.5, (bucket.tokens / max) * (height - 3));
        const label = `${bucketRangeLabel(bucket, i === current)} · ${formatExact(bucket.tokens)} tokens (${formatTokens(bucket.tokens)})`;
        return (
          <rect
            key={bucket.from}
            x={i * (barWidth + gap)}
            y={height - h}
            width={barWidth}
            height={h}
            rx={1}
            tabIndex={0}
            className={i === current ? 'cur' : undefined}
            aria-label={label}
          >
            <title>{label}</title>
          </rect>
        );
      })}
    </svg>
  );
}
