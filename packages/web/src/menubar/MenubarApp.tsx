import { useEffect, useRef, useState } from 'react';
import type {
  MenubarPreferences,
  MenubarTodo,
  OfficialQuotaAccount,
  OfficialQuotaSnapshot,
  UsageSelection,
  UsageSummary,
} from '@gian/shared';
import { DetailView } from './DetailView.js';
import { PERIOD_LABELS } from './format.js';
import { GianMark } from './GianMark.js';
import { ICON, SvgIcon } from './icons.js';
import { QuotaSection, type QuotaLoadState } from './QuotaSection.js';
import { ConfirmClearDialog, SettingsMenu } from './SettingsMenu.js';
import { TodoSection } from './TodoSection.js';
import { TokensSection } from './TokensSection.js';

export interface MenubarAppProps {
  /** Summary for the current selection; null until the first load. */
  summary: UsageSummary | null;
  selection: UsageSelection;
  todos: readonly MenubarTodo[];
  pendingTotal: number;
  todoExpanded: boolean;
  quota: OfficialQuotaSnapshot | null;
  quotaExpanded: boolean;
  /** Refresh keys currently in flight (quotaRefreshKey). */
  quotaRefreshing: ReadonlySet<string>;
  quotaLoadState: QuotaLoadState;
  quotaRefreshFailed: boolean;
  preferences: MenubarPreferences | null;
  /** Last local call failed; retained data stays visible. */
  disconnected: boolean;
  /** Increments on every `opened` change: resets view, Todo and Quota. */
  openedTick: number;
  onSelectSelection: (selection: UsageSelection) => void;
  onTodoNavigate: (todo: MenubarTodo) => void;
  onTodoExpandedChange: (expanded: boolean) => void;
  onQuotaExpandedChange: (expanded: boolean) => void;
  onQuotaRefresh: (account: OfficialQuotaAccount) => void;
  onQuotaRetry: () => void;
  onPreferencesChange: (preferences: MenubarPreferences) => void;
  onClearStats: () => void;
  onHide: () => void;
}

/** The panel shell. Purely props/callback driven — the bridge-bound container
 * is MenubarRoot; this component never talks to the Host itself. */
export function MenubarApp(props: MenubarAppProps) {
  const [view, setView] = useState<'main' | 'detail'>('main');
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const { openedTick } = props;
  useEffect(() => {
    setView('main');
    setMenuOpen(false);
    setConfirmClear(false);
    panelRef.current?.focus({ preventScroll: true });
  }, [openedTick]);

  const { onHide } = props;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmClear) setConfirmClear(false);
      else if (menuOpen) setMenuOpen(false);
      else onHide();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuOpen) return;
      const target = event.target as Node | null;
      const menu = document.querySelector('.mb-menu');
      if (target && !menu?.contains(target) && !settingsButtonRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen, confirmClear, onHide]);

  const periodLabel = PERIOD_LABELS[props.selection.mode][props.selection.period];
  // A summary whose selection no longer matches is stale: show loading
  // skeletons until the matching summary arrives.
  const summary = props.summary
    && props.summary.selection.mode === props.selection.mode
    && props.summary.selection.period === props.selection.period
    ? props.summary
    : null;

  return (
    <div className="mb-panel" ref={panelRef} tabIndex={-1}>
      {view === 'main' ? (
        <div className="mb-view">
          <div className="mb-p-head">
            <span className="mb-p-brand">
              <GianMark size={18} />
              <span className="mb-p-name">Gian</span>
            </span>
            <span className="mb-p-head-r">
              <button
                ref={settingsButtonRef}
                type="button"
                className="mb-iconbtn"
                title="Settings"
                aria-label="Settings"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(open => !open)}
              >
                <SvgIcon d={ICON.settings} size={15} />
              </button>
            </span>
          </div>

          <div className="mb-p-body">
            {props.disconnected && (
              <div className="mb-state-note mb-disconnected">
                <SvgIcon d={ICON.info} size={13} />
                <span>Can’t reach the Gian Host — showing the last known data</span>
              </div>
            )}
            <TokensSection
              summary={summary}
              selection={props.selection}
              onSelectSelection={props.onSelectSelection}
              onOpenDetail={() => setView('detail')}
            />
            <hr className="mb-rule" />
            <TodoSection
              items={props.todos}
              total={props.pendingTotal}
              expanded={props.todoExpanded}
              loading={summary == null && !props.disconnected}
              onExpandedChange={props.onTodoExpandedChange}
              onNavigate={props.onTodoNavigate}
            />
            <hr className="mb-rule" />
            <QuotaSection
              quota={props.quota}
              expanded={props.quotaExpanded}
              refreshing={props.quotaRefreshing}
              loadState={props.quotaLoadState}
              refreshFailed={props.quotaRefreshFailed}
              onExpandedChange={props.onQuotaExpandedChange}
              onRefresh={props.onQuotaRefresh}
              onRetry={props.onQuotaRetry}
            />
          </div>

          {menuOpen && props.preferences && (
            <SettingsMenu
              preferences={props.preferences}
              onPreferencesChange={props.onPreferencesChange}
              onRequestClear={() => {
                setMenuOpen(false);
                setConfirmClear(true);
              }}
            />
          )}
        </div>
      ) : (
        <DetailView
          summary={summary}
          periodLabel={periodLabel}
          onBack={() => setView('main')}
        />
      )}

      {confirmClear && (
        <ConfirmClearDialog
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            props.onClearStats();
          }}
        />
      )}
    </div>
  );
}
