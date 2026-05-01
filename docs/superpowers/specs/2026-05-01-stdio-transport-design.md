# Claude Code stdio Transport Refactor

## Problem

Claude Code CLI 2.1.121+ blocks `--sdk-url ws://localhost`, breaking Companion's core architecture.
The stdin/stdout NDJSON mode (`--print --output-format stream-json --input-format stream-json --verbose`)
still works and uses the identical NDJSON protocol.

## Decision

Clean cutover to stdio transport. Remove `--sdk-url` WebSocket path entirely.

## Architecture

### Before (WebSocket)

```
Browser <-> WsBridge <-> ClaudeAdapter <-> ServerWebSocket <-> CLI (--sdk-url)
```

CLI spawned with `--sdk-url ws://localhost:PORT/ws/cli/SESSION_ID`, connects back via WebSocket.

### After (stdio)

```
Browser <-> WsBridge <-> ClaudeAdapter <-> stdin/stdout pipes <-> CLI
```

CLI spawned with stdio pipes. ClaudeAdapter reads stdout and writes stdin directly.

## Files Changed

### `claude-adapter.ts` (major)

- Replace `cliSocket: ServerWebSocket` with stdin writer + stdout reader
- Remove `attachWebSocket()` / `detachWebSocket()` / `handleTransportClose()`
- Add `attachStdio(proc: Subprocess)` — gets stdin writer, starts stdout reader loop
- `sendRaw()` writes to stdin instead of `ws.send()`
- `isConnected()` checks stdio transport state instead of socket
- `disconnect()` closes stdin writer instead of WebSocket
- All NDJSON parsing, routing, dedup logic unchanged

### `cli-launcher.ts` (moderate)

- Remove `--sdk-url` argument from spawn args
- Add `stdin: "pipe"` to `Bun.spawn()` options
- After spawn, create `ClaudeAdapter` and call `attachStdio(proc)`
- Remove WebSocket URL construction (`sdkUrl`)
- Container mode: keep `docker exec -i` (stdin already piped)

### `ws-bridge.ts` (moderate)

- Remove `handleCLIOpen()`, `handleCLIMessage()`, `handleCLIClose()`
- Remove CLI disconnect debounce timers (no more WS cycling)
- Simplify `attachBackendAdapter()` for Claude (no WebSocket-specific logic)
- Remove `instanceof ClaudeAdapter` checks that were WS-specific

### `index.ts` (minor)

- Remove `/ws/cli/:id` WebSocket upgrade route
- Keep `/ws/browser/:id` unchanged

## Transport Implementation

The `StdioTransport` inside `claude-adapter.ts`:

```typescript
class StdioTransport {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private alive = true;

  constructor(stdin: WritableStream, stdout: ReadableStream, onLine: (line: string) => void) {
    this.writer = stdin.getWriter();
    this.readLoop(stdout, onLine);
  }

  private async readLoop(stdout: ReadableStream, onLine: (line: string) => void) {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) { this.alive = false; onLine(""); return; } // EOF
      this.buffer += decoder.decode(value, { stream: true });
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop()!; // keep incomplete tail
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    }
  }

  write(data: string) {
    this.writer.write(new TextEncoder().encode(data + "\n"));
  }

  close() { this.writer.close(); }
  isConnected() { return this.alive; }
}
```

## Key Simplifications

1. **No disconnect debounce**: With WebSocket, CLI cycled connections every ~30s requiring 15s debounce. With stdio, disconnect = process exit (already handled).
2. **No message queuing before connect**: stdin is available immediately after spawn, no need for `pendingMessages` in adapter.
3. **No stale socket guards**: No need to check `cliSocket !== ws` since there's no reconnection.

## What Does NOT Change

- NDJSON protocol format and message types
- All message routing in `routeCLIMessage()`
- Permission handling, streaming, tool progress
- Browser WebSocket transport (`/ws/browser/:id`)
- Codex adapter and transport
- Session persistence, recording, resumption
- Frontend code (no changes needed)

## Testing

- Update existing `claude-adapter.test.ts` — mock stdin/stdout instead of WebSocket
- Update `cli-launcher.test.ts` — verify `--sdk-url` removed, `stdin: "pipe"` added
- Update `ws-bridge.test.ts` — remove CLI WebSocket handler tests
- Add stdio transport tests (line buffering, EOF detection, write)
