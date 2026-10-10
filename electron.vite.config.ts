import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { validRelayUrl } from './src/shared/relay-config'

// Reads PARTYCAST_DEFAULT_RELAY_URL and returns the relay URL to bake into the
// main process bundle. Build-time only: it must be unset/empty or a bare
// https:// origin — anything else (or any credential-looking value) fails the
// build so that keys or secrets can never be baked in.
function bakedDefaultRelayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.PARTYCAST_DEFAULT_RELAY_URL ?? '').trim()
  if (!raw) return ''
  if (!validRelayUrl(raw)) {
    throw new Error(
      'PARTYCAST_DEFAULT_RELAY_URL must be empty or a bare https:// origin ' +
        '(e.g. https://relay.example.com). Got an invalid value, so the build was ' +
        'aborted — never bake keys or secrets, only the URL.',
    )
  }
  return raw.replace(/\/$/, '')
}

const defaultRelayUrl = bakedDefaultRelayUrl()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __DEFAULT_RELAY_URL__: JSON.stringify(defaultRelayUrl) },
  },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react(), { name: 'partycast-csp', apply: 'build', transformIndexHtml(html: string) {
    return html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: partycast-media:; connect-src 'self' wss:; object-src 'none'; base-uri 'none'; form-action 'none'">`)
  } }] },
})
