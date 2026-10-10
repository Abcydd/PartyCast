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

Enter a display name. To host, choose **Host a party**, open or drop a video, and share the six-character room code. To join, choose **Join with code** and enter the code; the dash and letter case are optional. The host controls playback and can change files, choose a quality preset, limit viewers, or kick someone. Viewers receive the host's live stream and control only their own volume and fullscreen view.

Host upload bandwidth is roughly the chosen bitrate times the number of viewers. Medium, the default, is 2.5 Mbps per viewer. PartyCast uses public Nostr relays for encrypted signaling and Google STUN for connection setup. Some NATs cannot establish a direct link; enter your own TURN server in Settings if needed. TURN traffic may consume server bandwidth.

## Known limitations

- Chromium must decode the source file. Some HEVC, AC3, and DTS files will not play. A later phase may add FFmpeg conversion.
- Room codes are short convenience codes, not strong secrets. Share them privately. The code is used as Trystero's signaling password.
- Streaming quality and connectivity depend on the host's upload speed, codec, network, public relay availability, and TURN availability.
- The app has not yet been packaged as an installer; Windows NSIS and portable targets are configured for a later phase.

Licensed under MIT.
