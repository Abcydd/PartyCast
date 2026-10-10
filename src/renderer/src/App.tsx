import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Clapperboard,
  Copy,
  Expand,
  FolderOpen,
  LogOut,
  Play,
  Plus,
  Radio,
  Settings2,
  Users,
  Volume2,
  X,
} from 'lucide-react'
import {
  createHostSession,
  requestViewer,
  approveViewer,
  admission,
  setLocked,
  removeViewer,
  closeHostSession,
  setViewerConnection,
  type HostSession,
} from '../../shared/host-session'
import { generateRoomCode, formatRoomCode, isRoomCode } from '../../shared/room-code'
import type { Message, Participant } from '../../shared/protocol'
import type { PickedMedia } from '../../shared/electron-api'
import { defaultSettings, type Settings } from '../../shared/settings'
import { openPartyRoom, localPeerId, type PartyRoom, type RoomEvents } from '../net/signaling'
import { effectiveQuality, estimatedUploadMbps, type Quality } from '../../shared/quality'
import { REACTIONS, type Reaction } from '../../shared/reactions'
import { sanitizeChat } from '../../shared/text'
import { cueAtTime, parseSubtitles, type Cue } from '../../shared/subtitles'
import { RELAY_BITRATES, type RelayQuality, validRelayUrl } from '../../shared/relay-config'
import { parseUsage, type RelayUsage } from '../../shared/usage'
import { RelayPublisher, RelayReceiver, RelayError, relayCall } from '../net/relay-media'
import { UsageMeter } from './UsageMeter'

type Mode = 'home' | 'host' | 'viewer'
type ViewerStatus =
  'connecting' | 'pending' | 'waiting' | 'playing' | 'paused' | 'host-left' | 'room-full' | 'kicked' | 'denied' | 'locked' | 'banned' | 'monthly-cap' | 'failed'

const qualityLabels: Record<Quality, string> = {
  auto: 'Auto · adapts to upload',
  low: 'Low · 1 Mbps',
  medium: 'Medium · 2.5 Mbps',
  high: 'High · 5 Mbps',
  source: 'Source · 8 Mbps',
}
const viewerMessages: Record<ViewerStatus, string> = {
  connecting: 'Connecting…',
  pending: 'Waiting for host to let you in',
  waiting: 'Waiting for host to pick a video',
  playing: 'Live with host',
  paused: 'Paused by host',
  'host-left': 'Host left',
  'room-full': 'Room full',
  kicked: 'Kicked',
  denied: 'Host denied your request',
  locked: 'Room locked',
  banned: 'Banned from this room',
  'monthly-cap': 'Relay monthly usage cap reached',
  failed: 'Could not connect (try TURN in settings)',
}
const terminalStatuses: ViewerStatus[] = ['host-left', 'room-full', 'kicked', 'denied', 'locked', 'banned', 'failed']

type ChatLine = { key: number; text: string; senderId: string; time: number; system?: boolean }
type FloatingReaction = { key: number; emoji: Reaction }

function safeTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0
}

export function App(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [draftSettings, setDraftSettings] = useState<Settings>(defaultSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('home')
  const [joining, setJoining] = useState(false)
  const [codeInput, setCodeInput] = useState('')
  const [roomCode, setRoomCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [quality, setQuality] = useState<Quality>('auto')
  const [session, setSession] = useState<HostSession>(createHostSession(8))
  const [connectingPeers, setConnectingPeers] = useState<string[]>([])
  const [media, setMedia] = useState<PickedMedia | null>(null)
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>('connecting')
  const [viewerState, setViewerState] = useState<Extract<Message, { type: 'state' }> | null>(null)
  const [roster, setRoster] = useState<Participant[]>([])
  const [viewerVolume, setViewerVolume] = useState(1)
  const [error, setError] = useState('')
  const [chat, setChat] = useState<ChatLine[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [floating, setFloating] = useState<FloatingReaction[]>([])
  const [subtitleCues, setSubtitleCues] = useState<Cue[]>([])
  const [subtitleTitle, setSubtitleTitle] = useState('')
  const [subtitleOffset, setSubtitleOffset] = useState(0)
  const [subtitleText, setSubtitleText] = useState<string | null>(null)
  const [subtitlesVisible, setSubtitlesVisible] = useState(true)
  const [subtitleSize, setSubtitleSize] = useState<'S' | 'M' | 'L'>('M')
  const [kickTarget, setKickTarget] = useState<string | null>(null)
  const [hostName, setHostName] = useState('Host')
  const [hasRelayKey, setHasRelayKey] = useState(false)
  const [transportChoice, setTransportChoice] = useState<'relay' | 'direct'>('direct')
  const [relayQuality, setRelayQuality] = useState<RelayQuality>('1080p')
  const [streamStats, setStreamStats] = useState('')
  const [relayUsage, setRelayUsage] = useState<RelayUsage | null>(null)
  const [usageFailed, setUsageFailed] = useState(false)
  const [toast, setToast] = useState('')
  const [viewerRelay, setViewerRelay] = useState(false)
  const roomRef = useRef<PartyRoom | null>(null)
  const sessionRef = useRef<HostSession>(createHostSession(8))
  const mediaRef = useRef<PickedMedia | null>(null)
  const captureRef = useRef<MediaStream | null>(null)
  const hostVideoRef = useRef<HTMLVideoElement>(null)
  const viewerVideoRef = useRef<HTMLVideoElement>(null)
  const viewerFrameRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const lastCueRef = useRef<string | null>(null)
  const relayRoomRef = useRef<{ roomId: string; code: string } | null>(null)
  const publisherRef = useRef<RelayPublisher | null>(null)
  const receiverRef = useRef<RelayReceiver | null>(null)
  const lastRelayRevisionRef = useRef(0)

  useEffect(() => { chatEndRef.current?.scrollIntoView({ block: 'end' }) }, [chat])
  const addChat = (line: Omit<ChatLine, 'key'>): void => setChat(old => [...old.slice(-199), { ...line, key: Date.now() + Math.random() }])
  const addReaction = (emoji: Reaction): void => {
    const key = Date.now() + Math.random()
    setFloating(old => [...old, { key, emoji }])
    setTimeout(() => setFloating(old => old.filter(item => item.key !== key)), 2800)
  }

  useEffect(() => {
    void window.partycast
      .loadSettings()
      .then(setSettings)
      .catch(() => setSettings(defaultSettings))
    void window.partycast.relayHasKey().then(value => { setHasRelayKey(value); if (value) setTransportChoice('relay') }).catch(() => {})
  }, [])
  useEffect(() => {
    if (viewerVideoRef.current) viewerVideoRef.current.volume = viewerVolume
  }, [viewerVolume, mode])
  useEffect(() => {
    return window.partycast.onWindowClosing(() => {
      const room = roomRef.current
      roomRef.current = null
      void (async () => {
        if (room && mode === 'host') await room.send({ version: 1, type: 'room-closed' }).catch(() => {})
        await receiverRef.current?.close().catch(() => {})
        await publisherRef.current?.close().catch(() => {})
        if (relayRoomRef.current && mode === 'host') await relayCall('roomClose', { roomId: relayRoomRef.current.roomId }).catch(() => {})
        if (mode === 'host') await window.partycast.runHostHook('stop').catch(() => {})
        await room?.leave().catch(() => {})
        window.partycast.closeReady()
      })()
    })
  }, [mode])

  const saveProfile = useCallback(
    async (name: string) => {
      if (!settings) return
      const saved = await window.partycast.saveSettings({ ...settings, displayName: name })
      setSettings(saved)
    },
    [settings],
  )

  const currentState = useCallback((): Extract<Message, { type: 'state' }> => {
    const video = hostVideoRef.current
    return {
      version: 1,
      type: 'state',
      playing: !!video && !video.paused && !!mediaRef.current,
      currentTime: safeTime(video?.currentTime ?? 0),
      duration: safeTime(video?.duration ?? 0),
      title: mediaRef.current?.title ?? null,
      ...(relayRoomRef.current ? { relayRevision: publisherRef.current?.generation ?? 0 } : {}),
    }
  }, [])
  const sendState = useCallback(
    (peerId?: string) => {
      void roomRef.current?.send(currentState(), peerId).catch(() => {})
    },
    [currentState],
  )
  const sendRoster = useCallback((hostName: string) => {
    const participants: Participant[] = [
      { peerId: 'host', name: hostName, connection: 'connected' },
      ...sessionRef.current.viewers,
    ]
    void roomRef.current?.send({ version: 1, type: 'roster', participants }).catch(() => {})
  }, [])

  useEffect(() => {
    if (mode !== 'host') return
    const timer = setInterval(() => sendState(), 1000)
    return () => clearInterval(timer)
  }, [mode, sendState])

  const stopRoom = useCallback(async (notify: boolean) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    const room = roomRef.current
    roomRef.current = null
    if (notify && room) await room.send({ version: 1, type: 'room-closed' }).catch(() => {})
    await receiverRef.current?.close().catch(() => {})
    receiverRef.current = null
    lastRelayRevisionRef.current = 0
    await publisherRef.current?.close().catch(() => {})
    publisherRef.current = null
    if (relayRoomRef.current) await relayCall('roomClose', { roomId: relayRoomRef.current.roomId }).catch(() => {})
    relayRoomRef.current = null
    if (notify) {
      const hook = await window.partycast.runHostHook('stop').catch(() => ({ ok: false, ran: false, message: 'Stop hook failed' }))
      if (!hook.ok) setToast(hook.message ?? 'Stop hook failed')
    }
    await room?.leave().catch(() => {})
    captureRef.current?.getTracks().forEach((track) => track.stop())
    captureRef.current = null
    mediaRef.current = null
    setMedia(null)
    setConnectingPeers([])
    setRoster([])
    setViewerState(null)
    setJoining(false)
    setError('')
    setChat([])
    setFloating([])
    setSubtitleCues([])
    setSubtitleText(null)
    setStreamStats('')
    sessionRef.current = closeHostSession(sessionRef.current)
    setMode('home')
  }, [])

  const startHost = async (): Promise<void> => {
    if (!settings?.displayName.trim()) {
      setError('Enter your display name first.')
      return
    }
    const relayHost = transportChoice === 'relay' && hasRelayKey
    if (!relayHost && settings.relayOnly && !settings.turn.url) { setError('Relay-only needs a TURN server. Add one in Settings or turn off IP privacy.'); return }
    let code = generateRoomCode()
    let iceServers: RTCIceServer[] | undefined
    let qaControlDirect = false
    if (relayHost) {
      try {
        setError('Starting Cloudflare relay…')
        const created = await relayCall('roomCreate', { hostPeerId: localPeerId(), bitrateMbps: RELAY_BITRATES[relayQuality] / 1_000_000 })
        if (typeof created.roomId !== 'string' || typeof created.code !== 'string' || !isRoomCode(created.code)) throw new Error('Invalid room response')
        relayRoomRef.current = { roomId: created.roomId, code: created.code }
        code = created.code
        const turn = await relayCall('turn', {})
        if (!Array.isArray(turn.iceServers) || !turn.iceServers.length) throw new Error('TURN credentials unavailable')
        iceServers = turn.iceServers as RTCIceServer[]
        qaControlDirect = turn.qaControlDirect === true
      } catch (cause) {
        if (relayRoomRef.current) await relayCall('roomClose', { roomId: relayRoomRef.current.roomId }).catch(() => {})
        relayRoomRef.current = null
        setError(cause instanceof Error ? `Could not start relay: ${cause.message}` : 'Could not start relay')
        return
      }
    }
    const name = settings.displayName.trim()
    setHostName(name)
    setError('')
    setRoomCode(code)
    sessionRef.current = createHostSession(settings.maxViewers)
    setSession(sessionRef.current)
    setMedia(null)
    setChat([])
    mediaRef.current = null
    if (relayRoomRef.current && iceServers) publisherRef.current = new RelayPublisher(relayRoomRef.current.roomId, iceServers, relayQuality)
    const events: RoomEvents = {
      canJoin: peerId => admission(sessionRef.current, peerId),
      onPeerConnecting: (peerId) => setConnectingPeers((old) => (old.includes(peerId) ? old : [...old.slice(-31), peerId])),
      onPeerRejected: peerId => setConnectingPeers(old => old.filter(id => id !== peerId)),
      onPeerState: (peerId, connection) => {
        const listed = sessionRef.current.viewers.some((viewer) => viewer.peerId === peerId)
        sessionRef.current = setViewerConnection(sessionRef.current, peerId, connection)
        setSession(sessionRef.current)
        if (listed) sendRoster(name)
      },
      onPeerJoin: (peerId) => {
        setConnectingPeers((old) => old.filter((id) => id !== peerId))
      },
      onPeerLeave: (peerId) => {
        setConnectingPeers((old) => old.filter((id) => id !== peerId))
        const viewer = sessionRef.current.viewers.find(p => p.peerId === peerId)
        sessionRef.current = removeViewer(sessionRef.current, peerId)
        setSession(sessionRef.current)
        sendRoster(name)
        if (viewer) systemLine(`${viewer.name} left`)
      },
      onMessage: (message, peerId) => {
        if (message.type === 'hello' && message.role === 'viewer') {
          if (admission(sessionRef.current, peerId) !== 'ok') { roomRef.current?.rejectPeer(peerId); return }
          sessionRef.current = requestViewer(sessionRef.current, peerId, message.name)
          setSession(sessionRef.current)
          if (settings.autoAccept) void acceptViewer(peerId)
        } else if (message.type === 'chat' && sessionRef.current.viewers.some(p => p.peerId === peerId)) {
          deliverChat(peerId, message.text)
        } else if (message.type === 'reaction' && sessionRef.current.viewers.some(p => p.peerId === peerId)) {
          deliverReaction(peerId, message.emoji)
        }
      },
      onAbuse: peerId => { void kick(peerId, true) },
    }
    try {
      roomRef.current = openPartyRoom('host', code, settings, events, quality, relayHost ? { iceServers, relayControl: !qaControlDirect } : {})
      setMode('host')
      void window.partycast.runHostHook('start').then(result => { if (!result.ok) setToast(result.message ?? 'Start hook failed') }).catch(() => setToast('Start hook failed'))
    } catch {
      if (relayRoomRef.current) void relayCall('roomClose', { roomId: relayRoomRef.current.roomId }).catch(() => {})
      relayRoomRef.current = null; publisherRef.current = null
      setError('Could not open the room. Check your connection.')
      setMode('home')
    }
  }

  const startViewer = async (): Promise<void> => {
    if (!settings?.displayName.trim()) {
      setError('Enter your display name first.')
      return
    }
    if (!isRoomCode(codeInput)) {
      setError('Enter a valid 6-character room code.')
      return
    }
    const code = formatRoomCode(codeInput)
    let pinnedHostId: string | undefined
    try {
      const lookup = await relayCall('lookup', { code })
      if (lookup.mode !== 'relay' || typeof lookup.hostPeerId !== 'string' || typeof lookup.roomId !== 'string') throw new Error('Invalid relay room')
      pinnedHostId = lookup.hostPeerId
    } catch (cause) {
      if (!(cause instanceof RelayError && cause.status === 404)) { setError('Could not check the relay room. Try again when the relay is reachable.'); return }
      if (settings.relayOnly && !settings.turn.url) { setError('Relay-only needs a TURN server. Add one in Settings or turn off IP privacy.'); return }
    }
    setViewerRelay(!!pinnedHostId)
    lastRelayRevisionRef.current = 0
    const name = settings.displayName.trim()
    setRoomCode(code)
    setError('')
    setViewerStatus('connecting')
    setViewerState(null)
    setRoster([])
    setChat([])
    setMode('viewer')
    let connected = false
    const events: RoomEvents = {
      onPeerJoin: (peerId) => {
        connected = true
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        setViewerStatus('pending')
        void roomRef.current
          ?.send({ version: 1, type: 'hello', name, role: 'viewer' }, peerId)
          .catch(() => {})
      },
      onPeerLeave: () => {
        void receiverRef.current?.close().catch(() => {})
        if (connected) setViewerStatus((status) => (terminalStatuses.includes(status) ? status : 'host-left'))
      },
      onMessage: (message) => {
        if (message.type === 'approval') {
          setViewerStatus(message.accepted ? 'waiting' : 'denied')
          if (message.relay) receiverRef.current = new RelayReceiver(message.relay.ticket, stream => {
            const video = viewerVideoRef.current
            if (video) { video.srcObject = stream; void video.play().catch(() => setError('Press play to start the stream.')) }
          }, () => setViewerStatus('monthly-cap'))
        } else if (message.type === 'hello' && message.role === 'host') setHostName(message.name)
        else if (message.type === 'state') {
          setViewerState(message)
          if (message.title && receiverRef.current && message.relayRevision) {
            const nextRevision = message.relayRevision
            const previousRevision = lastRelayRevisionRef.current
            lastRelayRevisionRef.current = nextRevision
            const task = previousRevision > 0 && previousRevision !== nextRevision ? receiverRef.current.restart() : receiverRef.current.pull()
            void task.catch(cause => { if (!(cause instanceof RelayError && cause.status === 409)) setError('Could not receive relay stream.') })
          }
          setViewerStatus((status) =>
            terminalStatuses.includes(status) || status === 'pending'
              ? status
              : message.title
                ? message.playing
                  ? 'playing'
                  : 'paused'
                : 'waiting',
          )
        } else if (message.type === 'roster') setRoster(message.participants)
        else if (message.type === 'kick')
          setViewerStatus(message.reason === 'room-full' ? 'room-full' : message.reason)
        else if (message.type === 'room-closed') setViewerStatus('host-left')
        else if (message.type === 'chat-delivery') addChat({ senderId: message.senderId, text: message.text, time: message.time })
        else if (message.type === 'system') addChat({ senderId: '', text: message.text, time: message.time, system: true })
        else if (message.type === 'reaction-display') addReaction(message.emoji)
        else if (message.type === 'subtitle') setSubtitleText(message.text)
      },
      onStream: (stream) => {
        if (pinnedHostId) return
        const video = viewerVideoRef.current
        if (video && video.srcObject !== stream) {
          video.srcObject = stream
          void video.play().catch(() => setError('Press play to start the stream.'))
        }
      },
      onError: (reason) => {
        if (reason !== 'connection') setViewerStatus(reason)
      },
    }
    try {
      roomRef.current = openPartyRoom('viewer', code, settings, events, 'auto', pinnedHostId ? { pinnedHostId, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] } : {})
      timeoutRef.current = setTimeout(() => {
        if (!connected) setViewerStatus('failed')
      }, 25000)
    } catch {
      setViewerStatus('failed')
    }
  }

  const pickMedia = async (dropped?: File): Promise<void> => {
    const selected = dropped
      ? await window.partycast.registerDroppedFile(dropped)
      : await window.partycast.pickMedia()
    if (!selected) {
      if (dropped) setError('Choose a supported video file.')
      return
    }
    captureRef.current?.getTracks().forEach((track) => track.stop())
    captureRef.current = null
    mediaRef.current = selected
    setMedia(selected)
    loadSubtitle(selected.subtitle)
    setError('')
    sendState()
  }

  const loadSubtitle = (file: { title: string; text: string } | null): void => {
    setSubtitleCues(file ? parseSubtitles(file.text) : [])
    setSubtitleTitle(file?.title ?? '')
    setSubtitleText(null)
    lastCueRef.current = null
    void roomRef.current?.send({ version: 1, type: 'subtitle', text: null }).catch(() => {})
  }
  const pickSubtitle = async (dropped?: File): Promise<void> => {
    const selected = dropped ? await window.partycast.registerDroppedSubtitle(dropped) : await window.partycast.pickSubtitle()
    if (!selected) { if (dropped) setError('Choose a .srt or .vtt subtitle file up to 2 MB.'); return }
    loadSubtitle(selected)
    setError('')
  }
  const updateSubtitle = (): void => {
    if (mode !== 'host') return
    const cue = cueAtTime(subtitleCues, hostVideoRef.current?.currentTime ?? 0, subtitleOffset)?.text ?? null
    if (cue !== lastCueRef.current) {
      lastCueRef.current = cue
      setSubtitleText(cue)
      void roomRef.current?.send({ version: 1, type: 'subtitle', text: cue }).catch(() => {})
    }
  }
  useEffect(() => {
    if (mode !== 'host') return
    updateSubtitle()
    const timer = setInterval(updateSubtitle, 150)
    return () => clearInterval(timer)
  }, [mode, subtitleCues, subtitleOffset])

  const syncCapture = (): void => {
    const video = hostVideoRef.current
    if (!video || !mediaRef.current) return
    if (
      !captureRef.current ||
      captureRef.current.getTracks().every((track) => track.readyState === 'ended')
    ) {
      let stream: MediaStream
      try {
        stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream()
      } catch {
        setError('Could not capture this video. Try an MP4 or WebM file.')
        return
      }
      captureRef.current = stream
      stream.addEventListener('addtrack', () => {
        if (publisherRef.current) void publisherRef.current.setStream(stream).catch(() => setError('Could not publish to Cloudflare relay.'))
        else void roomRef.current?.setHostStream(stream).catch(() => {})
      })
      stream.addEventListener('removetrack', () => {
        if (publisherRef.current) void publisherRef.current.setStream(stream).catch(() => setError('Could not update relay stream.'))
        else void roomRef.current?.setHostStream(stream).catch(() => {})
      })
    }
    if (publisherRef.current) void publisherRef.current.setStream(captureRef.current).catch(() => setError('Could not publish to Cloudflare relay.'))
    else void roomRef.current?.setHostStream(captureRef.current).catch(() => {})
    sendState()
  }

  const systemLine = (text: string): void => {
    const time = Date.now()
    addChat({ senderId: '', text, time, system: true })
    void roomRef.current?.send({ version: 1, type: 'system', text, time }).catch(() => {})
  }
  const acceptViewer = async (peerId: string): Promise<void> => {
    const pending = sessionRef.current.pending.find(p => p.peerId === peerId)
    if (!pending) return
    let relay: { roomId: string; ticket: string } | undefined
    if (relayRoomRef.current) {
      try {
        const issued = await relayCall('ticket', { roomId: relayRoomRef.current.roomId, viewerId: peerId })
        if (typeof issued.ticket !== 'string') throw new Error('Invalid ticket')
        relay = { roomId: relayRoomRef.current.roomId, ticket: issued.ticket }
      } catch (cause) {
        const cap = cause instanceof RelayError && cause.reason === 'monthly-cap'
        await roomRef.current?.send({ version: 1, type: 'kick', reason: cap ? 'monthly-cap' : 'denied' }, peerId).catch(() => {})
        roomRef.current?.rejectPeer(peerId)
        sessionRef.current = removeViewer(sessionRef.current, peerId)
        setSession(sessionRef.current)
        setToast(cap ? 'Relay monthly usage cap reached. New viewers cannot join.' : 'Could not issue a viewer ticket.')
        return
      }
    }
    sessionRef.current = approveViewer(sessionRef.current, peerId)
    setSession(sessionRef.current)
    await roomRef.current?.send({ version: 1, type: 'approval', accepted: true, ...(relay ? { relay } : {}) }, peerId).catch(() => {})
    await roomRef.current?.approvePeer(peerId).catch(() => {})
    void roomRef.current?.send({ version: 1, type: 'hello', name: settings?.displayName ?? 'Host', role: 'host' }, peerId).catch(() => {})
    sendRoster(settings?.displayName ?? 'Host')
    sendState(peerId)
    void roomRef.current?.send({ version: 1, type: 'subtitle', text: lastCueRef.current }, peerId).catch(() => {})
    systemLine(`${pending.name} joined`)
  }
  const kick = async (peerId: string, ban = false): Promise<void> => {
    const person = sessionRef.current.viewers.find(p => p.peerId === peerId) ?? sessionRef.current.pending.find(p => p.peerId === peerId)
    const pending = sessionRef.current.pending.some(p => p.peerId === peerId)
    if (relayRoomRef.current && !pending) await relayCall('revoke', { roomId: relayRoomRef.current.roomId, viewerId: peerId }).catch(() => setToast('Could not revoke relay access. Close the room to stop this viewer.'))
    await roomRef.current?.send({ version: 1, type: 'kick', reason: pending ? 'denied' : 'kicked' }, peerId).catch(() => {})
    roomRef.current?.rejectPeer(peerId)
    sessionRef.current = removeViewer(sessionRef.current, peerId, ban)
    setSession(sessionRef.current)
    sendRoster(settings?.displayName || 'Host')
    if (person) systemLine(`${person.name} was ${pending ? 'denied' : ban ? 'banned' : 'kicked'}`)
    setKickTarget(null)
  }

  const deliverChat = (senderId: string, text: string): void => {
    const time = Date.now()
    const message: Message = { version: 1, type: 'chat-delivery', senderId, text, time }
    addChat({ senderId, text, time })
    void roomRef.current?.send(message).catch(() => {})
  }
  const deliverReaction = (senderId: string, emoji: Reaction): void => {
    addReaction(emoji)
    void roomRef.current?.send({ version: 1, type: 'reaction-display', senderId, emoji }).catch(() => {})
  }
  const submitChat = (): void => {
    const text = sanitizeChat(chatDraft)
    if (!text || mode === 'viewer' && (viewerStatus === 'pending' || terminalStatuses.includes(viewerStatus))) return
    setChatDraft('')
    if (mode === 'host') deliverChat('host', text)
    else void roomRef.current?.send({ version: 1, type: 'chat', text }).catch(() => {})
  }
  const react = (emoji: Reaction): void => {
    if (mode === 'host') deliverReaction('host', emoji)
    else if (viewerStatus !== 'pending' && !terminalStatuses.includes(viewerStatus)) void roomRef.current?.send({ version: 1, type: 'reaction', emoji }).catch(() => {})
  }

  const applyQuality = (next: Quality): void => {
    setQuality(next)
  }
  const actualQuality = effectiveQuality(quality, session.viewers.length, settings?.uploadMbps ?? 6)
  useEffect(() => { if (mode === 'host' && !relayRoomRef.current) void roomRef.current?.setQuality(actualQuality) }, [mode, actualQuality])
  useEffect(() => {
    if (mode !== 'host' || !relayRoomRef.current) return
    void publisherRef.current?.setQuality(relayQuality).catch(() => {})
    void relayCall('roomHeartbeat', { roomId: relayRoomRef.current.roomId, bitrateMbps: RELAY_BITRATES[relayQuality] / 1_000_000 }).catch(() => setToast('Relay heartbeat failed.'))
  }, [mode, relayQuality])
  useEffect(() => {
    if (mode !== 'host') return
    const timer = setInterval(() => {
      void (relayRoomRef.current ? publisherRef.current?.stats() : roomRef.current?.stats())?.then(setStreamStats).catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  }, [mode])
  useEffect(() => {
    if (mode !== 'host' || !relayRoomRef.current) return
    const timer = setInterval(() => { if (relayRoomRef.current) void relayCall('roomHeartbeat', { roomId: relayRoomRef.current.roomId, bitrateMbps: RELAY_BITRATES[relayQuality] / 1_000_000 }).catch(() => setToast('Relay heartbeat failed.')) }, 60000)
    return () => clearInterval(timer)
  }, [mode, relayQuality])
  useEffect(() => {
    if (mode !== 'viewer') return
    const timer = setInterval(() => { void receiverRef.current?.heartbeat().catch(() => setError('Relay heartbeat failed.')) }, 60000)
    return () => clearInterval(timer)
  }, [mode])

  const fetchUsage = useCallback(async (): Promise<void> => {
    try {
      const usage = parseUsage(await relayCall('usage', {}))
      setRelayUsage(usage)
      setUsageFailed(usage === null)
    } catch {
      setUsageFailed(true)
    }
  }, [])
  useEffect(() => {
    if (mode !== 'host' || !hasRelayKey || !relayRoomRef.current) return
    void fetchUsage()
    const timer = setInterval(() => { void fetchUsage() }, 60000)
    return () => clearInterval(timer)
  }, [mode, hasRelayKey, fetchUsage])

  const openSettings = (): void => {
    setDraftSettings(structuredClone(settings ?? defaultSettings))
    setSettingsOpen(true)
    if (hasRelayKey) void fetchUsage()
  }
  const saveSettings = async (): Promise<void> => {
    try {
      if (!validRelayUrl(draftSettings.relayUrl)) { setError('Relay URL must be an HTTPS origin.'); return }
      const currentHooks = settings ?? defaultSettings
      const startChanged = draftSettings.hostStartHook.executable !== currentHooks.hostStartHook.executable ||
        JSON.stringify(draftSettings.hostStartHook.args) !== JSON.stringify(currentHooks.hostStartHook.args)
      const stopChanged = draftSettings.hostStopHook.executable !== currentHooks.hostStopHook.executable ||
        JSON.stringify(draftSettings.hostStopHook.args) !== JSON.stringify(currentHooks.hostStopHook.args)
      if (startChanged || stopChanged) {
        const hookRes = await window.partycast.configureHook({
          hostStartHook: startChanged ? draftSettings.hostStartHook : undefined,
          hostStopHook: stopChanged ? draftSettings.hostStopHook : undefined,
        })
        if (!hookRes.ok) {
          setError(hookRes.error === 'user-rejected' ? 'Hook execution not allowed.' : 'Invalid hook executable or arguments.')
          return
        }
      }
      const saved = await window.partycast.saveSettings(draftSettings)
      setSettings(saved)
      setSettingsOpen(false)
    } catch {
      setError('Could not save settings.')
      setSettingsOpen(false)
    }
  }

  const name = settings?.displayName ?? ''
  const chatPanel = (
    <section className="sidebar-block chat-block">
      <div className="sidebar-label">CHAT</div>
      <div className="chat-lines" aria-live="polite">
        {chat.map(line => <div className={`chat-line ${line.system ? 'system-line' : line.senderId === (mode === 'host' ? 'host' : roomRef.current?.selfId) ? 'own-line' : ''}`} key={line.key}>
          {line.system ? <span dir="auto">{line.text}</span> : <><small dir="auto">{line.senderId === 'host' ? hostName : line.senderId === roomRef.current?.selfId ? 'You' : (mode === 'host' ? session.viewers : roster).find(p => p.peerId === line.senderId)?.name ?? 'Viewer'}{line.senderId === 'host' && <span className="host-pill">HOST</span>} · {new Date(line.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small><span dir="auto">{line.text}</span></>}
        </div>)}
        <div ref={chatEndRef} />
      </div>
      <form className="chat-form" onSubmit={event => { event.preventDefault(); submitChat() }}>
        <input aria-label="Chat message" placeholder="Say something…" value={chatDraft} maxLength={500} onChange={event => setChatDraft(event.target.value)} disabled={mode === 'viewer' && (viewerStatus === 'pending' || terminalStatuses.includes(viewerStatus))} />
        <button type="submit" className="button-subtle">Send</button>
      </form>
      <div className="reaction-bar">{REACTIONS.map(emoji => <button key={emoji} type="button" title={`React ${emoji}`} onClick={() => react(emoji)} disabled={mode === 'viewer' && (viewerStatus === 'pending' || terminalStatuses.includes(viewerStatus))}>{emoji}</button>)}</div>
    </section>
  )
  const reactionOverlay = <div className="reaction-overlay" aria-hidden="true">{floating.map(item => <span className="floating-reaction" key={item.key}>{item.emoji}</span>)}</div>
  const subtitleOverlay = subtitlesVisible && subtitleText && <div className={`subtitle-overlay subtitle-${subtitleSize.toLowerCase()}`} dir="auto">{subtitleText}</div>
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Play size={15} fill="currentColor" />
          </div>
          <span>PartyCast</span>
          <span className="brand-tag">BETA</span>
        </div>
        <div className="topbar-actions">
          <span className="topbar-note">YOUR SPACE. YOUR STREAM.</span>
          <button className="icon-button" aria-label="Settings" title="Settings" onClick={openSettings}>
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      {toast && <div className="toast" role="status">{toast}<button aria-label="Dismiss" onClick={() => setToast('')}>×</button></div>}

      {mode === 'home' && (
        <main className="home-wrap">
          <div className="home-eyebrow">
            <span className="live-dot" /> WATCH TOGETHER, FROM ANYWHERE
          </div>
          <h1>
            Movie night,
            <br />
            <em>your way.</em>
          </h1>
          <p className="home-subtitle">
            Play a video from your computer. Share a code. Everyone watches your live stream together.
          </p>
          <div className="name-field">
            <label htmlFor="display-name">YOUR DISPLAY NAME</label>
            <input
              id="display-name"
              maxLength={32}
              placeholder="What should friends call you?"
              value={name}
              onChange={(event) =>
                setSettings((old) => (old ? { ...old, displayName: event.target.value } : old))
              }
              onBlur={() => {
                void saveProfile(name)
              }}
            />
          </div>
          <div className="home-actions">
            <button
              className="home-card primary-card"
              onClick={() => {
                void saveProfile(name)
                startHost()
              }}
            >
              <span className="card-icon">
                <Radio size={25} />
              </span>
              <span>
                <strong>Host a party</strong>
                <small>Pick a video and invite your friends</small>
              </span>
              <span className="card-arrow">↗</span>
            </button>
            <button
              className="home-card secondary-card"
              onClick={() => {
                setJoining(true)
                setError('')
              }}
            >
              <span className="card-icon">
                <Users size={25} />
              </span>
              <span>
                <strong>Join with code</strong>
                <small>Jump into a friend's room</small>
              </span>
              <span className="card-arrow">↗</span>
            </button>
          </div>
          {hasRelayKey && <div className="transport-choice"><label htmlFor="transport-mode">HOST CONNECTION</label><select id="transport-mode" value={transportChoice} onChange={event => setTransportChoice(event.target.value as 'relay' | 'direct')}><option value="relay">Cloudflare relay (recommended · hides your IP · any number of friends)</option><option value="direct">Direct (your IP may be visible)</option></select></div>}
          {joining && (
            <form
              className="join-form"
              onSubmit={(event) => {
                event.preventDefault()
                void saveProfile(name)
                startViewer()
              }}
            >
              <label htmlFor="room-code-input">ROOM CODE</label>
              <div className="join-row">
                <input
                  id="room-code-input"
                  autoFocus
                  placeholder="K7P-Q2M"
                  maxLength={7}
                  value={codeInput}
                  onChange={(event) => setCodeInput(event.target.value.toUpperCase())}
                />
                <button className="button-primary" type="submit">
                  Join room <ArrowLeft className="join-arrow" size={17} />
                </button>
              </div>
            </form>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="home-footnote">No account. Host directly or send one stream through Cloudflare relay.</div>
        </main>
      )}

      {mode === 'host' && (
        <main className="room-layout">
          <section className="player-column">
            <div className="room-heading">
              <div>
                <div className="section-kicker">
                  <span className="live-dot" /> HOSTING A PARTY
                </div>
                <h2>Your screen is the cinema.</h2>
              </div>
              <button
                className="text-button"
                onClick={() => {
                  void stopRoom(true)
                }}
              >
                <LogOut size={17} /> Close room
              </button>
            </div>
            <div
              className={`player-frame host-frame ${media ? 'has-media' : ''}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault()
                const file = event.dataTransfer.files[0]
                if (file) void (/[.](srt|vtt)$/i.test(file.name) ? pickSubtitle(file) : pickMedia(file))
              }}
            >
              <input className="file-fallback" type="file" accept="video/*,.mkv,.avi" aria-label="Select video file" onChange={event => { const file = event.target.files?.[0]; if (file) void pickMedia(file) }} />
              <input className="file-fallback" type="file" accept=".srt,.vtt" aria-label="Select subtitle file" onChange={event => { const file = event.target.files?.[0]; if (file) void pickSubtitle(file) }} />
              {media ? (
                <video
                  ref={hostVideoRef}
                  src={media.url}
                  crossOrigin="anonymous"
                  autoPlay
                  controls
                  playsInline
                  onLoadedData={syncCapture}
                  onPlay={syncCapture}
                  onPause={() => sendState()}
                  onSeeked={() => sendState()}
                  onEnded={() => sendState()}
                  onTimeUpdate={updateSubtitle}
                  onError={() =>
                    setError('This file could not be played. Try an MP4 or WebM with a supported codec.')
                  }
                />
              ) : (
                <div className="empty-player">
                  <div className="empty-orbit">
                    <Clapperboard size={42} strokeWidth={1.3} />
                  </div>
                  <h3>Set the scene</h3>
                  <p>
                    Open a video or drop one here. Playback on your screen goes live to everyone in the room.
                  </p>
                  <button
                    className="button-primary"
                    onClick={() => {
                      void pickMedia()
                    }}
                  >
                    <FolderOpen size={18} /> Open video…
                  </button>
                  <span>MP4, WEBM, MOV, MKV, AVI · CODEC SUPPORT VARIES</span>
                </div>
              )}
              {reactionOverlay}
              {subtitleOverlay}
            </div>
            <div className="player-footer">
              <div className="media-title">
                <span className="media-icon">
                  <Clapperboard size={17} />
                </span>
                <span>
                  {media?.title ?? 'No video selected'}
                  <small>
                    {media ? 'Streaming from your computer' : 'Drop a file on the player to begin'}
                  </small>
                </span>
              </div>
              {media && (
                <button
                  className="button-subtle"
                  onClick={() => {
                    void pickMedia()
                  }}
                >
                  <Plus size={16} /> Change video
                </button>
              )}
            </div>
            <div className="subtitle-controls">
              <button className="button-subtle" onClick={() => { void pickSubtitle() }}>Load subtitles…</button>
              {subtitleTitle && <><span dir="auto">{subtitleTitle}</span><button className="button-subtle" onClick={() => loadSubtitle(null)}>Remove</button><button className="button-subtle" onClick={() => setSubtitleOffset(v => v - 0.5)}>−0.5 s</button><span>{subtitleOffset.toFixed(1)} s</span><button className="button-subtle" onClick={() => setSubtitleOffset(v => v + 0.5)}>+0.5 s</button></>}
              <button className="button-subtle" onClick={() => setSubtitlesVisible(v => !v)}>{subtitlesVisible ? 'Hide' : 'Show'} subtitles</button>
            </div>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </section>
          <aside className="room-sidebar">
            <section className="sidebar-block invite-block">
              <div className="sidebar-label">INVITE YOUR FRIENDS</div>
              <p>Share this code to let them join your room.</p>
              <div className="code-box">
                <strong>{roomCode}</strong>
                <button
                  aria-label="Copy room code"
                  title="Copy room code"
                  onClick={() => {
                    void navigator.clipboard.writeText(roomCode).then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    })
                  }}
                >
                  {copied ? <Check size={19} /> : <Copy size={19} />}
                </button>
              </div>
              <div className="code-note">{copied ? 'Copied to clipboard' : 'Code is case insensitive'}</div>
              <label className="toggle-line"><input type="checkbox" checked={session.locked} onChange={event => { sessionRef.current = setLocked(sessionRef.current, event.target.checked); setSession(sessionRef.current) }} /> Lock room</label>
              {!relayRoomRef.current && !settings?.relayOnly && <p className="privacy-note">Your IP is visible to viewers you accept.</p>}
              {relayRoomRef.current && <p className="privacy-note">Cloudflare relay · viewers do not see your IP.</p>}
            </section>
            <section className="sidebar-block">
              <div className="sidebar-label">STREAM QUALITY</div>
              {relayRoomRef.current ? <><select aria-label="Relay quality" value={relayQuality} onChange={event => setRelayQuality(event.target.value as RelayQuality)}><option value="1080p">1080p · 4.5 Mbps</option><option value="1080p-high">1080p High · 6 Mbps</option><option value="720p">720p · 2.5 Mbps</option></select><p className="bandwidth-note">One upload: {(RELAY_BITRATES[relayQuality] / 1_000_000).toFixed(1)} Mbps, regardless of viewer count.</p>{hasRelayKey && (relayUsage ? <UsageMeter usage={relayUsage} compact /> : usageFailed && <p className="usage-unavailable">Usage unavailable</p>)}</> : <><select aria-label="Stream quality" value={quality} onChange={event => applyQuality(event.target.value as Quality)}>{Object.entries(qualityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><p className="bandwidth-note">Using ~{estimatedUploadMbps(actualQuality, session.viewers.length).toFixed(1)} Mbps of your {settings?.uploadMbps ?? 6} Mbps upload ({actualQuality}).</p></>}
              <p className="stream-stats">{streamStats}</p>
            </section>
            <section className="sidebar-block participants-block">
              <div className="participant-heading">
                <div className="sidebar-label">PARTICIPANTS</div>
                <span>
                  {session.viewers.length}/{session.maxViewers}
                </span>
              </div>
              <div className="participant-list">
                <div className="participant">
                  <span className="avatar host-avatar">{name.charAt(0).toUpperCase()}</span>
                  <span className="participant-main">
                    <strong>
                      {name || 'You'} <span className="host-pill">HOST</span>
                    </strong>
                    <small>Connected</small>
                  </span>
                  <span className="presence" />
                </div>
                {session.viewers.map((viewer) => (
                  <div className="participant" key={viewer.peerId}>
                    <span className="avatar">{viewer.name.charAt(0).toUpperCase()}</span>
                    <span className="participant-main">
                      <strong dir="auto">{viewer.name}</strong>
                      <small>{viewer.connection === 'connected' ? 'Connected' : viewer.connection}</small>
                    </span>
                    <button
                      className="kick-button"
                      title={`Kick ${viewer.name}`}
                      aria-label={`Kick ${viewer.name}`}
                      onClick={() => {
                        setKickTarget(viewer.peerId)
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                {session.pending.map((person) => (
                  <div className="participant pending-participant" key={person.peerId}>
                    <span className="avatar">·</span>
                    <span className="participant-main">
                      <strong dir="auto">{person.name}</strong>
                      <small>Waiting for approval</small>
                    </span>
                    <button className="button-subtle" onClick={() => { void acceptViewer(person.peerId) }}>Accept</button>
                    <button className="button-subtle" onClick={() => { void kick(person.peerId, true) }}>Deny</button>
                  </div>
                ))}
                {connectingPeers.map(peerId => <div className="participant" key={peerId}>Connecting…</div>)}
              </div>
              {session.viewers.length === 0 && session.pending.length === 0 && connectingPeers.length === 0 && (
                <p className="empty-participants">It's quiet in here. Share the code to invite friends.</p>
              )}
            </section>
            <div className="sidebar-status">
              <span className="status-pulse" /> {session.viewers.length} connected viewer
              {session.viewers.length === 1 ? '' : 's'}
              {session.pending.length ? ` · ${session.pending.length} pending` : ''}
            </div>
            {chatPanel}
          </aside>
        </main>
      )}

      {mode === 'viewer' && (
        <main className="viewer-layout">
          <div className="viewer-header">
            <div>
              <div className="section-kicker">
                <span className="live-dot" /> WATCHING ROOM {roomCode} {viewerRelay ? '· CLOUDFLARE RELAY' : '· DIRECT'}
              </div>
              <h2>{viewerState?.title ?? 'The party is getting ready'}</h2>
            </div>
            <button
              className="text-button"
              onClick={() => {
                void stopRoom(false)
              }}
            >
              <LogOut size={17} /> Leave
            </button>
          </div>
          <div className="viewer-player" ref={viewerFrameRef}>
            <video
              ref={viewerVideoRef}
              autoPlay
              playsInline
              onDoubleClick={() => {
                void viewerFrameRef.current?.requestFullscreen()
              }}
            />
            {reactionOverlay}
            {subtitleOverlay}
            {(viewerStatus === 'connecting' || viewerStatus === 'pending' ||
              viewerStatus === 'waiting' ||
              terminalStatuses.includes(viewerStatus)) && (
              <div className="viewer-overlay">
                <div className="viewer-overlay-icon">
                  {viewerStatus === 'waiting' ? <Clapperboard size={38} /> : <Radio size={38} />}
                </div>
                <h3>{viewerMessages[viewerStatus]}</h3>
                {viewerStatus === 'connecting' && (
                  <p>Finding the host and establishing the control connection.</p>
                )}
                {viewerStatus === 'waiting' && (
                  <p>The stream will appear here as soon as the host starts a video.</p>
                )}
                {viewerStatus === 'pending' && <p>The host will decide whether to admit you.</p>}
                {terminalStatuses.includes(viewerStatus) && (
                  <button
                    className="button-subtle"
                    onClick={() => {
                      void stopRoom(false)
                    }}
                  >
                    Back to home
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="viewer-controls">
            <div className="viewer-state">
              <span className={`status-pulse ${viewerStatus === 'playing' ? '' : 'muted-pulse'}`} />{' '}
              {viewerMessages[viewerStatus]}
              {viewerState?.title ? ` · ${viewerState.title}` : ''}
            </div>
            <div className="viewer-control-actions">
              {error && (
                <button
                  className="button-subtle"
                  onClick={() => {
                    void viewerVideoRef.current
                      ?.play()
                      .then(() => setError(''))
                      .catch(() => {})
                  }}
                >
                  Play stream
                </button>
              )}
              <Volume2 size={18} />
              <input
                aria-label="Volume"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={viewerVolume}
                onChange={(event) => setViewerVolume(Number(event.target.value))}
              />
              <button
                className="icon-button"
                aria-label="Fullscreen"
                title="Fullscreen"
                onClick={() => {
                  void viewerFrameRef.current?.requestFullscreen()
                }}
              >
                <Expand size={19} />
              </button>
            </div>
          </div>
          <div className="viewer-roster">
            <Users size={16} />{' '}
            {roster.length ? roster.map((person) => <span key={person.peerId} dir="auto">{person.name}{person.peerId === 'host' && <span className="host-pill">HOST</span>} · </span>) : 'Waiting for participants'}
          </div>
          <div className="viewer-extras"><div className="subtitle-controls"><button className="button-subtle" onClick={() => setSubtitlesVisible(v => !v)}>{subtitlesVisible ? 'Subtitles on' : 'Subtitles off'}</button><select aria-label="Subtitle size" value={subtitleSize} onChange={event => setSubtitleSize(event.target.value as 'S' | 'M' | 'L')}><option>S</option><option>M</option><option>L</option></select></div>{chatPanel}</div>
        </main>
      )}

      {kickTarget && <div className="modal-scrim"><div className="settings-modal" role="dialog" aria-modal="true" aria-label="Remove participant"><h2>Remove participant?</h2><p>Kick disconnects this viewer. Ban also blocks this peer ID for this room session.</p><div className="modal-actions"><button className="button-subtle" onClick={() => setKickTarget(null)}>Cancel</button><button className="button-subtle" onClick={() => { void kick(kickTarget) }}>Kick</button><button className="button-primary" onClick={() => { void kick(kickTarget, true) }}>Ban</button></div></div></div>}
      {settingsOpen && (
        <div
          className="modal-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSettingsOpen(false)
          }}
        >
          <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <div className="modal-head">
              <div>
                <div className="section-kicker">PREFERENCES</div>
                <h2 id="settings-title">Settings</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close settings"
                onClick={() => setSettingsOpen(false)}
              >
                <X size={19} />
              </button>
            </div>
            <div className="settings-body">
              <div className="sidebar-label">CLOUDFLARE RELAY</div>
              <p>The host key stays encrypted on this computer. Viewers need no key.</p>
              <label htmlFor="relay-url">Relay URL (HTTPS)</label>
              <input id="relay-url" value={draftSettings.relayUrl} onChange={event => setDraftSettings(old => ({ ...old, relayUrl: event.target.value }))} />
              <button className="button-subtle" onClick={() => { void window.partycast.relayImport().then(async imported => { if (!imported) return; const loaded = await window.partycast.loadSettings(); setSettings(loaded); setDraftSettings(loaded); setHasRelayKey(true); setTransportChoice('relay'); setToast('Relay key imported securely.') }).catch(() => setToast('Could not import relay key file.')) }}>Import…</button>
              <span className="settings-hint">{hasRelayKey ? 'Host key stored securely' : 'No host key imported'}</span>
              {hasRelayKey && (relayUsage ? <UsageMeter usage={relayUsage} /> : usageFailed && <p className="usage-unavailable">Usage unavailable</p>)}
              <div className="settings-divider" />
              <div className="sidebar-label">HOST HOOKS</div>
              <p>Local commands run without a shell when hosting starts or stops. Use full executable paths.</p>
              <label htmlFor="hook-start-path">When hosting starts run · executable</label>
              <input id="hook-start-path" value={draftSettings.hostStartHook.executable} onChange={event => setDraftSettings(old => ({ ...old, hostStartHook: { ...old.hostStartHook, executable: event.target.value } }))} placeholder="C:\Program Files\Docker\docker.exe" />
              <label htmlFor="hook-start-args">Arguments · one per line</label>
              <textarea id="hook-start-args" value={draftSettings.hostStartHook.args.join('\n')} onChange={event => setDraftSettings(old => ({ ...old, hostStartHook: { ...old.hostStartHook, args: event.target.value ? event.target.value.split('\n') : [] } }))} />
              <label htmlFor="hook-stop-path">When hosting stops run · executable</label>
              <input id="hook-stop-path" value={draftSettings.hostStopHook.executable} onChange={event => setDraftSettings(old => ({ ...old, hostStopHook: { ...old.hostStopHook, executable: event.target.value } }))} placeholder="C:\Program Files\Docker\docker.exe" />
              <label htmlFor="hook-stop-args">Arguments · one per line</label>
              <textarea id="hook-stop-args" value={draftSettings.hostStopHook.args.join('\n')} onChange={event => setDraftSettings(old => ({ ...old, hostStopHook: { ...old.hostStopHook, args: event.target.value ? event.target.value.split('\n') : [] } }))} />
              <div className="settings-divider" />
              <label htmlFor="max-viewers">
                Maximum viewers <small>Applies to the next room you host · 1–32</small>
              </label>
              <input
                id="max-viewers"
                type="number"
                min="1"
                max="32"
                value={draftSettings.maxViewers}
                onChange={(event) =>
                  setDraftSettings((old) => ({ ...old, maxViewers: Number(event.target.value) }))
                }
              />
              <label className="toggle-line"><input type="checkbox" checked={draftSettings.autoAccept} onChange={event => setDraftSettings(old => ({ ...old, autoAccept: event.target.checked }))} /> Auto-accept viewers (off by default)</label>
              <label htmlFor="upload-mbps">My upload speed (Mbps)</label>
              <input id="upload-mbps" type="number" min="0.5" max="1000" step="0.5" value={draftSettings.uploadMbps} onChange={event => setDraftSettings(old => ({ ...old, uploadMbps: Number(event.target.value) }))} />
              <label className="toggle-line"><input type="checkbox" checked={draftSettings.relayOnly} onChange={event => setDraftSettings(old => ({ ...old, relayOnly: event.target.checked }))} /> Hide my IP from viewers (relay only)</label>
              {draftSettings.relayOnly && !draftSettings.turn.url && <p className="error-text">Relay-only needs a TURN server. Add one below before hosting or joining.</p>}
              <div className="settings-divider" />
              <div className="sidebar-label">OPTIONAL TURN SERVER</div>
              <p>Some networks need a TURN server to connect. Enter your own server details here.</p>
              <label htmlFor="turn-url">Server URL</label>
              <input
                id="turn-url"
                placeholder="turn:example.com:3478"
                value={draftSettings.turn.url}
                onChange={(event) =>
                  setDraftSettings((old) => ({ ...old, turn: { ...old.turn, url: event.target.value }, relayOnly: old.turn.url || !/^(turns?):\S+$/i.test(event.target.value) ? old.relayOnly : true }))
                }
              />
              <label htmlFor="turn-user">Username</label>
              <input
                id="turn-user"
                value={draftSettings.turn.username}
                onChange={(event) =>
                  setDraftSettings((old) => ({ ...old, turn: { ...old.turn, username: event.target.value } }))
                }
              />
              <label htmlFor="turn-credential">Credential</label>
              <input
                id="turn-credential"
                type="password"
                value={draftSettings.turn.credential}
                onChange={(event) =>
                  setDraftSettings((old) => ({
                    ...old,
                    turn: { ...old.turn, credential: event.target.value },
                  }))
                }
              />
            </div>
            <div className="modal-actions">
              <button className="button-subtle" onClick={() => setSettingsOpen(false)}>
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={() => {
                  void saveSettings()
                }}
              >
                Save settings
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
