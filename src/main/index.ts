import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, resolve } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { parseRangeHeader } from './range'
import type { PickedMedia } from '../shared/electron-api'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'partycast-media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
  },
])

const mediaFiles = new Map<string, string>()
const contentTypes: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
}

function registerMedia(path: string): PickedMedia {
  const token = randomUUID()
  mediaFiles.clear()
  mediaFiles.set(token, path)
  return { url: `partycast-media://video/${token}`, title: basename(path) }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  protocol.handle('partycast-media', async (request) => {
    const token = new URL(request.url).pathname.slice(1)
    const path = mediaFiles.get(token)
    if (!path) return new Response('Not found', { status: 404 })
    try {
      const info = await stat(path)
      if (!info.isFile()) return new Response('Not found', { status: 404 })
      const range = parseRangeHeader(request.headers.get('range'), info.size)
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range',
        'Content-Type': contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      if (range === 'unsatisfiable') {
        headers.set('Content-Range', `bytes */${info.size}`)
        return new Response(null, { status: 416, headers })
      }
      const start = range?.start ?? 0
      const end = range?.end ?? info.size - 1
      headers.set('Content-Length', String(Math.max(0, end - start + 1)))
      if (range) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
      if (request.method === 'HEAD' || info.size === 0)
        return new Response(null, { status: range ? 206 : 200, headers })
      const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>
      return new Response(body, { status: range ? 206 : 200, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })

  ipcMain.handle('settings:load', () => loadSettings(settingsPath()))
  ipcMain.handle('settings:save', (_event, settings: unknown) =>
    saveSettings(settingsPath(), settings as Parameters<typeof saveSettings>[1]),
  )
  ipcMain.handle('media:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Video files', extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'] }],
    })
    return result.canceled || !result.filePaths[0] ? null : registerMedia(result.filePaths[0])
  })
  ipcMain.handle('media:drop', async (_event, input: unknown) => {
    if (typeof input !== 'string') return null
    const path = resolve(input)
    if (!Object.hasOwn(contentTypes, extname(path).toLowerCase())) return null
    try {
      if (!(await stat(path)).isFile()) return null
    } catch {
      return null
    }
    return registerMedia(path)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
