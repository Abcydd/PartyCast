import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { basename, extname, join, resolve, dirname, parse } from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { readSubtitle } from './subtitle-file'
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

async function registerMedia(path: string): Promise<PickedMedia> {
  const token = randomUUID()
  mediaFiles.clear()
  mediaFiles.set(token, path)
  const stem = parse(path).name
  const subtitle = await readSubtitle(join(dirname(path), `${stem}.srt`)) ?? await readSubtitle(join(dirname(path), `${stem}.vtt`))
  return { url: `partycast-media://video/${token}`, title: basename(path), subtitle }
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
      devTools: !app.isPackaged,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  let closing = false
  window.on('close', event => {
    if (closing) return
    event.preventDefault()
    window.webContents.send('app:closing')
    setTimeout(() => { if (!window.isDestroyed()) { closing = true; window.close() } }, 1200)
  })
  const onCloseReady = (event: Electron.IpcMainEvent): void => {
    if (event.sender !== window.webContents || window.isDestroyed()) return
    closing = true
    window.close()
  }
  ipcMain.on('app:close-ready', onCloseReady)
  window.on('closed', () => ipcMain.off('app:close-ready', onCloseReady))
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
}

if (process.env.PARTYCAST_QA === '1') {
  app.commandLine.appendSwitch('mute-audio')
  if (process.env.PARTYCAST_QA_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.PARTYCAST_QA_PORT)
  if (process.env.PARTYCAST_QA_PROFILE) app.setPath('userData', process.env.PARTYCAST_QA_PROFILE)
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
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

  const trusted = (event: Electron.IpcMainInvokeEvent): boolean => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return false
    const url = event.senderFrame?.url ?? ''
    const builtUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href
    const devUrl = process.env.ELECTRON_RENDERER_URL
    return url === builtUrl || !!devUrl && (url === devUrl || url === `${devUrl.replace(/\/$/, '')}/`)
  }
  ipcMain.handle('settings:load', (event) => trusted(event) ? loadSettings(settingsPath()) : null)
  ipcMain.handle('settings:save', (event, settings: unknown) => trusted(event) ? saveSettings(settingsPath(), settings) : null)
  ipcMain.handle('media:pick', async (event) => {
    if (!trusted(event)) return null
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Video files', extensions: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi'] }],
    })
    return result.canceled || !result.filePaths[0] ? null : registerMedia(result.filePaths[0])
  })
  ipcMain.handle('media:drop', async (event, input: unknown) => {
    if (!trusted(event)) return null
    if (typeof input !== 'string' || input.length > 32768) return null
    const path = resolve(input)
    if (!Object.hasOwn(contentTypes, extname(path).toLowerCase())) return null
    try {
      if (!(await stat(path)).isFile()) return null
    } catch {
      return null
    }
    return registerMedia(path)
  })
  ipcMain.handle('subtitle:pick', async (event) => {
    if (!trusted(event)) return null
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt'] }] })
    return result.canceled || !result.filePaths[0] ? null : readSubtitle(result.filePaths[0])
  })
  ipcMain.handle('subtitle:drop', async (event, input: unknown) => {
    if (!trusted(event) || typeof input !== 'string' || input.length > 32768) return null
    return readSubtitle(resolve(input))
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
