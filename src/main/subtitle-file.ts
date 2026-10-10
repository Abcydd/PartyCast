import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { PickedSubtitle } from '../shared/electron-api'

export async function readSubtitle(path: string): Promise<PickedSubtitle | null> {
  if (!['.srt', '.vtt'].includes(extname(path).toLowerCase())) return null
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null
    const bytes = await readFile(path)
    if (bytes.byteLength > 2 * 1024 * 1024) return null
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { text = new TextDecoder('windows-1256').decode(bytes) }
    return { title: basename(path), text: text.replace(/^\uFEFF/, '') }
  } catch { return null }
}
