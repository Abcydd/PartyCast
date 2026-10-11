// Real-file smoke: host opens PARTYCAST_E2E_FILE through the real Open video button (only the native
// dialog is stubbed), waits for audio preparation, then a viewer joins. Asserts sound on both sides and
// that the embedded subtitle list is populated. Always muted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright-core'

const file = process.env.PARTYCAST_E2E_FILE
if (!file || !fs.existsSync(file)) { console.error('Set PARTYCAST_E2E_FILE to an existing video'); process.exit(2) }
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partycast-e2e-real-'))
const launch = name => electron.launch({ args: ['out/main/index.js', '--mute-audio', `--user-data-dir=${path.join(tempDir, name)}`], timeout: 30000 })
const assert = (condition, message) => { if (!condition) throw new Error(message) }
let hostApp, viewerApp, failed = false
const report = []
try {
  hostApp = await launch('host')
  const host = await hostApp.firstWindow()
  await host.locator('#display-name').fill('Host')
  await host.getByRole('button', { name: /Host a party/ }).click()
  await host.waitForSelector('.code-box strong', { timeout: 20000 })
  const code = (await host.locator('.code-box strong').innerText()).trim()
  await hostApp.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }) }, file)
  const started = Date.now()
  await host.getByRole('button', { name: /Open video/ }).click()
  let lastProgress = ''
  const seen = new Set()
  while (Date.now() - started < 600000) {
    const ready = await host.evaluate(() => { const v = document.querySelector('.host-frame video'); return !!v && v.currentTime > 0.5 })
    if (ready) break
    const text = await host.locator('body').innerText()
    const m = /Preparing audio… (\d+)%/.exec(text)
    if (m) { seen.add(m[1]); lastProgress = m[1] }
    await delay(500)
  }
  const prepSeconds = ((Date.now() - started) / 1000).toFixed(1)
  report.push(`prepare+start: ${prepSeconds}s, progress values seen: ${[...seen].length} (last ${lastProgress}%)`)
  const hostRms = await host.locator('.host-frame video').evaluate(async video => {
    const context = new AudioContext(), source = context.createMediaElementSource(video), analyser = context.createAnalyser()
    source.connect(analyser); analyser.connect(context.destination); await context.resume()
    // Skip the quiet cold open: measure the loudest 300 ms window over ~6 s from 5 minutes in.
    video.currentTime = Math.min(300, video.duration / 2)
    await new Promise(r => setTimeout(r, 1000))
    let loudest = 0
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 300))
      const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples)
      loudest = Math.max(loudest, Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length))
    }
    return loudest
  })
  report.push(`host RMS: ${hostRms}`)
  const audioOptions = await host.getByLabel('Audio track').locator('option').allInnerTexts().catch(() => [])
  const subOptions = await host.getByLabel('Subtitles').locator('option').allInnerTexts().catch(() => [])
  report.push(`audio tracks: ${audioOptions.join(' | ')}`)
  report.push(`subtitle options: ${subOptions.length} (${subOptions.slice(0, 4).join(' | ')} ...)`)

  viewerApp = await launch('viewer')
  const viewer = await viewerApp.firstWindow()
  await viewer.locator('#display-name').fill('Viewer')
  await viewer.getByRole('button', { name: /Join with code/ }).click()
  await viewer.getByLabel('ROOM CODE').fill(code)
  await viewer.getByRole('button', { name: /Join room/ }).click()
  await host.getByRole('button', { name: 'Accept' }).click({ timeout: 30000 })
  await viewer.waitForFunction(() => document.querySelector('.viewer-player video')?.videoWidth > 0, undefined, { timeout: 40000 })
  const energy = async () => Number(/audio energy ([\d.e+-]+)/i.exec(await viewer.locator('[aria-label="Stream stats"]').innerText())?.[1] ?? 0)
  const e1 = await energy(); await delay(4000); const e2 = await energy()
  report.push(`viewer inbound audio energy: ${e1} -> ${e2}`)
  await viewer.screenshot({ path: path.join(tempDir, 'viewer.png') })
  await host.screenshot({ path: path.join(tempDir, 'host.png') })
  assert(hostRms > 0.001, 'host is silent')
  assert(e2 > e1, 'viewer audio energy not rising')
  assert(subOptions.length > 1, 'no embedded subtitles listed')
} catch (error) {
  failed = true
  report.push(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  for (const app of [viewerApp, hostApp]) await app?.close().catch(() => app?.process().kill())
}
console.log(report.join('\n'))
console.log(`screenshots: ${tempDir}`)
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
