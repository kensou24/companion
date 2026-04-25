<p align="center">
  <img src="screenshot.png" alt="The Companion" width="100%" />
</p>

<h1 align="center">The Companion</h1>
<p align="center"><strong>Web UI for Claude Code and Codex sessions.</strong></p>
<p align="center">Run multiple agents, inspect every tool call, and gate risky actions with explicit approvals.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/v/the-companion.svg" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/the-companion"><img src="https://img.shields.io/npm/dm/the-companion.svg" alt="npm downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" /></a>
</p>

---

## Quick Start

**Requirements:** [Bun](https://bun.sh) + [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and/or [Codex](https://github.com/openai/codex) CLI.

### Try it instantly

```bash
bunx the-companion
```

Open [http://localhost:3456](http://localhost:3456).

### Install globally

```bash
bun install -g the-companion

# Register as a background service (launchd on macOS, systemd on Linux)
the-companion install

# Start the service
the-companion start
```

Open [http://localhost:3456](http://localhost:3456). The server runs in the background and survives reboots.

### CLI Commands

| Command | Description |
|---|---|
| `the-companion` | Start server in foreground (default) |
| `the-companion serve` | Start server in foreground (explicit) |
| `the-companion install` | Register as a background service |
| `the-companion start` | Start the background service |
| `the-companion stop` | Stop the background service |
| `the-companion restart` | Restart the background service |
| `the-companion uninstall` | Remove the background service |
| `the-companion status` | Show service status |
| `the-companion logs` | Tail service log files |

**Options:** `--port <n>` overrides the default port (3456).

---

## Features

- **Parallel sessions** — work on multiple tasks without juggling terminals
- **Full visibility** — see streaming output, tool calls, and tool results in one timeline
- **Permission control** — approve/deny sensitive operations from the UI
- **Session recovery** — restore work after process/server restarts
- **Dual-engine support** — designed for both Claude Code and Codex

## Screenshots

| Chat + tool timeline | Permission flow |
|---|---|
| <img src="screenshot.png" alt="Main workspace" width="100%" /> | <img src="web/docs/screenshots/notification-section.png" alt="Permission and notifications" width="100%" /> |

---

## Authentication

The server auto-generates an auth token on first start, stored at `~/.companion/auth.json`.

```bash
# Show the current token (or auto-generate one)
cd web && bun run generate-token

# Force-regenerate a new token
cd web && bun run generate-token --force
```

Or set a token via environment variable (takes priority over the file):

```bash
COMPANION_AUTH_TOKEN="my-secret-token" bunx the-companion
```

---

## Integrations

### WeChat Bot

Control your sessions directly from WeChat — no browser needed.

**Setup:** Navigate to **Integrations → WeChat Bot** (or `#/integrations/wechat`), click **Start**, and scan the QR code.

**Commands:**

| Command | Description |
|---------|-------------|
| `/new [folder]` | Create new session |
| `/sessions` | List all sessions |
| `/switch <n>` | Switch to session n |
| `/kill` | Terminate current session |
| `/model <name>` | Switch model |
| `/mode <mode>` | Change permission mode |
| `/allow` / `/deny` | Approve or deny permission request |
| `/status` | Check session status |
| `/help` | Show all commands |

See [`docs/wechat-bot.md`](docs/wechat-bot.md) for full documentation.

---

## Architecture

```text
Browser (React)
  ↔ ws://localhost:3456/ws/browser/:session
Companion server (Bun + Hono)
  ↔ ws://localhost:3456/ws/cli/:session
Claude Code / Codex CLI
```

The bridge uses the CLI `--sdk-url` websocket path and NDJSON events. See [`WEBSOCKET_PROTOCOL_REVERSED.md`](WEBSOCKET_PROTOCOL_REVERSED.md) for protocol details.

---

## Development

```bash
# Start dev server (Hono backend + Vite HMR)
make dev

# Or manually
cd web && bun install && bun run dev

# Type checking
cd web && bun run typecheck

# Tests
cd web && bun run test
```

See [`CLAUDE.md`](CLAUDE.md) for contributor guidelines and full architecture documentation.

---

## License

MIT
