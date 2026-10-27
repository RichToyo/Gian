import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { usageRange } from '../src/usage/range.js';

describe('menubar Host-local calendar and rolling ranges', () => {
  it('covers six choices, Monday/month/year boundaries and exact half-open endpoints', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Shanghai';
      const now = new Date('2026-01-01T12:00:00+08:00').getTime();
      assert.equal(usageRange({ mode: 'calendar', period: 'day' }, now).from, Date.parse('2026-01-01T00:00:00+08:00'));
      assert.equal(usageRange({ mode: 'calendar', period: 'week' }, now).from, Date.parse('2025-12-29T00:00:00+08:00'));
      assert.equal(usageRange({ mode: 'calendar', period: 'month' }, now).from, Date.parse('2026-01-01T00:00:00+08:00'));
      for (const [period, hours] of [['day', 24], ['week', 168], ['month', 720]] as const) {
        const range = usageRange({ mode: 'rolling', period }, now);
        assert.equal(range.to - range.from, hours * 3_600_000);
        assert.equal(range.boundaries[0], range.from);
        assert.equal(range.boundaries.at(-1), now);
        assert.equal(new Set(range.boundaries).size, range.boundaries.length);
      }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('uses the actual DST day rather than assuming local days are 24 hours', () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      for (const [day, expectedHours] of [['2026-03-08', 23], ['2026-11-01', 25]] as const) {
        const now = new Date(`${day}T23:59:59.999`).getTime();
        const range = usageRange({ mode: 'calendar', period: 'day' }, now);
        assert.equal(now - range.from + 1, expectedHours * 3_600_000);
        assert.equal(range.boundaries.length - 1, expectedHours);
      }
      const now = Date.parse('2026-11-01T12:00:00Z');
      const ny = usageRange({ mode: 'calendar', period: 'day' }, now);
      process.env.TZ = 'Asia/Shanghai';
      const sh = usageRange({ mode: 'calendar', period: 'day' }, now);
      assert.notEqual(ny.from, sh.from);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
});
