import { contextBridge, ipcRenderer } from 'electron'
import type { AccountInput, AppSettings, AppSnapshot, LocalBridge } from '../shared/types'

const bridge: LocalBridge = {
  getSnapshot: () => ipcRenderer.invoke('snapshot:get'),
  refresh: (accountIds?: string[]) => ipcRenderer.invoke('refresh', accountIds),
  importCurrent: () => ipcRenderer.invoke('account:import-current'),
  saveAccount: (input: AccountInput) => ipcRenderer.invoke('account:save', input),
  removeAccount: (id: string) => ipcRenderer.invoke('account:remove', id),
  switchAccount: (id: string) => ipcRenderer.invoke('account:switch', id),
  importText: (text: string) => ipcRenderer.invoke('account:import-text', text),
  exportAccounts: (ids?: string[]) => ipcRenderer.invoke('account:export', ids),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
  getResetCreditDetail: (id: string) => ipcRenderer.invoke('reset-credits:get', id),
  installHook: () => ipcRenderer.invoke('hook:install'),
  openCodex: () => ipcRenderer.invoke('codex:open'),
  openLog: () => ipcRenderer.invoke('log:open'),
  openLogDirectory: () => ipcRenderer.invoke('log:open-directory'),
  showPanel: () => ipcRenderer.invoke('panel:show'),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),
  startWidgetDrag: () => ipcRenderer.invoke('widget:start-drag'),
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: AppSnapshot): void => listener(value)
    ipcRenderer.on('snapshot', handler)
    return () => ipcRenderer.removeListener('snapshot', handler)
  }
}

contextBridge.exposeInMainWorld('codexUsage', bridge)
