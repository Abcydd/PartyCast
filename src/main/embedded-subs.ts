import { execFile } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'
import type { EmbeddedSubtitleTrack } from '../shared/electron-api'
import { parseProbeJson } from '../shared/embedded-subtitles'

export {
  LANGUAGE_NAMES,
  TEXT_SUBTITLE_CODECS,
  parseProbeJson,
  trackLabel,
  validateEmbeddedIndex,
} from '../shared/embedded-subtitles'
export type { EmbeddedSubtitleTrack } from '../shared/electron-api'

const MAX_BYTES = 2 * 1024 * 1024

// When packaged the binaries live unpacked next to the asar (see "asarUnpack"
// in package.json), so replace app.asar with app.asar.unpacked. In development
// the paths never contain app.asar and this is a no-op.
function unpacked(binaryPath: string): string {
  return binaryPath.split('app.asar').join('app.asar.unpacked')
}

export function ffmpegBinary(): string | null {
  return ffmpegPath ? unpacked(ffmpegPath) : null
}

export function ffprobeBinary(): string {
  return unpacked(ffprobeStatic.path)
}

function runTool(binary: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    // execFile never spawns a shell; args are passed verbatim.
    execFile(binary, args, { timeout, maxBuffer: MAX_BYTES, windowsHide: true }, (error, stdout) => {
      if (error) rejectPromise(error)
      else resolvePromise(stdout)
    })
  })
}

export async function listSubtitleTracks(videoPath: string): Promise<EmbeddedSubtitleTrack[]> {
  const stdout = await runTool(
    ffprobeBinary(),
    ['-v', 'error', '-select_streams', 's', '-show_entries', 'stream=index,codec_name:stream_tags=language,title', '-of', 'json', videoPath],
    15000,
  )
  return parseProbeJson(stdout)
}

export async function extractSubtitleTrack(videoPath: string, streamIndex: number): Promise<string> {
  if (!Number.isInteger(streamIndex) || streamIndex < 0) throw new Error('invalid-stream-index')
  const binary = ffmpegBinary()
  if (!binary) throw new Error('ffmpeg-unavailable')
  // webvtt output is capped by maxBuffer, so oversized extractions abort.
  return runTool(binary, ['-v', 'error', '-i', videoPath, '-map', `0:${streamIndex}`, '-f', 'webvtt', '-'], 60000)
}
