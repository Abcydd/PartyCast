import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { _electron as electron } from 'playwright-core'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static')
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partycast-e2e-ui-'))
const videoPath = path.join(tempDir, 'test-tone.mp4')
const hostProfile = path.join(tempDir, 'host-profile')
const viewerProfile = path.join(tempDir, 'viewer-profile')
const results = []
const logs = { host: [], viewer: [] }
let hostApp
let viewerApp

const record = async (name, task) => {
  try {
    const detail = await task()
    results.push({ name, status: 'PASS', detail: detail ?? '' })
    return true
  } catch (error) {
    results.push({ name, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) })
    return false
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const screenshot = async (page, name) => page.screenshot({ path: path.join(tempDir, `${name}.png`), fullPage: true })
const rangeByKeyboard = async (page, selector, steps) => {
  const slider = page.locator(selector)
  await slider.focus()
  await page.keyboard.press('Home')
  for (let index = 0; index < steps; index++) await page.keyboard.press('ArrowRight')
}
const rangeByMouse = async (page, selector, proportion) => {
  const slider = page.locator(selector)
  const box = await slider.boundingBox()
  assert(box, `Slider is not visible: ${selector}`)
  await page.mouse.click(box.x + Math.min(0.98, Math.max(0.02, proportion)) * box.width, box.y + box.height / 2)
}
const visibleText = async page => page.locator('body').innerText()
const energy = async page => {
  const text = await page.locator('[aria-label="Stream stats"]').innerText()
  const match = /audio energy ([\d.e+-]+)/i.exec(text)
  return { text, value: match ? Number(match[1]) : 0 }
}
const waitForNativeFullscreen = async (app, expected) => {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    const current = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isFullScreen() ?? false)
    if (current === expected) return
    await delay(100)
  }
  throw new Error(`Electron window fullscreen state did not become ${expected}`)
}
const enterFullscreen = async (app, page) => {
  await page.getByRole('button', { name: 'Fullscreen' }).click()
  await page.waitForFunction(() => document.fullscreenElement !== null)
  await waitForNativeFullscreen(app, true)
  assert(await page.evaluate(() => document.fullscreenElement?.classList.contains('player-frame') || document.fullscreenElement?.classList.contains('viewer-player')), 'Player container is not the fullscreen element')
  await screenshot(page, page === hostPage ? 'host-fullscreen' : 'viewer-fullscreen')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.fullscreenElement === null)
  await waitForNativeFullscreen(app, false)
}

let hostPage
let viewerPage

try {
  assert(ffmpeg, 'ffmpeg-static did not provide an executable')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', videoPath,
  ], { stdio: 'ignore' })

  const electronOptions = profile => ({
    args: ['out/main/index.js', '--mute-audio', `--user-data-dir=${profile}`],
    env: { ...process.env },
    timeout: 30000,
  })
  hostApp = await electron.launch(electronOptions(hostProfile))
  hostPage = await hostApp.firstWindow()
  hostPage.on('console', message => logs.host.push(message.text()))
  await hostPage.locator('#display-name').fill('Host')
  await hostPage.getByRole('button', { name: /Host a party/ }).click()
  await hostPage.waitForSelector('.code-box strong', { timeout: 20000 })
  const roomCode = (await hostPage.locator('.code-box strong').innerText()).trim()
  await hostPage.getByLabel('Stream quality').selectOption('source')
  await hostPage.locator('input[aria-label="Select video file"]').setInputFiles(videoPath)
  await hostPage.waitForFunction(() => {
    const video = document.querySelector('.host-frame video')
    return !!video && Number.isFinite(video.duration) && video.duration > 19
  }, undefined, { timeout: 20000 })
  await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.currentTime > 0.5, undefined, { timeout: 15000 })
  await screenshot(hostPage, 'host-room')

  viewerApp = await electron.launch(electronOptions(viewerProfile))
  viewerPage = await viewerApp.firstWindow()
  viewerPage.on('console', message => logs.viewer.push(message.text()))
  await viewerPage.evaluate(() => {
    const snapshots = []
    window.__partycastUiAudit = snapshots
    window.setInterval(() => {
      if (snapshots.length < 1200) snapshots.push(document.body?.innerText ?? '')
    }, 100)
  })
  await viewerPage.locator('#display-name').fill('Viewer')
  await viewerPage.getByRole('button', { name: /Join with code/ }).click()
  await viewerPage.getByLabel('ROOM CODE').fill(roomCode)
  await viewerPage.getByRole('button', { name: /Join room/ }).click()
  await hostPage.getByRole('button', { name: 'Accept' }).waitFor({ timeout: 30000 })
  await hostPage.getByRole('button', { name: 'Accept' }).click()
  await viewerPage.waitForFunction(() => {
    const video = document.querySelector('.viewer-player video')
    return !!video?.srcObject?.getVideoTracks().length && video.videoWidth > 0
  }, undefined, { timeout: 40000 })
  await viewerPage.waitForFunction(() => document.querySelector('.viewer-player video')?.getVideoPlaybackQuality().totalVideoFrames > 8, undefined, { timeout: 30000 })
  await screenshot(viewerPage, 'viewer-playing')

  await record('a. Viewer frames, progress, duration, host sync', async () => {
    const initial = await viewerPage.locator('.viewer-player video').evaluate(video => ({ frames: video.getVideoPlaybackQuality().totalVideoFrames, time: video.currentTime }))
    await delay(1800)
    const later = await viewerPage.locator('.viewer-player video').evaluate(video => ({ frames: video.getVideoPlaybackQuality().totalVideoFrames, time: video.currentTime }))
    const display = await viewerPage.locator('.viewer-player-controls').innerText()
    const progress = await viewerPage.locator('input[aria-label="Viewer timeline"]').getAttribute('max')
    const hostTime = await hostPage.locator('.host-frame video').evaluate(video => video.currentTime)
    const viewerTime = Number((await viewerPage.locator('input[aria-label="Viewer timeline"]').inputValue()))
    assert(later.frames > initial.frames && later.time > initial.time, `Viewer frames/time did not advance (${initial.frames} to ${later.frames})`)
    assert(Math.abs(viewerTime - hostTime) < 2, `Timeline drift exceeded 2 seconds: viewer=${viewerTime}, host=${hostTime}`)
    assert(Math.abs(Number(progress) - 20) < 1, `Viewer duration is ${progress}, expected about 20 seconds`)
    assert(display.includes('/ 0:20'), `Viewer time and duration are not visible: ${display}`)
    return `frames ${initial.frames}→${later.frames}; timeline ${viewerTime.toFixed(1)} / ${progress}`
  })

  await record('b. Viewer receives audio track and nonzero inbound audio energy', async () => {
    const tracks = await viewerPage.locator('.viewer-player video').evaluate(video => video.srcObject.getAudioTracks().map(track => ({ state: track.readyState, enabled: track.enabled })))
    assert(tracks.length > 0 && tracks[0].state === 'live', `No live audio track: ${JSON.stringify(tracks)}`)
    await viewerPage.waitForFunction(() => /audio energy (?!0(?:\.0*)?(?:\s|$))[\d.e+-]+/i.test(document.querySelector('[aria-label="Stream stats"]')?.textContent ?? ''), undefined, { timeout: 20000 })
    const stats = await energy(viewerPage)
    assert(stats.value > 0, `Inbound audio energy is ${stats.value}: ${stats.text}`)
    await screenshot(viewerPage, 'viewer-audio')
    return `${tracks.length} live audio track; ${stats.text}`
  })

  await record('c. Viewer and host volume controls work independently of sent audio', async () => {
    await rangeByKeyboard(viewerPage, 'input[aria-label="Volume"]', 20)
    const viewerVolume = await viewerPage.locator('.viewer-player video').evaluate(video => ({ volume: video.volume, muted: video.muted }))
    assert(Math.abs(viewerVolume.volume - 0.2) < 0.04 && !viewerVolume.muted, `Viewer media volume is ${JSON.stringify(viewerVolume)}`)
    const before = await energy(viewerPage)
    await rangeByKeyboard(hostPage, 'input[aria-label="Host volume"]', 35)
    const hostVolume = await hostPage.locator('.host-frame video').evaluate(video => ({ volume: video.volume, muted: video.muted }))
    assert(Math.abs(hostVolume.volume - 0.35) < 0.04 && !hostVolume.muted, `Host media volume is ${JSON.stringify(hostVolume)}`)
    await delay(2500)
    const after = await energy(viewerPage)
    assert(after.value > before.value, `Inbound audio energy stopped after local host volume change: ${before.value} -> ${after.value}`)
    return `viewer=${viewerVolume.volume}; host=${hostVolume.volume}; inbound energy ${before.value}→${after.value}`
  })

  await record('d. Fullscreen works for viewer and host and Escape exits', async () => {
    await enterFullscreen(viewerApp, viewerPage)
    await enterFullscreen(hostApp, hostPage)
    return 'both player containers entered native fullscreen and exited with Escape'
  })

  await record('e. Viewer has no moderation controls, banned status, or emoji text', async () => {
    const buttons = await viewerPage.locator('button:visible').allTextContents()
    const visible = await visibleText(viewerPage)
    const audit = await viewerPage.evaluate(() => window.__partycastUiAudit ?? [])
    const forbiddenControls = buttons.filter(text => /kick|ban|approve|deny|lock/i.test(text))
    assert(!forbiddenControls.length, `Viewer sees moderation controls: ${forbiddenControls.join(', ')}`)
    assert(!/\bBanned from this room\b/i.test(visible) && audit.every(text => !/\bBanned from this room\b/i.test(text)), 'Viewer status became banned')
    assert(!/\p{Extended_Pictographic}/u.test(visible), 'Viewer visible text contains an emoji')
    assert(!/\p{Extended_Pictographic}/u.test(await visibleText(hostPage)), 'Host visible text contains an emoji')
    return `checked ${buttons.length} viewer buttons and ${audit.length} UI snapshots`
  })

  await record('f. Host pause and seek synchronize to viewer timeline', async () => {
    await hostPage.getByRole('button', { name: 'Pause playback' }).click()
    await viewerPage.getByText('Paused by host').waitFor({ timeout: 2500 })
    const pausedAt = Number(await viewerPage.locator('input[aria-label="Viewer timeline"]').inputValue())
    await delay(1200)
    const stillAt = Number(await viewerPage.locator('input[aria-label="Viewer timeline"]').inputValue())
    assert(Math.abs(stillAt - pausedAt) < 0.3, `Viewer timeline moved while paused: ${pausedAt} -> ${stillAt}`)
    const duration = await hostPage.locator('input[aria-label="Host timeline"]').getAttribute('max')
    await rangeByMouse(hostPage, 'input[aria-label="Host timeline"]', 0.55)
    await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.currentTime > 9, undefined, { timeout: 5000 })
    await viewerPage.waitForFunction(() => Number(document.querySelector('input[aria-label="Viewer timeline"]')?.value) > 9, undefined, { timeout: 3000 })
    const sought = Number(await viewerPage.locator('input[aria-label="Viewer timeline"]').inputValue())
    assert(Math.abs(Number(duration) - 20) < 1 && sought > 9, `Viewer seek did not jump: ${sought}; duration=${duration}`)
    await screenshot(viewerPage, 'viewer-seek')
    return `paused at ${pausedAt.toFixed(1)}; host seek propagated to ${sought.toFixed(1)}`
  })

  const hostStats = await hostPage.locator('.stream-stats').innerText()
  const viewerStats = (await energy(viewerPage)).text
  const encoderLogs = [...logs.host, ...logs.viewer].filter(line => line.includes('encoder probe'))
  console.log(`Negotiated sender stats: ${hostStats}`)
  console.log(`Negotiated receiver stats: ${viewerStats}`)
  console.log(`EncodingInfo probe: ${encoderLogs.join(' | ') || 'not reported'}`)
} catch (error) {
  results.push({ name: 'setup / connection', status: 'FAIL', detail: error instanceof Error ? error.message : String(error) })
  if (hostPage) await screenshot(hostPage, 'failure-host').catch(() => {})
  if (viewerPage) await screenshot(viewerPage, 'failure-viewer').catch(() => {})
} finally {
  for (const app of [viewerApp, hostApp]) {
    if (!app) continue
    const child = app.process()
    await app.close().catch(() => {})
    if (child.exitCode === null && !child.killed) child.kill()
  }
  console.log('\nUI E2E results')
  console.log('| Check | Result | Detail |')
  console.log('|---|---|---|')
  for (const result of results) console.log(`| ${result.name} | ${result.status} | ${String(result.detail).replaceAll('|', '\\|')} |`)
  console.log(`Screenshots and generated video: ${tempDir}`)
  if (results.some(result => result.status === 'FAIL') || results.length < 6) process.exitCode = 1
  else console.log('\nPASS')
}
