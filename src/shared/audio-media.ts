export type AudioTrackInfo = { streamIndex: number; codec: string; language: string; channels: number; title: string; isDefault: boolean }
export type ProbeStream = { index?: unknown; codec_name?: unknown; channels?: unknown; tags?: unknown; disposition?: unknown }

const chromiumAudio = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])
export function needsAudioTranscode(codec: string): boolean {
  return !(chromiumAudio.has(codec.toLowerCase()) || codec.toLowerCase().startsWith('pcm_'))
}

export function needsPlayableAudioPreparation(codec: string, filePath: string): boolean {
  return needsAudioTranscode(codec) || !/\.(mp4|m4v)$/i.test(filePath)
}

export function parseAudioTracks(input: unknown): AudioTrackInfo[] {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { streams?: unknown }).streams)) return []
  return (input as { streams: ProbeStream[] }).streams.flatMap(stream => {
    if (!Number.isSafeInteger(stream.index) || typeof stream.codec_name !== 'string') return []
    const tags = stream.tags && typeof stream.tags === 'object' ? stream.tags as Record<string, unknown> : {}
    const disposition = stream.disposition && typeof stream.disposition === 'object' ? stream.disposition as Record<string, unknown> : {}
    return [{
      streamIndex: stream.index as number,
      codec: stream.codec_name,
      language: typeof tags.language === 'string' ? tags.language : 'und',
      channels: typeof stream.channels === 'number' && Number.isFinite(stream.channels) ? stream.channels : 0,
      title: typeof tags.title === 'string' ? tags.title.slice(0, 128) : '',
      isDefault: disposition.default === 1,
    }]
  })
}

export function buildAudioTranscodeArgs(input: string, output: string, streamIndex: number): string[] {
  if (!Number.isSafeInteger(streamIndex) || streamIndex < 0) throw new Error('invalid-audio-stream')
  return ['-hide_banner', '-nostdin', '-y', '-i', input, '-map', '0:v:0', '-map', `0:${streamIndex}`, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:1', output]
}

export function parseFfmpegProgress(chunk: string, durationSeconds: number): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null
  const match = [...chunk.matchAll(/(?:^|\n)out_time_ms=(\d+)/g)].at(-1)
  if (!match) return null
  return Math.max(0, Math.min(100, Number(match[1]) / 1_000_000 / durationSeconds * 100))
}
