import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ffprobeStatic from 'ffprobe-static'
import { app } from 'electron'
import type { AudioTrackInfo } from '../shared/electron-api'
import { buildAudioTranscodeArgs, needsPlayableAudioPreparation, parseAudioTracks, parseFfmpegProgress } from '../shared/audio-media'
import { ffmpegBinary } from './embedded-subs'

const execFileAsync = promisify(execFile)
let activeConversion: ChildProcess | null = null
const temporaryFiles = new Set<string>()

function unpacked(binaryPath: string): string {
  return binaryPath.split('app.asar').join('app.asar.unpacked')
}

export async function probeAudio(path: string): Promise<{ tracks: AudioTrackInfo[]; duration: number }> {
  const { stdout } = await execFileAsync(unpacked(ffprobeStatic.path), [
    '-v', 'error', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels:stream_tags=language,title:stream_disposition=default', '-of', 'json', path,
  ], { timeout: 20000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
  const parsed: unknown = JSON.parse(stdout)
  if (!parsed || typeof parsed !== 'object') return { tracks: [], duration: 0 }
  const record = parsed as { streams?: unknown; format?: { duration?: unknown } }
  const streams = Array.isArray(record.streams) ? record.streams.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object' && (value as Record<string, unknown>).codec_type === 'audio') : []
  const duration = Number(record.format?.duration)
  return { tracks: parseAudioTracks({ streams }), duration: Number.isFinite(duration) ? duration : 0 }
}

export function cancelAudioPreparation(): boolean {
  if (!activeConversion) return false
  activeConversion.kill()
  activeConversion = null
  return true
}

export async function prepareAudio(path: string, streamIndex: number, duration: number, report: (progress: number | null) => void): Promise<string> {
  const tracks = await probeAudio(path)
  const selected = tracks.tracks.find(track => track.streamIndex === streamIndex)
  if (!selected) throw new Error('audio-track-unavailable')
  if (!needsPlayableAudioPreparation(selected.codec, path)) return path
  const binary = ffmpegBinary()
  if (!binary) throw new Error('ffmpeg-unavailable')
  const directory = join(app?.getPath('temp') ?? tmpdir(), `PartyCast-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  const output = join(directory, 'playable.mp4')
  temporaryFiles.add(output)
  const args = buildAudioTranscodeArgs(path, output, streamIndex)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    activeConversion = child
    let progressBuffer = ''
    child.stdout?.on('data', (data: Buffer) => {
      progressBuffer += data.toString('utf8')
      if (progressBuffer.length > 8192) progressBuffer = progressBuffer.slice(-4096)
      const value = parseFfmpegProgress(progressBuffer, duration)
      if (value !== null) report(value)
      progressBuffer = progressBuffer.slice(progressBuffer.lastIndexOf('\n') + 1)
      if (/progress=end/.test(data.toString('utf8'))) report(100)
    })
    child.once('error', error => { if (activeConversion === child) activeConversion = null; rejectPromise(error) })
    child.once('exit', code => {
      if (activeConversion === child) activeConversion = null
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(code === null ? 'preparation-cancelled' : `ffmpeg-exit-${code}`))
    })
  }).catch(async error => { temporaryFiles.delete(output); await rm(directory, { recursive: true, force: true }); throw error })
  return output
}

export async function cleanTemporaryMedia(): Promise<void> {
  cancelAudioPreparation()
  await Promise.all([...temporaryFiles].map(async path => { await rm(join(path, '..'), { recursive: true, force: true }).catch(() => {}); temporaryFiles.delete(path) }))
}

export async function removeTemporaryMedia(path: string): Promise<void> {
  if (!temporaryFiles.has(path)) return
  temporaryFiles.delete(path)
  await rm(join(path, '..'), { recursive: true, force: true }).catch(() => {})
}
