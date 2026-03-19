# openclaw-channel-mentra

MentraOS G2 Smart Glasses as a native channel in [OpenClaw](https://openclaw.dev).

Voice input travels from the G2 microphone through the MentraOS App, is processed by your OpenClaw agent, and the response appears on the G2 display — all over localhost.

## Architecture

```
G2 Mic → MentraOS App → POST :4747/mentra/inbound → Plugin → Agent
                                                               ↓
G2 Display ← MentraOS App ← POST :3000/response   ← Plugin ←┘
```

## Installation

### From npm / ClawHub

```bash
openclaw plugins install openclaw-channel-mentra
```

### Local development

```bash
openclaw plugins install -l ./openclaw-channel-mentra
```

## Configuration

Set these after installation:

```bash
openclaw config set channels.mentra.port 4747
openclaw config set channels.mentra.callbackUrl http://localhost:3000/response
```

| Key                         | Default                         | Description                                      |
|-----------------------------|---------------------------------|--------------------------------------------------|
| `channels.mentra.port`      | `4747`                          | Port the plugin listens on for inbound messages  |
| `channels.mentra.callbackUrl` | `http://localhost:3000/response` | URL to POST agent responses back to the MentraOS App |

## HTTP API

### POST `/mentra/inbound`

Receives a user prompt from the MentraOS App.

```json
{ "text": "Was ist die Hauptstadt von Frankreich?", "sessionKey": "<uuid>" }
```

**Response:** `202 Accepted`

### POST `/mentra/approval`

Receives an approval decision from the MentraOS App.

```json
{ "id": "<approval-id>", "decision": "allow-once", "sessionKey": "<uuid>" }
```

**Response:** `200 OK`

### GET `/mentra/health`

Health check endpoint.

**Response:** `200 { "status": "ok", "channel": "mentra" }`

## Callback payloads

The plugin POSTs one of the following to `callbackUrl`:

**Text response:**
```json
{ "text": "Paris.", "sessionKey": "<uuid>" }
```

**Approval request:**
```json
{ "type": "approval", "id": "<uuid>", "command": "rm -rf /tmp/cache", "sessionKey": "<uuid>" }
```

## Pairing with mentra-g2

This plugin is designed to work with the companion MentraOS App [`mentra-g2`](../mentra-g2).
Both run on the same Raspberry Pi — no ngrok or external connectivity needed between them.

## Publishing

```bash
npm publish --access public
```

The `openclaw.plugin.json` is included automatically and picked up by ClawHub.

## License

MIT
