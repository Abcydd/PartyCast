import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' }, miniflare: { bindings: {
    HOST_KEY: 'test-host-key-long-random-value',
    TURN_KEY_ID: 'dummy-turn', TURN_API_TOKEN: 'dummy-turn-token',
    SFU_APP_ID: 'dummy-app', SFU_APP_SECRET: 'dummy-app-secret',
    MOCK_SFU: '1', MONTHLY_CAP_GB: '0.0001',
  } } })],
  test: { include: ['test/**/*.test.ts'], maxWorkers: 1 },
})
