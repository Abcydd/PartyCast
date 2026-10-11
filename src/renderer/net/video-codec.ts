import { codecPreferenceOrder, type VideoCodecResult } from '../../shared/video-encoding'

type CodecResultMap = Readonly<Record<string, VideoCodecResult>>
let probe: Promise<CodecResultMap | undefined> | undefined

export function probeVideoEncoder(): Promise<CodecResultMap | undefined> {
  probe ??= (async () => {
    const mediaCapabilities = navigator.mediaCapabilities
    if (!mediaCapabilities || typeof mediaCapabilities.encodingInfo !== 'function') return undefined
    const results: Record<string, VideoCodecResult> = {}
    for (const codec of ['AV1', 'H265', 'H264', 'VP9']) {
      const contentType = codec === 'H265' ? 'video/H265' : `video/${codec}`
      try {
        const result = await mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: { contentType, width: 1920, height: 1080, bitrate: 5_000_000, framerate: 30 },
        })
        results[codec] = { supported: result.supported, powerEfficient: result.powerEfficient }
      } catch {
        return undefined
      }
    }
    console.info(`[PartyCast] encoder probe ${JSON.stringify(results)}`)
    return results
  })()
  return probe
}

export async function preferredVideoCodecs<T extends { mimeType: string }>(codecs: readonly T[]): Promise<T[]> {
  const results = await probeVideoEncoder()
  return codecPreferenceOrder(codecs, results)
}

export async function codecProbeSummary(): Promise<string> {
  const results = await probeVideoEncoder()
  return results ? JSON.stringify(results) : 'unavailable; fallback order'
}
