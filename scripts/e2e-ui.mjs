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
const mkvPath = path.join(tempDir, 'test-ac3.mkv')
const multiAudioPath = path.join(tempDir, 'test-two-audio.mkv')
const hostProfile = path.join(tempDir, 'host-profile')
const viewerProfile = path.join(tempDir, 'viewer-profile')
const secondViewerProfile = path.join(tempDir, 'second-viewer-profile')
const results = []
const logs = { host: [], viewer: [], secondViewer: [] }
let hostApp
let viewerApp
let secondViewerApp

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
  const state = await slider.evaluate(element => ({ value: Number(element.value), max: Number(element.max) }))
  const startRatio = state.max > 0 ? Math.min(0.98, Math.max(0.02, state.value / state.max)) : 0.02
  const startX = box.x + startRatio * box.width
  await page.mouse.move(startX, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + Math.min(0.98, Math.max(0.02, proportion)) * box.width, box.y + box.height / 2, { steps: 8 })
  await page.mouse.up()
}
const visibleText = async page => page.locator('body').innerText()
const hostRms = async page => page.locator('.host-frame video').evaluate(async video => {
  const instrumented = video.__partycastAudioProbe ?? (() => {
    const context = new AudioContext()
    const source = context.createMediaElementSource(video)
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    analyser.connect(context.destination)
    video.__partycastAudioProbe = { context, source, analyser }
    return video.__partycastAudioProbe
  })()
  await instrumented.context.resume()
  const samples = new Float32Array(instrumented.analyser.fftSize)
  await new Promise(resolve => setTimeout(resolve, 300))
  instrumented.analyser.getFloatTimeDomainData(samples)
  const rms = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length)
  return rms
})
const nativePick = async (app, page, selectedPath, label) => {
  await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, selectedPath)
  await page.getByRole('button', { name: new RegExp(label) }).click()
}
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
  await page.locator('button[aria-label="Fullscreen"]').click()
  await page.waitForFunction(() => document.fullscreenElement !== null)
  await waitForNativeFullscreen(app, true)
  assert(await page.evaluate(() => document.fullscreenElement?.classList.contains('player-frame') || document.fullscreenElement?.classList.contains('viewer-player')), 'Player container is not the fullscreen element')
  await screenshot(page, page === hostPage ? 'host-fullscreen' : 'viewer-fullscreen')
  const exitButton = page.getByRole('button', { name: 'Exit fullscreen' })
  assert(await exitButton.count() > 0, 'On-screen exit fullscreen button is missing')
  await exitButton.click()
  await page.waitForFunction(() => document.fullscreenElement === null)
  await waitForNativeFullscreen(app, false)
  await page.locator('button[aria-label="Fullscreen"]').click()
  await page.waitForFunction(() => document.fullscreenElement !== null)
  await waitForNativeFullscreen(app, true)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.fullscreenElement === null)
  await waitForNativeFullscreen(app, false)
}

let hostPage
let viewerPage
let secondViewerPage

try {
  assert(ffmpeg, 'ffmpeg-static did not provide an executable')
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=1920x1080:rate=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', videoPath,
  ], { stdio: 'ignore' })
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=1920x1080:rate=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
    '-t', '40', '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=ara',
    '-disposition:a:0', 'default', '-disposition:a:1', '0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a:0', 'ac3', '-b:a:0', '384k', '-ac:a:0', '6', '-c:a:1', 'aac', '-b:a:1', '128k', '-shortest', multiAudioPath,
  ], { stdio: 'ignore' })
  execFileSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=black:size=1920x1080:rate=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'ac3', '-b:a', '384k', '-ac', '6', '-shortest', mkvPath,
  ], { stdio: 'ignore' })

  const electronOptions = profile => ({
    args: ['out/main/index.js', '--mute-audio', `--user-data-dir=${profile}`],
    env: { ...process.env },
    timeout: 30000,
  })
  hostApp = await electron.launch(electronOptions(hostProfile))
  hostPage = await hostApp.firstWindow()
  hostPage.on('console', message => logs.host.push(message.text()))
  hostPage.on('crash', () => logs.host.push('[E2E] host renderer process crashed'))
  await hostPage.locator('#display-name').waitFor()
  assert(!/\p{Extended_Pictographic}/u.test(await hostPage.evaluate(() => document.body.innerText)), 'Home screen contains emoji characters')
  await hostPage.locator('#display-name').fill('Host')
  await hostPage.getByRole('button', { name: /Host a party/ }).click()
  await hostPage.waitForSelector('.code-box strong', { timeout: 20000 })
  const roomCode = (await hostPage.locator('.code-box strong').innerText()).trim()
  await hostPage.getByLabel('Stream quality').selectOption('source')
  await nativePick(hostApp, hostPage, mkvPath, 'Open video')
  await hostPage.waitForFunction(() => {
    const video = document.querySelector('.host-frame video')
    return !!video && Number.isFinite(video.duration) && video.duration > 19
  }, undefined, { timeout: 20000 })
  await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.currentTime > 0.5, undefined, { timeout: 15000 })
  const hostAudio = await hostRms(hostPage)
  console.log(`After audio repair native-picker host analyser RMS (AC3 MKV): ${hostAudio}`)
  await screenshot(hostPage, 'host-room')

  viewerApp = await electron.launch(electronOptions(viewerProfile))
  viewerPage = await viewerApp.firstWindow()
  viewerPage.on('console', message => logs.viewer.push(message.text()))
  viewerPage.on('crash', () => logs.viewer.push('[E2E] viewer renderer process crashed'))
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

  await record('a. Native-picked AC3 MKV produces nonzero host analyser RMS', async () => {
    assert(hostAudio > 0, `Host AC3 analyser RMS is ${hostAudio}`)
    return `RMS ${hostAudio}`
  })

  await record('b. Viewer frames, progress, duration, host sync', async () => {
    const initial = await viewerPage.locator('.viewer-player video').evaluate(video => ({ frames: video.getVideoPlaybackQuality().totalVideoFrames, time: video.currentTime }))
    await delay(1800)
    const later = await viewerPage.locator('.viewer-player video').evaluate(video => ({ frames: video.getVideoPlaybackQuality().totalVideoFrames, time: video.currentTime }))
    const display = await viewerPage.locator('.viewer-player-controls').innerText()
    const progress = await viewerPage.locator('input[aria-label="Viewer timeline"]').getAttribute('max')
    const hostTime = await hostPage.locator('.host-frame video').evaluate(video => video.currentTime)
    const viewerTime = Number((await viewerPage.locator('input[aria-label="Viewer timeline"]').inputValue()))
    assert(later.frames > initial.frames && later.time > initial.time, `Viewer frames/time did not advance (${initial.frames} to ${later.frames})`)
    assert(Math.abs(viewerTime - hostTime) < 2, `Timeline drift exceeded 2 seconds: viewer=${viewerTime}, host=${hostTime}`)
    assert(Math.abs(Number(progress) - 40) < 1, `Viewer duration is ${progress}, expected about 40 seconds`)
    assert(display.includes('/ 0:40'), `Viewer time and duration are not visible: ${display}`)
    return `frames ${initial.frames}→${later.frames}; timeline ${viewerTime.toFixed(1)} / ${progress}`
  })

  await record('c. AC3 viewer receives live audio track and nonzero inbound energy', async () => {
    const tracks = await viewerPage.locator('.viewer-player video').evaluate(video => video.srcObject.getAudioTracks().map(track => ({ state: track.readyState, enabled: track.enabled })))
    assert(tracks.length > 0 && tracks[0].state === 'live', `No live audio track: ${JSON.stringify(tracks)}`)
    await viewerPage.waitForFunction(() => /audio energy (?!0(?:\.0*)?(?:\s|$))[\d.e+-]+/i.test(document.querySelector('[aria-label="Stream stats"]')?.textContent ?? ''), undefined, { timeout: 20000 })
    const stats = await energy(viewerPage)
    assert(stats.value > 0, `Inbound audio energy is ${stats.value}: ${stats.text}`)
    await screenshot(viewerPage, 'viewer-audio')
    return `${tracks.length} live audio track; ${stats.text}`
  })

  await record('d. Native AAC MP4 plays with host RMS and viewer inbound energy', async () => {
    await nativePick(hostApp, hostPage, videoPath, 'Change video')
    await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.currentTime > 0.5, undefined, { timeout: 15000 })
    const rms = await hostRms(hostPage)
    await viewerPage.waitForFunction(() => /audio energy (?!0(?:\.0*)?(?:\s|$))[\d.e+-]+/i.test(document.querySelector('[aria-label="Stream stats"]')?.textContent ?? ''), undefined, { timeout: 20000 })
    const inbound = await energy(viewerPage)
    assert(rms > 0, `AAC host analyser RMS is ${rms}`)
    assert(inbound.value > 0, `AAC viewer inbound energy is ${inbound.value}`)
    return `host RMS ${rms.toFixed(4)}; viewer ${inbound.value}`
  })

  await record('e. Audio track picker switches tracks and keeps audio live', async () => {
    await nativePick(hostApp, hostPage, multiAudioPath, 'Change video')
    await hostPage.getByLabel('Audio track').waitFor()
    const options = await hostPage.locator('#host-audio-track option').allTextContents()
    assert(options.length === 2 && options.some(text => text.includes('ENG')) && options.some(text => text.includes('ARA')), `Audio tracks were not listed: ${options.join(' / ')}`)
    const previous = await hostPage.locator('.host-frame video').evaluate(video => video.currentTime)
    const second = await hostPage.locator('#host-audio-track option').nth(1).getAttribute('value')
    assert(second, 'Second audio stream was not selectable')
    await hostPage.getByLabel('Audio track').selectOption(second)
    await hostPage.waitForFunction(time => document.querySelector('.host-frame video')?.currentTime > Math.max(0.5, time - 1), previous, { timeout: 20000 })
    const rms = await hostRms(hostPage)
    assert(rms > 0, `Selected AAC track host RMS is ${rms}`)
    await viewerPage.waitForFunction(() => /audio energy (?!0(?:\.0*)?(?:\s|$))[\d.e+-]+/i.test(document.querySelector('[aria-label="Stream stats"]')?.textContent ?? ''), undefined, { timeout: 20000 })
    const inbound = await energy(viewerPage)
    assert(inbound.value > 0, `Viewer audio track energy is ${inbound.value}`)
    return `${options.join(' / ')}; selection survived at ${previous.toFixed(1)}s with host RMS ${rms.toFixed(4)} and viewer energy ${inbound.value}`
  })

  await record('f. Viewer playback control locks, seeks, pauses, resumes and resyncs', async () => {
    assert(await hostRms(hostPage) > 0, 'AAC host analyser is silent before playback-control test')
    await viewerPage.waitForFunction(() => /audio energy (?!0(?:\.0*)?(?:\s|$))[\d.e+-]+/i.test(document.querySelector('[aria-label="Stream stats"]')?.textContent ?? ''), undefined, { timeout: 12000 })
    const hostToggle = hostPage.getByLabel('Let friends control playback')
    const timeline = viewerPage.getByLabel('Viewer timeline')
    assert(await timeline.isDisabled(), 'Viewer timeline should be disabled by default')
    assert(await viewerPage.getByRole('button', { name: 'Pause playback' }).count() === 0, 'Viewer play/pause should be hidden while control is off')
    const before = await hostPage.locator('.host-frame video').evaluate(video => video.currentTime)
    await viewerPage.locator('body').click({ position: { x: 10, y: 10 } })
    await viewerPage.keyboard.press('ArrowRight')
    await delay(800)
    const after = await hostPage.locator('.host-frame video').evaluate(video => video.currentTime)
    assert(after - before < 4, `Viewer keyboard request was not ignored while disabled: ${before} -> ${after}`)
    await hostToggle.check()
    await timeline.waitFor({ state: 'visible' })
    await viewerPage.waitForFunction(() => !document.querySelector('input[aria-label="Viewer timeline"]').disabled)
    await timeline.focus()
    await viewerPage.keyboard.press('PageUp')
    try {
      await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.currentTime > 11, undefined, { timeout: 10000 })
    } catch {
      const hostTime = await hostPage.locator('.host-frame video').evaluate(video => video.currentTime)
      const requested = await timeline.inputValue()
      const systemChat = await hostPage.locator('.chat-lines').innerText()
      throw new Error(`Viewer seek not applied: host=${hostTime}, slider=${requested}, chat=${systemChat}`)
    }
    await delay(1100)
    await viewerPage.getByRole('button', { name: 'Pause playback' }).click()
    await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.paused, undefined, { timeout: 5000 })
    await viewerPage.getByRole('button', { name: 'Play playback' }).click()
    await hostPage.waitForFunction(() => !document.querySelector('.host-frame video')?.paused, undefined, { timeout: 5000 })
    await viewerPage.locator('body').click({ position: { x: 10, y: 10 } })
    await viewerPage.keyboard.press('Space')
    await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.paused, undefined, { timeout: 5000 })
    await viewerPage.keyboard.press('Space')
    await hostPage.waitForFunction(() => !document.querySelector('.host-frame video')?.paused, undefined, { timeout: 5000 })
    await viewerPage.getByRole('button', { name: 'Resync' }).click()
    await hostToggle.uncheck()
    await viewerPage.waitForFunction(() => document.querySelector('input[aria-label="Viewer timeline"]').disabled)
    return 'default lock held; viewer seek/pause/play reached host; control revocation disabled viewer immediately; Resync clicked'
  })

  await record('g. Per-joiner quality leaves other viewers at host quality', async () => {
    await viewerPage.getByLabel('Viewer quality').selectOption('1080p')
    secondViewerApp = await electron.launch(electronOptions(secondViewerProfile))
    secondViewerPage = await secondViewerApp.firstWindow()
    secondViewerPage.on('console', message => logs.secondViewer.push(message.text()))
    secondViewerPage.on('crash', () => logs.secondViewer.push('[E2E] second viewer renderer process crashed'))
    await secondViewerPage.locator('#display-name').fill('ViewerTwo')
    await secondViewerPage.getByRole('button', { name: /Join with code/ }).click()
    await secondViewerPage.getByLabel('ROOM CODE').fill(roomCode)
    await secondViewerPage.getByRole('button', { name: /Join room/ }).click()
    await hostPage.getByRole('button', { name: 'Accept' }).last().waitFor({ timeout: 30000 })
    await hostPage.getByRole('button', { name: 'Accept' }).last().click()
    await secondViewerPage.waitForFunction(() => document.querySelector('.viewer-player video')?.srcObject?.getVideoTracks().length, undefined, { timeout: 40000 })
    await secondViewerPage.getByLabel('Viewer quality').selectOption('720p')
    const viewerTwoRow = hostPage.locator('.participant').filter({ hasText: 'ViewerTwo' })
    await viewerTwoRow.getByText('1280×720', { exact: false }).waitFor({ timeout: 20000 })
    const viewerOneRow = hostPage.locator('.participant').filter({ hasText: 'Viewer' }).first()
    await viewerOneRow.getByText('1920×1080', { exact: false }).waitFor({ timeout: 20000 })
    const remoteHeight = await secondViewerPage.locator('[aria-label="Stream stats"]').innerText()
    assert(/1280×720/.test(remoteHeight) || await viewerTwoRow.innerText().then(text => text.includes('1280×720')), `Second viewer did not receive 1280×720: ${remoteHeight}`)
    return `ViewerTwo selected 720p (${await viewerTwoRow.innerText()}); first viewer stayed ${await viewerOneRow.innerText()}`
  })

  await record('h. Viewer and host volume controls work independently of sent audio', async () => {
    await nativePick(hostApp, hostPage, videoPath, 'Change video')
    await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.currentTime > 1, undefined, { timeout: 5000 })
    assert(await hostRms(hostPage) > 0, 'Host analyser is silent before volume check')
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

  await record('i. Normal, Cinema, Fullscreen, on-screen exit, Escape, chat overlay and auto-hide', async () => {
    for (const page of [hostPage, viewerPage]) {
      await page.locator('body').click({ position: { x: 10, y: 10 } })
      await page.keyboard.press('?')
      assert(await page.locator('.shortcut-help').isVisible(), 'Keyboard shortcut help did not open')
      await page.keyboard.press('?')
      await page.keyboard.press('c')
      assert(await page.locator('.app-shell').getAttribute('data-view-mode') === 'cinema', 'C shortcut did not activate Cinema')
      await page.getByRole('button', { name: 'Cinema', exact: true }).click()
      assert(await page.locator('.app-shell').getAttribute('data-view-mode') === 'cinema', 'Cinema mode did not activate')
      assert(await page.locator('.chat-block').isVisible(), 'Chat is not visible in Cinema mode')
      await page.getByRole('button', { name: 'Normal', exact: true }).click()
      assert(await page.locator('.app-shell').getAttribute('data-view-mode') === 'normal', 'Normal mode did not activate')
      await page.keyboard.press('f')
      await page.waitForFunction(() => document.fullscreenElement !== null)
      await waitForNativeFullscreen(page === hostPage ? hostApp : viewerApp, true)
      await page.getByRole('button', { name: 'Exit fullscreen' }).click()
      await waitForNativeFullscreen(page === hostPage ? hostApp : viewerApp, false)
    }
    await hostPage.locator('body').click({ position: { x: 10, y: 10 } })
    await hostPage.keyboard.press('m')
    assert(await hostPage.locator('.host-frame video').evaluate(video => video.volume) === 0, 'M did not mute the host locally')
    await hostPage.keyboard.press('m')
    await hostPage.keyboard.press('ArrowDown')
    assert(await hostPage.locator('.host-frame video').evaluate(video => video.volume) < 1, 'Arrow Down did not lower local volume')
    await hostPage.keyboard.press('ArrowUp')
    await enterFullscreen(viewerApp, viewerPage)
    await enterFullscreen(hostApp, hostPage)
    for (const page of [hostPage, viewerPage]) {
      await page.locator('button[aria-label="Fullscreen"]').click()
      await page.waitForFunction(() => document.fullscreenElement !== null)
      assert(await page.locator('.fullscreen-chat .chat-block').isVisible(), 'Fullscreen chat overlay did not appear')
      await page.getByRole('button', { name: 'Hide chat' }).click()
      assert(await page.locator('.fullscreen-chat').count() === 0, 'Fullscreen chat did not hide')
      await page.getByRole('button', { name: 'Show chat' }).click()
      await page.mouse.move(400, 400)
      await delay(3300)
      const opacity = await page.locator('.player-controls').evaluate(element => getComputedStyle(element).opacity)
      const shellClass = await page.locator('.app-shell').getAttribute('class')
      assert(Number(opacity) < 0.1, `Fullscreen controls did not auto-hide: opacity=${opacity}; ${shellClass}`)
      await page.mouse.move(400, 400)
      await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.querySelector('.player-controls')).opacity) > 0.9)
      await page.getByRole('button', { name: 'Exit fullscreen' }).click()
      await waitForNativeFullscreen(page === hostPage ? hostApp : viewerApp, false)
    }
    return 'both roles passed all view modes, on-screen and Escape exit, chat toggle, and idle control hiding'
  })

  await record('j. Viewer has no moderation controls, banned status, or emoji text', async () => {
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

  await record('k. Host pause and seek synchronize to viewer timeline', async () => {
    await rangeByMouse(hostPage, 'input[aria-label="Host timeline"]', 0.2)
    const playButton = hostPage.locator('button[aria-label="Play playback"]')
    if (await playButton.count()) await playButton.click()
    await hostPage.waitForFunction(() => document.querySelector('.host-frame video')?.currentTime > 1, undefined, { timeout: 5000 })
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
    assert(Math.abs(Number(duration) - 40) < 1 && sought > 9, `Viewer seek did not jump: ${sought}; duration=${duration}`)
    await screenshot(viewerPage, 'viewer-seek')
    return `paused at ${pausedAt.toFixed(1)}; host seek propagated to ${sought.toFixed(1)}`
  })

  const hostStats = await hostPage.locator('.stream-stats').innerText()
  const viewerStats = (await energy(viewerPage)).text
  const encoderLogs = [...logs.host, ...logs.viewer].filter(line => line.includes('encoder probe'))
  const crashLogs = Object.values(logs).flat().filter(line => line.includes('crashed'))
  console.log(`Negotiated sender stats: ${hostStats}`)
  console.log(`Negotiated receiver stats: ${viewerStats}`)
  console.log(`EncodingInfo probe: ${encoderLogs.join(' | ') || 'not reported'}`)
  console.log(`Renderer crash events: ${crashLogs.join(' | ') || 'none'}`)
} catch (error) {
  results.push({ name: 'setup / connection', status: 'FAIL', detail: error instanceof Error ? error.message : String(error) })
  if (hostPage) await screenshot(hostPage, 'failure-host').catch(() => {})
  if (viewerPage) await screenshot(viewerPage, 'failure-viewer').catch(() => {})
} finally {
  for (const app of [secondViewerApp, viewerApp, hostApp]) {
    if (!app) continue
    const child = app.process()
    await Promise.race([app.close().catch(() => {}), delay(5000)])
    if (child.exitCode === null && !child.killed) child.kill()
  }
  console.log('\nUI E2E results')
  console.log('| Check | Result | Detail |')
  console.log('|---|---|---|')
  for (const result of results) console.log(`| ${result.name} | ${result.status} | ${String(result.detail).replaceAll('|', '\\|')} |`)
  console.log(`Screenshots and generated video: ${tempDir}`)
  if (results.some(result => result.status === 'FAIL') || results.length < 11) process.exitCode = 1
  else console.log('\nPASS')
}
