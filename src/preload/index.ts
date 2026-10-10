import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PartyCastApi } from '../shared/electron-api'

const api: PartyCastApi = {
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  pickMedia: () => ipcRenderer.invoke('media:pick'),
  registerDroppedFile: (file) => {
    const path = webUtils.getPathForFile(file)
    return path ? ipcRenderer.invoke('media:drop', path) : Promise.resolve(null)
  },
}

contextBridge.exposeInMainWorld('partycast', api)
