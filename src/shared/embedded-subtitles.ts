import type { EmbeddedSubtitleTrack } from './electron-api'

// Text-based codecs can be converted to WebVTT by ffmpeg. Everything else
// (PGS, DVD/DVB subtitles, …) is bitmap based and cannot be sent as text.
export const TEXT_SUBTITLE_CODECS: ReadonlySet<string> = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'])

// Bitmap (or otherwise non-extractable) subtitle codecs.
export const IMAGE_SUBTITLE_CODECS: ReadonlySet<string> = new Set([
  'hdmv_pgs_subtitle',
  'hdmv_text_subtitle',
  'dvd_subtitle',
  'dvb_subtitle',
  'dvb_teletext',
  'arib_caption',
])

const KNOWN_SUBTITLE_CODECS: ReadonlySet<string> = new Set([...TEXT_SUBTITLE_CODECS, ...IMAGE_SUBTITLE_CODECS])

export const LANGUAGE_NAMES: Record<string, string> = {
  ara: 'Arabic',
  eng: 'English',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  spa: 'Spanish',
  ita: 'Italian',
  tur: 'Turkish',
  hin: 'Hindi',
  urd: 'Urdu',
  per: 'Persian',
  fas: 'Persian',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  rus: 'Russian',
  por: 'Portuguese',
  und: 'Unknown',
}

const CODEC_LABELS: Record<string, string> = {
  subrip: 'SRT',
  srt: 'SRT',
  ass: 'ASS',
  ssa: 'SSA',
  webvtt: 'WebVTT',
  mov_text: 'MOV_TEXT',
  text: 'TEXT',
  hdmv_pgs_subtitle: 'PGS',
  hdmv_text_subtitle: 'HDMV TEXT',
  dvd_subtitle: 'DVD',
  dvb_subtitle: 'DVB',
}

function codecLabel(codec: string): string {
  return CODEC_LABELS[codec] ?? codec.replace(/_/g, ' ').toUpperCase()
}

// Strictly validates ffprobe JSON output (-select_streams s -of json) and
// ignores anything that is not a well-formed subtitle stream entry.
export function parseProbeJson(json: string): EmbeddedSubtitleTrack[] {
  let data: unknown
  try { data = JSON.parse(json) } catch { return [] }
  if (!data || typeof data !== 'object') return []
  const streams = (data as { streams?: unknown }).streams
  if (!Array.isArray(streams)) return []
  const tracks: EmbeddedSubtitleTrack[] = []
  for (const entry of streams) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as { index?: unknown; codec_name?: unknown; tags?: unknown }
    if (typeof record.index !== 'number' || !Number.isInteger(record.index) || record.index < 0) continue
    if (typeof record.codec_name !== 'string' || !record.codec_name) continue
    const codec = record.codec_name.toLowerCase()
    // Anything that is not a recognized subtitle stream (video, audio, exotic
    // data tracks) is junk for our purposes.
    if (!KNOWN_SUBTITLE_CODECS.has(codec)) continue
    let language = ''
    let title = ''
    if (record.tags && typeof record.tags === 'object') {
      const tags = record.tags as { language?: unknown; title?: unknown }
      if (typeof tags.language === 'string') language = tags.language.trim().toLowerCase()
      if (typeof tags.title === 'string') title = tags.title.trim()
    }
    tracks.push({ index: record.index, codec, language, title, textBased: TEXT_SUBTITLE_CODECS.has(codec) })
  }
  return tracks
}

// Human label, e.g. "Arabic · SRT", "English (Forced) · ASS",
// "Track 3 · PGS (image – not supported)".
export function trackLabel(track: EmbeddedSubtitleTrack): string {
  const known = LANGUAGE_NAMES[track.language]
  let name: string
  if (known) name = known
  else if (track.language) name = track.language.toUpperCase()
  else if (track.title) name = track.title
  else name = `Track ${track.index + 1}`
  if (/\bforced\b/i.test(track.title) && !/\bforced\b/i.test(name)) name += ' (Forced)'
  const label = `${name} · ${codecLabel(track.codec)}`
  return track.textBased ? label : `${label} (image – not supported)`
}

// Validates the renderer-supplied index for subtitle:load-embedded: it must be
// a non-negative integer that exists in the last listing AND be text-based.
export function validateEmbeddedIndex(tracks: EmbeddedSubtitleTrack[], index: unknown): EmbeddedSubtitleTrack | null {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null
  const track = tracks.find((candidate) => candidate.index === index)
  return track && track.textBased ? track : null
}
