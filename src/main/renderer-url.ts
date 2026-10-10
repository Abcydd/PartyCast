import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// realpathSync.native expands Windows 8.3 short names (ABDULS~1 -> Abdulsayed) and normalises case,
// so two spellings of the same file compare equal.
function canonical(path: string): string {
  try { return realpathSync.native(path).toLowerCase() } catch { return resolve(path).toLowerCase() }
}

export function isOwnRendererUrl(url: string, rendererIndexPath: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:' || parsed.search || parsed.hash && parsed.hash !== '#') return false
    return canonical(fileURLToPath(parsed)) === canonical(rendererIndexPath)
  } catch { return false }
}
