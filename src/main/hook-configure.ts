import { isAbsolute, join, delimiter } from 'node:path'
import { stat } from 'node:fs/promises'
import type { HookConfig } from '../shared/relay-config'

export type HookValidationResult =
  | { ok: true; resolved: HookConfig }
  | { ok: false; error: string }

export async function validateAndResolveHook(
  input: unknown,
  options?: {
    envPath?: string
    statFn?: (path: string) => Promise<boolean>
  }
): Promise<HookValidationResult> {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid-hook' }
  const v = input as Record<string, unknown>
  const rawExe = v.executable
  if (typeof rawExe !== 'string') return { ok: false, error: 'invalid-executable' }
  const trimmed = rawExe.trim()

  if (trimmed === '') {
    return { ok: true, resolved: { executable: '', args: [] } }
  }

  if (trimmed.length > 1024 || /[\r\n\0]/.test(trimmed)) {
    return { ok: false, error: 'invalid-executable' }
  }

  const rawArgs = v.args ?? []
  if (!Array.isArray(rawArgs) || rawArgs.length > 16) {
    return { ok: false, error: 'invalid-args' }
  }
  const args: string[] = []
  for (const a of rawArgs) {
    if (typeof a !== 'string' || a.length > 256 || /[\r\n\0]/.test(a)) {
      return { ok: false, error: 'invalid-args' }
    }
    args.push(a)
  }

  const checkFile = options?.statFn ?? (async (p: string) => {
    try {
      const s = await stat(p)
      return s.isFile()
    } catch {
      return false
    }
  })

  const isAbs = isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
  if (isAbs) {
    if (await checkFile(trimmed)) {
      return { ok: true, resolved: { executable: trimmed, args } }
    }
    if (!trimmed.toLowerCase().endsWith('.exe') && (await checkFile(`${trimmed}.exe`))) {
      return { ok: true, resolved: { executable: `${trimmed}.exe`, args } }
    }
    return { ok: false, error: 'executable-not-found' }
  }

  if (/[\\/]/.test(trimmed)) {
    return { ok: false, error: 'relative-path-not-allowed' }
  }

  const envPath = options?.envPath ?? process.env.PATH ?? ''
  const dirs = envPath.split(delimiter).filter(Boolean)
  const candidates = trimmed.toLowerCase().endsWith('.exe') ? [trimmed] : [`${trimmed}.exe`, trimmed]

  for (const dir of dirs) {
    for (const cand of candidates) {
      const fullPath = join(dir, cand)
      if (await checkFile(fullPath)) {
        return { ok: true, resolved: { executable: fullPath, args } }
      }
    }
  }

  return { ok: false, error: 'executable-not-found' }
}
