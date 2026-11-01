import { Suspense, lazy } from 'react';
import { useT } from '../i18n/index.js';
import type { RemoteSettingsController } from '../remote-settings/types.js';

const SettingsRemotePage = lazy(() =>
  import('../components/SettingsRemotePage.js').then(module => ({ default: module.SettingsRemotePage })));

export function RemoteEntryShell({
  localController,
  onBack,
}: {
  localController: RemoteSettingsController | null;
  onBack: () => void;
}) {
  const t = useT();

  return (
    <div className="remote-entry-workspace" data-testid="remote-entry" style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: 8, flexWrap: 'wrap' }}>
        <strong>Gian Remote</strong>
        <button type="button" className="btn secondary" onClick={onBack}>{t('login.remote.back')}</button>
      </header>
      <div className="login-shell" style={{ minHeight: 0, flex: 1, overflow: 'auto' }}>
        <div style={{ width: 'min(1100px, 100%)' }}>
          <Suspense fallback={<div className="app-loading" role="status" />}>
            <SettingsRemotePage controller={localController} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
