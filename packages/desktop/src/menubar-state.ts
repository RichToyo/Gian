import { readFileSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isMenubarPreferences, OFFICIAL_QUOTA_REFRESH_TIMEOUT_MS, type MenubarPreferences } from '@gian/shared';

export const DEFAULT_MENUBAR_PREFERENCES: MenubarPreferences = {
  showTokens: true, showTodoCount: true, selection: { mode: 'calendar', period: 'day' },
};

export const MENUBAR_WIDTH = 392;
export const MENUBAR_MAX_HEIGHT = 640;

export function menubarRequestTimeout(path: string, method: 'GET' | 'POST'): number {
  return method === 'POST' && /^\/api\/agents\/[^/?#]+\/official-quota\/refresh$/u.test(path)
    ? OFFICIAL_QUOTA_REFRESH_TIMEOUT_MS + 5_000 : 12_000;
}

export function formatTrayTokens(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return '?';
  if (value < 1_000) return String(value);
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function formatTrayTitle(tokens: number, pendingTotal: number, preferences: MenubarPreferences): string {
  return [
    preferences.showTokens ? formatTrayTokens(tokens) : '',
    preferences.showTodoCount && pendingTotal > 0 ? String(pendingTotal) : '',
  ].filter(Boolean).join(' \u00b7 ');
}

export function menubarBounds(tray: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number }, preferredHeight = 640): { x: number; y: number; width: number; height: number } {
  const width = Math.min(MENUBAR_WIDTH, area.width);
  const height = Math.min(Number.isFinite(preferredHeight) ? Math.max(120, Math.ceil(preferredHeight)) : MENUBAR_MAX_HEIGHT,
    MENUBAR_MAX_HEIGHT, area.height);
  const x = Math.round(Math.max(area.x, Math.min(area.x + area.width - width, tray.x + tray.width / 2 - width / 2)));
  const below = tray.y + tray.height;
  const y = Math.round(Math.max(area.y, Math.min(area.y + area.height - height, below)));
  return { x, y, width, height };
}

export function isMenubarResource(url: string, entry: URL): boolean {
  try {
    const candidate = new URL(url);
    if (candidate.origin !== entry.origin || candidate.username || candidate.password) return false;
    if (candidate.pathname === entry.pathname) return candidate.search === '';
    return /^\/(?:assets\/|src\/|node_modules\/|@vite\/|@react-refresh$|@fs\/|@id\/)/u.test(candidate.pathname)
      || /^\/api\/proxies\/[a-zA-Z0-9_.%:-]+\/logo\/(?:light|dark)$/u.test(candidate.pathname);
  } catch { return false; }
}

export function isLocalMenubarOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export class FileMenubarPreferences {
  constructor(private readonly path: string) {}
  load(): MenubarPreferences {
    try {
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (isMenubarPreferences(value)) return value;
    } catch { /* Missing preferences use the product defaults. */ }
    return structuredClone(DEFAULT_MENUBAR_PREFERENCES);
  }
  save(preferences: MenubarPreferences): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(preferences), { mode: 0o600 });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }
}
