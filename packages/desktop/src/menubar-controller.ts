import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, session, Tray } from 'electron';
import {
  DEFAULT_ACCENT, FRAME_OPACITY_DEFAULT, isAttentionNavigationTarget, isMenubarAppearance, isMenubarId,
  isMenubarNavigation, isMenubarPending, isMenubarPreferences, isMenubarSnapshot, isOfficialQuotaSnapshot, isUsageClearRequest, isUsageSelection,
  type MenubarAppearance, type MenubarChange, type MenubarPreferences,
} from '@gian/shared';
import { FileMenubarPreferences, formatTrayTitle, isMenubarResource, menubarBounds, MENUBAR_MAX_HEIGHT, MENUBAR_WIDTH } from './menubar-state.js';

const CHANNELS = ['snapshot', 'pending', 'quota', 'quota-refresh', 'preferences', 'preferences-set', 'appearance', 'navigate', 'clear', 'hide'];

export class MenubarController {
  private panel: BrowserWindow | null = null;
  private tray: Tray;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private suspended = false;
  private disposed = false;
  private lifecycleRevision = 0;
  private preferredHeight = 640;
  private panelMaxHeight = 0;
  private panelLimitStyle: string | null = null;
  private lastLocalKey = '';
  private lastPanelMinute = 0;
  private lastTitle = '';
  private preferences: MenubarPreferences;
  private appearance: MenubarAppearance = { theme: 'light', accent: DEFAULT_ACCENT, frameOpacity: FRAME_OPACITY_DEFAULT };
  private readonly entry: URL;
  private readonly partition: Electron.Session;
  private readonly resumed = () => { void this.refreshLocal(); };
  private readonly displayChanged = () => { if (this.panel?.isVisible()) this.positionPanel(); };

  constructor(private readonly options: {
    webUrl: string; hostUrl: string; preloadPath: string; iconPath: string; preferencesPath: string;
    desktopToken: string | null; tokenHeader: string;
    request: (path: string, body?: unknown) => Promise<unknown>;
    navigate: (target: Extract<import('@gian/shared').AttentionNavigationTarget, { type: 'session' }>) => Promise<void>;
    quit: () => void;
  }) {
    this.entry = new URL('/menubar.html', options.webUrl);
    const store = new FileMenubarPreferences(options.preferencesPath);
    this.preferences = store.load();
    this.partition = session.fromPartition('gian-menubar');
    this.partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.partition.setPermissionCheckHandler(() => false);
    this.partition.on('will-download', event => event.preventDefault());
    this.partition.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isMenubarResource(details.url, this.entry) });
    });
    this.partition.webRequest.onBeforeSendHeaders((details, callback) => {
      const url = new URL(details.url);
      const trustedHost = url.origin === new URL(options.hostUrl).origin && isMenubarResource(details.url, this.entry);
      if (options.desktopToken && trustedHost) {
        details.requestHeaders[options.tokenHeader] = options.desktopToken;
      }
      if (trustedHost && /^\/api\/proxies\/[^/]+\/logo\/(light|dark)$/u.test(url.pathname)) {
        void session.defaultSession.cookies.get({ url: options.hostUrl, name: 'gian_session' }).then(cookies => {
          const cookie = cookies.find(item => item.name === 'gian_session');
          if (cookie) details.requestHeaders.Cookie = `gian_session=${cookie.value}`;
          callback({ requestHeaders: details.requestHeaders });
        }).catch(() => callback({ requestHeaders: details.requestHeaders }));
        return;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    this.partition.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      if (new URL(details.url).pathname === this.entry.pathname) {
        headers['Content-Security-Policy'] = [`default-src 'none'; script-src 'self'${app.isPackaged ? '' : " 'unsafe-inline'"}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`];
      }
      callback({ responseHeaders: headers });
    });
    // Dedicated 20pt Dragon-G PNGs, not the full-color App ICNS. macOS tints
    // the template for the actual menu-bar background, including dark mode.
    const icon = nativeImage.createFromPath(options.iconPath);
    if (icon.isEmpty()) throw new Error('Gian menu bar template icon is missing');
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip('Gian');
    this.tray.on('click', () => { void this.toggle(); });
    this.tray.on('right-click', () => this.tray.popUpContextMenu(Menu.buildFromTemplate([
      { label: 'Show Today Tokens', type: 'checkbox', checked: this.preferences.showTokens,
        click: item => { this.preferences.showTokens = item.checked; store.save(this.preferences); void this.refreshLocal(); } },
      { label: 'Show Todo Count', type: 'checkbox', checked: this.preferences.showTodoCount,
        click: item => { this.preferences.showTodoCount = item.checked; store.save(this.preferences); void this.refreshLocal(); } },
      { type: 'separator' }, { label: 'Quit Gian', click: options.quit },
    ])));
    for (const name of CHANNELS) ipcMain.handle(`menubar:${name}`, async (event, value: unknown) => {
      if (!this.panel || this.panel.isDestroyed() || event.sender !== this.panel.webContents
        || event.senderFrame !== this.panel.webContents.mainFrame
        || event.senderFrame.url !== this.entry.href || this.suspended) throw new Error('Menubar request rejected');
      switch (name) {
        case 'snapshot':
          if (!isUsageSelection(value)) throw new Error('Invalid selection');
          return this.checked(`/api/menubar/snapshot?mode=${value.mode}&period=${value.period}`, isMenubarSnapshot);
        case 'pending': return this.checked('/api/menubar/pending', isMenubarPending);
        case 'quota': return this.checked('/api/agents/official-quota', isOfficialQuotaSnapshot);
        case 'quota-refresh':
          if (!isMenubarId(value)) throw new Error('Invalid Agent');
          try { return await this.checked(`/api/agents/${encodeURIComponent(value)}/official-quota/refresh`, isOfficialQuotaSnapshot, {}); }
          finally { this.changed({ type: 'quota' }); }
        case 'preferences': return structuredClone(this.preferences);
        case 'preferences-set':
          if (!isMenubarPreferences(value)) throw new Error('Invalid preferences');
          store.save(value);
          this.preferences = structuredClone(value);
          void this.refreshLocal();
          return structuredClone(value);
        case 'appearance': return { ...this.appearance };
        case 'navigate': {
          if (!isMenubarNavigation(value)) throw new Error('Invalid navigation');
          const result = await options.request('/api/menubar/navigate', value) as { valid?: unknown; target?: unknown };
          if (result.valid !== true || !isAttentionNavigationTarget(result.target) || result.target.type !== 'session'
            || result.target.session_id !== value.sessionId) { this.changed({ type: 'local' }); return false; }
          await options.navigate(result.target);
          this.panel.hide();
          return true;
        }
        case 'clear': {
          if (!isUsageClearRequest(value)) throw new Error('Invalid clear request');
          const result = await dialog.showMessageBox(this.panel, { type: 'warning', message: 'Clear local usage statistics?',
            detail: 'Conversation history and official account quota will not change.', buttons: ['Cancel', 'Clear Statistics'], defaultId: 0, cancelId: 0 });
          if (result.response !== 1) throw new Error('Clear cancelled');
          const response = await options.request('/api/usage/clear', value);
          if (!response || typeof response !== 'object' || Array.isArray(response)
            || Object.keys(response).length !== 1 || !('generation' in response)
            || typeof response.generation !== 'number' || !Number.isSafeInteger(response.generation) || response.generation < 1) {
            throw new Error('Invalid clear response');
          }
          void this.refreshLocal();
          return { generation: response.generation };
        }
        case 'hide': this.panel.hide(); return;
      }
    });
    powerMonitor.on('resume', this.resumed);
    nativeTheme.on('updated', this.resumed);
    screen.on('display-metrics-changed', this.displayChanged);
    this.resume();
  }

  pause(): void {
    this.lifecycleRevision++;
    this.suspended = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.panel?.hide();
  }

  resume(): void {
    if (this.disposed) return;
    this.suspended = false;
    if (!this.timer) { this.timer = setInterval(() => { void this.refreshLocal(); }, 2_000); this.timer.unref(); }
    void this.refreshLocal();
  }

  dispose(): void {
    this.pause();
    this.disposed = true;
    powerMonitor.removeListener('resume', this.resumed);
    nativeTheme.removeListener('updated', this.resumed);
    screen.removeListener('display-metrics-changed', this.displayChanged);
    for (const name of CHANNELS) ipcMain.removeHandler(`menubar:${name}`);
    this.panel?.destroy();
    this.tray.destroy();
  }

  private changed(change: MenubarChange): void {
    if (this.panel && !this.panel.isDestroyed()) this.panel.webContents.send('menubar:changed', change);
  }

  private async checked<T>(path: string, guard: (value: unknown) => value is T, body?: unknown): Promise<T> {
    const value = await this.options.request(path, body);
    if (!guard(value)) throw new Error('Invalid menubar response');
    return value;
  }

  private async toggle(): Promise<void> {
    if (this.suspended || this.disposed) return;
    if (this.panel?.isVisible()) { this.panel.hide(); return; }
    if (this.panel && !this.panel.isDestroyed() && this.panel.webContents.isLoading()) return;
    if (!this.panel || this.panel.isDestroyed()) {
      const panel = new BrowserWindow({ width: MENUBAR_WIDTH, height: MENUBAR_MAX_HEIGHT, show: false, frame: false, resizable: false,
        minimizable: false, maximizable: false, skipTaskbar: true, fullscreenable: false, transparent: true,
        ...(process.platform === 'darwin' ? { vibrancy: this.appearance.theme === 'dark' ? 'sidebar' as const : 'under-window' as const } : {}),
        webPreferences: { preload: this.options.preloadPath, session: this.partition, contextIsolation: true,
          sandbox: true, nodeIntegration: false, webSecurity: true, enablePreferredSizeMode: true, devTools: !app.isPackaged } });
      this.panel = panel;
      this.panelMaxHeight = 0;
      this.panelLimitStyle = null;
      panel.webContents.on('dom-ready', () => { this.panelMaxHeight = 0; this.positionPanel(); });
      panel.on('closed', () => { if (this.panel === panel) this.panel = null; });
      panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      panel.setAlwaysOnTop(true, 'pop-up-menu');
      panel.webContents.on('preferred-size-changed', (_event, size) => {
        if (this.panel !== panel || panel.isDestroyed() || !Number.isFinite(size.height)) return;
        this.preferredHeight = size.height;
        this.positionPanel();
      });
      panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      panel.webContents.on('will-navigate', (event, url) => { if (url !== this.entry.href) event.preventDefault(); });
      panel.webContents.on('will-redirect', event => event.preventDefault());
      panel.webContents.on('will-attach-webview', event => event.preventDefault());
      panel.webContents.on('before-input-event', (event, input) => { if (input.key === 'Escape') { event.preventDefault(); panel.hide(); } });
      panel.on('blur', () => { if (!panel.isDestroyed()) panel.hide(); });
      try { await panel.loadURL(this.entry.href); } catch { panel.destroy(); this.panel = null; return; }
    }
    if (this.disposed || this.suspended || !this.panel) return;
    this.positionPanel();
    this.panel.show();
    this.panel.focus();
    this.changed({ type: 'opened' });
    void this.refreshLocal();
  }

  private positionPanel(): void {
    if (!this.panel || this.panel.isDestroyed()) return;
    const trayBounds = this.tray.getBounds();
    const area = screen.getDisplayMatching(trayBounds).workArea;
    const panel = this.panel;
    const maxHeight = Math.min(MENUBAR_MAX_HEIGHT, area.height);
    if (this.panelMaxHeight !== maxHeight) {
      this.panelMaxHeight = maxHeight;
      void panel.webContents.insertCSS(`:root { --mb-panel-max-height: ${maxHeight}px; }`).then(key => {
        if (panel.isDestroyed()) return;
        if (this.panel !== panel || this.panelMaxHeight !== maxHeight) {
          void panel.webContents.removeInsertedCSS(key).catch(() => {});
          return;
        }
        const previous = this.panelLimitStyle;
        this.panelLimitStyle = key;
        if (previous) void panel.webContents.removeInsertedCSS(previous).catch(() => {});
      }).catch(() => { if (this.panel === panel) this.panelMaxHeight = 0; });
    }
    const bounds = menubarBounds(trayBounds, area, this.preferredHeight);
    const current = this.panel.getBounds();
    if (Object.entries(bounds).some(([key, value]) => current[key as keyof typeof bounds] !== value)) this.panel.setBounds(bounds);
  }

  private async refreshLocal(): Promise<void> {
    if (this.refreshing || this.suspended || this.disposed) return;
    this.refreshing = true;
    const revision = this.lifecycleRevision;
    try {
      const snapshot = await this.checked('/api/menubar/snapshot?mode=calendar&period=day', isMenubarSnapshot);
      if (this.disposed || this.suspended || revision !== this.lifecycleRevision) return;
      const tokens = snapshot.today.totalTokens;
      const count = snapshot.pendingTotal;
      if (!Number.isSafeInteger(tokens) || tokens < 0 || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid local snapshot');
      const title = formatTrayTitle(tokens, count, this.preferences);
      if (title !== this.lastTitle) { this.tray.setTitle(title, { fontType: 'monospacedDigit' }); this.lastTitle = title; }
      this.tray.setToolTip(`Gian: ${tokens.toLocaleString('en')} tokens today, ${count} Todo`);
      const localKey = JSON.stringify([snapshot.today.generation, snapshot.today.revision, snapshot.today.from, snapshot.pendingTotal, snapshot.pending]);
      const minute = Math.floor(snapshot.asOf / 60_000);
      if (this.panel?.isVisible() && (localKey !== this.lastLocalKey || minute !== this.lastPanelMinute)) {
        this.changed({ type: 'local' });
        this.lastPanelMinute = minute;
      }
      this.lastLocalKey = localKey;
      const settings = await this.options.request('/api/settings') as { theme: string; accent: string; frame_opacity: number; system_light_theme: string };
      if (this.disposed || this.suspended || revision !== this.lifecycleRevision) return;
      const theme = settings.theme === 'system' ? nativeTheme.shouldUseDarkColors ? 'dark' : settings.system_light_theme : settings.theme;
      const next = { theme, accent: settings.accent, frameOpacity: settings.frame_opacity };
      if (isMenubarAppearance(next) && JSON.stringify(next) !== JSON.stringify(this.appearance)) {
        this.appearance = next;
        if (process.platform === 'darwin') this.panel?.setVibrancy(theme === 'dark' ? 'sidebar' : 'under-window');
        this.changed({ type: 'appearance', appearance: { ...next } });
      }
    } catch {
      if (!this.disposed) this.tray.setToolTip('Gian: local Host unavailable');
    } finally { this.refreshing = false; }
  }
}
