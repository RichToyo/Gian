/**
 * A session running on another Gian (mirrored here, `remote_execution`)
 * does not offer what needs this Mac to run it: Fork and Side Chat stay
 * visible but greyed with "Not available for sessions running on another
 * Gian", Force recover leaves the session menu, and no terminal opens (Dock,
 * the terminal strip's "+", the shortcuts' rail toggle and the palette).
 * A session running here keeps all of them.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { Session, Workspace } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';

import { sessionActionControlState } from '../src/components/action-gating.js';
import type { CatalogActionDescriptor } from '../src/components/composer/capabilities.js';
import { Dock } from '../src/components/Dock.js';
import { PathBreadcrumb } from '../src/components/PathBreadcrumb.js';
import { Sheet, type SheetTab } from '../src/components/Sheet.js';
import { useTopbarModel } from '../src/controllers/use-topbar-model.js';
import { useWorkbench } from '../src/controllers/use-workbench.js';
import { EN } from '../src/i18n/en.js';
import { LocaleProvider } from '../src/i18n/index.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { isMirroredSession, MIRRORED_SESSION_UNAVAILABLE } from '../src/remote-environments.js';
import { COMMANDS_SEARCH_REGISTRY, type SearchPaletteContext } from '../src/search/registry.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return { ...actual, loadAllFiles: vi.fn().mockResolvedValue([]), loadApps: vi.fn().mockResolvedValue([]) };
});

const REASON = EN[MIRRORED_SESSION_UNAVAILABLE]!;
const t = (key: string) => EN[key] ?? key;

const workspace = {
  id: 'workspace-1', name: 'demo', path: '/tmp/w1', sort_order: 0, hidden: 0, pinned: 0,
  created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
} as Workspace;

const localSession = {
  id: 'session-local', name: 'Local session', type: 'coding', task_id: null, workspace_id: 'workspace-1',
  executor: 'codex', status: 'idle', archived: 0, completed_at: null, worktree_path: null, branch: null,
  available_actions: {
    'sidechat.create': { enabled: true }, 'session.fork': { enabled: true }, 'session.fork.atTurn': { enabled: true },
  },
} as unknown as Session;

const mirroredSession = {
  ...localSession,
  id: 'session-remote', name: 'Mirrored session', workspace_id: null,
  remote_execution: {
    environment_id: 'env-1', environment_name: 'Build box', host_id: 'host-1', remote_session_id: 'remote-1',
    repository_id: 'repo-1', repository_name: 'api', worktree_root: '/srv/api',
  },
} as unknown as Session;

const catalog: CatalogActionDescriptor[] = [
  { id: 'sidechat.create', supported: true },
  { id: 'session.fork', supported: true },
  { id: 'session.fork.atTurn', supported: true },
];

describe('mirrored sessions', () => {
  it('are told apart by remote_execution', () => {
    expect(isMirroredSession(mirroredSession)).toBe(true);
    expect(isMirroredSession(localSession)).toBe(false);
    expect(isMirroredSession(null)).toBe(false);
  });

  it('grey Side Chat and Fork with the reason even when the catalog and session allow them', () => {
    for (const id of ['sidechat.create', 'session.fork', 'session.fork.atTurn']) {
      expect(sessionActionControlState(mirroredSession, catalog, id, REASON))
        .toEqual({ visible: true, enabled: false, reason: REASON });
      expect(sessionActionControlState(localSession, catalog, id, REASON)).toEqual({ visible: true, enabled: true });
    }
    expect(REASON).toBe('Not available for sessions running on another Gian');
  });

  function openSessionMenu(session: Session) {
    function Menu() {
      const model = useTopbarModel({
        mode: 'sessions', activeTaskId: null, activeSubtaskId: null, activeSession: session,
        activeWorkspace: session.workspace_id ? workspace : null, activeWorktreeName: null, workingTrees: [],
        refreshWorkingTrees: () => {}, wtView: null, setWtView: () => {}, viewedWorkingTreeId: () => null,
        activeSessionRecovering: false,
        forkHead: { control: sessionActionControlState(session, catalog, 'session.fork', REASON), forking: false, onFork: vi.fn() },
        onAssignSessionTask: () => {},
        ops: { dispatch: vi.fn() } as unknown as OperationDispatcher,
        t,
      });
      return <PathBreadcrumb segments={model.pathSegments} sessionMenu={model.sessionMenu} />;
    }
    render(<LocaleProvider locale="en"><Menu /></LocaleProvider>);
    fireEvent.click(screen.getByText(session.name!));
  }

  it('keep Fork greyed with the reason in the session menu and leave Force recover out', () => {
    openSessionMenu(mirroredSession);
    expect(screen.getByTestId('menu-fork')).toBeDisabled();
    expect(screen.getByTestId('menu-fork')).toHaveAttribute('title', REASON);
    expect(screen.queryByTestId('menu-recover')).toBeNull();
    expect(screen.getByTestId('menu-rename')).toBeEnabled();
  });

  it('leave a local session\'s Fork and Force recover as they were', () => {
    openSessionMenu(localSession);
    expect(screen.getByTestId('menu-fork')).toBeEnabled();
    expect(screen.getByTestId('menu-recover')).toBeEnabled();
  });

  it('grey the Dock terminal with the reason, but an open terminal can still be collapsed', () => {
    const base: Parameters<typeof Dock>[0] = {
      activeRail: null, onToggleRail: vi.fn(), wsState: 'open', wsAttempt: 0, authed: true, runner: null,
    };
    const view = render(<Dock {...base} terminalUnavailableReason={REASON} />);
    expect(screen.getByTestId('dock-terminal')).toBeDisabled();
    expect(screen.getByTestId('dock-terminal')).toHaveAttribute('title', REASON);
    view.rerender(<Dock {...base} activeRail="terminal" terminalUnavailableReason={REASON} />);
    expect(screen.getByTestId('dock-terminal')).toBeEnabled();
    view.rerender(<Dock {...base} />);
    expect(screen.getByTestId('dock-terminal')).toBeEnabled();
    expect(screen.getByTestId('dock-terminal')).toHaveAttribute('title', EN['dock.terminal']);
  });

  it('grey the terminal strip\'s "+" with the reason', () => {
    const term = { id: 'term-1', group: 'term', name: 'zsh', kind: 'term', icoKind: 'term', ico: '$' } as SheetTab;
    const actions = { activateTab: vi.fn(), closeTab: vi.fn(), pinTab: vi.fn(), setTabViewMode: vi.fn(), setTabName: vi.fn() };
    const onAddTab = vi.fn();
    const view = render(<Sheet tabs={[term]} activeByGroup={{ term: term.id }} activeGroup="term" actions={actions}
      renderTab={() => null} onAddTab={onAddTab} terminalUnavailableReason={REASON} />);
    const add = () => document.querySelector<HTMLButtonElement>('.tab-add')!;
    expect(add()).toBeDisabled();
    expect(add()).toHaveAttribute('title', REASON);
    view.rerender(<Sheet tabs={[term]} activeByGroup={{ term: term.id }} activeGroup="term" actions={actions}
      renderTab={() => null} onAddTab={onAddTab} />);
    expect(add()).toBeEnabled();
    fireEvent.click(add());
    expect(onAddTab).toHaveBeenCalledWith('term');
  });

  it('open no terminal through the rail, its toggle (shortcuts) or a new tab', async () => {
    const { result, rerender } = renderHook(({ session, mode = 'sessions' }: { session: Session; mode?: string }) => useWorkbench({
      authStatus: 'authenticated', dispatch: vi.fn(), sessions: [localSession, mirroredSession],
      activeSessionId: session.id, activeSession: session, activeWorkspace: workspace, workspaces: [workspace],
      workingTrees: [], mode, activeSubtaskId: null, t,
    }), { initialProps: { session: mirroredSession } as { session: Session; mode?: string } });
    await act(async () => {}); // the installed-apps load settles
    const terminals = () => result.current.wbTabs.filter(tab => tab.group === 'term').length;
    expect(result.current.terminalUnavailable).toBe(true);
    act(() => result.current.activateRail('terminal'));
    act(() => result.current.toggleRail('terminal'));
    act(() => result.current.addTerminalTab());
    expect(terminals()).toBe(0);
    expect(result.current.activeRail).not.toBe('terminal');

    rerender({ session: mirroredSession, mode: 'tasks' });
    expect(result.current.terminalUnavailable, 'the Tasks overview does not show the session').toBe(false);

    rerender({ session: localSession });
    expect(result.current.terminalUnavailable).toBe(false);
    act(() => result.current.toggleRail('terminal'));
    expect(terminals()).toBe(1);
    expect(result.current.activeRail).toBe('terminal');
  });

  it('leave Side Chat and Terminal out of the command palette', () => {
    const context: SearchPaletteContext = { hasActiveSession: true, workbenchActive: true, canGoBack: false,
      canGoForward: false, inspectorAvailable: true, browserAvailable: true };
    for (const command of ['tool.sideChat', 'tool.terminal']) {
      const entry = COMMANDS_SEARCH_REGISTRY.find(item => item.command === command)!;
      expect(entry.available({ ...context, activeSessionMirrored: true })).toBe(false);
      expect(entry.available({ ...context, activeSessionMirrored: false })).toBe(true);
      expect(entry.available(context)).toBe(true);
    }
  });
});
