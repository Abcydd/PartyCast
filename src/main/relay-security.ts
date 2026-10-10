import { app, dialog, safeStorage } from 'electron'
import { readFile, writeFile, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseHostKeyFile } from '../shared/relay-config'
import { saveSettings, loadSettings } from './settings'

const keyPath = (): string => join(app.getPath('userData'), 'relay-host-key.bin')
const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export async function getHostKey(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  try { return safeStorage.decryptString(await readFile(keyPath())) }
  catch { return null }
}
export async function importRelayConfig(): Promise<{ relayUrl: string } | null> {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'PartyCast relay key', extensions: ['txt','env'] }] })
  const path = result.filePaths[0]
  if (result.canceled || !path) return null
  const info = await stat(path)
  if (!info.isFile() || info.size > 4096) throw new Error('Invalid relay key file')
  const parsed = parseHostKeyFile(await readFile(path, 'utf8'))
  if (!parsed || !safeStorage.isEncryptionAvailable()) throw new Error('Could not import relay key securely')
  const temp = `${keyPath()}.tmp`
  await writeFile(temp, safeStorage.encryptString(parsed.hostKey), { mode: 0o600 })
  await rename(temp, keyPath())
  await saveSettings(settingsPath(), { ...await loadSettings(settingsPath()), relayUrl: parsed.relayUrl })
  return { relayUrl: parsed.relayUrl }
}
