import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readSubtitle } from './subtitle-file'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
describe('host subtitle selection', () => {
  it('loads UTF-8 BOM and falls back to Windows-1256 for invalid UTF-8', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.tmp-subs-'))
    dirs.push(dir)
    const utf = join(dir, 'arabic.srt')
    await writeFile(utf, '\uFEFFمرحبا')
    expect((await readSubtitle(utf))?.text).toBe('مرحبا')
    const cp = join(dir, 'legacy.vtt')
    await writeFile(cp, Buffer.from([0xc7, 0xe3]))
    expect((await readSubtitle(cp))?.text).toBe('ام')
  })
  it('rejects oversized or unsupported files', async () => {
    const dir = await mkdtemp(join(process.cwd(), '.tmp-subs-'))
    dirs.push(dir)
    const huge = join(dir, 'huge.srt')
    await writeFile(huge, Buffer.alloc(2 * 1024 * 1024 + 1))
    expect(await readSubtitle(huge)).toBeNull()
    expect(await readSubtitle(join(dir, 'movie.txt'))).toBeNull()
  })
})
