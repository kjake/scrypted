# AGENTS.override.md — Tuya Plugin Discovery UX Workstream

## Branch
Work in a new branch, e.g.:
- `feature/tuya-discovery-ux`

## Objective
Implement improved camera discovery and onboarding for the Scrypted Tuya plugin:
- Candidate vs Verified vs Unverified (Force Confirmed) registries
- Default-on verification (stream URL issuance + RTSP OPTIONS validation)
- Force confirm workflow
- Opportunistic verification on MQTT online events
- Plugin Settings UX for discovery (retry/force/export)
- Add unit tests (Vitest) for pure logic

## Constraints
- Do not change “cloud camera” behavior: no automatic streaming.
- Do not add LAN DP control or deep SDP/SETUP/PLAY validation.
- Do not store/retain stream URLs; they are short-lived. Always request on demand.
- Keep user-facing messaging non-technical (“video stream URL”, “validate”), not “RTSP”, “OPTIONS”, etc.
- Internal diagnostics may include technical codes, but redact IDs.

## Suggested Project Structure
Add a discovery subsystem under `src/discovery/`:
- `types.ts` (records and enums)
- `registry.ts` (persistent state + maps)
- `controller.ts` (orchestrates probes, backoff, debounce)
- `backoff.ts` (pure)
- `rtspValidator.ts` (interface + net/tls implementation + parser)
- `strings.ts` (user-facing string table)

Integrate into `src/plugin.ts`:
- After `fetchDevices()`, update discovery registry
- Only create Scrypted devices for Verified and Unverified devices
- Consume MQTT `online/offline` messages to update online state and trigger debounced probes
- Implement plugin Settings entries for discovery actions

## Testing
Add Vitest and create unit tests for:
- backoff schedule
- URL scheme validation
- RTSP status parsing
- state transitions (Candidate→Verified, Force Confirm, Unverified→Verified)
- user-facing message mapping

Avoid real network calls in tests:
- inject a mock `RtspValidator` into controller tests.

## Commands
From plugin directory:
- `npm ci`
- `npm run build` (scrypted-webpack)
- `npm test`

## Diagnostics / Redaction
Export diagnostics as JSON and redact sensitive identifiers:
- devId: show only last 4–6 chars (e.g., `…ckf`)
- productId/category: OK to show unless user opts to redact
- never include full token material

## Definition of Done
- Discovery UX present in Settings and functional
- Verified/Unverified logic matches the design
- No regression in streaming behavior
- Tests pass and build succeeds