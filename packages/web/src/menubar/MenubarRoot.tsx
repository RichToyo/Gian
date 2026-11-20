import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GianMenubarBridge,
  MenubarAppearance,
  MenubarPreferences,
  MenubarSnapshot,
  MenubarTodo,
  OfficialQuotaAccount,
  OfficialQuotaSnapshot,
  UsageSelection,
} from '@gian/shared';
import { MenubarApp } from './MenubarApp.js';
import { quotaRefreshKey } from './quota-row.js';
import type { QuotaLoadState } from './QuotaSection.js';

const DEFAULT_SELECTION: UsageSelection = { mode: 'calendar', period: 'day' };

/** Bridge-bound container: owns all data flow between window.gianMenubar and
 * the purely presentational MenubarApp. Late responses for a superseded
 * selection are discarded. Accounts owns its loading/error/retry state,
 * independently of local Token/Todo connectivity. Only an explicit row refresh
 * queries an account here; scheduled refreshes belong to the Host. */
export function MenubarRoot({ bridge }: { bridge: GianMenubarBridge }) {
  const [appearance, setAppearance] = useState<MenubarAppearance | null>(null);
  const [preferences, setPreferences] = useState<MenubarPreferences | null>(null);
  const [selection, setSelection] = useState<UsageSelection>(DEFAULT_SELECTION);
  const [snapshot, setSnapshot] = useState<MenubarSnapshot | null>(null);
  const [todos, setTodos] = useState<readonly MenubarTodo[]>([]);
  const [pendingTotal, setPendingTotal] = useState(0);
  const [todoExpanded, setTodoExpanded] = useState(false);
  const [quota, setQuota] = useState<OfficialQuotaSnapshot | null>(null);
  const [quotaExpanded, setQuotaExpanded] = useState(true);
  const [quotaRefreshing, setQuotaRefreshing] = useState<ReadonlySet<string>>(new Set());
  const [quotaLoadState, setQuotaLoadState] = useState<QuotaLoadState>('idle');
  const [quotaRefreshErrors, setQuotaRefreshErrors] = useState<ReadonlySet<string>>(new Set());
  const [disconnected, setDisconnected] = useState(false);
  const [openedTick, setOpenedTick] = useState(0);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const todoExpandedRef = useRef(todoExpanded);
  todoExpandedRef.current = todoExpanded;
  const quotaExpandedRef = useRef(quotaExpanded);
  quotaExpandedRef.current = quotaExpanded;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const snapshotSeq = useRef(0);
  const quotaReadSeq = useRef(0);
  const quotaRef = useRef<OfficialQuotaSnapshot | null>(null);
  const quotaFlights = useRef(new Set<string>());

  const acceptQuota = useCallback((next: OfficialQuotaSnapshot) => {
    if (quotaRef.current && next.asOf < quotaRef.current.asOf) return false;
    quotaRef.current = next;
    setQuota(next);
    const keys = new Set(next.accounts.map(quotaRefreshKey));
    setQuotaRefreshErrors(previous => new Set([...previous].filter(key => keys.has(key))));
    return true;
  }, []);

  useEffect(() => {
    if (!appearance) return;
    document.body.dataset.theme = appearance.theme;
    document.body.dataset.accent = appearance.accent;
    document.body.style.setProperty('--frame-opacity', String(appearance.frameOpacity));
  }, [appearance]);

  const fetchSnapshot = useCallback(async (sel: UsageSelection) => {
    const seq = ++snapshotSeq.current;
    try {
      const next = await bridge.getSnapshot(sel);
      if (seq !== snapshotSeq.current) return;
      setSnapshot(next);
      setPendingTotal(next.pendingTotal);
      if (!todoExpandedRef.current) setTodos(next.pending);
      setDisconnected(false);
    } catch {
      if (seq !== snapshotSeq.current) return;
      setDisconnected(true);
    }
  }, [bridge]);

  const fetchAllPending = useCallback(async () => {
    try {
      const next = await bridge.getPending();
      if (!todoExpandedRef.current) return;
      setTodos(next.pending);
      setPendingTotal(next.pendingTotal);
      setDisconnected(false);
    } catch {
      setDisconnected(true);
    }
  }, [bridge]);

  const refreshAccount = useCallback(async (account: OfficialQuotaAccount) => {
    if (!['eligible', 'unverified', 'auth_required'].includes(account.eligibility)) return;
    const key = quotaRefreshKey(account);
    if (quotaFlights.current.has(key)) return;
    quotaFlights.current.add(key);
    setQuotaRefreshing(prev => new Set(prev).add(key));
    try {
      const next = await bridge.refreshQuota(key);
      acceptQuota(next);
      setQuotaRefreshErrors(previous => {
        const nextErrors = new Set(previous); nextErrors.delete(key); return nextErrors;
      });
    } catch {
      if (quotaRef.current?.accounts.some(item => quotaRefreshKey(item) === key)) {
        setQuotaRefreshErrors(previous => new Set(previous).add(key));
      }
    } finally {
      quotaFlights.current.delete(key);
      setQuotaRefreshing(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [bridge, acceptQuota]);

  const loadQuota = useCallback(async () => {
    const seq = ++quotaReadSeq.current;
    setQuotaLoadState('loading');
    try {
      const cached = await bridge.getQuota();
      if (seq !== quotaReadSeq.current) return;
      acceptQuota(cached);
      setQuotaLoadState('ready');
    } catch {
      if (seq === quotaReadSeq.current) setQuotaLoadState('error');
    }
  }, [bridge, acceptQuota]);

  useEffect(() => { void loadQuota(); }, [loadQuota]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextAppearance, nextPreferences] = await Promise.all([
          bridge.getAppearance(),
          bridge.getPreferences(),
        ]);
        if (cancelled) return;
        setAppearance(nextAppearance);
        setPreferences(nextPreferences);
        setSelection(nextPreferences.selection);
        await fetchSnapshot(nextPreferences.selection);
      } catch {
        if (!cancelled) setDisconnected(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, fetchSnapshot]);

  useEffect(() => bridge.onChanged(change => {
    if (change.type === 'appearance') {
      setAppearance(change.appearance);
    } else if (change.type === 'local') {
      void fetchSnapshot(selectionRef.current);
      if (todoExpandedRef.current) void fetchAllPending();
      if (quotaExpandedRef.current) void loadQuota();
    } else if (change.type === 'quota') {
      if (quotaExpandedRef.current) {
        void loadQuota();
      }
    } else if (change.type === 'opened') {
      setTodoExpanded(false);
      setQuotaExpanded(true);
      quotaExpandedRef.current = true;
      quotaReadSeq.current++;
      setQuotaLoadState(quotaRef.current ? 'ready' : 'idle');
      setOpenedTick(tick => tick + 1);
      void fetchSnapshot(selectionRef.current);
      void loadQuota();
    }
  }), [bridge, fetchSnapshot, fetchAllPending, loadQuota]);

  useEffect(() => () => { quotaReadSeq.current++; }, [bridge]);

  const onSelectSelection = useCallback((next: UsageSelection) => {
    if (next.mode === selectionRef.current.mode && next.period === selectionRef.current.period) return;
    setSelection(next);
    void fetchSnapshot(next);
    const prefs = preferencesRef.current;
    if (prefs) {
      const updated = { ...prefs, selection: next };
      setPreferences(updated);
      void bridge.setPreferences(updated).then(setPreferences, () => {});
    }
  }, [bridge, fetchSnapshot]);

  const onTodoExpandedChange = useCallback((expanded: boolean) => {
    setTodoExpanded(expanded);
    if (expanded) {
      void fetchAllPending();
    } else if (snapshotRef.current) {
      setTodos(snapshotRef.current.pending);
      setPendingTotal(snapshotRef.current.pendingTotal);
    }
  }, [fetchAllPending]);

  const onQuotaExpandedChange = useCallback((expanded: boolean) => {
    quotaExpandedRef.current = expanded;
    setQuotaExpanded(expanded);
    if (expanded) void loadQuota();
  }, [loadQuota]);

  const onTodoNavigate = useCallback((todo: MenubarTodo) => {
    void bridge.navigate({ sessionId: todo.sessionId, revision: todo.revision }).then(valid => {
      if (!valid) void fetchSnapshot(selectionRef.current);
    }, () => setDisconnected(true));
  }, [bridge, fetchSnapshot]);

  const onPreferencesChange = useCallback((next: MenubarPreferences) => {
    setPreferences(next);
    void bridge.setPreferences(next).then(setPreferences, () => {});
  }, [bridge]);

  const onClearStats = useCallback(() => {
    const generation = snapshotRef.current?.today.generation;
    if (generation == null) return;
    void bridge.clearUsage({ generation, idempotencyKey: crypto.randomUUID() })
      .then(() => fetchSnapshot(selectionRef.current), () => setDisconnected(true));
  }, [bridge, fetchSnapshot]);

  const onHide = useCallback(() => {
    void bridge.hide().catch(() => {});
  }, [bridge]);

  return (
    <MenubarApp
      summary={snapshot ? snapshot.selectedRange : null}
      selection={selection}
      todos={todos}
      pendingTotal={pendingTotal}
      todoExpanded={todoExpanded}
      quota={quota}
      quotaExpanded={quotaExpanded}
      quotaRefreshing={quotaRefreshing}
      quotaLoadState={quotaLoadState}
      quotaRefreshFailed={quotaRefreshErrors.size > 0}
      preferences={preferences}
      disconnected={disconnected}
      openedTick={openedTick}
      onSelectSelection={onSelectSelection}
      onTodoNavigate={onTodoNavigate}
      onTodoExpandedChange={onTodoExpandedChange}
      onQuotaExpandedChange={onQuotaExpandedChange}
      onQuotaRefresh={refreshAccount}
      onQuotaRetry={() => { void loadQuota(); }}
      onPreferencesChange={onPreferencesChange}
      onClearStats={onClearStats}
      onHide={onHide}
    />
  );
}
