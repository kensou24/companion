# Claude Code stdio Transport Refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the blocked `--sdk-url` WebSocket transport with stdin/stdout pipes for Claude Code CLI communication.

**Architecture:** CLI spawned with `stdin: "pipe"` instead of `--sdk-url`. A `StdioTransport` class reads stdout (NDJSON) and writes stdin (NDJSON). The `ClaudeAdapter` uses this transport instead of a `ServerWebSocket`. All downstream message routing, parsing, and browser-facing code is unchanged.

**Tech Stack:** Bun, TypeScript, NDJSON protocol (unchanged)

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `web/server/claude-adapter.ts` | Replace WebSocket transport with stdio transport |
| Modify | `web/server/cli-launcher.ts` | Remove `--sdk-url`, add stdin pipe, create adapter in-process |
| Modify | `web/server/ws-bridge.ts` | Remove CLI WebSocket handlers, simplify adapter attachment |
| Modify | `web/server/ws-bridge-types.ts` | Remove `CLISocketData` type |
| Modify | `web/server/index.ts` | Remove `/ws/cli` WebSocket upgrade route and handlers |
| Modify | `web/server/event-bus-types.ts` | Add `backend:claude-adapter-created` event |
| Modify | `web/server/session-orchestrator.ts` | Listen for `backend:claude-adapter-created` |
| Modify | `web/server/claude-adapter.test.ts` | Update tests for stdio transport |
| Modify | `web/server/cli-launcher.test.ts` | Update tests for new spawn args |
| Modify | `web/server/ws-bridge.test.ts` | Remove CLI WebSocket handler tests |

---

### Task 1: Add StdioTransport to claude-adapter.ts

**Files:**
- Modify: `web/server/claude-adapter.ts`

This is the core change. Add a private `StdioTransport` class and replace all WebSocket-based transport code.

- [ ] **Step 1: Add StdioTransport class before the ClaudeAdapter class definition**

Add this class at line ~55 (before `export class ClaudeAdapter`):

```typescript
// --- Stdio Transport (stdin/stdout pipes) ----------------------------------

/** Transport that reads NDJSON from stdout and writes NDJSON to stdin. */
class StdioTransport {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer = "";
  private alive = true;
  private onLine: (line: string) => void;
  private onError: (err: unknown) => void;
  private sessionId: string;

  constructor(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
    opts: {
      sessionId: string;
      onLine: (line: string) => void;
      onError: (err: unknown) => void;
    },
  ) {
    this.sessionId = opts.sessionId;
    this.onLine = opts.onLine;
    this.onError = opts.onError;

    // Handle both Bun subprocess stdin types (same pattern as CodexAdapter)
    let writable: WritableStream<Uint8Array>;
    if ("write" in stdin && typeof stdin.write === "function") {
      writable = new WritableStream({
        write(chunk) {
          (stdin as { write(data: Uint8Array): number }).write(chunk);
        },
      });
    } else {
      writable = stdin as WritableStream<Uint8Array>;
    }
    this.writer = writable.getWriter();
    this.readStdout(stdout);
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop()!;
        for (const line of lines) {
          if (line.trim()) {
            this.onLine(line);
          }
        }
      }
    } catch (err) {
      this.onError(err);
    } finally {
      this.alive = false;
      // Signal EOF as an empty line to trigger disconnect
      this.onLine("");
    }
  }

  write(data: string): void {
    if (!this.alive) return;
    try {
      this.writer.write(new TextEncoder().encode(data + "\n"));
    } catch (err) {
      console.error(`[claude-adapter] Failed to write to stdin for session ${this.sessionId}:`, err);
    }
  }

  async close(): Promise<void> {
    this.alive = false;
    try {
      await this.writer.close();
    } catch {
      // Already closed
    }
  }

  isConnected(): boolean {
    return this.alive;
  }
}
```

- [ ] **Step 2: Replace WebSocket fields with StdioTransport in ClaudeAdapter**

In the `ClaudeAdapter` class, replace:
```typescript
  // WebSocket to the Claude Code CLI process
  private cliSocket: ServerWebSocket<SocketData> | null = null;
```
with:
```typescript
  // Stdio transport to the Claude Code CLI process
  private transport: StdioTransport | null = null;
```

- [ ] **Step 3: Remove WebSocket imports**

Remove from the import section:
```typescript
import type { ServerWebSocket } from "bun";
```
and:
```typescript
import type { SocketData } from "./ws-bridge-types.js";
import type { PendingControlRequest } from "./ws-bridge-types.js";
```

Add import for PendingControlRequest from a local definition or keep importing it from ws-bridge-types (it's still used by the adapter). Actually, keep `PendingControlRequest` import — it's still needed.

The change is just removing `ServerWebSocket` and `SocketData`:
```typescript
// Remove these:
import type { ServerWebSocket } from "bun";
import type { SocketData } from "./ws-bridge-types.js";
```

- [ ] **Step 4: Replace attachWebSocket/detachWebSocket with attachStdio**

Replace the three WebSocket lifecycle methods (`attachWebSocket`, `detachWebSocket`, `handleTransportClose`) with:

```typescript
  // -- Stdio lifecycle --------------------------------------------------------

  /**
   * Called after CLI process is spawned. Attaches stdin/stdout transport,
   * starts reading stdout for NDJSON messages.
   */
  attachStdio(
    stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
    stdout: ReadableStream<Uint8Array>,
  ): void {
    this.transport = new StdioTransport(stdin, stdout, {
      sessionId: this.sessionId,
      onLine: (line) => {
        if (!line) {
          // EOF — transport closed
          this.disconnectCb?.();
          return;
        }
        this.handleRawMessage(line);
      },
      onError: (err) => {
        console.error(`[claude-adapter] Stdout read error for session ${this.sessionId}:`, err);
      },
    });
  }
```

- [ ] **Step 5: Update isConnected, disconnect, sendRaw**

Replace `isConnected()`:
```typescript
  isConnected(): boolean {
    return this.transport !== null && this.transport.isConnected();
  }
```

Replace `disconnect()`:
```typescript
  async disconnect(): Promise<void> {
    this.pendingControlRequests.clear();
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // Already closed
      }
      this.transport = null;
    }
  }
```

Replace `sendRaw()`:
```typescript
  private sendRaw(ndjson: string): void {
    this.recorder?.record(
      this.sessionId, "out", ndjson, "cli", "claude", "",
    );
    if (!this.transport) return;
    this.transport.write(ndjson);
  }
```

- [ ] **Step 6: Update sendToBackend — remove pendingMessages queue**

Since stdin is available immediately after spawn (no WebSocket handshake delay), the pending message queue is no longer needed for transport reasons. However, we still need to queue messages that arrive before `system.init` (e.g., user sends a message while CLI is starting). The existing `pendingMessages` array handles this in `handleSystemInit` already — keep that queue. Only change `sendToBackend`:

```typescript
  private sendToBackend(ndjson: string): void {
    if (!this.transport) {
      console.log(
        `[claude-adapter] Transport not ready for session ${this.sessionId}, queuing message`,
      );
      this.pendingMessages.push(ndjson);
      return;
    }
    this.sendRaw(ndjson);
  }
```

This is functionally identical — it just checks `this.transport` instead of `this.cliSocket`. The comment in the existing code about "CLI not yet connected" is now about "transport not yet attached".

- [ ] **Step 7: Remove handleRawMessage's multi-line parsing**

The current `handleRawMessage(data: string)` receives raw WebSocket frames that may contain multiple NDJSON lines. With stdio, the `StdioTransport` already splits on newlines and delivers one line at a time. Simplify:

```typescript
  handleRawMessage(data: string): void {
    // Record raw incoming CLI message before any parsing
    this.recorder?.record(
      this.sessionId, "in", data, "cli", "claude", "",
    );

    let msg: CLIMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      reportProtocolDrift(
        this.parseErrorSeen,
        {
          backend: "claude",
          sessionId: this.sessionId,
          direction: "incoming",
          messageKind: "parse_error",
          messageName: "ndjson",
          rawPreview: data,
        },
        (message) => this.browserMessageCb?.({ type: "error", message }),
      );
      return;
    }

    if (isDuplicateCLIMessage(msg, data, this.dedupState, CLI_DEDUP_WINDOW)) {
      return;
    }

    this.routeCLIMessage(msg);
  }
```

Note: `parseNDJSON` is no longer called here. The import can be removed if nothing else uses it. Check `ws-bridge-cli-ingest.ts` — the `parseNDJSON` helper is only imported here, so it can remain (unused imports won't break).

- [ ] **Step 8: Update handleSystemInit flush to use sendRaw directly**

The existing `handleSystemInit` has:
```typescript
for (const ndjson of queued) {
  this.sendRaw(ndjson);
}
```
This already works with the new transport. No change needed.

- [ ] **Step 9: Commit**

```bash
git add web/server/claude-adapter.ts
git commit -m "refactor(claude-adapter): replace WebSocket transport with stdio transport"
```

---

### Task 2: Update cli-launcher.ts to use stdio spawn

**Files:**
- Modify: `web/server/cli-launcher.ts`
- Modify: `web/server/event-bus-types.ts`
- Modify: `web/server/session-orchestrator.ts`

- [ ] **Step 1: Add ClaudeAdapter import to cli-launcher.ts**

Add at the imports section (around line 15):
```typescript
import { ClaudeAdapter } from "./claude-adapter.js";
```

- [ ] **Step 2: Remove --sdk-url from spawn args in spawnCLI()**

In the `spawnCLI` method, remove the `sdkUrl` construction (lines 486-493):
```typescript
// DELETE these lines:
const containerSdkHost = (process.env.COMPANION_CONTAINER_SDK_HOST || "host.docker.internal").trim()
  || "host.docker.internal";
const sdkUrl = isContainerized
  ? `ws://${containerSdkHost}:${this.port}/ws/cli/${sessionId}`
  : `ws://localhost:${this.port}/ws/cli/${sessionId}`;
```

Remove `--sdk-url` from the args array (line 521):
```typescript
// Change from:
const args: string[] = [
  "--sdk-url", sdkUrl,
  "--print",
  ...
// To:
const args: string[] = [
  "--print",
  ...
```

- [ ] **Step 3: Add stdin: "pipe" to Bun.spawn**

Change the Bun.spawn call (line 604):
```typescript
// Change from:
const proc = Bun.spawn(spawnCmd, {
  cwd: spawnCwd,
  env: spawnEnv,
  stdout: "pipe",
  stderr: "pipe",
});

// To:
const proc = Bun.spawn(spawnCmd, {
  cwd: spawnCwd,
  env: spawnEnv,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});
```

- [ ] **Step 4: Replace pipeOutput with adapter creation**

After `this.processes.set(sessionId, proc)`, replace `this.pipeOutput(sessionId, proc)` with adapter creation:

```typescript
    // Replace this.pipeOutput(sessionId, proc) with:

    // Create ClaudeAdapter with stdio transport
    const adapter = new ClaudeAdapter(sessionId, {
      recorder: this.recorder,
      onActivityUpdate: () => {
        // Activity tracking is handled by the bridge
      },
    });

    // Attach stdio transport (stdin for writing, stdout for reading NDJSON)
    const stdin = proc.stdin;
    const stdout = proc.stdout;
    if (stdin && stdout && typeof stdin !== "number" && typeof stdout !== "number") {
      adapter.attachStdio(stdin, stdout);
    } else {
      console.error(`[cli-launcher] Failed to get stdin/stdout pipes for session ${sessionId}`);
      info.state = "exited";
      info.exitCode = 1;
      this.persistState();
      return;
    }

    // Only pipe stderr for debugging (stdout is NDJSON protocol now)
    const stderr = proc.stderr;
    if (stderr && typeof stderr !== "number") {
      this.pipeStream(sessionId, stderr, "stderr");
    }

    // Notify the WsBridge to attach this adapter
    companionBus.emit("backend:claude-adapter-created", { sessionId, adapter });

    info.state = "connected";
```

- [ ] **Step 5: Add backend:claude-adapter-created event type**

In `web/server/event-bus-types.ts`, add after the `backend:codex-adapter-created` event (around line 55):

```typescript
  /** Claude adapter created and ready to be attached to WsBridge. */
  "backend:claude-adapter-created": {
    sessionId: string;
    adapter: ClaudeAdapter;
  };
```

Add import at top of file:
```typescript
import type { ClaudeAdapter } from "./claude-adapter.js";
```

- [ ] **Step 6: Wire the event in session-orchestrator.ts**

In `web/server/session-orchestrator.ts`, add after the existing `backend:codex-adapter-created` handler (around line 168):

```typescript
    // When a Claude adapter is created, attach it to the WsBridge
    companionBus.on("backend:claude-adapter-created", ({ sessionId, adapter }) => {
      this.wsBridge.attachBackendAdapter(sessionId, adapter, "claude");
    });
```

Add import:
```typescript
import type { ClaudeAdapter } from "./claude-adapter.js";
```

- [ ] **Step 7: Commit**

```bash
git add web/server/cli-launcher.ts web/server/event-bus-types.ts web/server/session-orchestrator.ts
git commit -m "refactor(cli-launcher): spawn Claude CLI with stdio pipes instead of --sdk-url"
```

---

### Task 3: Simplify ws-bridge.ts — remove CLI WebSocket handlers

**Files:**
- Modify: `web/server/ws-bridge.ts`
- Modify: `web/server/ws-bridge-types.ts`

- [ ] **Step 1: Remove CLI WebSocket handler methods**

Delete from `ws-bridge.ts`:
- `handleCLIOpen()` method (lines ~820-880)
- `handleCLIMessage()` method (lines ~882-895)
- `handleCLIClose()` method (lines ~897-934) — including the disconnect debounce timer logic

Also remove the `DISCONNECT_DEBOUNCE_MS` constant (line 69-72):
```typescript
// DELETE:
private static readonly DISCONNECT_DEBOUNCE_MS = Number(
  process.env.COMPANION_DISCONNECT_DEBOUNCE_MS || "15000",
);
```

- [ ] **Step 2: Remove ClaudeAdapter import and instanceof checks**

Remove:
```typescript
import { ClaudeAdapter } from "./claude-adapter.js";
```

In `attachBackendAdapter()` (around line 400), the `instanceof ClaudeAdapter` check guards the state machine transition. With stdio, Claude adapters now behave like Codex adapters — the adapter attachment IS the transport open event. Remove the special case:

```typescript
// Change from:
if (!(adapter instanceof ClaudeAdapter)) {
  this.cancelDisconnectTimer(sessionId);
  const phase = session.stateMachine.phase;
  if (phase === "terminated") {
    session.stateMachine.transition("starting", "adapter_reattached");
  }
  session.stateMachine.transition("initializing", "adapter_attached");
}

// To:
this.cancelDisconnectTimer(sessionId);
const phase = session.stateMachine.phase;
if (phase === "terminated") {
  session.stateMachine.transition("starting", "adapter_reattached");
}
session.stateMachine.transition("initializing", "adapter_attached");
```

- [ ] **Step 3: Remove ClaudeAdapter-specific disconnect handling**

In the `onDisconnect` callback (around line 675), remove:
```typescript
// DELETE:
if (adapter instanceof ClaudeAdapter) {
  // Do nothing here — handleCLIClose manages the debounce timer
  return;
}
```

Now both Claude and Codex follow the same disconnect path. The remaining Codex disconnect logic becomes the universal path:

```typescript
adapter.onDisconnect(() => {
  if (session.backendAdapter !== adapter) {
    console.log(`[ws-bridge] Ignoring stale disconnect for session ${sessionId} (adapter replaced)`);
    return;
  }

  // Universal disconnect handling for all backend types
  session.backendAdapter = null;
  session.stateMachine.transition("reconnecting", "adapter_disconnected");
  this.persistSession(session);
  log.info("ws-bridge", "Adapter disconnected, starting debounce", { sessionId });

  const debounceMs = session.backendType === "codex"
    ? WsBridge.CODEX_DISCONNECT_DEBOUNCE_MS
    : WsBridge.CODEX_DISCONNECT_DEBOUNCE_MS; // same for both now
  const existing = this.disconnectTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  this.disconnectTimers.set(sessionId, setTimeout(() => {
    this.disconnectTimers.delete(sessionId);
    if (session.backendAdapter?.isConnected()) return;

    log.warn("ws-bridge", "Disconnect confirmed", { sessionId });
    for (const [reqId] of session.pendingPermissions) {
      this.broadcastToBrowsers(session, { type: "permission_cancelled", request_id: reqId });
      companionBus.emit("session:permission-cancelled", { sessionId, requestId: reqId });
    }
    session.pendingPermissions.clear();
    session.stateMachine.transition("terminated", "disconnect_confirmed");
    this.persistSession(session);
    this.broadcastToBrowsers(session, { type: "cli_disconnected" });
    companionBus.emit("session:relaunch-needed", { sessionId });
  }, WsBridge.CODEX_DISCONNECT_DEBOUNCE_MS));
});
```

Note: We use `CODEX_DISCONNECT_DEBOUNCE_MS` (5s) instead of the old 15s because there's no WebSocket cycling with stdio — the process is either alive or dead.

- [ ] **Step 4: Remove ClaudeAdapter flush special case**

In `attachBackendAdapter` (around line 720), remove:
```typescript
// DELETE the special case:
if (!(adapter instanceof ClaudeAdapter) && session.pendingMessages.length > 0) {
```

Replace with unconditional flush:
```typescript
if (session.pendingMessages.length > 0) {
  this.flushQueuedBrowserMessages(session, adapter, "adapter_attach");
  this.persistSession(session);
}
```

- [ ] **Step 5: Remove ClaudeAdapter check in sendInitialize**

Search for `instanceof ClaudeAdapter` in ws-bridge.ts and remove any remaining checks. There's one around line 1082:

```typescript
// Change from:
if (session.backendAdapter instanceof ClaudeAdapter) {

// To: (remove the check, or check if adapter supports sendRawNDJSON)
```

Since `ClaudeAdapter` still has `sendRawNDJSON`, we can check for its existence:

```typescript
if ("sendRawNDJSON" in session.backendAdapter) {
```

Or import `ClaudeAdapter` and keep the instanceof. Given the design goal is to remove coupling, use the duck-type check.

- [ ] **Step 6: Remove CLISocketData from ws-bridge-types.ts**

Delete the `CLISocketData` interface and remove it from the `SocketData` union:

```typescript
// DELETE:
export interface CLISocketData {
  kind: "cli";
  sessionId: string;
}

// Update the union:
export type SocketData = BrowserSocketData | TerminalSocketData | NoVncSocketData;
```

- [ ] **Step 7: Commit**

```bash
git add web/server/ws-bridge.ts web/server/ws-bridge-types.ts
git commit -m "refactor(ws-bridge): remove CLI WebSocket handlers, simplify for stdio transport"
```

---

### Task 4: Remove CLI WebSocket route from index.ts

**Files:**
- Modify: `web/server/index.ts`

- [ ] **Step 1: Remove /ws/cli upgrade route**

Delete lines 195-204:
```typescript
// DELETE:
const cliMatch = url.pathname.match(/^\/ws\/cli\/([a-f0-9-]+)$/);
if (cliMatch) {
  const sessionId = cliMatch[1];
  const upgraded = server.upgrade(req, {
    data: { kind: "cli" as const, sessionId },
  });
  if (upgraded) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}
```

- [ ] **Step 2: Remove CLI WebSocket handlers in websocket object**

Remove the `cli` branches from `open`, `message`, and `close` handlers:

In `open()` — remove:
```typescript
if (data.kind === "cli") {
  wsBridge.handleCLIOpen(ws, data.sessionId);
  launcher.markConnected(data.sessionId);
}
```

In `message()` — remove:
```typescript
if (data.kind === "cli") {
  wsBridge.handleCLIMessage(ws, msg);
}
```

In `close()` — remove:
```typescript
if (data.kind === "cli") {
  wsBridge.handleCLIClose(ws);
}
```

- [ ] **Step 3: Commit**

```bash
git add web/server/index.ts
git commit -m "refactor(server): remove /ws/cli WebSocket upgrade route"
```

---

### Task 5: Update tests

**Files:**
- Modify: `web/server/claude-adapter.test.ts`
- Modify: `web/server/cli-launcher.test.ts`
- Modify: `web/server/ws-bridge.test.ts`

- [ ] **Step 1: Update claude-adapter.test.ts**

Replace WebSocket mock with stdio mock. The existing tests create a mock `ServerWebSocket` and call `adapter.attachWebSocket(ws)`. Replace with:

Create a helper function:
```typescript
function createStdioMock(onWrite?: (data: string) => void) {
  const chunks: string[] = [];
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      // Tests will push data manually via simulateStdout()
    },
  });
  // Actually, for tests we need a simpler approach:
  // Use a mock transport approach

  const written: string[] = [];
  const mockStdin = {
    write: vi.fn((data: Uint8Array) => {
      written.push(new TextDecoder().decode(data));
      return data.length;
    }),
    getWriter: vi.fn(() => ({
      write: vi.fn((data: Uint8Array) => {
        written.push(new TextDecoder().decode(data));
        return Promise.resolve();
      }),
      close: vi.fn(() => Promise.resolve()),
    })),
  };
  return { mockStdin, written };
}
```

For each test that uses WebSocket:
1. Remove the `ws` mock
2. Instead of `adapter.attachWebSocket(ws)`, call `adapter.attachStdio(mockStdin, mockStdout)`
3. For simulating incoming messages, push data to the stdout stream
4. For checking outgoing messages, check the `written` array from the stdin mock

- [ ] **Step 2: Update cli-launcher.test.ts**

Find the test `"spawns CLI with correct --sdk-url and flags"` and update:
- Remove the assertion that args contain `--sdk-url`
- Add assertion that `Bun.spawn` is called with `stdin: "pipe"`
- Verify the adapter creation event is emitted

- [ ] **Step 3: Update ws-bridge.test.ts**

Remove or update tests that:
- Call `handleCLIOpen()` — these tests should be replaced with tests that call `attachBackendAdapter()` with a ClaudeAdapter
- Call `handleCLIMessage()` — message routing is now handled by the adapter's stdout reader
- Call `handleCLIClose()` — disconnect is now triggered by the adapter's onDisconnect callback
- Test the 15s disconnect debounce — this debounce is removed; disconnect is immediate via process exit

- [ ] **Step 4: Run all tests**

```bash
cd web && bun run typecheck && bun run test
```

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add web/server/claude-adapter.test.ts web/server/cli-launcher.test.ts web/server/ws-bridge.test.ts
git commit -m "test: update tests for stdio transport refactor"
```

---

### Task 6: Integration test and cleanup

**Files:**
- Various cleanup

- [ ] **Step 1: Run typecheck**

```bash
cd web && bun run typecheck
```

Fix any type errors.

- [ ] **Step 2: Run full test suite**

```bash
cd web && bun run test
```

- [ ] **Step 3: Manual smoke test**

Start dev server and verify:
1. A new Claude Code session can be created
2. Messages flow correctly (user → CLI → browser)
3. Permission requests appear and can be approved/denied
4. Session resume works after server restart
5. Streaming text and tool calls render correctly

```bash
cd web && bun run dev
```

- [ ] **Step 4: Remove unused code**

Search for and remove:
- `parseNDJSON` import in claude-adapter.ts if unused (it's only used by handleRawMessage which now receives single lines)
- Any dead references to `CLISocketData`, `handleCLIOpen`, `handleCLIMessage`, `handleCLIClose`
- The `markConnected` method in cli-launcher.ts (it was called from index.ts on CLI WS open — now unused)

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: cleanup dead code from --sdk-url WebSocket transport"
```
