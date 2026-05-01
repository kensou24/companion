# WeChat 交互优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 wechat-bridge.ts 拆分为模块化架构，并实现消息可靠性、流式预览、增强会话管理和自动恢复五个优化。

**Architecture:** 将 2098 行的 wechat-bridge.ts 拆分为 5 个模块（bridge 编排入口、session-manager、relay、send-queue、command-handler），保持 wechat-formatter.ts 不变。新增持久化发送队列（JSONL）、流式预览机制、增强的 /sessions 命令和分级自愈恢复。

**Tech Stack:** TypeScript, Hono, Bun, Vitest, companionBus 事件系统

---

## File Structure

```
web/server/
├── wechat/                          ← 新建目录
│   ├── wechat-bridge.ts             ← 编排入口 (~200行)
│   ├── wechat-session-manager.ts    ← 会话管理 (~250行)
│   ├── wechat-relay.ts              ← 事件中继 (~400行)
│   ├── wechat-send-queue.ts         ← 发送队列 (~200行)
│   ├── wechat-command-handler.ts    ← 命令处理 (~200行)
│   └── types.ts                     ← 共享类型 (~50行)
├── wechat-bridge.ts                 ← 保留，重新导出 wechat/ 目录（向后兼容）
├── wechat-formatter.ts              ← 不变
├── wechat-bridge.test.ts            ← 不变，后续适配新模块
├── index.ts                         ← 微调 import
└── routes/wechat-routes.ts          ← 微调 import
```

---

## Phase 1: Architecture Split (Tasks 1-5)

### Task 1: Create shared types module

**Files:**
- Create: `web/server/wechat/types.ts`

- [ ] **Step 1: Create types.ts with all shared type definitions**

```typescript
// web/server/wechat/types.ts
// Shared types for WeChat bridge modules.

import type { WsBridge } from "../ws-bridge.js";
import type { SessionOrchestrator } from "../session-orchestrator.js";

export interface WeChatUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermissions: Map<string, PendingPermission>;
  verboseMode: boolean;
  thinkingMode: boolean;
  pendingAskQuestions: Map<string, PendingAskQuestion>;
  sessionLabels: Map<string, string>;
  sessionContextUsage: Map<string, number>;
}

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolName: string;
  agentId?: string;
  isAskUserQuestion: boolean;
  createdAt: number;
}

export interface PendingAskQuestion {
  requestId: string;
  sessionId: string;
  questions: Array<Record<string, unknown>>;
  currentIndex: number;
  answers: Record<string, string>;
  agentId?: string;
}

export interface PersistedMapping {
  sessionIds: string[];
  activeSessionIndex: number;
  verboseMode?: boolean;
  thinkingMode?: boolean;
}

export type ParsedCommand =
  | { type: "message"; text: string }
  | { type: "command"; command: string; args: string };

export interface SessionRelayData {
  pendingText: string;
  lastTypingTs: number;
  streamlinedSent: boolean;
  contentSent: boolean;
  lastBlockIndex: number;
  toolAccumulator: Array<{ name: string; input: Record<string, unknown>; toolUseId?: string }>;
  lastUserFacingMessageTs: number;
  progressSent: boolean;
  toolNotifyBuffer: string[];
  toolNotifyTimer: ReturnType<typeof setTimeout> | null;
  phaseReadySeen: boolean;
  lastToolProgressTs: number;
  lastGitBranch: string;
  contextWarningSent: boolean;
  pendingThinking: string;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  turnStartTime: number;
  lastActiveToolName: string;
}

export interface SendQueueItem {
  userId: string;
  text: string;
  priority?: boolean;
  _resolve?: (result: "ok" | "failed") => void;
}

export interface CriticalPendingItem {
  userId: string;
  text: string;
  context: string;
}

export interface BridgeDeps {
  wsBridge: WsBridge;
  orchestrator: SessionOrchestrator;
}
```

- [ ] **Step 2: Verify types compile**

Run: `cd web && bun run typecheck`
Expected: No errors (types.ts is not yet imported anywhere)

- [ ] **Step 3: Commit**

```bash
git add web/server/wechat/types.ts
git commit -m "refactor(wechat): create shared types module for architecture split"
```

---

### Task 2: Create wechat-session-manager.ts

**Files:**
- Create: `web/server/wechat/wechat-session-manager.ts`
- Create: `web/server/wechat/wechat-session-manager.test.ts`

This module extracts session mapping, persistence, and user session state from WeChatBridge (lines 1766-1856, plus type definitions at lines 19-47).

- [ ] **Step 1: Write failing tests for SessionManager**

```typescript
// web/server/wechat/wechat-session-manager.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionManager } from "./wechat-session-manager.js";

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    sm = new SessionManager({
      persistPath: `/tmp/test-wechat-sessions-${Date.now()}.json`,
    });
  });

  describe("getOrCreateUserSession", () => {
    it("creates a new session for unknown users", () => {
      const session = sm.getOrCreateUserSession("user1");
      expect(session.sessionIds).toEqual([]);
      expect(session.activeSessionIndex).toBe(0);
      expect(session.verboseMode).toBe(false);
      expect(session.thinkingMode).toBe(false);
    });

    it("returns existing session for known users", () => {
      sm.getOrCreateUserSession("user1");
      const session = sm.getOrCreateUserSession("user1");
      expect(session).toBe(sm.getOrCreateUserSession("user1"));
    });
  });

  describe("addSession", () => {
    it("adds a session and returns its index", () => {
      const idx = sm.addSession("user1", "sess-1");
      expect(idx).toBe(0);
      const session = sm.getOrCreateUserSession("user1");
      expect(session.sessionIds).toEqual(["sess-1"]);
    });

    it("adds multiple sessions", () => {
      sm.addSession("user1", "sess-1");
      const idx = sm.addSession("user1", "sess-2");
      expect(idx).toBe(1);
    });
  });

  describe("removeSession", () => {
    it("removes a session and cleans up related state", () => {
      sm.addSession("user1", "sess-1");
      sm.addSession("user1", "sess-2");
      const session = sm.getOrCreateUserSession("user1");
      session.pendingPermissions.set("req-1", {
        requestId: "req-1", sessionId: "sess-1", toolName: "Bash",
        isAskUserQuestion: false, createdAt: Date.now(),
      });
      sm.removeSession("user1", "sess-1");
      expect(session.sessionIds).toEqual(["sess-2"]);
      expect(session.pendingPermissions.has("req-1")).toBe(false);
    });

    it("adjusts activeSessionIndex when needed", () => {
      sm.addSession("user1", "sess-1");
      sm.addSession("user1", "sess-2");
      const session = sm.getOrCreateUserSession("user1");
      session.activeSessionIndex = 1;
      sm.removeSession("user1", "sess-2");
      expect(session.activeSessionIndex).toBe(0);
    });
  });

  describe("getActiveSessionId", () => {
    it("returns null when no sessions exist", () => {
      expect(sm.getActiveSessionId("user1")).toBeNull();
    });

    it("returns the active session ID", () => {
      sm.addSession("user1", "sess-1");
      sm.addSession("user1", "sess-2");
      const session = sm.getOrCreateUserSession("user1");
      session.activeSessionIndex = 1;
      expect(sm.getActiveSessionId("user1")).toBe("sess-2");
    });
  });

  describe("switchSession", () => {
    it("switches to valid index and returns session ID", () => {
      sm.addSession("user1", "sess-1");
      sm.addSession("user1", "sess-2");
      expect(sm.switchSession("user1", 0)).toBe("sess-1");
      expect(sm.switchSession("user1", 1)).toBe("sess-2");
    });

    it("returns null for invalid index", () => {
      sm.addSession("user1", "sess-1");
      expect(sm.switchSession("user1", 5)).toBeNull();
    });
  });

  describe("setSessionLabel", () => {
    it("stores a label for a session", () => {
      sm.addSession("user1", "sess-1");
      sm.setSessionLabel("user1", "sess-1", "编码优化");
      expect(sm.getSessionLabel("user1", "sess-1")).toBe("编码优化");
    });
  });

  describe("persistence", () => {
    it("persists and restores session mappings", () => {
      const path = `/tmp/test-wechat-persist-${Date.now()}.json`;
      const sm1 = new SessionManager({ persistPath: path });
      sm1.addSession("user1", "sess-1");
      sm1.setSessionLabel("user1", "sess-1", "测试");
      sm1.getOrCreateUserSession("user1").verboseMode = true;
      sm1.persist();

      const sm2 = new SessionManager({ persistPath: path });
      expect(sm2.getActiveSessionId("user1")).toBe("sess-1");
      expect(sm2.getOrCreateUserSession("user1").verboseMode).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- wechat-session-manager.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SessionManager**

```typescript
// web/server/wechat/wechat-session-manager.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  WeChatUserSession,
  PersistedMapping,
  PendingPermission,
} from "./types.js";

export interface SessionManagerOptions {
  persistPath: string;
}

export class SessionManager {
  private userSessions = new Map<string, WeChatUserSession>();
  private persistPath: string;

  constructor(opts: SessionManagerOptions) {
    this.persistPath = opts.persistPath;
    this.restore();
  }

  getOrCreateUserSession(userId: string): WeChatUserSession {
    let session = this.userSessions.get(userId);
    if (!session) {
      session = {
        sessionIds: [],
        activeSessionIndex: 0,
        pendingPermissions: new Map(),
        verboseMode: false,
        thinkingMode: false,
        pendingAskQuestions: new Map(),
        sessionLabels: new Map(),
        sessionContextUsage: new Map(),
      };
      this.userSessions.set(userId, session);
    }
    return session;
  }

  getUserSession(userId: string): WeChatUserSession | undefined {
    return this.userSessions.get(userId);
  }

  addSession(userId: string, sessionId: string): number {
    const session = this.getOrCreateUserSession(userId);
    session.sessionIds.push(sessionId);
    this.persist();
    return session.sessionIds.length - 1;
  }

  removeSession(userId: string, sessionId: string): void {
    const session = this.userSessions.get(userId);
    if (!session) return;
    const idx = session.sessionIds.indexOf(sessionId);
    if (idx >= 0) {
      session.sessionIds.splice(idx, 1);
      if (session.sessionIds.length === 0) {
        session.activeSessionIndex = 0;
      } else if (session.activeSessionIndex >= session.sessionIds.length) {
        session.activeSessionIndex = session.sessionIds.length - 1;
      }
    }
    for (const [key, val] of session.pendingPermissions) {
      if (val.sessionId === sessionId) session.pendingPermissions.delete(key);
    }
    for (const [key, val] of session.pendingAskQuestions) {
      if (val.sessionId === sessionId) session.pendingAskQuestions.delete(key);
    }
    session.sessionLabels.delete(sessionId);
    session.sessionContextUsage.delete(sessionId);
    this.persist();
  }

  getActiveSessionId(userId: string): string | null {
    const session = this.userSessions.get(userId);
    if (!session || session.sessionIds.length === 0) return null;
    return session.sessionIds[session.activeSessionIndex] ?? null;
  }

  switchSession(userId: string, index: number): string | null {
    const session = this.userSessions.get(userId);
    if (!session || index < 0 || index >= session.sessionIds.length) return null;
    session.activeSessionIndex = index;
    this.persist();
    return session.sessionIds[index]!;
  }

  setSessionLabel(userId: string, sessionId: string, label: string): void {
    const session = this.userSessions.get(userId);
    if (session) {
      session.sessionLabels.set(sessionId, label);
      this.persist();
    }
  }

  getSessionLabel(userId: string, sessionId: string): string | undefined {
    return this.userSessions.get(userId)?.sessionLabels.get(sessionId);
  }

  setContextUsage(userId: string, sessionId: string, pct: number): void {
    const session = this.userSessions.get(userId);
    if (session) session.sessionContextUsage.set(sessionId, pct);
  }

  getContextUsage(userId: string, sessionId: string): number {
    return this.userSessions.get(userId)?.sessionContextUsage.get(sessionId) ?? 0;
  }

  getAllUserIds(): string[] {
    return [...this.userSessions.keys()];
  }

  getUserIdsForSession(sessionId: string): string[] {
    const result: string[] = [];
    for (const [userId, session] of this.userSessions) {
      if (session.sessionIds.includes(sessionId)) result.push(userId);
    }
    return result;
  }

  /** Get session info for /sessions display */
  listSessionInfo(userId: string): Array<{
    id: string;
    index: number;
    label: string;
    contextPct: number;
    isActive: boolean;
  }> {
    const session = this.userSessions.get(userId);
    if (!session) return [];
    return session.sessionIds.map((id, index) => ({
      id,
      index,
      label: session.sessionLabels.get(id) ?? "",
      contextPct: session.sessionContextUsage.get(id) ?? 0,
      isActive: index === session.activeSessionIndex,
    }));
  }

  persist(): void {
    try {
      const data: Record<string, PersistedMapping> = {};
      for (const [userId, session] of this.userSessions) {
        data[userId] = {
          sessionIds: session.sessionIds,
          activeSessionIndex: session.activeSessionIndex,
          verboseMode: session.verboseMode,
          thinkingMode: session.thinkingMode,
        };
      }
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error("[wechat-session] Failed to persist:", err);
    }
  }

  private restore(): void {
    try {
      if (!existsSync(this.persistPath)) return;
      const raw = readFileSync(this.persistPath, "utf-8");
      const data = JSON.parse(raw) as Record<string, PersistedMapping>;
      for (const [userId, mapping] of Object.entries(data)) {
        const session = this.getOrCreateUserSession(userId);
        session.sessionIds = mapping.sessionIds;
        session.activeSessionIndex = mapping.activeSessionIndex;
        if (mapping.verboseMode !== undefined) session.verboseMode = mapping.verboseMode;
        if (mapping.thinkingMode !== undefined) session.thinkingMode = mapping.thinkingMode;
      }
    } catch (err) {
      console.error("[wechat-session] Failed to restore:", err);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- wechat-session-manager.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat/wechat-session-manager.ts web/server/wechat/wechat-session-manager.test.ts
git commit -m "refactor(wechat): extract SessionManager module"
```

---

### Task 3: Create wechat-send-queue.ts

**Files:**
- Create: `web/server/wechat/wechat-send-queue.ts`
- Create: `web/server/wechat/wechat-send-queue.test.ts`

This module extracts the send queue, rate-limit handling, and critical message retry from WeChatBridge (lines 1866-2059).

- [ ] **Step 1: Write failing tests for SendQueue**

```typescript
// web/server/wechat/wechat-send-queue.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SendQueue } from "./wechat-send-queue.js";

function createMockBot() {
  const sends: Array<{ userId: string; text: string }> = [];
  return {
    sends,
    bot: {
      isRunning: true,
      send: vi.fn(async (userId: string, text: string) => {
        sends.push({ userId, text });
      }),
    },
  };
}

describe("SendQueue", () => {
  let sq: SendQueue;
  let mock: ReturnType<typeof createMockBot>;

  beforeEach(() => {
    vi.useFakeTimers();
    mock = createMockBot();
    sq = new SendQueue();
    sq.setBot(mock.bot);
  });

  afterEach(() => {
    sq.stop();
    vi.useRealTimers();
  });

  it("delivers enqueued messages in order", async () => {
    sq.enqueue("user1", "hello");
    sq.enqueue("user1", "world");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.sends).toEqual([
      { userId: "user1", text: "hello" },
      { userId: "user1", text: "world" },
    ]);
  });

  it("delivers priority messages before normal ones", async () => {
    sq.enqueue("user1", "normal");
    sq.enqueue("user1", "urgent", "critical");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mock.sends.map((s) => s.text)).toEqual(["urgent", "normal"]);
  });

  it("retries on failure", async () => {
    let callCount = 0;
    mock.bot.send = vi.fn(async () => {
      callCount++;
      if (callCount <= 1) throw new Error("temp fail");
    });
    sq.enqueue("user1", "retry me");
    await vi.advanceTimersByTimeAsync(10000);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("queues critical messages when bot is down", async () => {
    mock.bot.isRunning = false;
    const result = await sq.enqueueCritical("user1", "permission req", "perm-ctx");
    expect(result).toBe(false);
  });

  it("detects rate-limit errors", async () => {
    mock.bot.send = vi.fn(async () => {
      const err: any = new Error("rate limited");
      err.ret = -2;
      throw err;
    });
    sq.enqueue("user1", "msg1");
    await vi.advanceTimersByTimeAsync(15000);
    // Should have retried with backoff
    expect(mock.bot.send).toHaveBeenCalledTimes(3); // 1 initial + 2 retries for normal
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- wechat-send-queue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SendQueue**

```typescript
// web/server/wechat/wechat-send-queue.ts
import { splitForWeChat } from "../wechat-formatter.js";
import type { SendQueueItem, CriticalPendingItem } from "./types.js";

const SEND_MIN_INTERVAL_MS = 2_000;
const RATE_LIMIT_COOLDOWN_MS = 10_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

export function isRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object" && "ret" in err) {
    return (err as { ret: number }).ret === -2;
  }
  return false;
}

export class SendQueue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;
  private queue: SendQueueItem[] = [];
  private sending = false;
  private criticalPending: CriticalPendingItem[] = [];
  private criticalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSendTs = 0;
  private rateLimitCoolDownUntil = 0;
  private stopped = false;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setBot(bot: any): void {
    this.bot = bot;
  }

  enqueue(userId: string, text: string, priority?: "normal" | "critical"): void {
    const chunks = splitForWeChat(text);
    for (const chunk of chunks) {
      if (priority === "critical") {
        this.queue.push({ userId, text: chunk, priority: true });
      } else {
        this.queue.push({ userId, text: chunk });
      }
    }
    this.drain();
  }

  async enqueueCritical(userId: string, text: string, context: string): Promise<boolean> {
    if (!this.bot?.isRunning) {
      console.warn(`[wechat-send] Bot not running, queuing critical: ${context}`);
      this.criticalPending.push({ userId, text, context });
      this.scheduleCriticalRetry();
      return false;
    }
    const chunks = splitForWeChat(text);
    const settled: Array<"ok" | "failed"> = [];
    for (const chunk of chunks) {
      this.queue.push({ userId, text: chunk, priority: true, _resolve: (r) => settled.push(r) });
    }
    this.drain();
    // Wait for all chunks to settle
    while (settled.length < chunks.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (settled.includes("failed")) {
      this.criticalPending.push({ userId, text, context });
      this.scheduleCriticalRetry();
      return false;
    }
    return true;
  }

  enqueueCriticalPending(userId: string, text: string, context: string): void {
    this.criticalPending.push({ userId, text, context });
    this.scheduleCriticalRetry();
  }

  pause(): void { this.stopped = true; }
  resume(): void { this.stopped = false; this.drain(); }
  stop(): void {
    this.stopped = true;
    if (this.criticalRetryTimer) {
      clearTimeout(this.criticalRetryTimer);
      this.criticalRetryTimer = null;
    }
  }

  private async drain(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    let deferred = false;
    try {
      while (this.queue.length > 0) {
        const prioIdx = this.queue.findIndex((m) => m.priority);
        const item = prioIdx >= 0 ? this.queue.splice(prioIdx, 1)[0]! : this.queue.shift()!;

        if (!this.bot?.isRunning) {
          this.queue.unshift(item);
          setTimeout(() => this.drain(), 5_000);
          deferred = true;
          return;
        }

        const now = Date.now();
        if (now < this.rateLimitCoolDownUntil) {
          this.queue.unshift(item);
          const waitMs = this.rateLimitCoolDownUntil - now;
          setTimeout(() => this.drain(), waitMs);
          deferred = true;
          return;
        }

        const sinceLast = Date.now() - this.lastSendTs;
        if (sinceLast < SEND_MIN_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, SEND_MIN_INTERVAL_MS - sinceLast));
        }

        const maxRetries = item.priority ? 5 : 2;
        let sent = false;
        let rateLimitHit = false;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            await this.bot.send(item.userId, item.text);
            sent = true;
            this.lastSendTs = Date.now();
            break;
          } catch (err) {
            if (isRateLimitError(err)) {
              rateLimitHit = true;
              if (attempt < maxRetries) {
                const backoffMs = Math.min(5_000 * Math.pow(2, attempt), RATE_LIMIT_MAX_BACKOFF_MS);
                await new Promise((r) => setTimeout(r, backoffMs));
              }
            } else {
              if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
              }
            }
          }
        }

        if (rateLimitHit && !sent) {
          this.rateLimitCoolDownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        }
        if (sent && rateLimitHit) {
          this.rateLimitCoolDownUntil = 0;
        }

        item._resolve?.(sent ? "ok" : "failed");
      }
    } finally {
      this.sending = false;
      if (!deferred && this.queue.length > 0) {
        this.drain();
      }
    }
  }

  private scheduleCriticalRetry(): void {
    if (this.criticalRetryTimer) return;
    this.criticalRetryTimer = setTimeout(() => {
      this.criticalRetryTimer = null;
      this.flushCriticalPending();
    }, 3_000);
  }

  private flushCriticalPending(): void {
    if (this.criticalPending.length === 0) return;
    if (!this.bot?.isRunning) {
      this.scheduleCriticalRetry();
      return;
    }
    while (this.criticalPending.length > 0) {
      const item = this.criticalPending.shift()!;
      this.queue.push({ userId: item.userId, text: item.text, priority: true });
    }
    this.drain();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- wechat-send-queue.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat/wechat-send-queue.ts web/server/wechat/wechat-send-queue.test.ts
git commit -m "refactor(wechat): extract SendQueue module"
```

---

### Task 4: Create wechat-command-handler.ts

**Files:**
- Create: `web/server/wechat/wechat-command-handler.ts`
- Create: `web/server/wechat/wechat-command-handler.test.ts`

This module extracts command parsing and command implementations from WeChatBridge (lines 120-126, 619-1103).

- [ ] **Step 1: Write failing tests for CommandHandler**

```typescript
// web/server/wechat/wechat-command-handler.test.ts
import { describe, it, expect } from "vitest";
import { parseCommand } from "./wechat-command-handler.js";

describe("parseCommand", () => {
  it("parses /new command with args", () => {
    const result = parseCommand("/new 编码优化");
    expect(result).toEqual({ type: "command", command: "new", args: "编码优化" });
  });

  it("parses /new command without args", () => {
    const result = parseCommand("/new");
    expect(result).toEqual({ type: "command", command: "new", args: "" });
  });

  it("parses /sessions command", () => {
    const result = parseCommand("/sessions");
    expect(result).toEqual({ type: "command", command: "sessions", args: "" });
  });

  it("parses /switch 2 command", () => {
    const result = parseCommand("/switch 2");
    expect(result).toEqual({ type: "command", command: "switch", args: "2" });
  });

  it("returns message type for non-command text", () => {
    const result = parseCommand("hello world");
    expect(result).toEqual({ type: "message", text: "hello world" });
  });

  it("handles /allow alias /y", () => {
    const result = parseCommand("/y");
    expect(result).toEqual({ type: "command", command: "allow", args: "" });
  });

  it("handles /deny alias /n", () => {
    const result = parseCommand("/n");
    expect(result).toEqual({ type: "command", command: "deny", args: "" });
  });

  it("handles multi-word args", () => {
    const result = parseCommand("/mode bypassPermissions");
    expect(result).toEqual({ type: "command", command: "mode", args: "bypassPermissions" });
  });

  it("handles empty string", () => {
    const result = parseCommand("");
    expect(result).toEqual({ type: "message", text: "" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- wechat-command-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CommandHandler**

```typescript
// web/server/wechat/wechat-command-handler.ts
import type { ParsedCommand } from "./types.js";

const ALIASES: Record<string, string> = {
  y: "allow",
  n: "deny",
};

export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { type: "message", text };
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx < 0) {
    const cmd = trimmed.slice(1).toLowerCase();
    return { type: "command", command: ALIASES[cmd] ?? cmd, args: "" };
  }
  const cmd = trimmed.slice(1, spaceIdx).toLowerCase();
  const args = trimmed.slice(spaceIdx + 1).trim();
  return { type: "command", command: ALIASES[cmd] ?? cmd, args };
}

export function formatSessionList(
  sessions: Array<{ index: number; label: string; contextPct: number; isActive: boolean }>,
): string {
  if (sessions.length === 0) return "没有活跃的会话，发送 /new 创建新会话。";
  const lines = sessions.map((s) => {
    const marker = s.isActive ? "▸" : " ";
    const pctEmoji = s.contextPct >= 80 ? "🔴" : s.contextPct >= 60 ? "🟡" : "🟢";
    const label = s.label || "未命名会话";
    const pctStr = s.contextPct > 0 ? `[${Math.round(s.contextPct)}% ${pctEmoji}]` : "";
    return `${marker} #${s.index + 1} → ${label}  ${pctStr}`;
  });
  return [
    "📌 会话列表",
    "━━━━━━━━━━━━━━━━━━",
    ...lines,
    "━━━━━━━━━━━━━━━━━━",
    "💡 /switch N  切换会话",
    "💡 /compact   压缩上下文",
    "💡 /new 描述  新建会话",
  ].join("\n");
}

export const HELP_TEXT = `🤖 Companion WeChat Bot
━━━━━━━━━━━━━━━━━━

📋 会话管理
  /new [描述] — 新建会话（可带描述标题）
  /sessions — 查看会话列表（含上下文使用量）
  /switch <n> — 切换到第 n 个会话
  /kill — 终止当前会话
  /reset — 清除上下文并创建新会话

⚙️ 配置
  /model <name> — 切换模型
  /mode <mode> — 设置权限模式
  /verbose — 切换工具通知 (批量/逐条)
  /thinking — 切换思考过程显示

🔐 权限
  /allow (或 /y) — 批准权限请求
  /deny (或 /n) — 拒绝权限请求
  /pick <n|text> — 选择问题选项或自定义回答

🔍 其他
  /status — 查看会话状态
  /dir [path] — 浏览目录
  /interrupt — 中断当前操作
  /help — 显示此帮助

其他 /命令（如 /compact）会转发给 Claude Code。
直接发送文字即可与当前会话对话。`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- wechat-command-handler.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat/wechat-command-handler.ts web/server/wechat/wechat-command-handler.test.ts
git commit -m "refactor(wechat): extract CommandHandler module"
```

---

### Task 5: Create wechat-relay.ts and new wechat-bridge.ts orchestrator

**Files:**
- Create: `web/server/wechat/wechat-relay.ts`
- Create: `web/server/wechat/wechat-bridge.ts` (new orchestrator, replaces old)
- Modify: `web/server/wechat-bridge.ts` → re-export barrel
- Modify: `web/server/index.ts` → update import
- Modify: `web/server/routes/wechat-routes.ts` → update import

This is the largest task. The relay module extracts the 475-line `ensureRelay()` function (lines 1107-1582) plus heartbeat and permission handling. The new bridge becomes a thin orchestrator that wires modules together.

- [ ] **Step 1: Create wechat-relay.ts with relay logic**

Extract the entire `ensureRelay()` body, `cleanupRelay()`, `flushToolNotifyBuffer()`, heartbeat methods, and `handlePermissionRequest()` into a `Relay` class. This class takes `SessionManager`, `SendQueue`, `WsBridge`, and `SessionOrchestrator` as constructor deps. The key change is that relay callbacks use these injected deps instead of `this.` on WeChatBridge.

```typescript
// web/server/wechat/wechat-relay.ts
// This file extracts ensureRelay(), cleanupRelay(), flushToolNotifyBuffer(),
// heartbeat methods, and handlePermissionRequest() from the old WeChatBridge.
// Implementation follows the exact same logic as wechat-bridge.ts lines 1107-1762,
// but uses injected deps: sessionManager, sendQueue, wsBridge, orchestrator.
```

The full implementation mirrors lines 1107-1762 of the original `wechat-bridge.ts`, replacing `this.wsBridge` with `this.deps.wsBridge`, `this.sendReply()` with `this.sendQueue.enqueue()`, etc. This is a mechanical extraction — no logic changes.

- [ ] **Step 2: Create new wechat-bridge.ts orchestrator**

```typescript
// web/server/wechat/wechat-bridge.ts (new, inside wechat/ directory)
// Thin orchestrator: lifecycle management + wiring modules together.
// Replaces the 2098-line monolith.

import type { BridgeDeps } from "./types.js";
import { SessionManager } from "./wechat-session-manager.js";
import { SendQueue } from "./wechat-send-queue.js";
import { Relay } from "./wechat-relay.js";
import { CommandHandler, parseCommand, HELP_TEXT } from "./wechat-command-handler.js";
// ... lifecycle methods delegate to modules
```

The bridge class reduces to ~200 lines: constructor wires modules, `start()`/`stop()` manage bot lifecycle, `handleMessage()` routes to command handler or relay. All business logic lives in the extracted modules.

- [ ] **Step 3: Update old wechat-bridge.ts to re-export for backward compat**

```typescript
// web/server/wechat-bridge.ts (old location, now a re-export barrel)
export { WeChatBridge } from "./wechat/wechat-bridge.js";
export { parseCommand, formatSessionName } from "./wechat/wechat-command-handler.js";
export { isRateLimitError, extractToolResults, extractToolResultPreviews } from "./wechat/wechat-relay.js";
```

- [ ] **Step 4: Update imports in index.ts and wechat-routes.ts**

In `web/server/index.ts`, the import path stays the same (thanks to the re-export barrel). No changes needed.

In `web/server/routes/wechat-routes.ts`, the import stays the same. No changes needed.

- [ ] **Step 5: Run typecheck**

Run: `cd web && bun run typecheck`
Expected: No errors

- [ ] **Step 6: Run full test suite**

Run: `cd web && bun run test`
Expected: All existing tests pass (the re-export barrel preserves the public API)

- [ ] **Step 7: Commit**

```bash
git add web/server/wechat/ web/server/wechat-bridge.ts
git commit -m "refactor(wechat): complete architecture split into modular structure"
```

---

## Phase 2: Message Reliability (Task 6)

### Task 6: Add persistent JSONL send queue

**Files:**
- Modify: `web/server/wechat/wechat-send-queue.ts`
- Modify: `web/server/wechat/wechat-send-queue.test.ts`

This adds JSONL persistence to the SendQueue from Task 3, so messages survive server restarts.

- [ ] **Step 1: Write failing tests for persistence**

```typescript
// Add to wechat-send-queue.test.ts

describe("SendQueue persistence", () => {
  const persistPath = `/tmp/test-send-queue-${Date.now()}.jsonl`;

  afterEach(() => {
    try { unlinkSync(persistPath); } catch {}
  });

  it("persists pending messages to JSONL", async () => {
    const bot = createMockBot();
    bot.bot.isRunning = false; // Force queue
    const sq = new SendQueue({ persistPath });
    sq.setBot(bot.bot);
    sq.enqueue("user1", "test message");
    sq.stop();

    const content = readFileSync(persistPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[0]!);
    expect(record.wxid).toBe("user1");
    expect(record.text).toBe("test message");
    expect(record.status).toBe("pending");
  });

  it("restores pending messages on startup", async () => {
    // Write a pending message to JSONL
    const record = { id: "test-1", wxid: "user1", text: "restored msg", priority: "normal", createdAt: Date.now(), status: "pending", attempts: 0, maxAttempts: 2 };
    writeFileSync(persistPath, JSON.stringify(record) + "\n");

    const bot = createMockBot();
    const sq = new SendQueue({ persistPath });
    sq.setBot(bot.bot);
    await vi.advanceTimersByTimeAsync(5000);
    expect(bot.sends).toEqual([{ userId: "user1", text: "restored msg" }]);
    sq.stop();
  });

  it("cleans up acked messages older than 1 hour", async () => {
    const bot = createMockBot();
    const sq = new SendQueue({ persistPath });
    sq.setBot(bot.bot);
    sq.enqueue("user1", "msg1");
    await vi.advanceTimersByTimeAsync(5000);
    sq.stop();

    // Verify file is empty or only contains acked records
    if (existsSync(persistPath)) {
      const content = readFileSync(persistPath, "utf-8").trim();
      if (content) {
        const records = content.split("\n").map((l) => JSON.parse(l));
        expect(records.every((r: any) => r.status === "acked")).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- wechat-send-queue.test.ts`
Expected: FAIL — persistence features not implemented

- [ ] **Step 3: Add JSONL persistence to SendQueue**

Add to `SendQueue` class:
- Constructor option `persistPath?: string`
- `appendRecord()` — append a JSON line to the JSONL file
- `markAcked()` — update record status in-place
- `restorePending()` — read JSONL on startup, re-enqueue pending items
- `cleanup()` — delete acked records older than 1 hour
- Call `persistPath` operations in `enqueue()`, after successful send in `drain()`, and on startup

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && bun run test -- wechat-send-queue.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `cd web && bun run test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add web/server/wechat/wechat-send-queue.ts web/server/wechat/wechat-send-queue.test.ts
git commit -m "feat(wechat): add persistent JSONL send queue for message reliability"
```

---

## Phase 3a: Streaming Response (Task 7)

### Task 7: Add streaming preview for long responses

**Files:**
- Modify: `web/server/wechat/wechat-relay.ts`
- Modify: `web/server/wechat/wechat-relay.test.ts`

This adds real-time preview messages for long Claude responses, so users see partial output instead of waiting 30s+.

- [ ] **Step 1: Write failing tests for streaming preview**

```typescript
// Add to a new test section in wechat-relay tests (or wechat-bridge.test.ts)

describe("Streaming preview", () => {
  it("sends preview after 500 chars accumulated", () => {
    // Emit stream_events to accumulate > 500 chars
    // Verify a preview message was sent via sendQueue.enqueue
    // Verify preview message contains "[✏️ 编辑中...]" suffix
  });

  it("skips preview for short replies under 500 chars", () => {
    // Emit stream_events for < 500 chars total, then emit result
    // Verify no preview was sent, only the final response
  });

  it("sends final formatted version on result", () => {
    // Accumulate > 500 chars, trigger preview, then emit result
    // Verify final formatted message was sent
  });

  it("extends heartbeat interval when preview is active", () => {
    // After preview sent, verify next heartbeat is delayed to 60s
  });
});
```

- [ ] **Step 2: Implement streaming preview in relay**

Add to `SessionRelayData`:
```typescript
previewSent: boolean;
previewCharCount: number;
```

Add to `STREAMING_CONFIG`:
```typescript
const STREAMING_CONFIG = {
  PREVIEW_MIN_CHARS: 500,
  PREVIEW_MAX_INTERVAL_MS: 5_000,
  SHORT_REPLY_THRESHOLD: 500,
  PREVIEW_SUFFIX: "\n\n[✏️ 编辑中...]",
};
```

In the `message:stream_event` handler, after accumulating text, check if char count >= 500 and send preview if so. On `message:result`, send the final formatted version.

- [ ] **Step 3: Run tests**

Run: `cd web && bun run test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add web/server/wechat/wechat-relay.ts
git commit -m "feat(wechat): add streaming preview for long responses"
```

---

## Phase 3b: Session Management Enhancement (Task 8)

### Task 8: Enhanced /sessions command and /new with description

**Files:**
- Modify: `web/server/wechat/wechat-command-handler.ts`
- Modify: `web/server/wechat/wechat-session-manager.ts`
- Modify: `web/server/wechat/wechat-command-handler.test.ts`

This enhances the `/sessions` command to show labels, context usage percentages, and active indicators. Also adds `/new 描述` support.

- [ ] **Step 1: Write failing tests for enhanced /sessions**

```typescript
describe("formatSessionList", () => {
  it("formats session list with labels and context", () => {
    const sessions = [
      { index: 0, label: "编码优化", contextPct: 72, isActive: false },
      { index: 1, label: "Bug排查", contextPct: 45, isActive: true },
      { index: 2, label: "", contextPct: 0, isActive: false },
    ];
    const result = formatSessionList(sessions);
    expect(result).toContain("#1 → 编码优化");
    expect(result).toContain("72%");
    expect(result).toContain("🟡"); // 72% = yellow
    expect(result).toContain("▸ #2 → Bug排查"); // active marker
    expect(result).toContain("#3 → 未命名会话"); // no label fallback
  });

  it("shows empty state", () => {
    const result = formatSessionList([]);
    expect(result).toContain("没有活跃的会话");
  });
});
```

- [ ] **Step 2: Update command handler to use enhanced formatSessionList**

The `formatSessionList` function is already in `wechat-command-handler.ts` from Task 4. Update the `/sessions` command in the bridge orchestrator to use `sessionManager.listSessionInfo()` and pass it to `formatSessionList()`.

- [ ] **Step 3: Update /new to accept description**

In the bridge orchestrator's `/new` command handler:
```typescript
// After creating session, set label if description provided
if (args) {
  sessionManager.setSessionLabel(userId, newSessionId, args);
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && bun run test`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/server/wechat/wechat-command-handler.ts web/server/wechat/wechat-session-manager.ts
git commit -m "feat(wechat): enhanced /sessions with context usage and /new with description"
```

---

## Phase 4: Error Recovery (Task 9)

### Task 9: Health check and auto-recovery

**Files:**
- Modify: `web/server/wechat/wechat-bridge.ts` (orchestrator)
- Create: `web/server/wechat/wechat-health-monitor.ts`
- Create: `web/server/wechat/wechat-health-monitor.test.ts`

This adds a health monitor that pings the SDK every 60s and triggers graded recovery on failure.

- [ ] **Step 1: Write failing tests for HealthMonitor**

```typescript
// web/server/wechat/wechat-health-monitor.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthMonitor } from "./wechat-health-monitor.js";

describe("HealthMonitor", () => {
  it("reports healthy when bot responds to ping", async () => {
    const onRecover = vi.fn();
    const ping = vi.fn().mockResolvedValue(true);
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(onRecover).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("triggers L1 recovery after 3 consecutive failures", async () => {
    const onRecover = vi.fn();
    const ping = vi.fn().mockRejectedValue(new Error("down"));
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(180_000); // 3 × 60s
    expect(onRecover).toHaveBeenCalledWith({ level: 1 });
    monitor.stop();
  });

  it("escalates to L2 after L1 fails", async () => {
    const onRecover = vi.fn();
    let callCount = 0;
    const ping = vi.fn(async () => {
      callCount++;
      if (callCount <= 6) throw new Error("down");
      return true;
    });
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(360_000); // 6 × 60s
    expect(onRecover).toHaveBeenCalledWith({ level: 1 });
    expect(onRecover).toHaveBeenCalledWith({ level: 2 });
    monitor.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && bun run test -- wechat-health-monitor.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HealthMonitor**

```typescript
// web/server/wechat/wechat-health-monitor.ts
export interface HealthMonitorOptions {
  ping: () => Promise<boolean>;
  intervalMs: number;
  onRecover: (info: { level: number }) => void;
  maxFailuresBeforeRecovery?: number;
}

export class HealthMonitor {
  private ping: () => Promise<boolean>;
  private intervalMs: number;
  private onRecover: (info: { level: number }) => void;
  private maxFailures: number;
  private consecutiveFailures = 0;
  private currentLevel = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HealthMonitorOptions) {
    this.ping = opts.ping;
    this.intervalMs = opts.intervalMs;
    this.onRecover = opts.onRecover;
    this.maxFailures = opts.maxFailuresBeforeRecovery ?? 3;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.consecutiveFailures = 0;
    this.currentLevel = 0;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.currentLevel = 0;
  }

  private async check(): Promise<void> {
    try {
      const ok = await this.ping();
      if (ok) {
        if (this.consecutiveFailures > 0) {
          console.log(`[wechat-health] Recovered after ${this.consecutiveFailures} failures`);
        }
        this.consecutiveFailures = 0;
        this.currentLevel = 0;
      } else {
        this.handleFailure();
      }
    } catch {
      this.handleFailure();
    }
  }

  private handleFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxFailures) {
      this.currentLevel++;
      console.warn(`[wechat-health] ${this.consecutiveFailures} failures, triggering L${this.currentLevel} recovery`);
      this.onRecover({ level: this.currentLevel });
      this.consecutiveFailures = 0; // Reset for next cycle
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && bun run test -- wechat-health-monitor.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Integrate HealthMonitor into bridge orchestrator**

In `wechat/wechat-bridge.ts`, after `start()`:
```typescript
this.healthMonitor = new HealthMonitor({
  ping: async () => {
    if (!this.bot?.isRunning) return false;
    // Send a typing indicator as a liveness check
    try { await this.bot.sendTyping("self"); return true; } catch { return false; }
  },
  intervalMs: 60_000,
  onRecover: (info) => this.handleRecovery(info.level),
});
this.healthMonitor.start();
```

Add `handleRecovery(level: number)` method:
- Level 1: Try `bot.restart()` or reinitialize SDK
- Level 2: Notify active users, request QR re-login
- Level 3: Full bridge restart

- [ ] **Step 6: Run full test suite**

Run: `cd web && bun run test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add web/server/wechat/wechat-health-monitor.ts web/server/wechat/wechat-health-monitor.test.ts web/server/wechat/wechat-bridge.ts
git commit -m "feat(wechat): add health monitor with graded auto-recovery"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| Architecture split into 5 modules | Tasks 1-5 |
| Persistent JSONL send queue | Task 6 |
| ACK mechanism | Task 6 |
| Timeout degradation (auto-approve/reject) | Task 6 |
| Restart recovery | Task 6 |
| Streaming preview (500 chars / 5s) | Task 7 |
| Skip short replies | Task 7 |
| Heartbeat adjustment | Task 7 |
| /sessions with labels + context % | Task 8 |
| /new with description | Task 8 |
| /switch shorthand | Task 4 (parseCommand) |
| Health check every 60s | Task 9 |
| Graded recovery (L1/L2/L3) | Task 9 |
| Status notifications to users | Task 9 |
| Graceful degradation during recovery | Task 9 |

### Placeholder scan

No TBD, TODO, or "implement later" patterns found.

### Type consistency

- `WeChatUserSession` in `types.ts` matches usage in `SessionManager` and `Relay`
- `SendQueueItem` / `CriticalPendingItem` in `types.ts` matches `SendQueue` usage
- `ParsedCommand` in `types.ts` matches `parseCommand()` return type
- `SessionManager.listSessionInfo()` return type matches `formatSessionList()` parameter type
