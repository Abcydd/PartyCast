import type { Settings } from './settings'
import type { HookConfig } from './relay-config'
import type { RelayCall } from '../main/relay-ipc'

export type PickedSubtitle = { title: string; text: string }
export type AudioTrackInfo = import('./audio-media').AudioTrackInfo
export type PickedMedia = { url: string; title: string; subtitle: PickedSubtitle | null; audioTracks: AudioTrackInfo[]; selectedAudioStream: number | null }
export type EmbeddedSubtitleTrack = { index: number; codec: string; language: string; title: string; textBased: boolean }
export type PartyCastApi = {
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>
  configureHook(config: { hostStartHook?: HookConfig; hostStopHook?: HookConfig }): Promise<{ ok: boolean; error?: string; settings?: Settings }>
  pickMedia(): Promise<PickedMedia | null>
  selectAudioTrack(streamIndex: number): Promise<PickedMedia | null>
  cancelMediaPreparation(): Promise<boolean>
  releaseMedia(): Promise<boolean>
  onMediaProgress(callback: (progress: number | null) => void): () => void
  registerDroppedFile(file: File): Promise<PickedMedia | null>
  pickSubtitle(): Promise<PickedSubtitle | null>
  registerDroppedSubtitle(file: File): Promise<PickedSubtitle | null>
  listEmbeddedSubtitles(): Promise<EmbeddedSubtitleTrack[]>
  loadEmbeddedSubtitle(index: number): Promise<PickedSubtitle | null>
  onWindowClosing(callback: () => void): () => void
  closeReady(): void
  setFullscreen(fullscreen: boolean): Promise<boolean>
  relayHasKey(): Promise<boolean>
  relayDefaultUrl(): Promise<string>
  relayImport(): Promise<{ relayUrl: string } | null>
  relayCall(call: RelayCall): Promise<{ status: number; body: unknown }>
  runHostHook(phase: 'start' | 'stop'): Promise<{ ok: boolean; ran: boolean; message?: string }>
}
