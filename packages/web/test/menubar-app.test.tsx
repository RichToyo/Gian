import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MenubarApp, type MenubarAppProps } from '../src/menubar/MenubarApp.js';
import { DEMO_NOW, makeQuotaAccount, makeSnapshot, makeSummary, makeTodo, USER_AUTHORED_TITLE } from './menubar-fixtures.js';

function makeProps(overrides: Partial<MenubarAppProps> = {}): MenubarAppProps {
  const selection = { mode: 'calendar', period: 'day' } as const;
  return {
    summary: makeSnapshot(selection).selectedRange,
    selection,
    todos: [makeTodo()],
    pendingTotal: 1,
    todoExpanded: false,
    quota: { asOf: 0, accounts: [makeQuotaAccount()] },
    quotaExpanded: false,
    quotaRefreshing: new Set<string>(),
    quotaLoadState: 'ready',
    quotaRefreshFailed: false,
    preferences: { showTokens: true, showTodoCount: true, selection },
    disconnected: false,
    openedTick: 0,
    onSelectSelection: vi.fn(),
    onTodoNavigate: vi.fn(),
    onTodoExpandedChange: vi.fn(),
    onQuotaExpandedChange: vi.fn(),
    onQuotaRefresh: vi.fn(),
    onQuotaRetry: vi.fn(),
    onPreferencesChange: vi.fn(),
    onClearStats: vi.fn(),
    onHide: vi.fn(),
    ...overrides,
  };
}

describe('MenubarApp', () => {
  it('renders the three top-level sections and never an Open Gian footer', () => {
    render(<MenubarApp {...makeProps()} />);
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText('Accounts')).toBeInTheDocument();
    expect(screen.queryByText(/open gian/i)).toBeNull();
  });

  it('focuses the panel on open without highlighting the Settings button', () => {
    const props = makeProps();
    const { container, rerender } = render(<MenubarApp {...props} />);
    expect(container.querySelector('.mb-panel')).toHaveFocus();
    screen.getByRole('button', { name: 'Settings' }).focus();
    rerender(<MenubarApp {...props} openedTick={1} />);
    expect(container.querySelector('.mb-panel')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Settings' })).not.toHaveFocus();
  });

  it('keeps user conversation titles untranslated while the UI stays English', () => {
    const { container } = render(<MenubarApp {...makeProps()} />);
    expect(screen.getByText(USER_AUTHORED_TITLE)).toBeInTheDocument();
    const text = (container.textContent ?? '').replaceAll(USER_AUTHORED_TITLE, '');
    expect(/\p{Script=Han}/u.test(text)).toBe(false);
  });

  it('opens the token detail view from the big number and returns', () => {
    render(<MenubarApp {...makeProps()} />);
    fireEvent.click(screen.getAllByTitle('Token details')[0]);
    expect(screen.getByText('Token details')).toBeInTheDocument();
    expect(screen.getByText('By agent')).toBeInTheDocument();
    expect(screen.getByText('By model')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Tokens')).toBeInTheDocument();
  });

  it('reports selection changes instead of fetching data itself', () => {
    const props = makeProps();
    render(<MenubarApp {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rolling' }));
    expect(props.onSelectSelection).toHaveBeenCalledWith({ mode: 'rolling', period: 'day' });
    fireEvent.click(screen.getByRole('button', { name: 'This Month' }));
    expect(props.onSelectSelection).toHaveBeenCalledWith({ mode: 'calendar', period: 'month' });
  });

  it('passes the calendar-week granularity through to the current bar tooltip', () => {
    const selection = { mode: 'calendar', period: 'week' } as const;
    const monday = new Date(2026, 9, 19).getTime();
    const buckets = [0, 1, 2].map(day => ({
      from: monday + day * 86_400_000,
      to: day === 2 ? DEMO_NOW : monday + (day + 1) * 86_400_000,
      tokens: 1000,
      coverage: 'complete' as const,
    }));
    const summary = makeSummary(selection, {
      from: monday, to: DEMO_NOW, trackingStartedAt: monday, buckets, totalTokens: 3000,
    });
    const { container } = render(<MenubarApp {...makeProps({ selection, summary })} />);
    const current = container.querySelector('rect.cur');
    expect(current).toHaveAttribute('aria-label', 'Wed, Oct 21 · ongoing · 1,000 tokens (1K)');
    expect(current?.querySelector('title')?.textContent).toBe('Wed, Oct 21 · ongoing · 1,000 tokens (1K)');
  });

  it('shows the loading skeleton while the selected range has no matching summary', () => {
    const props = makeProps({
      selection: { mode: 'rolling', period: 'day' },
    });
    const { container } = render(<MenubarApp {...props} />);
    expect(container.querySelector('.mb-tnum-skel')).not.toBeNull();
  });

  it('flows settings changes through and clears stats only after confirmation', () => {
    const props = makeProps();
    render(<MenubarApp {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByLabelText(/show todo count/i));
    expect(props.onPreferencesChange).toHaveBeenCalledWith({
      showTokens: true,
      showTodoCount: false,
      selection: { mode: 'calendar', period: 'day' },
    });
    fireEvent.click(screen.getByText('Clear Token Stats…'));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onClearStats).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByText('Clear Token Stats…'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.onClearStats).toHaveBeenCalledTimes(1);
  });

  it('resets to the main view when the panel is reopened', () => {
    const props = makeProps();
    const { rerender } = render(<MenubarApp {...props} />);
    fireEvent.click(screen.getAllByTitle('Token details')[0]);
    expect(screen.getByText('Token details')).toBeInTheDocument();
    rerender(<MenubarApp {...props} openedTick={1} />);
    expect(screen.getByText('Tokens')).toBeInTheDocument();
  });

  it('shows the disconnected note without dropping known data', () => {
    render(<MenubarApp {...makeProps({ disconnected: true })} />);
    expect(screen.getByText(/can’t reach the gian host/i)).toBeInTheDocument();
    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText(USER_AUTHORED_TITLE)).toBeInTheDocument();
  });
});
