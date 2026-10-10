import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { validateAndResolveHook } from './hook-configure'

describe('hook:configure validation and resolution', () => {
  const fakeEnvPath = ['C:\\Tools', 'C:\\Windows\\System32'].join(';')
  const existingFiles = new Set([
    'C:\\Program Files\\App\\app.exe',
    'C:\\Tools\\docker.exe',
    'C:\\Windows\\System32\\notepad.exe',
  ])
  const statFn = async (p: string): Promise<boolean> => existingFiles.has(p)

  it('validates and resolves absolute path to existing file', async () => {
    const res = await validateAndResolveHook(
      { executable: 'C:\\Program Files\\App\\app.exe', args: ['--serve', '8080'] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(res).toEqual({
      ok: true,
      resolved: {
        executable: 'C:\\Program Files\\App\\app.exe',
        args: ['--serve', '8080'],
      },
    })
  })

  it('rejects absolute path to non-existing file', async () => {
    const res = await validateAndResolveHook(
      { executable: 'C:\\NonExistent\\tool.exe', args: [] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(res).toEqual({ ok: false, error: 'executable-not-found' })
  })

  it('resolves bare name via PATH to existing .exe', async () => {
    const res = await validateAndResolveHook(
      { executable: 'docker', args: ['ps'] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(res).toEqual({
      ok: true,
      resolved: {
        executable: join('C:\\Tools', 'docker.exe'),
        args: ['ps'],
      },
    })

    const withExt = await validateAndResolveHook(
      { executable: 'notepad.exe', args: [] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(withExt).toEqual({
      ok: true,
      resolved: {
        executable: join('C:\\Windows\\System32', 'notepad.exe'),
        args: [],
      },
    })
  })

  it('rejects bare name not found in PATH', async () => {
    const res = await validateAndResolveHook(
      { executable: 'unknown-tool', args: [] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(res).toEqual({ ok: false, error: 'executable-not-found' })
  })

  it('rejects relative path with separators', async () => {
    const res = await validateAndResolveHook(
      { executable: '.\\bin\\tool.exe', args: [] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(res).toEqual({ ok: false, error: 'relative-path-not-allowed' })
  })

  it('allows empty executable to clear hook', async () => {
    const res = await validateAndResolveHook(
      { executable: '', args: ['ignored'] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(res).toEqual({ ok: true, resolved: { executable: '', args: [] } })
  })

  it('rejects invalid arguments and injection attempts', async () => {
    const newlineExe = await validateAndResolveHook(
      { executable: 'C:\\test.exe\nmalicious', args: [] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(newlineExe.ok).toBe(false)

    const newlineArg = await validateAndResolveHook(
      { executable: 'C:\\Program Files\\App\\app.exe', args: ['arg1\narg2'] },
      { statFn, envPath: fakeEnvPath }
    )
    expect(newlineArg.ok).toBe(false)

    const tooManyArgs = await validateAndResolveHook(
      { executable: 'C:\\Program Files\\App\\app.exe', args: Array.from({ length: 17 }, (_, i) => `a${i}`) },
      { statFn, envPath: fakeEnvPath }
    )
    expect(tooManyArgs.ok).toBe(false)
  })
})
