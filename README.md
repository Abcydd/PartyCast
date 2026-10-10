# PartyCast

PartyCast is an open-source Windows desktop app for watching a local video together. The host opens a file, plays it on their computer, and sends its live audio and video directly to viewers over WebRTC. There are no accounts or PartyCast servers.

## Development

Install Node.js 24, then run:

```sh
npm install
npm run dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.

## Host or join

Enter a display name. To host, choose **Host a party**, open or drop a video, and share the six-character room code. To join, choose **Join with code** and enter the code; the dash and letter case are optional. New viewers wait for host approval by default. The host controls playback, quality, room lock, viewer admission, kicks, and bans. Viewers receive the host's live stream and control only their own volume, fullscreen view, and subtitle display.

Use the side panel for plain-text chat and the fixed emoji reactions. Host chat and reactions are relayed to approved viewers. The host can load `.srt` or `.vtt` subtitles, adjust their offset, or remove them. A same-name subtitle file beside a selected video loads automatically. Subtitle text is sent as the current cue, not as a file.

Host upload bandwidth is roughly the chosen bitrate times the number of viewers. Auto starts at Medium (2.5 Mbps per viewer) and switches to Low (1 Mbps) when the estimated load exceeds the configured upload speed. PartyCast uses public Nostr relays for encrypted signaling and Google STUN for connection setup. Some NATs cannot establish a direct link; enter your own TURN server in Settings if needed. TURN traffic may consume server bandwidth.

## Security and IP privacy

Pending viewers receive no media, chat, roster, or playback state. Approval is required unless the host deliberately enables Auto-accept. Lock rejects new connections. Deny blocks that peer for this room session; Kick disconnects a viewer; Ban also blocks that peer ID for the session. Peer IDs are cheap to regenerate, so approval is the main defense. The host validates and rate-limits control messages. Viewers can send only a display name, plain-text chat, and one of the offered reactions; they cannot send files, playback commands, or filesystem requests to the host.

Without relay-only mode, accepted viewers may learn the host's IP address through WebRTC. **Hide my IP from viewers (relay only)** forces TURN relay candidates and requires a configured TURN server; hosting and joining are refused if this setting is on without TURN. The setting defaults on when a TURN server is already configured. A TURN provider can observe connection metadata and relay traffic. Room codes are short convenience codes, not strong secrets. Anyone who has the code can attempt to present themselves as a host to a joining viewer; there is no separate host identity credential in this phase. Confirm the host out of band before trusting a room.

## Known limitations

- Chromium must decode the source file. Some HEVC, AC3, and DTS files will not play. A later phase may add FFmpeg conversion.
- Room codes are used as Trystero's signaling password. Share them privately.
- Streaming quality and connectivity depend on the host's upload speed, codec, network, public relay availability, and TURN availability.
- The app has not yet been packaged as an installer; Windows NSIS and portable targets are configured for a later phase.

Licensed under MIT.
