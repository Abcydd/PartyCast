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
  joinViewer,
  removeViewer,
  closeHostSession,
  setViewerConnection,
  type HostSession,
} from '../../shared/host-session'
import { generateRoomCode, formatRoomCode, isRoomCode } from '../../shared/room-code'
import type { Message, Participant } from '../../shared/protocol'
import type { PickedMedia } from '../../shared/electron-api'
import { defaultSettings, type Settings } from '../../shared/settings'
import { openPartyRoom, BITRATES, type PartyRoom, type Quality, type RoomEvents } from '../net/signaling'

type Mode = 'home' | 'host' | 'viewer'
type ViewerStatus =
  'connecting' | 'waiting' | 'playing' | 'paused' | 'host-left' | 'room-full' | 'kicked' | 'failed'

const qualityLabels: Record<Quality, string> = {
  low: 'Low · 1 Mbps',
  medium: 'Medium · 2.5 Mbps',
  high: 'High · 5 Mbps',
  source: 'Source · 8 Mbps',
}
const viewerMessages: Record<ViewerStatus, string> = {
  connecting: 'Connecting…',
  waiting: 'Waiting for host to pick a video',
  playing: 'Live with host',
  paused: 'Paused by host',
  'host-left': 'Host left',
  'room-full': 'Room full',
  kicked: 'Kicked',
  failed: 'Could not connect (try TURN in settings)',
}
const terminalStatuses: ViewerStatus[] = ['host-left', 'room-full', 'kicked', 'failed']

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
  const [quality, setQuality] = useState<Quality>('medium')
  const [session, setSession] = useState<HostSession>(createHostSession(8))
  const [pendingPeers, setPendingPeers] = useState<string[]>([])
  const [media, setMedia] = useState<PickedMedia | null>(null)
  const [viewerStatus, setViewerStatus] = useState<ViewerStatus>('connecting')
  const [viewerState, setViewerState] = useState<Extract<Message, { type: 'state' }> | null>(null)
  const [roster, setRoster] = useState<Participant[]>([])
  const [viewerVolume, setViewerVolume] = useState(1)
  const [error, setError] = useState('')
  const roomRef = useRef<PartyRoom | null>(null)
  const sessionRef = useRef<HostSession>(createHostSession(8))
  const mediaRef = useRef<PickedMedia | null>(null)
  const captureRef = useRef<MediaStream | null>(null)
  const hostVideoRef = useRef<HTMLVideoElement>(null)
  const viewerVideoRef = useRef<HTMLVideoElement>(null)
  const viewerFrameRef = useRef<HTMLDivElement>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.partycast
      .loadSettings()
      .then(setSettings)
      .catch(() => setSettings(defaultSettings))
  }, [])
  useEffect(() => {
    if (viewerVideoRef.current) viewerVideoRef.current.volume = viewerVolume
  }, [viewerVolume, mode])
  useEffect(() => {
    const close = (): void => {
      if (roomRef.current && mode === 'host')
        void roomRef.current.send({ version: 1, type: 'room-closed' }).catch(() => {})
      void roomRef.current?.leave()
    }
    window.addEventListener('beforeunload', close)
    return () => window.removeEventListener('beforeunload', close)
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
    await room?.leave().catch(() => {})
    captureRef.current?.getTracks().forEach((track) => track.stop())
    captureRef.current = null
    mediaRef.current = null
    setMedia(null)
    setPendingPeers([])
    setRoster([])
    setViewerState(null)
    setJoining(false)
    setError('')
    sessionRef.current = closeHostSession(sessionRef.current)
    setMode('home')
  }, [])

  const startHost = (): void => {
    if (!settings?.displayName.trim()) {
      setError('Enter your display name first.')
      return
    }
    const code = generateRoomCode()
    const name = settings.displayName.trim()
    setError('')
    setRoomCode(code)
    sessionRef.current = createHostSession(settings.maxViewers)
    setSession(sessionRef.current)
    setMedia(null)
    mediaRef.current = null
    setMode('host')
    const events: RoomEvents = {
      onPeerConnecting: (peerId) => setPendingPeers((old) => (old.includes(peerId) ? old : [...old, peerId])),
      onPeerState: (peerId, connection) => {
        const listed = sessionRef.current.viewers.some((viewer) => viewer.peerId === peerId)
        sessionRef.current = setViewerConnection(sessionRef.current, peerId, connection)
        setSession(sessionRef.current)
        if (listed) sendRoster(name)
      },
      onPeerJoin: (peerId) => {
        setPendingPeers((old) => old.filter((id) => id !== peerId))
        void roomRef.current?.send({ version: 1, type: 'hello', name, role: 'host' }, peerId).catch(() => {})
        sendState(peerId)
      },
      onPeerLeave: (peerId) => {
        setPendingPeers((old) => old.filter((id) => id !== peerId))
        sessionRef.current = removeViewer(sessionRef.current, peerId)
        setSession(sessionRef.current)
        sendRoster(name)
      },
      onMessage: (message, peerId) => {
        if (message.type !== 'hello' || message.role !== 'viewer') return
        const joined = joinViewer(sessionRef.current, peerId, message.name)
        if (!joined.accepted) {
          void roomRef.current
            ?.send({ version: 1, type: 'kick', reason: 'room-full' }, peerId)
            .finally(() => roomRef.current?.rejectPeer(peerId))
          return
        }
        sessionRef.current = joined.session
        setSession(joined.session)
        sendRoster(name)
        sendState(peerId)
      },
    }
    try {
      roomRef.current = openPartyRoom('host', code, settings, events, quality)
    } catch {
      setError('Could not open the room. Check your connection.')
      setMode('home')
    }
  }

  const startViewer = (): void => {
    if (!settings?.displayName.trim()) {
      setError('Enter your display name first.')
      return
    }
    if (!isRoomCode(codeInput)) {
      setError('Enter a valid 6-character room code.')
      return
    }
    const code = formatRoomCode(codeInput)
    const name = settings.displayName.trim()
    setRoomCode(code)
    setError('')
    setViewerStatus('connecting')
    setViewerState(null)
    setRoster([])
    setMode('viewer')
    let connected = false
    const events: RoomEvents = {
      onPeerJoin: (peerId) => {
        connected = true
        if (timeoutRef.current) clearTimeout(timeoutRef.current)
        setViewerStatus('waiting')
        void roomRef.current
          ?.send({ version: 1, type: 'hello', name, role: 'viewer' }, peerId)
          .catch(() => {})
      },
      onPeerLeave: () => {
        if (connected) setViewerStatus((status) => (terminalStatuses.includes(status) ? status : 'host-left'))
      },
      onMessage: (message) => {
        if (message.type === 'state') {
          setViewerState(message)
          setViewerStatus((status) =>
            terminalStatuses.includes(status)
              ? status
              : message.title
                ? message.playing
                  ? 'playing'
                  : 'paused'
                : 'waiting',
          )
        } else if (message.type === 'roster') setRoster(message.participants)
        else if (message.type === 'kick')
          setViewerStatus(message.reason === 'room-full' ? 'room-full' : 'kicked')
        else if (message.type === 'room-closed') setViewerStatus('host-left')
      },
      onStream: (stream) => {
        const video = viewerVideoRef.current
        if (video && video.srcObject !== stream) {
          video.srcObject = stream
          void video.play().catch(() => setError('Press play to start the stream.'))
        }
      },
      onError: (reason) => {
        if (reason === 'room-full') setViewerStatus('room-full')
      },
    }
    try {
      roomRef.current = openPartyRoom('viewer', code, settings, events)
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
    setError('')
    sendState()
  }

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
        void roomRef.current?.setHostStream(stream).catch(() => {})
      })
      stream.addEventListener('removetrack', () => {
        void roomRef.current?.setHostStream(stream).catch(() => {})
      })
    }
    void roomRef.current?.setHostStream(captureRef.current).catch(() => {})
    sendState()
  }

  const kick = async (peerId: string): Promise<void> => {
    await roomRef.current?.send({ version: 1, type: 'kick', reason: 'kicked' }, peerId).catch(() => {})
    roomRef.current?.rejectPeer(peerId)
    sessionRef.current = removeViewer(sessionRef.current, peerId)
    setSession(sessionRef.current)
    sendRoster(settings?.displayName || 'Host')
  }

  const applyQuality = (next: Quality): void => {
    setQuality(next)
    void roomRef.current?.setQuality(next)
  }

  const openSettings = (): void => {
    setDraftSettings(structuredClone(settings ?? defaultSettings))
    setSettingsOpen(true)
  }
  const saveSettings = async (): Promise<void> => {
    try {
      const saved = await window.partycast.saveSettings(draftSettings)
      setSettings(saved)
      setSettingsOpen(false)
    } catch {
      setError('Could not save settings.')
      setSettingsOpen(false)
    }
  }

  const name = settings?.displayName ?? ''
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
              maxLength={40}
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
          <div className="home-footnote">No account. No uploads. The host streams directly to friends.</div>
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
                if (file) void pickMedia(file)
              }}
            >
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
            </section>
            <section className="sidebar-block">
              <div className="sidebar-label">STREAM QUALITY</div>
              <select
                aria-label="Stream quality"
                value={quality}
                onChange={(event) => applyQuality(event.target.value as Quality)}
              >
                {Object.entries(qualityLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <p className="bandwidth-note">
                Host upload needed ≈ {((BITRATES[quality] * session.viewers.length) / 1_000_000).toFixed(1)}{' '}
                Mbps for {session.viewers.length} viewer{session.viewers.length === 1 ? '' : 's'}.
              </p>
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
                      <strong>{viewer.name}</strong>
                      <small>{viewer.connection === 'connected' ? 'Connected' : viewer.connection}</small>
                    </span>
                    <button
                      className="kick-button"
                      title={`Kick ${viewer.name}`}
                      aria-label={`Kick ${viewer.name}`}
                      onClick={() => {
                        void kick(viewer.peerId)
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                ))}
                {pendingPeers.map((peerId) => (
                  <div className="participant" key={peerId}>
                    <span className="avatar">·</span>
                    <span className="participant-main">
                      <strong>Connecting…</strong>
                      <small>Establishing connection</small>
                    </span>
                  </div>
                ))}
              </div>
              {session.viewers.length === 0 && pendingPeers.length === 0 && (
                <p className="empty-participants">It's quiet in here. Share the code to invite friends.</p>
              )}
            </section>
            <div className="sidebar-status">
              <span className="status-pulse" /> {session.viewers.length} connected viewer
              {session.viewers.length === 1 ? '' : 's'}
              {pendingPeers.length ? ` · ${pendingPeers.length} connecting` : ''}
            </div>
          </aside>
        </main>
      )}

      {mode === 'viewer' && (
        <main className="viewer-layout">
          <div className="viewer-header">
            <div>
              <div className="section-kicker">
                <span className="live-dot" /> WATCHING ROOM {roomCode}
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
            {(viewerStatus === 'connecting' ||
              viewerStatus === 'waiting' ||
              terminalStatuses.includes(viewerStatus)) && (
              <div className="viewer-overlay">
                <div className="viewer-overlay-icon">
                  {viewerStatus === 'waiting' ? <Clapperboard size={38} /> : <Radio size={38} />}
                </div>
                <h3>{viewerMessages[viewerStatus]}</h3>
                {viewerStatus === 'connecting' && (
                  <p>Finding the host and establishing a direct connection.</p>
                )}
                {viewerStatus === 'waiting' && (
                  <p>The stream will appear here as soon as the host starts a video.</p>
                )}
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
            {roster.length ? roster.map((person) => person.name).join(' · ') : 'Waiting for participants'}
          </div>
        </main>
      )}

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
              <div className="settings-divider" />
              <div className="sidebar-label">OPTIONAL TURN SERVER</div>
              <p>Some networks need a TURN server to connect. Enter your own server details here.</p>
              <label htmlFor="turn-url">Server URL</label>
              <input
                id="turn-url"
                placeholder="turn:example.com:3478"
                value={draftSettings.turn.url}
                onChange={(event) =>
                  setDraftSettings((old) => ({ ...old, turn: { ...old.turn, url: event.target.value } }))
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
