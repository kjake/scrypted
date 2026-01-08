# AGENTS.override.md — Tuya Plugin WebRTC

## Branch
Work in a new branch, e.g.:
- `feature/tuya-webrtc`

## Objective
Implement improved camera streaming for the Scrypted Tuya plugin:
- Attempt WebRTC verification first, then failback to known working RTSP request.
- If WebRTC requests result in validated stream, create camera device as having a RTCSignalingChannel

## Constraints
- Do not change “cloud camera” behavior: no automatic streaming.
- Do not store/retain stream URLs; they are short-lived. Always request on demand.
- Keep user-facing messaging non-technical (“video stream URL”, “validate”), not “RTSP”, “OPTIONS”, etc.
- Internal diagnostics may include technical codes, but redact IDs.

## Testing
Add Vitest and create unit tests for:
- URL scheme validation
- RTSP status parsing

Avoid real network calls in tests:
- inject a mock `RTCValidator` into controller tests.

## Commands
From plugin directory:
- `npm ci`
- `npm run build` (scrypted-webpack)
- `npm test`

## Diagnostics / Redaction
Export diagnostics as JSON and redact sensitive identifiers:
- productId/category: OK to show unless user opts to redact
- never include full token material

## Definition of Done
- No regression in streaming behavior
- Tests pass and build succeeds