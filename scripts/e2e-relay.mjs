/* global window, document, fetch */
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import console from 'node:console'

function loadConfig() {
  let relayUrl = process.env.PARTYCAST_QA_RELAY_URL || process.env.PARTYCAST_RELAY_URL
  let hostKey = process.env.PARTYCAST_QA_HOST_KEY || process.env.PARTYCAST_HOST_KEY

  if (!relayUrl || !hostKey) {
    const keyFilePath = process.env.PARTYCAST_KEY_FILE || 'partycast-hostkey.txt'
    if (fs.existsSync(keyFilePath)) {
      const lines = fs.readFileSync(keyFilePath, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        const trimmed = line.trim()
        if (!relayUrl && trimmed.startsWith('PARTYCAST_RELAY_URL=')) {
          relayUrl = trimmed.slice('PARTYCAST_RELAY_URL='.length).trim()
        } else if (!hostKey && trimmed.startsWith('PARTYCAST_HOST_KEY=')) {
          hostKey = trimmed.slice('PARTYCAST_HOST_KEY='.length).trim()
        }
      }
    }
  }

  if (!relayUrl) throw new Error('Missing PARTYCAST_RELAY_URL')
  if (!hostKey) throw new Error('Missing PARTYCAST_HOST_KEY')

  return { relayUrl, hostKey }
}

function isPrivateOrLocalIp(ip) {
  if (!ip) return false
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase()
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1') return true
  const v4Match = clean.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4Match) {
    const b0 = Number(v4Match[1])
    const b1 = Number(v4Match[2])
    if (b0 === 10) return true
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true
    if (b0 === 192 && b1 === 168) return true
    if (b0 === 127) return true
    if (b0 === 169 && b1 === 254) return true
  }
  if (clean.startsWith('fe80:') || clean.startsWith('fc00:') || clean.startsWith('fd')) return true
  return false
}

function cleanupProcesses() {
  try {
    const cmd = `powershell -NoProfile -Command "Get-Process -ErrorAction SilentlyContinue | Where-Object { \\$_.Path -like '*\\PartyCast\\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
    execSync(cmd, { stdio: 'ignore' })
  } catch {
    // Ignore errors during process cleanup
  }
}

const installWebRtcTracker = () => {
  const OrigPC = window.RTCPeerConnection
  if (!OrigPC || window.__partycastTrackerInstalled) return
  window.__partycastTrackerInstalled = true
  window.__pcList = []

  function parseCandidateString(candStr) {
    if (!candStr) return null
    const parts = candStr.trim().split(/\s+/)
    const typIndex = parts.indexOf('typ')
    const type = typIndex !== -1 && parts[typIndex + 1] ? parts[typIndex + 1] : 'unknown'
    const address = parts[4] || ''
    const port = parts[5] ? Number(parts[5]) : undefined
    return { candidate: candStr, type, address, port }
  }

  window.RTCPeerConnection = function (...args) {
    const pc = new OrigPC(...args)
    const pcData = {
      pc,
      config: args[0] || {},
      gatheredCandidates: [],
      remoteCandidates: [],
    }
    window.__pcList.push(pcData)

    // Record gathered candidates only; the app's own ICE/SDP handling is exercised unmodified.
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        pcData.gatheredCandidates.push({
          candidate: event.candidate.candidate,
          type: event.candidate.type,
          address: event.candidate.address || event.candidate.ip,
          port: event.candidate.port,
          protocol: event.candidate.protocol,
        })
      }
    })

    const origAddIceCandidate = pc.addIceCandidate
    pc.addIceCandidate = function (candidate, ...rest) {
      if (candidate) {
        let parsed = null
        if (typeof candidate === 'string') {
          parsed = parseCandidateString(candidate)
        } else if (candidate.candidate) {
          parsed = parseCandidateString(candidate.candidate)
          if (candidate.type) parsed.type = candidate.type
          if (candidate.address || candidate.ip) parsed.address = candidate.address || candidate.ip
        } else if (candidate.type) {
          parsed = { type: candidate.type, address: candidate.address || candidate.ip }
        }
        if (parsed) pcData.remoteCandidates.push(parsed)
      }
      return origAddIceCandidate.apply(this, [candidate, ...rest])
    }

    const origSetRemoteDescription = pc.setRemoteDescription
    pc.setRemoteDescription = function (desc, ...rest) {
      if (desc && desc.sdp) {
        const lines = desc.sdp.split(/\r?\n/)
        for (const line of lines) {
          if (line.startsWith('a=candidate:')) {
            const parsed = parseCandidateString(line.slice(2))
            if (parsed) pcData.remoteCandidates.push(parsed)
          }
        }
      }
      return origSetRemoteDescription.apply(this, [desc, ...rest])
    }

    return pc
  }

  window.RTCPeerConnection.prototype = OrigPC.prototype
  for (const prop of Object.getOwnPropertyNames(OrigPC)) {
    if (prop !== 'prototype' && prop !== 'name' && prop !== 'length') {
      try {
        window.RTCPeerConnection[prop] = OrigPC[prop]
      } catch {
        // Ignore read-only properties
      }
    }
  }
}

async function measureOutboundStats(hostPage, preset) {
  const currentVal = await hostPage.evaluate(() => document.querySelector('select[aria-label="Relay quality"]')?.value)
  if (currentVal !== preset) {
    await hostPage.selectOption('select[aria-label="Relay quality"]', preset)
    await sleep(3000)
  }

  const sample1 = await hostPage.evaluate(async () => {
    for (const entry of window.__pcList || []) {
      const reports = await entry.pc.getStats()
      for (const r of reports.values()) {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          const codecReport = reports.get(r.codecId)
          return {
            bytesSent: r.bytesSent,
            timestamp: r.timestamp,
            frameWidth: r.frameWidth,
            frameHeight: r.frameHeight,
            mimeType: codecReport?.mimeType || 'unknown',
          }
        }
      }
    }
    return null
  })

  await sleep(10000)

  const sample2 = await hostPage.evaluate(async () => {
    for (const entry of window.__pcList || []) {
      const reports = await entry.pc.getStats()
      for (const r of reports.values()) {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          const codecReport = reports.get(r.codecId)
          return {
            bytesSent: r.bytesSent,
            timestamp: r.timestamp,
            frameWidth: r.frameWidth,
            frameHeight: r.frameHeight,
            mimeType: codecReport?.mimeType || 'unknown',
          }
        }
      }
    }
    return null
  })

  if (!sample1 || !sample2) {
    throw new Error(`Failed to collect outbound-rtp video stats for preset ${preset}`)
  }

  const timeDiffSec = (sample2.timestamp - sample1.timestamp) / 1000
  const bytesDiff = sample2.bytesSent - sample1.bytesSent
  const bitrateMbps = Number(((bytesDiff * 8) / timeDiffSec / 1_000_000).toFixed(2))

  return {
    preset,
    codec: sample2.mimeType.replace(/^video\//, ''),
    frameWidth: sample2.frameWidth,
    frameHeight: sample2.frameHeight,
    bitrateMbps,
    durationSec: Number(timeDiffSec.toFixed(2)),
  }
}

async function runE2eTest() {
  const testStartTime = Date.now()
  const { relayUrl, hostKey } = loadConfig()

  const hostProfileDir = path.resolve('tmp-e2e\\host-profile')
  const viewerProfileDir = path.resolve('tmp-e2e\\viewer-profile')
  const testVideoPath = 'tmp-e2e\\test-1080p.mp4'

  if (!fs.existsSync(testVideoPath)) {
    throw new Error(`Test video not found at: ${testVideoPath}`)
  }

  // Ensure clean QA directories
  fs.rmSync(hostProfileDir, { recursive: true, force: true })
  fs.rmSync(viewerProfileDir, { recursive: true, force: true })

  // Build first
  execSync('npm run build', { stdio: 'ignore' })

  let hostApp = null
  let viewerApp = null

  const results = {
    success: false,
    steps: {},
    codecNegotiated: null,
    measuredPresets: {},
    iceCandidateTypes: {
      hostLocalTypes: [],
      hostSelectedPairLocalTypes: [],
      viewerRemoteTypesLearned: [],
    },
    bugsFound: [],
    durationMs: 0,
  }

  try {
    // -------------------------------------------------------------
    // Step 1: Host creates relay room
    // -------------------------------------------------------------
    hostApp = await electron.launch({
      args: ['out/main/index.js', '--mute-audio'],
      env: {
        ...process.env,
        PARTYCAST_QA: '1',
        PARTYCAST_QA_PROFILE: hostProfileDir,
        PARTYCAST_QA_RELAY_URL: relayUrl,
        PARTYCAST_QA_HOST_KEY: hostKey,
      },
    })
    const hostPage = await hostApp.firstWindow()
    await hostPage.addInitScript(installWebRtcTracker)
    await hostPage.evaluate(installWebRtcTracker)

    await hostPage.fill('#display-name', 'HostUser')
    await hostPage.click('button.home-card.primary-card')
    await hostPage.waitForSelector('.code-box strong', { timeout: 20000 })
    const roomCode = (await hostPage.textContent('.code-box strong')).trim()

    const byCodeRes = await fetch(`${relayUrl}/v1/rooms/by-code/${roomCode}`)
    if (byCodeRes.status !== 200) {
      throw new Error(`Expected GET /v1/rooms/by-code/${roomCode} to return 200, got ${byCodeRes.status}`)
    }
    const byCodeData = await byCodeRes.json()
    if (byCodeData.mode !== 'relay') {
      throw new Error(`Expected room mode 'relay', got '${byCodeData.mode}'`)
    }
    if (typeof byCodeData.hostPeerId !== 'string' || !byCodeData.hostPeerId) {
      throw new Error(`Expected pinned hostPeerId, got ${JSON.stringify(byCodeData.hostPeerId)}`)
    }

    // Load video on host
    const fileInput = await hostPage.waitForSelector('input[aria-label="Select video file"]', { timeout: 10000 })
    await fileInput.setInputFiles(testVideoPath)
    await hostPage.waitForSelector('video', { timeout: 15000 })
    await hostPage.evaluate(() => document.querySelector('video')?.play())

    results.steps.step1_host_creates_room = {
      passed: true,
      roomCode,
      mode: byCodeData.mode,
      hostPeerId: byCodeData.hostPeerId,
    }

    // -------------------------------------------------------------
    // Step 2: Viewer enters code -> pending (assert 0 media tracks for 10s)
    // -------------------------------------------------------------
    viewerApp = await electron.launch({
      args: ['out/main/index.js', '--mute-audio'],
      env: {
        ...process.env,
        PARTYCAST_QA: '1',
        PARTYCAST_QA_PROFILE: viewerProfileDir,
        PARTYCAST_QA_RELAY_URL: relayUrl,
      },
    })
    const viewerPage = await viewerApp.firstWindow()
    await viewerPage.addInitScript(installWebRtcTracker)
    await viewerPage.evaluate(installWebRtcTracker)

    await viewerPage.fill('#display-name', 'ViewerUser')
    await viewerPage.click('button.home-card.secondary-card')
    await viewerPage.waitForSelector('#room-code-input', { timeout: 10000 })
    await viewerPage.fill('#room-code-input', roomCode)
    await viewerPage.click('form.join-form button[type="submit"]')

    await viewerPage.waitForSelector('.viewer-overlay h3:has-text("Waiting for host to let you in")', {
      timeout: 20000,
    })

    for (let i = 0; i < 10; i++) {
      const trackCount = await viewerPage.evaluate(() => {
        const v = document.querySelector('video')
        return v && v.srcObject ? v.srcObject.getTracks().length : 0
      })
      if (trackCount !== 0) {
        throw new Error(`Viewer has ${trackCount} remote media tracks while pending! Expected 0.`)
      }
      await sleep(1000)
    }

    results.steps.step2_viewer_pending_no_media = {
      passed: true,
      pendingDurationSeconds: 10,
      remoteMediaTracksWhilePending: 0,
    }

    // -------------------------------------------------------------
    // Step 3: Host approves -> viewer receives live tracks & advances currentTime
    // -------------------------------------------------------------
    await hostPage.waitForSelector('.pending-participant button:has-text("Accept")', { timeout: 15000 })
    await hostPage.click('.pending-participant button:has-text("Accept")')

    const approveStartTime = Date.now()
    let viewerMediaReady = false
    let initialViewerMedia = null

    while (Date.now() - approveStartTime < 30000) {
      initialViewerMedia = await viewerPage.evaluate(() => {
        const v = document.querySelector('video')
        if (!v || !v.srcObject) return null
        const videoTrack = v.srcObject.getVideoTracks()[0]
        const audioTrack = v.srcObject.getAudioTracks()[0]
        return {
          hasVideoTrack: !!videoTrack && videoTrack.readyState === 'live',
          hasAudioTrack: !!audioTrack && audioTrack.readyState === 'live',
          videoWidth: v.videoWidth,
          videoHeight: v.videoHeight,
          currentTime: v.currentTime,
        }
      })
      if (
        initialViewerMedia &&
        initialViewerMedia.hasVideoTrack &&
        initialViewerMedia.hasAudioTrack &&
        initialViewerMedia.videoWidth > 0 &&
        initialViewerMedia.videoHeight > 0
      ) {
        viewerMediaReady = true
        break
      }
      await sleep(500)
    }

    if (!viewerMediaReady || !initialViewerMedia) {
      throw new Error('Viewer did not receive playable live video and audio tracks within 30s of host approval.')
    }

    const tStart = await viewerPage.evaluate(() => document.querySelector('video')?.currentTime || 0)
    await sleep(15000)
    const tEnd = await viewerPage.evaluate(() => document.querySelector('video')?.currentTime || 0)
    const timeAdvanced = tEnd - tStart

    if (timeAdvanced < 10) {
      throw new Error(`Viewer currentTime did not advance sufficiently: initial=${tStart}, final=${tEnd}, delta=${timeAdvanced}`)
    }

    const inboundStats = await viewerPage.evaluate(async () => {
      for (const entry of window.__pcList || []) {
        const reports = await entry.pc.getStats()
        for (const r of reports.values()) {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            return {
              frameWidth: r.frameWidth,
              frameHeight: r.frameHeight,
              framesPerSecond: r.framesPerSecond,
              bytesReceived: r.bytesReceived,
            }
          }
        }
      }
      return null
    })

    results.steps.step3_host_approves_playback = {
      passed: true,
      timeToMediaMs: Date.now() - approveStartTime,
      hasLiveVideoTrack: initialViewerMedia.hasVideoTrack,
      hasLiveAudioTrack: initialViewerMedia.hasAudioTrack,
      videoWidth: initialViewerMedia.videoWidth,
      videoHeight: initialViewerMedia.videoHeight,
      currentTimeAdvancedSeconds: Number(timeAdvanced.toFixed(2)),
      inboundStats,
    }

    // -------------------------------------------------------------
    // Step 4: Host stats across quality presets (1080p, 1080p-high, 720p)
    // -------------------------------------------------------------
    const preset1080p = await measureOutboundStats(hostPage, '1080p')
    const preset1080pHigh = await measureOutboundStats(hostPage, '1080p-high')
    const preset720p = await measureOutboundStats(hostPage, '720p')

    results.codecNegotiated = preset1080p.codec
    results.measuredPresets = {
      '1080p': preset1080p,
      '1080p-high': preset1080pHigh,
      '720p': preset720p,
    }
    results.steps.step4_presets_measured = {
      passed: true,
      codec: preset1080p.codec,
      presets: results.measuredPresets,
    }

    // -------------------------------------------------------------
    // Step 5: IP Privacy verification
    // -------------------------------------------------------------
    const hostPrivacyData = await hostPage.evaluate(async () => {
      const connections = []
      for (const entry of window.__pcList || []) {
        const stats = await entry.pc.getStats()
        const localCandidates = []
        let selectedPair = null

        for (const r of stats.values()) {
          if (r.type === 'transport' && r.selectedCandidatePairId) {
            selectedPair = stats.get(r.selectedCandidatePairId)
            break
          }
          if (r.type === 'candidate-pair' && (r.selected || r.nominated || r.state === 'succeeded')) {
            selectedPair = r
          }
        }

        for (const r of stats.values()) {
          if (r.type === 'local-candidate') {
            localCandidates.push({
              candidateType: r.candidateType,
              ip: r.ip || r.address,
              protocol: r.protocol,
            })
          }
        }

        let selectedLocalCand = null
        if (selectedPair && selectedPair.localCandidateId) {
          const c = stats.get(selectedPair.localCandidateId)
          if (c) {
            selectedLocalCand = {
              candidateType: c.candidateType,
              ip: c.ip || c.address,
            }
          }
        }

        connections.push({
          localCandidates,
          selectedLocalCand,
          gatheredCount: entry.gatheredCandidates.length,
          gatheredTypes: [...new Set(entry.gatheredCandidates.map(c => c.type))],
        })
      }
      return connections
    })

    const hostLocalTypes = new Set()
    const hostSelectedTypes = new Set()

    for (const conn of hostPrivacyData) {
      if (conn.localCandidates.length === 0) {
        throw new Error('Host connection has 0 local candidates in getStats')
      }
      for (const lc of conn.localCandidates) {
        hostLocalTypes.add(lc.candidateType)
        if (lc.candidateType !== 'relay') {
          throw new Error(`Host gathered non-relay local candidate: ${JSON.stringify(lc)}`)
        }
      }
      if (conn.selectedLocalCand) {
        hostSelectedTypes.add(conn.selectedLocalCand.candidateType)
        if (conn.selectedLocalCand.candidateType !== 'relay') {
          throw new Error(`Host selected pair is non-relay: ${JSON.stringify(conn.selectedLocalCand)}`)
        }
      }
    }

    const viewerPrivacyData = await viewerPage.evaluate(async () => {
      const pcs = window.__pcList || []
      const controlEntry = pcs.find(entry => {
        const urls = entry.config.iceServers?.flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls]) || []
        return urls.some(u => u && u.includes('google.com')) || !urls.some(u => u && u.includes('cloudflare.com'))
      }) || pcs[0]

      if (!controlEntry) return null

      const stats = await controlEntry.pc.getStats()
      const statsRemoteCandidates = []
      for (const r of stats.values()) {
        if (r.type === 'remote-candidate') {
          statsRemoteCandidates.push({
            candidateType: r.candidateType,
            ip: r.ip || r.address,
            protocol: r.protocol,
          })
        }
      }

      return {
        remoteCandidatesAdded: controlEntry.remoteCandidates,
        statsRemoteCandidates,
      }
    })

    const allViewerRemoteLearned = [
      ...(viewerPrivacyData?.remoteCandidatesAdded || []),
      ...(viewerPrivacyData?.statsRemoteCandidates || []),
    ]

    const viewerRemoteTypes = new Set()
    for (const cand of allViewerRemoteLearned) {
      const candType = cand.type || cand.candidateType
      if (candType) viewerRemoteTypes.add(candType)
      if (candType && candType !== 'relay') {
        throw new Error(`Viewer learned non-relay remote candidate for host: ${JSON.stringify(cand)}`)
      }
      if (cand.address && isPrivateOrLocalIp(cand.address)) {
        throw new Error(`Viewer learned private/local IP candidate for host: ${JSON.stringify(cand)}`)
      }
      if (cand.ip && isPrivateOrLocalIp(cand.ip)) {
        throw new Error(`Viewer learned private/local IP candidate for host: ${JSON.stringify(cand)}`)
      }
    }

    results.iceCandidateTypes = {
      hostLocalTypes: [...hostLocalTypes],
      hostSelectedPairLocalTypes: [...hostSelectedTypes],
      viewerRemoteTypesLearned: [...viewerRemoteTypes],
    }

    results.steps.step5_ip_privacy = {
      passed: true,
      hostPeerConnectionsChecked: hostPrivacyData.length,
      hostLocalTypes: [...hostLocalTypes],
      hostSelectedPairLocalTypes: [...hostSelectedTypes],
      viewerRemoteTypesLearned: [...viewerRemoteTypes],
      viewerLearnedRemoteCandidatesCount: allViewerRemoteLearned.length,
      allAddressesRelayOnly: true,
    }

    // -------------------------------------------------------------
    // Step 6: Host seeks to 60s and pause/resume -> viewer keeps receiving
    // -------------------------------------------------------------
    await hostPage.evaluate(() => {
      const v = document.querySelector('video')
      if (v) v.currentTime = 60
    })
    await sleep(1000)
    await hostPage.evaluate(() => document.querySelector('video')?.pause())
    await sleep(2000)
    await hostPage.evaluate(() => document.querySelector('video')?.play())
    await sleep(2000)

    const seekT1 = await viewerPage.evaluate(() => document.querySelector('video')?.currentTime || 0)
    await sleep(5000)
    const seekT2 = await viewerPage.evaluate(() => document.querySelector('video')?.currentTime || 0)
    const seekDelta = seekT2 - seekT1

    if (seekDelta < 2) {
      throw new Error(`Viewer stream did not advance after host seek/resume: t1=${seekT1}, t2=${seekT2}, delta=${seekDelta}`)
    }

    results.steps.step6_seek_pause_resume = {
      passed: true,
      hostSeekTarget: 60,
      viewerCurrentTimeAdvancing: true,
      viewerFiveSecondAdvanceDelta: Number(seekDelta.toFixed(2)),
    }

    // -------------------------------------------------------------
    // Step 7: Viewer leaves, host closes room -> by-code returns 404
    // -------------------------------------------------------------
    await viewerPage.click('.viewer-header button:has-text("Leave")')
    await viewerPage.waitForSelector('.home-wrap', { timeout: 15000 })
    await hostPage.click('.room-heading button:has-text("Close room")')
    await hostPage.waitForSelector('.home-wrap', { timeout: 15000 })

    let finalLookupStatus = null
    const lookupDeadline = Date.now() + 10000
    while (Date.now() < lookupDeadline) {
      const finalLookupRes = await fetch(`${relayUrl}/v1/rooms/by-code/${roomCode}`)
      finalLookupStatus = finalLookupRes.status
      if (finalLookupStatus === 404) break
      await sleep(500)
    }

    if (finalLookupStatus !== 404) {
      throw new Error(`Expected room lookup to return 404 after close, got ${finalLookupStatus}`)
    }

    results.steps.step7_leave_and_close = {
      passed: true,
      roomCodeLookupStatus: finalLookupStatus,
    }


    results.success = true
    results.durationMs = Date.now() - testStartTime

    console.log(JSON.stringify(results, null, 2))
    return results
  } finally {
    if (viewerApp) await viewerApp.close().catch(() => {})
    if (hostApp) await hostApp.close().catch(() => {})
    cleanupProcesses()
    fs.rmSync(hostProfileDir, { recursive: true, force: true })
    fs.rmSync(viewerProfileDir, { recursive: true, force: true })
  }
}

runE2eTest().catch(err => {
  console.error('E2E Relay Test Failed:', err)
  process.exit(1)
})
