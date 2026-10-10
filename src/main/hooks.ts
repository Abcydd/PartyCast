import { execFile } from 'node:child_process'
import type { HookConfig } from '../shared/relay-config'

export function executeHook(config: HookConfig): Promise<{ ok: boolean; message?: string; ran: boolean }> {
  if (!config.executable) return Promise.resolve({ ok: true, ran: false })
  return new Promise(resolve => {
    execFile(config.executable, config.args, { shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 1024 }, error => {
      resolve(error ? { ok: false, ran: true, message: error.message.slice(0, 200) } : { ok: true, ran: true })
    })
  })
}
