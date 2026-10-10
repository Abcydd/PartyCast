import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { isOwnRendererUrl } from './renderer-url'

const dir = mkdtempSync(join(tmpdir(), 'pc-renderer-'))
const index = join(dir, 'index.html')
writeFileSync(index, '<!doctype html>')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('isOwnRendererUrl', () => {
  it('accepts the renderer index by its own URL', () => {
    expect(isOwnRendererUrl(pathToFileURL(index).href, index)).toBe(true)
  })

  it('accepts the same file when one side uses an 8.3 short path and the other the long path', () => {
    const long = realpathSync.native(index)
    // On Windows os.tmpdir() is often the short form (C:\Users\ABDULS~1\...); realpath gives the long form.
    expect(isOwnRendererUrl(pathToFileURL(long).href, index)).toBe(true)
    expect(isOwnRendererUrl(pathToFileURL(index).href, long)).toBe(true)
  })

  it('rejects other files, other schemes, queries and garbage', () => {
    const other = join(dir, 'other.html')
    writeFileSync(other, '')
    expect(isOwnRendererUrl(pathToFileURL(other).href, index)).toBe(false)
    expect(isOwnRendererUrl('https://example.com/index.html', index)).toBe(false)
    expect(isOwnRendererUrl(`${pathToFileURL(index).href}?x=1`, index)).toBe(false)
    expect(isOwnRendererUrl('not a url', index)).toBe(false)
  })
})
