import type { MenubarTodo } from '@gian/shared';
import { AgentMark } from './identity.js';
import { ICON, SvgIcon } from './icons.js';

export const TODO_COLLAPSED_MAX = 3;

const REASON_LABELS: Record<MenubarTodo['reason'], string> = {
  approval: 'Approval',
  reply: 'Reply',
  unread: 'Unread',
  failed: 'Failed',
};

/** Pending conversations: single-line rows of Agent mark + verbatim user
 * title + neutral status word. The header count is always the real pending
 * total, independent of how many rows are visible. All/Less expands inline
 * and never navigates or marks anything read; only a row click navigates. */
export function TodoSection({
  items,
  total,
  expanded,
  loading,
  onExpandedChange,
  onNavigate,
}: {
  items: readonly MenubarTodo[];
  total: number;
  expanded: boolean;
  loading?: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onNavigate: (todo: MenubarTodo) => void;
}) {
  const visible = expanded ? items : items.slice(0, TODO_COLLAPSED_MAX);
  return (
    <section className="mb-sec">
      <div className="mb-sec-head">
        <span className="mb-sec-label">Todo</span>
        {total > 0 && <span className="mb-todo-count">{total}</span>}
        <span className="mb-spacer" />
        {total > TODO_COLLAPSED_MAX && (
          <button
            type="button"
            className="mb-ghost-link"
            aria-expanded={expanded}
            aria-controls="mb-todo-list"
            onClick={() => onExpandedChange(!expanded)}
          >
            <span>{expanded ? 'Less' : 'All'}</span>
            <SvgIcon d={ICON.caretDown} size={11} />
          </button>
        )}
      </div>
      <div className="mb-todo-list" id="mb-todo-list">
        {loading ? (
          <div className="mb-todo-empty">
            <span className="mb-skel-line" aria-label="Loading pending conversations" />
          </div>
        ) : items.length === 0 ? (
          <div className="mb-todo-empty">
            <SvgIcon d={ICON.circleCheck} size={15} />
            <span>Nothing needs attention</span>
          </div>
        ) : (
          visible.map(todo => (
            <button
              key={todo.sessionId}
              type="button"
              className="mb-todo"
              onClick={() => onNavigate(todo)}
            >
              <AgentMark pluginId={todo.pluginId ?? todo.agentId} size={16} className="mb-t-ico" />
              <span className="mb-t-title">{todo.title}</span>
              <span className="mb-t-status">{REASON_LABELS[todo.reason]}</span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
