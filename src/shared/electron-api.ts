import type { Settings } from './settings'

export type PickedSubtitle = { title: string; text: string }
export type PickedMedia = { url: string; title: string; subtitle: PickedSubtitle | null }
export type PartyCastApi = {
  loadSettings(): Promise<Settings>
  saveSettings(settings: Settings): Promise<Settings>
  pickMedia(): Promise<PickedMedia | null>
  registerDroppedFile(file: File): Promise<PickedMedia | null>
  pickSubtitle(): Promise<PickedSubtitle | null>
  registerDroppedSubtitle(file: File): Promise<PickedSubtitle | null>
  onWindowClosing(callback: () => void): () => void
  closeReady(): void
}
