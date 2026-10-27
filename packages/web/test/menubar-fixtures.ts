import type {
  GianMenubarBridge,
  MenubarChange,
  MenubarPreferences,
  MenubarSnapshot,
  MenubarTodo,
  OfficialQuotaAccount,
  UsageBucket,
  UsageSelection,
  UsageSummary,
} from '@gian/shared';
import { vi } from 'vitest';

/* Shared fixtures for the menubar panel tests. Fixed local clock:
 * 2026-10-21 17:37 (a Wednesday), matching the approved design preview. */

export const DEMO_NOW = new Date(2026, 9, 21, 17, 37, 0).getTime();
export const USER_AUTHORED_TITLE = String.fromCodePoint(
  0x6570, 0x636e, 0x5e93, 0x8fc1, 0x79fb, 0x9700, 0x8981, 0x786e, 0x8ba4,
);

export function localMidnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function hourBuckets(dayMs: number, filledThroughHour: number): UsageBucket[] {
  const midnight = localMidnight(dayMs);
  const buckets: UsageBucket[] = [];
  for (let i = 0; i < 24; i += 1) {
    const from = midnight + i * 3_600_000;
    const isCurrent = new Date(dayMs).getHours() === i;
    buckets.push({
      from,
      to: isCurrent ? dayMs : from + 3_600_000,
      tokens: i <= filledThroughHour ? (i + 1) * 1000 : null,
      coverage: 'complete',
    });
  }
  return buckets;
}

export function makeSummary(
  selection: UsageSelection,
  overrides: Partial<UsageSummary> = {},
): UsageSummary {
  const buckets = hourBuckets(DEMO_NOW, 17);
  const totalTokens = buckets.reduce((acc, b) => acc + (b.tokens ?? 0), 0);
  return {
    selection,
    from: buckets[0].from,
    to: DEMO_NOW,
    timezone: 'local',
    asOf: DEMO_NOW,
    trackingStartedAt: buckets[0].from,
    generation: 1,
    revision: 1,
    coverage: 'complete',
    totalTokens,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    byAgent: [
      {
        id: 'codex', label: 'Codex', pluginId: 'codex', totalTokens: Math.round(totalTokens * 0.6),
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
      },
      {
        id: null, label: 'Other', pluginId: null, totalTokens: Math.round(totalTokens * 0.4),
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
      },
    ],
    byModel: [
      {
        id: 'gpt-5.1-codex', label: 'gpt-5.1-codex', pluginId: 'codex', totalTokens,
        inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
      },
    ],
    buckets,
    ...overrides,
  };
}

export function makeTodo(overrides: Partial<MenubarTodo> = {}): MenubarTodo {
  return {
    sessionId: 's-1',
    revision: 'r1',
    title: USER_AUTHORED_TITLE,
    agentId: 'codex',
    pluginId: 'codex',
    reason: 'approval',
    ...overrides,
  };
}

export function makeQuotaAccount(overrides: Partial<OfficialQuotaAccount> = {}): OfficialQuotaAccount {
  return {
    accountKey: 'acct-codex',
    agentIds: ['codex'],
    pluginId: 'codex',
    label: 'ChatGPT',
    eligibility: 'eligible',
    status: 'ready',
    fetchedAt: DEMO_NOW,
    freshness: 'fresh',
    error: null,
    windows: [
      { id: '5h', label: '5h', usedRatio: 0.22, resetAt: DEMO_NOW + 3_600_000, windowDurationMinutes: 300 },
      { id: 'weekly', label: 'Weekly', usedRatio: 0.59, resetAt: null, windowDurationMinutes: 10080 },
    ],
    balances: [],
    ...overrides,
  };
}

export function makeSnapshot(
  selection: UsageSelection,
  overrides: Partial<MenubarSnapshot> = {},
): MenubarSnapshot {
  return {
    asOf: DEMO_NOW,
    pendingTotal: 0,
    pending: [],
    today: makeSummary({ mode: 'calendar', period: 'day' }),
    selectedRange: makeSummary(selection),
    ...overrides,
  };
}

export interface FakeBridge {
  bridge: GianMenubarBridge;
  emit: (change: MenubarChange) => void;
}

export function makeBridge(overrides: Partial<GianMenubarBridge> = {}): FakeBridge {
  const listeners = new Set<(change: MenubarChange) => void>();
  const bridge: GianMenubarBridge = {
    getSnapshot: vi.fn(async (selection: UsageSelection) => makeSnapshot(selection)),
    getPending: vi.fn(async () => ({ pendingTotal: 0, pending: [] })),
    getQuota: vi.fn(async () => ({ asOf: DEMO_NOW, accounts: [] })),
    refreshQuota: vi.fn(async () => ({ asOf: DEMO_NOW, accounts: [] })),
    getPreferences: vi.fn(async () => ({
      showTokens: true,
      showTodoCount: true,
      selection: { mode: 'calendar', period: 'day' } as UsageSelection,
    })),
    setPreferences: vi.fn(async (preferences: MenubarPreferences) => preferences),
    getAppearance: vi.fn(async () => ({ theme: 'dark' as const, accent: 'azure' as const, frameOpacity: 100 })),
    navigate: vi.fn(async () => true),
    clearUsage: vi.fn(async () => ({ generation: 2 })),
    hide: vi.fn(async () => {}),
    onChanged: vi.fn((listener: (change: MenubarChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    ...overrides,
  };
  return {
    bridge,
    emit: change => listeners.forEach(listener => listener(change)),
  };
}

/** A promise with manual resolution, for late-response ordering tests. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
