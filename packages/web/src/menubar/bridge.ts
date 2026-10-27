import type { GianMenubarBridge } from '@gian/shared';

/* The dedicated sandboxed preload (owned by the Desktop track) exposes the
 * bridge. Declared here per the contract; the renderer never sees a Host
 * token, Provider credential or arbitrary IPC. */
declare global {
  interface Window {
    gianMenubar?: GianMenubarBridge;
  }
}

export function resolveMenubarBridge(): GianMenubarBridge | null {
  return typeof window !== 'undefined' && window.gianMenubar ? window.gianMenubar : null;
}
