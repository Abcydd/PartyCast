# PartyCast

PartyCast is an open-source Windows desktop app for watching a local video together. The host opens a file and plays it on their computer. Friends join with a short code. Direct mode sends a separate WebRTC stream to each viewer. Cloudflare relay mode sends one stream to Cloudflare Realtime SFU, which distributes it to approved viewers. There are no accounts or PartyCast-run servers.

## Download & run

Build the portable app with `npm run dist`. The result is a single, no-install executable at `release/PartyCast-<version>-portable.exe` — copy it anywhere (a USB stick works) and double-click. PartyCast is unsigned, so Windows SmartScreen may show "Windows protected your PC" on first launch: click **More info → Run anyway**. The first launch unpacks the app into a temporary folder, which takes a few seconds; repeat launches reuse the same folder and start faster. Muted launches and exit behavior are otherwise identical to a normal install. To remove PartyCast, delete the exe (and `%TEMP%\PartyCast` if present).

The build bakes a default relay URL into the executable so viewers can join with no settings at all. Set the `PARTYCAST_DEFAULT_RELAY_URL` environment variable to a bare `https://` origin when building (empty or unset means no baked default, and hosts must enter the relay URL in Settings). The build fails with a clear error for any value that is not a bare HTTPS origin — only the URL is baked in, never a key or secret:

```sh
PARTYCAST_DEFAULT_RELAY_URL=https://your-worker.example npm run dist
```

In the app, the Settings field shows the baked default as placeholder text; leave it empty to use it, or enter your own `https://` origin to override it per machine.

## Development

Install Node.js 24, then run:

```sh
npm install
npm run dev
```

Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm --prefix relay run typecheck`, and `npm --prefix relay test`.

## Host or join

Enter a display name. To host, choose **Host a party**, open or drop a video, and share the six-character room code. To join, choose **Join with code** and enter the code; the dash and letter case are optional. New viewers wait for host approval by default. The host controls playback, quality, room lock, viewer admission, kicks, and bans. Viewers receive the host's live stream and control only their own volume, fullscreen view, and subtitle display.

Use the side panel for plain-text chat and the fixed emoji reactions. Host chat and reactions are relayed to approved viewers. The host can load `.srt` or `.vtt` subtitles, adjust their offset, or remove them. A same-name subtitle file beside a selected video loads automatically. Subtitle text is sent as the current cue, not as a file.

In Direct mode, host upload bandwidth is roughly the chosen bitrate times the number of viewers. Auto starts at Medium (2.5 Mbps per viewer) and switches to Low (1 Mbps) when the estimated load exceeds the configured upload speed. Relay mode uses one host upload: 1080p at 4.5 Mbps by default, 1080p High at 6 Mbps, or 720p at 2.5 Mbps. PartyCast prefers AV1, then VP9, then H.264 where supported; the actual codec and bitrate appear in the host stats line. Source video still has to be decoded by Chromium. Public Nostr relays carry encrypted signaling. Direct mode uses Google STUN and optionally your TURN server.

## Cloudflare relay mode

Import a file in Settings containing `PARTYCAST_RELAY_URL=https://your-worker.example` and `PARTYCAST_HOST_KEY=<your-random-key>`. Choose the file explicitly with **Import…**; PartyCast never searches your disk for it. The host key is encrypted with Electron safeStorage in userData and only the main process sends it to the Worker. The default relay URL is the one baked in at build time (`PARTYCAST_DEFAULT_RELAY_URL`), so viewers need no configuration and no host key; a portable build made without the variable requires both host and viewers to enter the relay URL in Settings. Relay mode is selected by default when a host key is imported; Direct stays available.

The Worker gives the host a room code and short-lived TURN credentials for the host's control connection. It pins the host's Trystero peer ID for viewers and issues a viewer ticket only after host approval. Kick revokes that ticket for the room session. The host sends one WebRTC stream to Cloudflare Realtime SFU. The SFU distributes it to approved viewers. The host's IP is not exposed to viewers through the media or control connection in relay mode. Cloudflare sees connection metadata and carries media. Viewer IP privacy is outside this phase. A viewer's code lookup must reach the configured Worker; only a confirmed 404 falls back to Direct mode.

To deploy your own relay, create a **Realtime TURN key** and a **Realtime SFU app** in the Cloudflare dashboard. Generate a long random `HOST_KEY` and keep it private. In `relay/`, run `npm install`, then set the five Worker secrets with `npx wrangler secret put TURN_KEY_ID`, `TURN_API_TOKEN`, `SFU_APP_ID`, `SFU_APP_SECRET`, and `HOST_KEY` (one command per secret). Run `npx wrangler deploy` after review. The `v1` Wrangler migration creates the SQLite-backed `RelayState` Durable Object; use the same class and migration tag on subsequent deploys. Set your Worker HTTPS URL in the host import file; viewers use the baked-in default unless the build had none or they want a different Worker. `relay/.dev.vars.example` is for local development only. Never commit `.dev.vars` or a real host key. The Worker has no CORS wildcard because all requests are made by Electron's main process.

The Worker estimates monthly SFU usage from each viewer's active pull time and configured stream bitrate. The default cap is 900 GB (`MONTHLY_CAP_GB`). New tickets are refused above the cap and active viewers are told to stop at their next heartbeat. This is an estimate, not Cloudflare's billing meter. Worker requests are limited per IP in memory to 120 per minute, so the limit resets when an isolate restarts. Rooms expire after 12 hours unless the host keeps heartbeating. The session's viewer admission limit still applies; the default is eight and Settings permits up to 32.

For local validation and post-deployment checks, see [Relay smoke test](docs/relay-smoke-test.md).

## Host start and stop hooks

Settings accepts an absolute executable path and one argument per line for each hook. Hooks run locally with `execFile`, without a shell, for at most ten seconds. Hook failures appear as a non-blocking message. The stop hook runs when a room ends and is attempted on app quit or renderer crash if the start hook ran. For a homelab backup, an example is the executable path to `docker.exe` with start arguments `pause` and `restic-restic-1`, and stop arguments `unpause` and `restic-restic-1`. These commands affect the local machine; enter only executables you trust.

## Security and IP privacy

Pending viewers receive no media, chat, roster, or playback state. Approval is required unless the host deliberately enables Auto-accept. Lock rejects new connections. Deny blocks that peer for this room session; Kick disconnects a viewer; Ban also blocks that peer ID for the session. Peer IDs are cheap to regenerate, so approval is the main defense. The host validates and rate-limits control messages. Viewers can send only a display name, plain-text chat, and one of the offered reactions; they cannot send files, playback commands, or filesystem requests to the host.

In Direct mode, accepted viewers may learn the host's IP address through WebRTC. **Hide my IP from viewers (relay only)** forces TURN relay candidates and requires a configured TURN server; Direct hosting and joining are refused if this setting is on without TURN. The setting defaults on when a TURN server is already configured. Relay mode always uses Cloudflare TURN for the host control channel, regardless of this Direct setting. A TURN provider can observe connection metadata and relay traffic. Room codes are short convenience codes, not strong secrets. Relay rooms pin the host peer ID obtained from the Worker before signaling, preventing another peer with the code from impersonating the host. Direct rooms have no separate host identity credential; confirm the host out of band before trusting a Direct room. Viewers cannot push SFU tracks, request TURN credentials, access the host session, or invoke host hooks through the Worker. A leaked `HOST_KEY` can control rooms and SFU sessions, so rotate it if exposed.

## Known limitations

- Chromium must decode the source file. Some HEVC, AC3, and DTS files will not play. A later phase may add FFmpeg conversion.
- Room codes are used as Trystero's signaling password. Share them privately.
- Streaming quality and connectivity depend on the host's upload speed, codec, network, public relay availability, and TURN availability.
- Relay usage estimation is approximate, and SFU/TURN service availability and costs depend on your Cloudflare account. The host's control data channel still connects to each viewer, relayed through TURN.
- Windows ships as a single portable executable only (`npm run dist`); there is no installer yet. The executable is unsigned, so SmartScreen shows a warning on first launch.

Licensed under MIT.
