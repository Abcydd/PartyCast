import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defaultSettings, sanitizeSettings, type Settings } from '../shared/settings'
import type { HookConfig } from '../shared/relay-config'
export { defaultSettings, sanitizeSettings, type Settings } from '../shared/settings'

export async function loadSettings(path: string): Promise<Settings> {
  try {
    return sanitizeSettings(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return structuredClone(defaultSettings)
  }
}

export async function saveSettings(path: string, settings: unknown): Promise<Settings> {
  const current = await loadSettings(path)
  const incoming = settings && typeof settings === 'object' ? { ...(settings as Record<string, unknown>) } : {}
  // settings:save must IGNORE hostStartHook/hostStopHook fields
  delete incoming.hostStartHook
  delete incoming.hostStopHook
  const cleaned = sanitizeSettings({
    ...incoming,
    hostStartHook: current.hostStartHook,
    hostStopHook: current.hostStopHook,
  })
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(cleaned, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return cleaned
}

export async function saveHookSettings(
  path: string,
  hooks: { hostStartHook?: HookConfig; hostStopHook?: HookConfig }
): Promise<Settings> {
  const current = await loadSettings(path)
  const cleaned: Settings = {
    ...current,
    hostStartHook: hooks.hostStartHook ?? current.hostStartHook,
    hostStopHook: hooks.hostStopHook ?? current.hostStopHook,
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(cleaned, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return cleaned
}
