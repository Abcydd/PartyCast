import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultSettings, loadSettings, saveSettings, saveHookSettings } from './settings'

const paths: string[] = []
async function testPath(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), '.tmp-settings-'))
  paths.push(dir)
  return join(dir, 'settings.json')
}
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('settings persistence', () => {
  it('uses defaults when missing or corrupt', async () => {
    const path = await testPath()
    expect(await loadSettings(path)).toEqual(defaultSettings)
    await writeFile(path, '{broken')
    expect(await loadSettings(path)).toEqual(defaultSettings)
  })
  it('saves and validates settings', async () => {
    const path = await testPath()
    const saved = await saveSettings(path, {
      displayName: ' Ada ',
      maxViewers: 100,
      turn: { url: 'turn:relay.example:3478', username: 'u', credential: 'secret' },
    })
    expect(saved.maxViewers).toBe(32)
    expect((await loadSettings(path)).turn.credential).toBe('secret')
    await writeFile(path, JSON.stringify({ maxViewers: -1, turn: { url: 'https://wrong' } }))
    expect(await loadSettings(path)).toMatchObject({ maxViewers: 1, turn: { url: '' } })
  })
  it('settings:save drops hook fields and preserves existing hooks', async () => {
    const path = await testPath()
    const savedInitial = await saveSettings(path, {
      displayName: 'Alice',
      hostStartHook: { executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'calc'] },
      hostStopHook: { executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'notepad'] },
    })
    expect(savedInitial.hostStartHook).toEqual({ executable: '', args: [] })
    expect(savedInitial.hostStopHook).toEqual({ executable: '', args: [] })

    await saveHookSettings(path, {
      hostStartHook: { executable: 'C:\\Program Files\\App\\hook.exe', args: ['--start'] },
    })
    const loadedAfterHook = await loadSettings(path)
    expect(loadedAfterHook.hostStartHook).toEqual({
      executable: 'C:\\Program Files\\App\\hook.exe',
      args: ['--start'],
    })

    const savedSecond = await saveSettings(path, {
      displayName: 'Bob',
      hostStartHook: { executable: 'powershell.exe', args: ['-Command', 'evil'] },
    })
    expect(savedSecond.displayName).toBe('Bob')
    expect(savedSecond.hostStartHook).toEqual({
      executable: 'C:\\Program Files\\App\\hook.exe',
      args: ['--start'],
    })
    expect((await loadSettings(path)).hostStartHook).toEqual({
      executable: 'C:\\Program Files\\App\\hook.exe',
      args: ['--start'],
    })
  })
})
