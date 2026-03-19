# openclaw-channel-mentra

OpenClaw Channel Plugin for MentraOS G2 Smart Glasses.

Integrates MentraOS G2 Smart Glasses as a native voice/display channel in OpenClaw.
Voice input via G2 microphone, text output on G2 display.

## Architecture

The plugin spawns a child process (`src/tpa-server.ts`) that runs the MentraOS TpaServer.
The child communicates with the OpenClaw gateway via local HTTP IPC (loopback only).

```
OpenClaw Gateway
  └── openclaw-channel-mentra (plugin)
        ├── IPC HTTP server (random loopback port)
        └── spawns: bun src/tpa-server.ts
              └── MentraOS TpaServer (port 7010)
                    └── State machine: IDLE -> TRIGGERED -> LISTENING -> PROCESSING
```

## Setup (first time on a new machine)

```bash
# 1. Clone the repo
git clone https://github.com/creolinchen/MentraOsClawd.git
cd MentraOsClawd/openclaw-channel-mentra

# 2. Install dependencies
bun install

# 3. Link plugin into OpenClaw
openclaw plugins install -l ~/MentraOsClawd/openclaw-channel-mentra

# 4. Run the setup wizard
openclaw configure --section channels
# Enter: package name, API key, server port (7010), public server URL

# 5. Set up ngrok (must forward to same port as TpaServer, default 7010)
ngrok http --url=YOUR_STATIC_NGROK_URL 7010

# 6. Set server URL in Mentra console
# Go to console.mentra.glass -> your app -> set Server URL to your ngrok URL

# 7. Restart gateway
openclaw gateway restart
```

## Updating (pulling new code to Pi)

```bash
cd ~/MentraOsClawd/openclaw-channel-mentra && git pull && openclaw gateway restart
```

## Config values

Stored in `~/.openclaw/openclaw.json` under `channels.mentra`:

| Key | Description |
|-----|-------------|
| `mentraPackageName` | Package name from console.mentra.glass |
| `mentraApiKey` | API key from console.mentra.glass |
| `mentraServerPort` | Port TpaServer listens on (default: 7010) |
| `mentraServerUrl` | Public ngrok URL (must match console.mentra.glass) |

Check config:
```bash
openclaw config get channels.mentra
```

Re-run setup wizard:
```bash
openclaw configure --section channels
```

## Trigger words

Say one of these to activate, then say `mentra` to start recording.

`hey`, `hi`, `hallo`, `servus`, `moin`, `yo`, `na`, `guten morgen`, `guten abend`,
`guten tag`, `grüß gott`, `howdy`, `aloha`, `salut`, `ahoi`, `ciao`, `jojo`

Example flow:
- "Hey" -> display shows "hey"
- "Mentra" -> display shows "hey mentra"
- Speak prompt -> display shows your text live
- 2s silence -> sends to AI -> displays response

## Debugging

Check if TpaServer is running:
```bash
sudo lsof -i :7010
```

Check if MentraOS is reaching the webhook:
```bash
python3 check_ngrok.py
```

Check OpenClaw logs:
```bash
openclaw logs 2>&1 | tail -30
```

Check plugin status:
```bash
openclaw plugins list | grep mentra
```

## Pi details (Prometheus)

- Hostname: `timothy@Prometheus`
- IP: `192.168.0.151`
- Repo location: `~/MentraOsClawd/openclaw-channel-mentra`
- ngrok URL: `https://cochleate-potently-arnold.ngrok-free.dev` (static, paid plan)
- ngrok forwards to: `localhost:7010`

## Notes

- Plugin ID mismatch warning is harmless
- ngrok must be running before the gateway starts
- The child process auto-kills port 7010 before starting to avoid conflicts
- If gateway crashes with plugin enabled, check if something else occupies port 7010
