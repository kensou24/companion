// ─── WeChat Relay ────────────────────────────────────────────────────────
// Event bus relay: subscribes to companionBus events and forwards them to
// WeChat users via the send queue. Extracted from WeChatBridge for modular
// architecture. Uses injected deps instead of `this.` on the bridge class.

import { companionBus } from "../event-bus.js";
import { getSettings } from "../settings-manager.js";
import {
  formatToolCall, formatPermissionRequest, formatMarkdown, formatToolSummary,
  formatToolCallFailure, formatAskUserQuestion, formatSystemEvent, formatStatusChange,
  formatAuthStatus, formatToolProgress, formatPermissionAutoResolved, formatSessionPhase,
  formatPromptSuggestions, formatRateLimitEvent, formatToolResultPreview,
} from "../wechat-formatter.js";
import { formatSessionName, formatSingleQuestion } from "./wechat-command-handler.js";
import type { WsBridge } from "../ws-bridge.js";
import type { BrowserIncomingMessage } from "../session-types.js";
import type { WeChatUserSession, SessionRelayData, PendingPermission, PendingAskQuestion } from "./types.js";
import { SessionManager } from "./wechat-session-manager.js";
import { isRateLimitError as isRateLimitErrorFn, SendQueue } from "./wechat-send-queue.js";

// Re-export for backward compatibility
export { isRateLimitErrorFn as isRateLimitError };

// Progress heartbeat: how long before first heartbeat, and interval between heartbeats
const HEARTBEAT_INITIAL_DELAY_MS = 30_000; // 30 seconds of silence before first "still working"
const HEARTBEAT_INTERVAL_MS = 15_000; // every 15 seconds after that

const SAFE_TOOLS = new Set([
  "Read", "Glob", "Grep", "LS", "WebSearch",
  "mcp__context7__resolve-library-id", "mcp__context7__query-docs",
  "TodoRead", "TaskList", "TaskGet",
]);

/** Format token count: show as K if >= 1000 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Check if a tool use is considered dangerous. */
export function isDangerousTool(toolName: string, _input: Record<string, unknown>): boolean {
  if (SAFE_TOOLS.has(toolName)) return false;
  return true;
}

/** Extract text from assistant message content blocks */
function extractTextFromAssistant(msg: BrowserIncomingMessage): string {
  if (msg.type !== "assistant") return "";
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text" && typeof (b as Record<string, unknown>).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Extract tool use blocks from assistant message */
function extractToolUses(msg: BrowserIncomingMessage): Array<{ name: string; input: Record<string, unknown>; id?: string }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; name: string; input?: Record<string, unknown> } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_use"
      && typeof (b as Record<string, unknown>).name === "string")
    .map((toolBlock) => ({
      name: toolBlock.name,
      input: toolBlock.input ?? {},
      id: (toolBlock as Record<string, unknown>).id as string | undefined,
    }));
}

/** Extract tool_result blocks (errors only) from assistant message content. */
export function extractToolResults(msg: BrowserIncomingMessage): Array<{ tool_use_id: string; content: string; is_error: boolean }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; tool_use_id: string; content: string; is_error: boolean } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_result"
      && typeof (b as Record<string, unknown>).tool_use_id === "string"
      && (b as Record<string, unknown>).is_error === true)
    .map((b) => ({
      tool_use_id: b.tool_use_id,
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
      is_error: true,
    }));
}

/** Extract non-error tool_result previews from assistant message content. */
export function extractToolResultPreviews(msg: BrowserIncomingMessage): Array<{ tool_use_id: string; content: string }> {
  if (msg.type !== "assistant") return [];
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is { type: string; tool_use_id: string; content: unknown; is_error?: boolean } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "tool_result"
      && typeof (b as Record<string, unknown>).tool_use_id === "string"
      && (b as Record<string, unknown>).is_error !== true)
    .map((b) => ({
      tool_use_id: b.tool_use_id,
      content: typeof b.content === "string" ? b.content : JSON.stringify(b.content),
    }));
}

/** Extract thinking content blocks from assistant message. */
function extractThinkingFromAssistant(msg: BrowserIncomingMessage): string {
  if (msg.type !== "assistant") return "";
  const raw = msg as Record<string, unknown>;
  const message = raw.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; thinking: string } =>
      typeof b === "object" && b !== null
      && (b as Record<string, unknown>).type === "thinking"
      && typeof (b as Record<string, unknown>).thinking === "string")
    .map((b) => b.thinking)
    .join("\n");
}

export interface RelayDeps {
  wsBridge: WsBridge;
  sessionManager: SessionManager;
  sendQueue: SendQueue;
  sendTyping: (userId: string) => Promise<void>;
}

export class Relay {
  private deps: RelayDeps;
  private sessionCleanups = new Map<string, Array<() => void>>();
  private sessionRelayData = new Map<string, SessionRelayData>();

  constructor(deps: RelayDeps) {
    this.deps = deps;
  }

  /** Check if relay is already active for a session */
  hasRelay(sessionId: string): boolean {
    return this.sessionCleanups.has(sessionId);
  }

  /** Get relay data for a session */
  getRelayData(sessionId: string): SessionRelayData | undefined {
    return this.sessionRelayData.get(sessionId);
  }

  /** Create relay data for a session (used when starting a new turn) */
  initRelayData(sessionId: string): SessionRelayData {
    const data: SessionRelayData = {
      pendingText: "",
      lastTypingTs: 0,
      streamlinedSent: false,
      contentSent: false,
      lastBlockIndex: -1,
      toolAccumulator: [],
      lastUserFacingMessageTs: Date.now(),
      progressSent: false,
      toolNotifyBuffer: [],
      toolNotifyTimer: null,
      phaseReadySeen: false,
      lastToolProgressTs: 0,
      lastGitBranch: "",
      contextWarningSent: false,
      pendingThinking: "",
      heartbeatTimer: null,
      turnStartTime: Date.now(),
      lastActiveToolName: "",
    };
    this.sessionRelayData.set(sessionId, data);
    return data;
  }

  /** Ensure relay subscriptions are active for a session */
  ensureRelay(sessionId: string, userId: string): void {
    if (this.sessionCleanups.has(sessionId)) return;

    const cleanups: Array<() => void> = [];
    this.initRelayData(sessionId);

    const { wsBridge, sessionManager, sendQueue, sendTyping } = this.deps;

    // Helper: send a reply and update the heartbeat tracker
    const relaySend = (text: string) => {
      sendQueue.enqueue(userId, text);
      const rd = this.sessionRelayData.get(sessionId);
      if (rd) rd.lastUserFacingMessageTs = Date.now();
    };

    // Stream events — accumulate text + thinking
    const unsubStream = companionBus.on("message:stream_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      if (!relayData) return;

      const event = (message as Record<string, unknown>).event as Record<string, unknown> | undefined;
      if (!event || event.type !== "content_block_delta") return;

      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return;

      const blockIndex = typeof event.index === "number" ? event.index : -1;

      // Handle thinking deltas
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        const userSession = sessionManager.getUserSession(userId);
        if (userSession?.thinkingMode) {
          relayData.pendingThinking += delta.thinking;
        }
        const now = Date.now();
        if (now - relayData.lastTypingTs > 5000) {
          relayData.lastTypingTs = now;
          sendTyping(userId).catch(() => {});
        }
        return;
      }

      // Handle text deltas
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (relayData.pendingThinking) {
          const thinkingText = relayData.pendingThinking.trim();
          if (thinkingText) {
            relaySend(`🧠 思考过程\n─────────────\n${formatMarkdown(thinkingText.length > 800 ? thinkingText.slice(0, 797) + "..." : thinkingText)}`);
          }
          relayData.pendingThinking = "";
        }
        if (relayData.lastBlockIndex >= 0 && blockIndex >= 0 && blockIndex !== relayData.lastBlockIndex && relayData.pendingText.length > 0) {
          relayData.pendingText += "\n\n";
        }
        if (blockIndex >= 0) {
          relayData.lastBlockIndex = blockIndex;
        }
        relayData.pendingText += delta.text;
        relayData.contentSent = true;
        const now = Date.now();
        if (now - relayData.lastTypingTs > 5000) {
          relayData.lastTypingTs = now;
          sendTyping(userId).catch(() => {});
        }
      }
    });
    cleanups.push(unsubStream);

    // Streamlined text
    const unsubStreamlined = companionBus.on("message:streamlined_text", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const text = typeof raw.text === "string" ? raw.text : "";
      if (text.trim()) {
        relaySend(formatMarkdown(text.trim()));
        const relayData = this.sessionRelayData.get(sessionId);
        if (relayData) {
          relayData.streamlinedSent = true;
          relayData.contentSent = true;
        }
      }
    });
    cleanups.push(unsubStreamlined);

    // Streamlined tool use summary
    const unsubToolSummary = companionBus.on("message:streamlined_tool_use_summary", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const summary = typeof raw.tool_summary === "string" ? raw.tool_summary : "";
      if (summary.trim()) {
        relaySend(`📋 ${summary}`);
      }
    });
    cleanups.push(unsubToolSummary);

    // Assistant messages
    const unsubAssistant = companionBus.on("message:assistant", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;

      const raw = message as Record<string, unknown>;
      const parentToolUseId = raw.parent_tool_use_id as string | undefined;
      const agentPrefix = parentToolUseId ? "[子任务] " : "";

      const relayData = this.sessionRelayData.get(sessionId);
      const userSession = sessionManager.getUserSession(userId);

      // Thinking fallback
      if (relayData && userSession?.thinkingMode && !relayData.pendingThinking.trim()) {
        const thinkingText = extractThinkingFromAssistant(message);
        if (thinkingText.trim()) {
          relayData.pendingThinking = thinkingText.trim();
          relaySend(`🧠 思考过程\n─────────────\n${formatMarkdown(thinkingText.length > 800 ? thinkingText.slice(0, 797) + "..." : thinkingText)}`);
          relayData.pendingThinking = "";
        }
      }

      // Fallback text
      if (relayData && !relayData.pendingText.trim()) {
        const assistantText = extractTextFromAssistant(message);
        if (assistantText.trim()) {
          relayData.pendingText = assistantText.trim();
        }
      }

      // Tool calls
      const tools = extractToolUses(message);
      if (tools.length > 0) {
        const verboseMode = userSession?.verboseMode ?? false;
        for (const t of tools) {
          const parsedInput = t.input;

          if (relayData) {
            relayData.toolAccumulator.push({ name: t.name, input: parsedInput, toolUseId: t.id });
            relayData.lastActiveToolName = t.name;
          }

          const formatted = formatToolCall(t.name, parsedInput);
          if (!formatted) continue;
          const labeled = `${agentPrefix}${formatted}`;
          if (verboseMode) {
            relaySend(labeled);
          } else {
            if (relayData) {
              relayData.toolNotifyBuffer.push(labeled);
              if (!relayData.toolNotifyTimer) {
                relayData.toolNotifyTimer = setTimeout(() => this.flushToolNotifyBuffer(userId, sessionId), 15_000);
              }
            }
          }
        }
      }

      // Tool failures
      const toolResults = extractToolResults(message);
      if (toolResults.length > 0 && relayData) {
        for (const result of toolResults) {
          const match = relayData.toolAccumulator.find(t => t.toolUseId === result.tool_use_id);
          const toolName = match?.name ?? "unknown";
          relaySend(formatToolCallFailure(toolName, result.content));
        }
      }

      // Tool result previews
      if (userSession?.verboseMode && relayData) {
        const previews = extractToolResultPreviews(message);
        for (const preview of previews) {
          if (!preview.content.trim()) continue;
          const match = relayData.toolAccumulator.find(t => t.toolUseId === preview.tool_use_id);
          const toolName = match?.name ?? "unknown";
          if (!SAFE_TOOLS.has(toolName)) {
            const formatted = formatToolResultPreview(toolName, preview.content);
            if (formatted) {
              relaySend(`${agentPrefix}${formatted}`);
            }
          }
        }
      }
    });
    cleanups.push(unsubAssistant);

    // Result
    const unsubResult = companionBus.on("message:result", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      const streamText = relayData?.pendingText ?? "";
      const streamlinedSent = relayData?.streamlinedSent ?? false;
      const hadContent = relayData?.contentSent ?? false;

      if (relayData) {
        if (relayData.pendingThinking) {
          const userSession = sessionManager.getUserSession(userId);
          if (userSession?.thinkingMode) {
            const thinkingText = relayData.pendingThinking.trim();
            if (thinkingText) {
              relaySend(`🧠 思考过程\n─────────────\n${formatMarkdown(thinkingText.length > 800 ? thinkingText.slice(0, 797) + "..." : thinkingText)}`);
            }
          }
        }
        relayData.pendingText = "";
        relayData.streamlinedSent = false;
        relayData.contentSent = false;
        relayData.lastBlockIndex = -1;
        relayData.pendingThinking = "";
      }

      const result = message as Record<string, unknown>;
      const data = result.data as Record<string, unknown> | undefined;

      if (!streamlinedSent) {
        const finalText = (typeof data?.result === "string" && data.result.trim())
          ? data.result.trim()
          : streamText.trim();

        if (finalText) {
          relaySend(formatMarkdown(finalText));
        } else if (!hadContent) {
          if (!data?.is_error) {
            const toolSummary = formatToolSummary(relayData?.toolAccumulator ?? []);
            relaySend(toolSummary || "(操作完成，无文本输出)");
          }
        }
      }

      if (data?.is_error) {
        const errors = data.errors as string[] | undefined;
        if (errors?.length) {
          relaySend(`❌ 错误: ${errors.join(", ")}`);
        }
      }

      const session = wsBridge.getSession(sessionId);
      if (session && !data?.is_error) {
        const cost = session.state.total_cost_usd ?? 0;
        const ctxPct = session.state.context_used_percent ?? 0;
        const turns = session.state.num_turns ?? 0;
        const linesAdded = session.state.total_lines_added ?? 0;
        const linesRemoved = session.state.total_lines_removed ?? 0;
        const statsParts: string[] = [];
        statsParts.push(`$${cost.toFixed(4)}`);
        statsParts.push(`↑${fmtTokens(session.state.input_tokens ?? 0)} ↓${fmtTokens(session.state.output_tokens ?? 0)}`);
        statsParts.push(`第 ${turns} 轮`);
        if (linesAdded > 0 || linesRemoved > 0) {
          statsParts.push(`${linesAdded > 0 ? `+${linesAdded}` : ""}${linesAdded > 0 && linesRemoved > 0 ? "/" : ""}${linesRemoved > 0 ? `-${linesRemoved}` : ""} 行`);
        }
        if (cost > 0 || (session.state.input_tokens ?? 0) > 0 || (session.state.output_tokens ?? 0) > 0) {
          relaySend(`💰 ${statsParts.join(" · ")}`);
        }
        sessionManager.setContextUsage(userId, sessionId, ctxPct);
        if (relayData && ctxPct >= 80 && !relayData.contextWarningSent) {
          relayData.contextWarningSent = true;
          relaySend(`⚠️ 上下文已达 ${ctxPct.toFixed(0)}%\n建议 · /compact 压缩 · /new 新会话`);
        }
        if (relayData && ctxPct < 60) {
          relayData.contextWarningSent = false;
        }
      }

      if (relayData) {
        relayData.toolAccumulator = [];
        relayData.lastUserFacingMessageTs = Date.now();
        relayData.progressSent = false;
        relayData.lastToolProgressTs = 0;
        relayData.lastActiveToolName = "";
        this.stopHeartbeat(sessionId);
      }
    });
    cleanups.push(unsubResult);

    // Permission requests
    const unsubPermReq = companionBus.on("session:permission-request", ({ sessionId: sid, request }) => {
      if (sid !== sessionId) return;
      this.handlePermissionRequest(sessionId, userId, request);
    });
    cleanups.push(unsubPermReq);

    // Permission cancelled
    const unsubPermCancel = companionBus.on("session:permission-cancelled", ({ sessionId: sid, requestId }) => {
      if (sid !== sessionId) return;
      const userSession = sessionManager.getUserSession(userId);
      if (!userSession) return;

      const wasInPerms = userSession.pendingPermissions.delete(requestId);
      const wasInAsk = userSession.pendingAskQuestions.delete(requestId);

      if (wasInPerms || wasInAsk) {
        relaySend("权限请求已取消。");
      }
    });
    cleanups.push(unsubPermCancel);

    // Session exited
    const unsubExited = companionBus.on("session:exited", ({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      this.cleanupRelay(sessionId);
      sessionManager.removeSession(userId, sessionId);
      relaySend(`🔚 会话 ${sessionId.slice(0, 8)}... 已退出`);
    });
    cleanups.push(unsubExited);

    // System events
    const unsubSystemEvent = companionBus.on("message:system_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const event = raw.event as Record<string, unknown> | undefined;
      if (!event) return;
      const formatted = formatSystemEvent(event as { subtype: string; [key: string]: unknown });
      if (formatted) {
        relaySend(formatted);
      }
    });
    cleanups.push(unsubSystemEvent);

    // Status change
    const unsubStatusChange = companionBus.on("message:status_change", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const status = typeof raw.status === "string" ? raw.status : "";
      const formatted = formatStatusChange(status);
      if (formatted) {
        relaySend(formatted);
      }
    });
    cleanups.push(unsubStatusChange);

    // Tool progress
    const unsubToolProgress = companionBus.on("message:tool_progress", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const relayData = this.sessionRelayData.get(sessionId);
      if (!relayData) return;

      const now = Date.now();
      if (now - relayData.lastToolProgressTs < 60_000) return;

      const toolName = typeof raw.tool_name === "string" ? raw.tool_name : "";
      const toolUseId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : "";
      const elapsed = typeof raw.elapsed_time_seconds === "number" ? raw.elapsed_time_seconds : 0;
      const parentToolUseId = raw.parent_tool_use_id as string | null | undefined;

      if (toolName === "Agent" && elapsed >= 15) {
        const agentLabel = parentToolUseId ? "[子任务] " : "";
        relayData.lastToolProgressTs = now;
        const elapsedMins = Math.floor(elapsed / 60);
        const elapsedSecs = Math.round(elapsed % 60);
        const elapsedStr = elapsedMins > 0 ? `${elapsedMins}分${elapsedSecs}秒` : `${elapsedSecs}秒`;
        relaySend(`${agentLabel}🤖 子任务执行中 · 已运行 ${elapsedStr}`);
        return;
      }

      const formatted = formatToolProgress(toolName, toolUseId, elapsed);
      if (formatted) {
        relayData.lastToolProgressTs = now;
        relaySend(formatted);
      }
    });
    cleanups.push(unsubToolProgress);

    // Auth status
    const unsubAuthStatus = companionBus.on("message:auth_status", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const formatted = formatAuthStatus(message as Record<string, unknown>);
      if (formatted) {
        relaySend(formatted);
      }
    });
    cleanups.push(unsubAuthStatus);

    // Permission auto-resolved
    const unsubPermAuto = companionBus.on("session:permission-auto-resolved", ({ sessionId: sid, request, behavior, reason }) => {
      if (sid !== sessionId) return;
      const formatted = formatPermissionAutoResolved(request.tool_name, request.input, behavior, reason);
      if (formatted) {
        const agentLabel = request.agent_id ? "[子任务] " : "";
        relaySend(`${agentLabel}${formatted}`);
      }
    });
    cleanups.push(unsubPermAuto);

    // Session phase
    const unsubPhase = companionBus.on("session:phase-changed", ({ sessionId: sid, from, to }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      const isFirstReady = !relayData?.phaseReadySeen;
      const formatted = formatSessionPhase(from, to, isFirstReady);
      if (formatted) {
        relaySend(formatted);
      }
      if (to === "ready" && relayData) {
        relayData.phaseReadySeen = true;
      }
    });
    cleanups.push(unsubPhase);

    // Prompt suggestion
    const unsubPromptSuggestion = companionBus.on("message:prompt_suggestion", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const raw = message as Record<string, unknown>;
      const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions as string[] : [];
      const formatted = formatPromptSuggestions(suggestions);
      if (formatted) {
        relaySend(formatted);
      }
    });
    cleanups.push(unsubPromptSuggestion);

    // Session auto-naming
    const unsubFirstTurn = companionBus.on("session:first-turn-completed", ({ sessionId: sid, firstUserMessage }) => {
      if (sid !== sessionId) return;
      const name = formatSessionName(firstUserMessage);
      if (name) {
        relaySend(`📝 会话已命名 · ${name}`);
      }
    });
    cleanups.push(unsubFirstTurn);

    // Git branch change
    const unsubGitInfo = companionBus.on("session:git-info-ready", ({ sessionId: sid, branch }) => {
      if (sid !== sessionId) return;
      const relayData = this.sessionRelayData.get(sessionId);
      if (!relayData) return;
      if (relayData.lastGitBranch && relayData.lastGitBranch !== branch) {
        relaySend(`🔀 分支切换: ${relayData.lastGitBranch} → ${branch}`);
      }
      relayData.lastGitBranch = branch;
    });
    cleanups.push(unsubGitInfo);

    // Idle kill
    const unsubIdleKill = companionBus.on("session:idle-kill", ({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      this.cleanupRelay(sessionId);
      sessionManager.removeSession(userId, sessionId);
      relaySend(`⏰ 会话 ${sessionId.slice(0, 8)}... 因长时间无活动已自动关闭\n发送 /new 创建新会话`);
    });
    cleanups.push(unsubIdleKill);

    // Relaunch notification
    const unsubRelaunch = companionBus.on("session:relaunch-needed", ({ sessionId: sid }) => {
      if (sid !== sessionId) return;
      relaySend("🔄 会话正在重新连接...");
    });
    cleanups.push(unsubRelaunch);

    // Rate limit event
    const unsubRateLimit = companionBus.on("message:rate_limit_event", ({ sessionId: sid, message }) => {
      if (sid !== sessionId) return;
      const formatted = formatRateLimitEvent(message as Record<string, unknown>);
      if (formatted) {
        relaySend(formatted);
      }
    });
    cleanups.push(unsubRateLimit);

    this.sessionCleanups.set(sessionId, cleanups);
  }

  /** Clean up relay subscriptions and data for a session */
  cleanupRelay(sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (relayData) {
      this.stopHeartbeat(sessionId);
      if (relayData.toolNotifyBuffer.length > 0) {
        const userId = this.deps.sessionManager.getUserIdBySession(sessionId);
        if (userId) this.flushToolNotifyBuffer(userId, sessionId);
      }
      if (relayData.toolNotifyTimer) {
        clearTimeout(relayData.toolNotifyTimer);
      }
    }
    const cleanups = this.sessionCleanups.get(sessionId);
    if (cleanups) {
      for (const cleanup of cleanups) cleanup();
      this.sessionCleanups.delete(sessionId);
    }
    this.sessionRelayData.delete(sessionId);
  }

  /** Flush pending tool notification buffer */
  flushToolNotifyBuffer(userId: string, sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (!relayData || relayData.toolNotifyBuffer.length === 0) return;
    const merged = relayData.toolNotifyBuffer.join("\n");
    relayData.toolNotifyBuffer = [];
    relayData.toolNotifyTimer = null;
    this.deps.sendQueue.enqueue(userId, merged);
    relayData.lastUserFacingMessageTs = Date.now();
  }

  /** Start the progress heartbeat for a session */
  startHeartbeat(sessionId: string, userId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (!relayData) return;
    if (relayData.heartbeatTimer) {
      clearTimeout(relayData.heartbeatTimer);
    }
    relayData.heartbeatTimer = setTimeout(() => {
      this.fireHeartbeat(sessionId, userId);
    }, HEARTBEAT_INITIAL_DELAY_MS);
  }

  /** Fire a progress heartbeat and schedule the next one */
  private fireHeartbeat(sessionId: string, userId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (!relayData) return;
    relayData.heartbeatTimer = null;
    const now = Date.now();
    if (now - relayData.lastUserFacingMessageTs < HEARTBEAT_INTERVAL_MS) {
      relayData.heartbeatTimer = setTimeout(() => {
        this.fireHeartbeat(sessionId, userId);
      }, HEARTBEAT_INTERVAL_MS);
      return;
    }
    const elapsed = Math.round((now - relayData.turnStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}分${secs}秒` : `${secs}秒`;
    const toolHint = relayData.lastActiveToolName
      ? ` (${relayData.lastActiveToolName})`
      : "";
    this.deps.sendQueue.enqueue(userId, `⏳ 处理中${toolHint} · 已用时 ${timeStr}`);
    relayData.lastUserFacingMessageTs = now;
    relayData.heartbeatTimer = setTimeout(() => {
      this.fireHeartbeat(sessionId, userId);
    }, HEARTBEAT_INTERVAL_MS);
  }

  /** Stop the progress heartbeat for a session */
  stopHeartbeat(sessionId: string): void {
    const relayData = this.sessionRelayData.get(sessionId);
    if (relayData?.heartbeatTimer) {
      clearTimeout(relayData.heartbeatTimer);
      relayData.heartbeatTimer = null;
    }
  }

  /** Clean up all relay subscriptions */
  cleanupAll(): void {
    for (const [sessionId, cleanups] of this.sessionCleanups) {
      this.stopHeartbeat(sessionId);
      for (const cleanup of cleanups) cleanup();
    }
    this.sessionCleanups.clear();
    this.sessionRelayData.clear();
  }

  /**
   * Handle a single permission request from the CLI.
   */
  private async handlePermissionRequest(
    sessionId: string,
    userId: string,
    perm: {
      request_id: string;
      tool_name: string;
      input: Record<string, unknown>;
      description?: string;
      agent_id?: string;
    },
  ): Promise<void> {
    const agentLabel = perm.agent_id ? "[子任务] " : "";
    const context = `permission request ${perm.request_id.slice(0, 8)} (${perm.tool_name}${perm.agent_id ? ", subagent" : ""})`;
    const { wsBridge, sessionManager, sendQueue } = this.deps;
    const settings = getSettings();
    const userSession = sessionManager.getUserSession(userId);
    if (!userSession) {
      console.warn(`[wechat] No userSession for userId=${userId}, sessionId=${sessionId} — ${context} dropped`);
      return;
    }

    console.log(`[wechat] Handling ${context} for session ${sessionId.slice(0, 8)}`);

    // AskUserQuestion: track in both Maps, show first question
    if (perm.tool_name === "AskUserQuestion" || perm.tool_name.endsWith("__AskUserQuestion")) {
      const questions = Array.isArray(perm.input.questions) ? perm.input.questions as Array<Record<string, unknown>> : [];
      userSession.pendingAskQuestions.set(perm.request_id, {
        requestId: perm.request_id,
        sessionId,
        questions,
        currentIndex: 0,
        answers: {},
        agentId: perm.agent_id,
      });
      userSession.pendingPermissions.set(perm.request_id, {
        requestId: perm.request_id,
        sessionId,
        toolName: perm.tool_name,
        agentId: perm.agent_id,
        isAskUserQuestion: true,
        createdAt: Date.now(),
      });
      const sent = await sendQueue.enqueueCritical(userId, `${agentLabel}${formatSingleQuestion(questions, 0)}`, `AskUserQuestion ${perm.request_id.slice(0, 8)}`);
      if (!sent) {
        console.warn(`[wechat] AskUserQuestion undeliverable, auto-approving with defaults: ${perm.request_id.slice(0, 8)}`);
        const defaultAnswers: Record<string, string> = {};
        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          const opts = Array.isArray(q?.options) ? q.options as Array<Record<string, string>> : [];
          defaultAnswers[String(i)] = opts.length > 0 ? opts[0].label : "auto-approved";
        }
        userSession.pendingAskQuestions.delete(perm.request_id);
        userSession.pendingPermissions.delete(perm.request_id);
        wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", {
          questions,
          answers: defaultAnswers,
        });
      }
      return;
    }

    if (settings.wechatAutoApproveSafe && !isDangerousTool(perm.tool_name, perm.input)) {
      wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
      const formatted = formatToolCall(perm.tool_name, perm.input);
      sendQueue.enqueueCritical(userId, formatted ? `✅ 自动批准 · ${agentLabel}${formatted}` : `✅ 自动批准 · ${agentLabel}${perm.tool_name}`, `auto-approve ${perm.tool_name}`).catch(() => {});
    } else if (settings.wechatForwardDangerous) {
      userSession.pendingPermissions.set(perm.request_id, {
        requestId: perm.request_id,
        sessionId,
        toolName: perm.tool_name,
        agentId: perm.agent_id,
        isAskUserQuestion: false,
        createdAt: Date.now(),
      });
      const sent = await sendQueue.enqueueCritical(userId, `${agentLabel}${formatPermissionRequest(perm.tool_name, perm.input, perm.description)}`, `dangerous permission ${perm.tool_name}`);
      if (!sent) {
        console.warn(`[wechat] Dangerous permission undeliverable, auto-approving to prevent stuck session: ${perm.request_id.slice(0, 8)} (${perm.tool_name})`);
        userSession.pendingPermissions.delete(perm.request_id);
        wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
      }
    } else {
      wsBridge.injectPermissionResponse(sessionId, perm.request_id, "allow", perm.input);
    }
  }
}
