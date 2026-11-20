import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/tokens.css';
import './menubar.css';
import { resolveMenubarBridge } from './bridge.js';
import { GianMark } from './GianMark.js';
import { MenubarRoot } from './MenubarRoot.js';

/* Standalone menubar panel entry (packages/web/menubar.html). Deliberately
 * separate from the main App bootstrap: no session subscriptions, editor or
 * chat startup. Data arrives only through the contracted window.gianMenubar
 * bridge; when the bridge is absent the panel says so — it never renders
 * fixture or demo data as a production fallback. */

function BridgeMissing() {
  return (
    <div className="mb-panel">
      <div className="mb-p-head">
        <span className="mb-p-brand">
          <GianMark size={18} />
          <span className="mb-p-name">Gian</span>
        </span>
      </div>
      <div className="mb-p-body">
        <div className="mb-state-note calm mb-bridge-missing">
          <span>The menu bar panel is unavailable in this context.</span>
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

const bridge = resolveMenubarBridge();

createRoot(container).render(
  <StrictMode>
    {bridge ? <MenubarRoot bridge={bridge} /> : <BridgeMissing />}
  </StrictMode>,
);
