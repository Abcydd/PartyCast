import { describe, expect, it } from 'vitest'
import { buildAudioTranscodeArgs, needsAudioTranscode, needsPlayableAudioPreparation, parseAudioTracks, parseFfmpegProgress } from './audio-media'

describe('movie audio preparation', () => {
  it('only marks audio outside Chromium playback support for conversion', () => {
    for (const codec of ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le']) expect(needsAudioTranscode(codec)).toBe(false)
    for (const codec of ['ac3', 'eac3', 'dts', 'truehd']) expect(needsAudioTranscode(codec)).toBe(true)
  })
  it('maps the chosen stream and converts surround audio to AAC stereo in MP4', () => {
    expect(buildAudioTranscodeArgs('movie.mkv', 'prepared.mp4', 2)).toEqual([
      '-hide_banner', '-nostdin', '-y', '-i', 'movie.mkv', '-map', '0:v:0', '-map', '0:2', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:1', 'prepared.mp4',
    ])
    expect(() => buildAudioTranscodeArgs('movie.mkv', 'prepared.mp4', -1)).toThrow('invalid-audio-stream')
  })
  it('prepares unsupported codecs and audio from MKV while leaving AAC MP4 untouched', () => {
    expect(needsPlayableAudioPreparation('ac3', 'movie.mkv')).toBe(true)
    expect(needsPlayableAudioPreparation('aac', 'movie.mkv')).toBe(true)
    expect(needsPlayableAudioPreparation('aac', 'movie.mp4')).toBe(false)
  })
  it('parses audio stream labels and safe progress values', () => {
    expect(parseAudioTracks({ streams: [{ index: 1, codec_name: 'ac3', channels: 6, tags: { language: 'eng', title: 'Surround' }, disposition: { default: 1 } }] })).toEqual([
      { streamIndex: 1, codec: 'ac3', language: 'eng', channels: 6, title: 'Surround', isDefault: true },
    ])
    expect(parseFfmpegProgress('out_time_ms=5000000\nprogress=continue', 20)).toBe(25)
    expect(parseFfmpegProgress('progress=end', 20)).toBeNull()
    expect(parseFfmpegProgress('out_time_ms=2000000\nprogress=continue\nout_time_ms=10000000\nprogress=continue', 20)).toBe(50)
    expect(parseFfmpegProgress('out_time_ms=90000000', 20)).toBe(100)
  })
})
