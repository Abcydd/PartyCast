import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractSubtitleTrack,
  ffmpegBinary,
  ffprobeBinary,
  listSubtitleTracks,
  parseProbeJson,
  trackLabel,
  validateEmbeddedIndex,
  type EmbeddedSubtitleTrack,
} from './embedded-subs'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

const track = (overrides: Partial<EmbeddedSubtitleTrack>): EmbeddedSubtitleTrack => ({
  index: 0, codec: 'subrip', language: '', title: '', textBased: true, ...overrides,
})

describe('parseProbeJson', () => {
  it('parses well-formed ffprobe output and ignores junk', () => {
    const json = JSON.stringify({
      streams: [
        { index: 0, codec_name: 'h264' },
        { index: 1, codec_name: 'aac' },
        { index: 99, codec_name: 'made_up_codec' },
        { index: 2, codec_name: 'subrip', tags: { language: 'ARA', title: ' Arabic main ' } },
        { index: 3, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
        { index: 'four', codec_name: 'subrip' },
        { index: -1, codec_name: 'subrip' },
        { index: 4.5, codec_name: 'subrip' },
        { codec_name: 'subrip' },
        { index: 5 },
        'junk',
        null,
      ],
    })
    expect(parseProbeJson(json)).toEqual([
      { index: 2, codec: 'subrip', language: 'ara', title: 'Arabic main', textBased: true },
      { index: 3, codec: 'hdmv_pgs_subtitle', language: 'eng', title: '', textBased: false },
    ])
  })
  it('returns no tracks for missing tags, invalid JSON or missing streams', () => {
    expect(parseProbeJson('{"streams":[{"index":1,"codec_name":"ass"}]}')).toEqual([
      { index: 1, codec: 'ass', language: '', title: '', textBased: true },
    ])
    expect(parseProbeJson('not json at all')).toEqual([])
    expect(parseProbeJson('{"streams":"nope"}')).toEqual([])
    expect(parseProbeJson('{"errors":[]}')).toEqual([])
    expect(parseProbeJson(null as unknown as string)).toEqual([])
  })
})

describe('trackLabel', () => {
  it('names known languages', () => {
    expect(trackLabel(track({ language: 'ara' }))).toBe('Arabic · SRT')
    expect(trackLabel(track({ language: 'eng', codec: 'webvtt' }))).toBe('English · WebVTT')
    expect(trackLabel(track({ language: 'fre' }))).toBe('French · SRT')
    expect(trackLabel(track({ language: 'fra' }))).toBe('French · SRT')
    expect(trackLabel(track({ language: 'ger' }))).toBe('German · SRT')
    expect(trackLabel(track({ language: 'deu' }))).toBe('German · SRT')
    expect(trackLabel(track({ language: 'per' }))).toBe('Persian · SRT')
    expect(trackLabel(track({ language: 'fas' }))).toBe('Persian · SRT')
    expect(trackLabel(track({ language: 'zho' }))).toBe('Chinese · SRT')
  })
  it('marks forced tracks and uses titles', () => {
    expect(trackLabel(track({ language: 'eng', codec: 'ass', title: 'Forced' }))).toBe('English (Forced) · ASS')
    expect(trackLabel(track({ language: 'eng', codec: 'ass', title: 'English (Forced)' }))).toBe('English (Forced) · ASS')
    expect(trackLabel(track({ language: '', title: 'Commentary' }))).toBe('Commentary · SRT')
  })
  it('falls back to Unknown, raw codes and track numbers', () => {
    expect(trackLabel(track({ language: 'und' }))).toBe('Unknown · SRT')
    expect(trackLabel(track({ language: 'vsn' }))).toBe('VSN · SRT')
    expect(trackLabel(track({ index: 2, language: '', title: '' }))).toBe('Track 3 · SRT')
  })
  it('marks image codecs as not supported', () => {
    expect(trackLabel(track({ index: 2, codec: 'hdmv_pgs_subtitle', textBased: false }))).toBe('Track 3 · PGS (image – not supported)')
    expect(trackLabel(track({ codec: 'dvd_subtitle', textBased: false }))).toBe('Track 1 · DVD (image – not supported)')
    expect(trackLabel(track({ language: 'ara', codec: 'dvb_subtitle', textBased: false }))).toBe('Arabic · DVB (image – not supported)')
  })
})

describe('validateEmbeddedIndex', () => {
  const tracks = [
    track({ index: 2, language: 'ara' }),
    track({ index: 3, codec: 'hdmv_pgs_subtitle', textBased: false }),
    track({ index: 4, language: 'eng' }),
  ]
  it('accepts an integer that exists in the listing and is text-based', () => {
    expect(validateEmbeddedIndex(tracks, 2)?.language).toBe('ara')
    expect(validateEmbeddedIndex(tracks, 4)?.language).toBe('eng')
  })
  it('rejects image tracks and bad input', () => {
    expect(validateEmbeddedIndex(tracks, 3)).toBeNull()
    expect(validateEmbeddedIndex(tracks, 1)).toBeNull()
    expect(validateEmbeddedIndex(tracks, 2.5)).toBeNull()
    expect(validateEmbeddedIndex(tracks, -1)).toBeNull()
    expect(validateEmbeddedIndex(tracks, '2')).toBeNull()
    expect(validateEmbeddedIndex(tracks, null)).toBeNull()
    expect(validateEmbeddedIndex([], 2)).toBeNull()
  })
})

const binariesReady = !!ffmpegBinary() && existsSync(ffmpegBinary()!) && existsSync(ffprobeBinary())

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegBinary()!, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error) => (error ? reject(error) : resolve()))
  })
}

describe('embedded subtitle extraction', () => {
  it.skipIf(!binariesReady)('lists and extracts an embedded SRT track from a generated MKV', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'partycast-embedded-'))
    dirs.push(dir)
    const srtPath = join(dir, 'sample.srt')
    await writeFile(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nHello\n\n2\n00:00:01,000 --> 00:00:02,000\nWorld\n')
    const mkvPath = join(dir, 'sample.mkv')
    await runFfmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=160x120:d=1',
      '-f', 'srt', '-i', srtPath,
      '-map', '0:v', '-map', '1:s',
      '-c:v', 'mpeg4', '-q:v', '7', '-c:s', 'srt',
      '-y', mkvPath,
    ])
    const tracks = await listSubtitleTracks(mkvPath)
    expect(tracks).toHaveLength(1)
    expect(tracks[0].index).toBeTypeOf('number')
    expect(tracks[0].codec).toBe('subrip')
    expect(tracks[0].textBased).toBe(true)
    const text = await extractSubtitleTrack(mkvPath, tracks[0].index)
    expect(text).toContain('WEBVTT')
    expect(text).toContain('Hello')
    expect(text).toContain('World')
  }, 30000)
})
