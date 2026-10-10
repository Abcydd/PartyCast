import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { basename, extname, join, resolve, dirname, parse } from 'node:path'
import { loadSettings, saveSettings, saveHookSettings } from './settings'
import { getQaOverrides } from './qa-guard'
import { validateAndResolveHook } from './hook-configure'
import { readSubtitle } from './subtitle-file'
import { relayEndpoint } from './relay-ipc'
import { getHostKey, importRelayConfig } from './relay-security'
import { executeHook } from './hooks'
import { parseRangeHeader } from './range'
import type { PickedMedia } from '../shared/electron-api'
import type { HookConfig } from '../shared/relay-config'

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

const qa = getQaOverrides(app.isPackaged)
if (qa.isQa) {
  app.commandLine.appendSwitch('mute-audio')
  if (qa.qaPort) app.commandLine.appendSwitch('remote-debugging-port', qa.qaPort)
  if (qa.qaProfile) app.setPath('userData', qa.qaProfile)
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
  ipcMain.handle('hook:configure', async (event, proposed: unknown) => {
    if (!trusted(event)) return { ok: false, error: 'forbidden' }
    if (!proposed || typeof proposed !== 'object') return { ok: false, error: 'invalid-request' }
    const p = proposed as Record<string, unknown>
    const window = BrowserWindow.fromWebContents(event.sender)
    let newStartHook: HookConfig | undefined
    let newStopHook: HookConfig | undefined

    if ('hostStartHook' in p && p.hostStartHook !== undefined) {
      const startRes = await validateAndResolveHook(p.hostStartHook)
      if (!startRes.ok) return { ok: false, error: startRes.error }
      if (startRes.resolved.executable) {
        const argsPart = startRes.resolved.args.length > 0 ? ` ${startRes.resolved.args.join(' ')}` : ''
        const message = `Allow PartyCast to run ${startRes.resolved.executable}${argsPart} when hosting starts?`
        const choice = window
          ? await dialog.showMessageBox(window, { type: 'question', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, title: 'PartyCast Hook Confirmation', message })
          : await dialog.showMessageBox({ type: 'question', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, title: 'PartyCast Hook Confirmation', message })
        if (choice.response !== 0) return { ok: false, error: 'user-rejected' }
      }
      newStartHook = startRes.resolved
    }

    if ('hostStopHook' in p && p.hostStopHook !== undefined) {
      const stopRes = await validateAndResolveHook(p.hostStopHook)
      if (!stopRes.ok) return { ok: false, error: stopRes.error }
      if (stopRes.resolved.executable) {
        const argsPart = stopRes.resolved.args.length > 0 ? ` ${stopRes.resolved.args.join(' ')}` : ''
        const message = `Allow PartyCast to run ${stopRes.resolved.executable}${argsPart} when hosting stops?`
        const choice = window
          ? await dialog.showMessageBox(window, { type: 'question', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, title: 'PartyCast Hook Confirmation', message })
          : await dialog.showMessageBox({ type: 'question', buttons: ['Allow', 'Cancel'], defaultId: 1, cancelId: 1, title: 'PartyCast Hook Confirmation', message })
        if (choice.response !== 0) return { ok: false, error: 'user-rejected' }
      }
      newStopHook = stopRes.resolved
    }

    const updated = await saveHookSettings(settingsPath(), {
      hostStartHook: newStartHook,
      hostStopHook: newStopHook,
    })
    return { ok: true, settings: updated }
  })
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
  ipcMain.handle('relay:has-key', async event => trusted(event) ? !!(await getHostKey()) || (qa.isQa && !!qa.qaHostKey) : false)
  ipcMain.handle('relay:import', event => trusted(event) ? importRelayConfig() : null)
  ipcMain.handle('relay:call', async (event, input: unknown) => {
    if (!trusted(event)) return { status: 403, body: { error: 'forbidden' } }
    const endpoint = relayEndpoint(input)
    if (!endpoint || endpoint.body && JSON.stringify(endpoint.body).length > 65536) return { status: 400, body: { error: 'invalid-request' } }
    const settings = await loadSettings(settingsPath())
    const key = endpoint.host ? (qa.isQa && qa.qaHostKey || await getHostKey()) : endpoint.ticket
    if (endpoint.host && !key) return { status: 401, body: { error: 'missing-host-key' } }
    const base = (qa.isQa && qa.qaRelayUrl) || settings.relayUrl
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch(`${base}${endpoint.path}`, { method: endpoint.method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json' }, body: endpoint.body === undefined ? undefined : JSON.stringify(endpoint.body), signal: controller.signal })
      const raw = await response.text()
      if (raw.length > 65536) return { status: 502, body: { error: 'relay-response-too-large' } }
      const body = JSON.parse(raw) as unknown
      if (qa.isQa && qa.qaControlDirect && endpoint.path === '/v1/turn' && response.ok)
        return { status: response.status, body: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], qaControlDirect: true } }
      return { status: response.status, body }
    } catch { return { status: 503, body: { error: 'relay-unavailable' } } }
    finally { clearTimeout(timer) }
  })
  let hookStarted = false
  let stoppingHook = false
  let startTask: Promise<{ ok: boolean; message?: string; ran: boolean }> | null = null
  const stopHook = async (): Promise<{ ok: boolean; message?: string; ran: boolean }> => {
    if (startTask) await startTask
    if (!hookStarted || stoppingHook) return { ok: true, ran: false }
    hookStarted = false; stoppingHook = true
    const result = await executeHook((await loadSettings(settingsPath())).hostStopHook)
    stoppingHook = false
    return result
  }
  ipcMain.handle('hook:start', async event => {
    if (!trusted(event) || hookStarted || startTask) return { ok: false, ran: false, message: 'Hook is already active' }
    startTask = (async () => executeHook((await loadSettings(settingsPath())).hostStartHook))()
    try {
      const result = await startTask
      hookStarted = result.ran
      return result
    } finally { startTask = null }
  })
  ipcMain.handle('hook:stop', event => trusted(event) ? stopHook() : { ok: false, ran: false })
  app.on('before-quit', event => {
    if (!hookStarted && !startTask) return
    event.preventDefault()
    void stopHook().finally(() => app.quit())
  })
  app.on('render-process-gone', () => { void stopHook() })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
