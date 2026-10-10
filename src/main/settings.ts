import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defaultSettings, sanitizeSettings, type Settings } from '../shared/settings'
export { defaultSettings, sanitizeSettings, type Settings } from '../shared/settings'

export async function loadSettings(path: string): Promise<Settings> {
  try {
    return sanitizeSettings(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return structuredClone(defaultSettings)
  }
}

export async function saveSettings(path: string, settings: Settings): Promise<Settings> {
  const cleaned = sanitizeSettings(settings)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(cleaned, null, 2), { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  return cleaned
}
