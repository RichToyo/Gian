import type { MenubarPreferences } from '@gian/shared';

/** Settings overlay: menu-bar display toggles and the destructive clear
 * action. Panel appearance follows the main App; there is no panel-local
 * theme setting. Quit lives in the native tray menu owned by Desktop Main,
 * not here. */
export function SettingsMenu({
  preferences,
  onPreferencesChange,
  onRequestClear,
}: {
  preferences: MenubarPreferences;
  onPreferencesChange: (preferences: MenubarPreferences) => void;
  onRequestClear: () => void;
}) {
  return (
    <div className="mb-menu" role="menu" aria-label="Menu bar settings">
      <label className="mb-menu-toggle">
        Show today’s tokens in menu bar
        <span className="mb-switch">
          <input
            type="checkbox"
            checked={preferences.showTokens}
            onChange={event => onPreferencesChange({ ...preferences, showTokens: event.target.checked })}
          />
        </span>
      </label>
      <label className="mb-menu-toggle">
        Show todo count in menu bar
        <span className="mb-switch">
          <input
            type="checkbox"
            checked={preferences.showTodoCount}
            onChange={event => onPreferencesChange({ ...preferences, showTodoCount: event.target.checked })}
          />
        </span>
      </label>
      <div className="mb-menu-rule" />
      <button type="button" className="mb-menu-item danger" onClick={onRequestClear}>
        Clear Token Stats…
      </button>
    </div>
  );
}

/** Confirmation for the irreversible clear action. */
export function ConfirmClearDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="mb-confirm-overlay" onPointerDown={event => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div className="mb-confirm-modal" role="alertdialog" aria-modal="true" aria-label="Clear token stats">
        <div className="mb-confirm-title">Clear token stats?</div>
        <div className="mb-confirm-msg">
          This deletes all local token usage summaries. Conversations are not affected. This cannot be undone.
        </div>
        <div className="mb-confirm-actions">
          <button type="button" className="mb-btn ghosty" onClick={onCancel}>Cancel</button>
          <button type="button" className="mb-btn danger" onClick={onConfirm}>Clear</button>
        </div>
      </div>
    </div>
  );
}
