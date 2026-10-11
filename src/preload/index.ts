import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PartyCastApi } from '../shared/electron-api'

const api: PartyCastApi = {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  configureHook: (config) => ipcRenderer.invoke('hook:configure', config),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  selectAudioTrack: streamIndex => ipcRenderer.invoke('media:select-audio', streamIndex),
  cancelMediaPreparation: () => ipcRenderer.invoke('media:cancel-preparation'),
  releaseMedia: () => ipcRenderer.invoke('media:release'),
  onMediaProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: number | null): void => callback(progress)
    ipcRenderer.on('media:progress', listener)
    return () => ipcRenderer.removeListener('media:progress', listener)
  },
  registerDroppedFile: (file) => {
    const path = webUtils.getPathForFile(file)
    return path ? ipcRenderer.invoke('media:drop', path) : Promise.resolve(null)
  },
  pickSubtitle: () => ipcRenderer.invoke('subtitle:pick'),
  registerDroppedSubtitle: (file) => {
    const path = webUtils.getPathForFile(file)
    return path ? ipcRenderer.invoke('subtitle:drop', path) : Promise.resolve(null)
  },
  listEmbeddedSubtitles: () => ipcRenderer.invoke('subtitle:list-embedded'),
  loadEmbeddedSubtitle: (index) => ipcRenderer.invoke('subtitle:load-embedded', index),
  onWindowClosing: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:closing', listener)
    return () => ipcRenderer.removeListener('app:closing', listener)
  },
  closeReady: () => ipcRenderer.send('app:close-ready'),
  setFullscreen: fullscreen => ipcRenderer.invoke('window:fullscreen', fullscreen),
  relayHasKey: () => ipcRenderer.invoke('relay:has-key'),
  relayDefaultUrl: async () => (await ipcRenderer.invoke('settings:relay-default')) ?? '',
  relayImport: () => ipcRenderer.invoke('relay:import'),
  relayCall: (call) => ipcRenderer.invoke('relay:call', call),
  runHostHook: (phase) => ipcRenderer.invoke(phase === 'start' ? 'hook:start' : 'hook:stop'),
}

contextBridge.exposeInMainWorld('partycast', api)
