import type { Settings } from './settings'
import type { HookConfig } from './relay-config'
import type { RelayCall } from '../main/relay-ipc'

export type PickedSubtitle = { title: string; text: string }
export type PickedMedia = { url: string; title: string; subtitle: PickedSubtitle | null }
export type EmbeddedSubtitleTrack = { index: number; codec: string; language: string; title: string; textBased: boolean }
export type PartyCastApi = {
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>
  configureHook(config: { hostStartHook?: HookConfig; hostStopHook?: HookConfig }): Promise<{ ok: boolean; error?: string; settings?: Settings }>
  pickMedia(): Promise<PickedMedia | null>
  registerDroppedFile(file: File): Promise<PickedMedia | null>
  pickSubtitle(): Promise<PickedSubtitle | null>
  registerDroppedSubtitle(file: File): Promise<PickedSubtitle | null>
  listEmbeddedSubtitles(): Promise<EmbeddedSubtitleTrack[]>
  loadEmbeddedSubtitle(index: number): Promise<PickedSubtitle | null>
  onWindowClosing(callback: () => void): () => void
  closeReady(): void
  relayHasKey(): Promise<boolean>
  relayDefaultUrl(): Promise<string>
  relayImport(): Promise<{ relayUrl: string } | null>
  relayCall(call: RelayCall): Promise<{ status: number; body: unknown }>
  runHostHook(phase: 'start' | 'stop'): Promise<{ ok: boolean; ran: boolean; message?: string }>
}
