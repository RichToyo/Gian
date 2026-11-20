const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
import type { GianMenubarBridge, MenubarChange } from '@gian/shared';

const bridge: GianMenubarBridge = {
  getSnapshot: selection => ipcRenderer.invoke('menubar:snapshot', selection),
  getPending: () => ipcRenderer.invoke('menubar:pending'),
  getQuota: () => ipcRenderer.invoke('menubar:quota'),
  refreshQuota: agentId => ipcRenderer.invoke('menubar:quota-refresh', agentId),
  getPreferences: () => ipcRenderer.invoke('menubar:preferences'),
  setPreferences: preferences => ipcRenderer.invoke('menubar:preferences-set', preferences),
  getAppearance: () => ipcRenderer.invoke('menubar:appearance'),
  navigate: input => ipcRenderer.invoke('menubar:navigate', input),
  clearUsage: input => ipcRenderer.invoke('menubar:clear', input),
  hide: () => ipcRenderer.invoke('menubar:hide'),
  onChanged: listener => {
    const handler = (_event: Electron.IpcRendererEvent, change: MenubarChange) => listener(change);
    ipcRenderer.on('menubar:changed', handler);
    return () => ipcRenderer.removeListener('menubar:changed', handler);
  },
};
contextBridge.exposeInMainWorld('gianMenubar', Object.freeze(bridge));
