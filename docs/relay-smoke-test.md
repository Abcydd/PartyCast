# Relay smoke test

## Local Worker and control flow

1. In `relay/`, copy `.dev.vars.example` to `.dev.vars` and replace the placeholders with **dummy** values. Keep `MOCK_SFU=1`. Do not use real Cloudflare secrets for this check.
2. Run `npm --prefix relay install`, then `npm --prefix relay exec wrangler dev -- --local --port 8787`. This does not deploy. The mock returns placeholder TURN credentials and SDP; it exercises authorization and session routes but cannot carry media.
3. With `PARTYCAST_QA=1`, point both app instances at `http://127.0.0.1:8787` using `PARTYCAST_QA_RELAY_URL` and give the host instance `PARTYCAST_QA_HOST_KEY` matching the dummy `HOST_KEY`. Set `PARTYCAST_QA_CONTROL_DIRECT=1` on the host to use ordinary ICE for this local signaling check, since dummy TURN credentials cannot establish the host's control connection. This bypass exists only when both QA flags are set in the main process; it does not test IP privacy. **Launch every Electron process with `--mute-audio`** and use separate `PARTYCAST_QA_PROFILE` directories. Close both instances and delete `.dev.vars` and QA profiles afterwards.
4. Host a room, copy its code, and confirm `GET /v1/rooms/by-code/CODE` returns the host's peer ID. Enter the code in the viewer. The viewer should wait for approval; the host should see the pending name. Approve it. The Worker should issue a ticket, and the viewer should receive the host name and room state. Chat and reactions should still use the control channel. The mock SDP cannot negotiate playable media.

## After the orchestrator deploys

1. Import a private file containing the deployed HTTPS Worker URL and host key on the host. Set the same Relay URL in viewer Settings, without importing a key.
2. Start a relay room and confirm the code comes from the Worker. Check that a pending viewer receives no media before approval. Approve the viewer and play a supported 1080p MP4 or WebM with audio. Launch QA instances with `--mute-audio` if automating this on a shared PC.
3. Verify video and audio arrive, seek and change the host file, and confirm the viewer remains in sync. Confirm host stats show the actual codec, resolution, and bitrate; test all three relay quality presets. Add several viewers and check the host still has one outbound SFU media connection.
4. On the host and viewer, inspect WebRTC ICE candidates (`chrome://webrtc-internals` in a development build). The host control and media connections should use relay candidates only; viewers must not learn a host private or public IP. Verify the viewer cannot call a host Worker endpoint or push a track using its ticket.
5. Leave and close the room. Confirm SFU tracks and sessions close, the room lookup becomes 404, and the stop hook runs if configured. Check `/v1/usage` with the host key for the monthly estimate. Do not use a production host key in logs or screenshots.

Cloudflare's real TURN and SFU exchange, playable media, and accounting must be verified after deployment; the local mock intentionally does not simulate media transport.
