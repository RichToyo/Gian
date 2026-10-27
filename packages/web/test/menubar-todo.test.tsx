import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MenubarTodo } from '@gian/shared';
import { TodoSection } from '../src/menubar/TodoSection.js';
import { makeTodo, USER_AUTHORED_TITLE } from './menubar-fixtures.js';

function makeItems(count: number): MenubarTodo[] {
  const reasons: MenubarTodo['reason'][] = ['approval', 'reply', 'failed', 'unread'];
  return Array.from({ length: count }, (_, i) => makeTodo({
    sessionId: `s-${i + 1}`,
    revision: `r${i + 1}`,
    title: i === 0 ? USER_AUTHORED_TITLE : `Task ${i + 1}`,
    reason: reasons[i % reasons.length],
    pluginId: i === 3 ? null : 'codex',
    agentId: i === 3 ? null : 'codex',
  }));
}

function renderSection(overrides: Partial<Parameters<typeof TodoSection>[0]> = {}) {
  const props = {
    items: makeItems(8),
    total: 8,
    expanded: false,
    onExpandedChange: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
  return { ...render(<TodoSection {...props} />), props };
}

describe('TodoSection', () => {
  it('shows three rows by default and always the real pending total', () => {
    const { container } = renderSection();
    expect(container.querySelectorAll('.mb-todo')).toHaveLength(3);
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('renders single-line rows: Agent mark, verbatim title, neutral status word', () => {
    const { container } = renderSection();
    const first = container.querySelector('.mb-todo')!;
    expect(first.querySelector('.mb-t-title')?.textContent).toBe(USER_AUTHORED_TITLE);
    expect(first.querySelector('.mb-t-status')?.textContent).toBe('Approval');
    expect(first.querySelector('.mb-t-ico img')?.getAttribute('src')).toBe('/api/proxies/codex/logo/light');
    expect(first.querySelector('.mb-t-meta')).toBeNull();
  });

  it('uses the generic bot mark when the Agent identity is unknown', () => {
    const { container } = renderSection({ expanded: true });
    expect(container.querySelectorAll('.mb-agent-generic')).toHaveLength(2);
  });

  it('shows all status words in neutral English', () => {
    renderSection({ expanded: true });
    for (const label of ['Approval', 'Reply', 'Failed', 'Unread']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it('All expands inline to every item with aria-expanded and never navigates', () => {
    const { container, props, rerender } = renderSection();
    const all = screen.getByRole('button', { name: /all/i });
    expect(all).toHaveAttribute('aria-expanded', 'false');
    expect(all).toHaveAttribute('aria-controls', 'mb-todo-list');
    fireEvent.click(all);
    expect(props.onExpandedChange).toHaveBeenCalledWith(true);
    expect(props.onNavigate).not.toHaveBeenCalled();
    rerender(<TodoSection {...props} expanded={true} />);
    expect(container.querySelectorAll('.mb-todo')).toHaveLength(8);
    expect(screen.getByRole('button', { name: /less/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('Less collapses back to three rows while the count stays at the total', () => {
    const onExpandedChange = vi.fn();
    const { container, rerender } = render(
      <TodoSection items={makeItems(8)} total={8} expanded={false}
        onExpandedChange={onExpandedChange} onNavigate={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /all/i }));
    rerender(
      <TodoSection items={makeItems(8)} total={8} expanded={true}
        onExpandedChange={onExpandedChange} onNavigate={vi.fn()} />,
    );
    expect(container.querySelectorAll('.mb-todo')).toHaveLength(8);
    const less = screen.getByRole('button', { name: /less/i });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(less);
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    rerender(
      <TodoSection items={makeItems(8)} total={8} expanded={false}
        onExpandedChange={onExpandedChange} onNavigate={vi.fn()} />,
    );
    expect(container.querySelectorAll('.mb-todo')).toHaveLength(3);
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('hides the All button when the total fits in three rows', () => {
    renderSection({ items: makeItems(3), total: 3 });
    expect(screen.queryByRole('button', { name: /all/i })).toBeNull();
  });

  it('shows the empty state and hides the count when nothing is pending', () => {
    const { container } = renderSection({ items: [], total: 0 });
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
    expect(container.querySelector('.mb-todo-count')).toBeNull();
  });

  it('navigates only via a concrete row click', () => {
    const { container, props } = renderSection();
    fireEvent.click(container.querySelectorAll('.mb-todo')[1]);
    expect(props.onNavigate).toHaveBeenCalledTimes(1);
    expect(props.onNavigate.mock.calls[0][0].sessionId).toBe('s-2');
  });
});
