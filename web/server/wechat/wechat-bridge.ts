// ─── WeChat Bridge Orchestrator ───────────────────────────────────────────
// Thin orchestrator: lifecycle management + wiring modules together.
// This replaces the 2098-line monolith. All business logic lives in the
// extracted modules (session-manager, send-queue, relay, command-handler).

import type { WsBridge } from "../ws-bridge.js";
import type { SessionOrchestrator, CreateSessionResult } from "../session-orchestrator.js";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { COMPANION_HOME } from "../paths.js";
import QRCode from "qrcode";
import { getSettings } from "../settings-manager.js";
import type { WeChatUserSession } from "./types.js";
import { SessionManager } from "./wechat-session-manager.js";
import { SendQueue } from "./wechat-send-queue.js";
import { Relay } from "./wechat-relay.js";
import { parseCommand, formatSessionName, formatSingleQuestion, HELP_TEXT } from "./wechat-command-handler.js";
// Re-export types and helpers for backward compatibility
export { parseCommand, formatSessionName, formatSingleQuestion } from "./wechat-command-handler.js";
export { isRateLimitError } from "./wechat-send-queue.js";
export { extractToolResults, extractToolResultPreviews, isDangerousTool } from "./wechat-relay.js";

const PERSIST_PATH = join(COMPANION_HOME, "wechat-sessions.json");

const MIN_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

// Message dedup: TTL for seen message hashes
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class WeChatBridge {
  private wsBridge: WsBridge;
  private orchestrator: SessionOrchestrator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;
  private running = false;
  private starting = false;
  private startError: string | null = null;
  private qrCodeData: string | null = null;
  // Auto-reconnect state
  private reconnectDelay = MIN_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;
  private reconnectAttempt = 0;
  // Message dedup + old message filtering
  private seenHashes = new Map<string, number>();
  private startedAt = Date.now();
  // Modules
  private sessionManager: SessionManager;
  private sendQueue: SendQueue;
  private relay: Relay;

  constructor(wsBridge: WsBridge, orchestrator: SessionOrchestrator) {
    this.wsBridge = wsBridge;
    this.orchestrator = orchestrator;
    this.sessionManager = new SessionManager({ persistPath: PERSIST_PATH });
    this.sendQueue = new SendQueue();
    this.relay = new Relay({
      wsBridge,
      sessionManager: this.sessionManager,
      sendQueue: this.sendQueue,
      sendTyping: this.sendTyping.bind(this),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    this.intentionalStop = false;
    this.reconnectAttempt = 0;
    this.starting = true;
    this.startError = null;

    this.doStart().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[wechat] Failed to start:", message);
      this.starting = false;
      this.startError = message;
    });
  }

  private async doStart(): Promise<void> {
    const { WeChatBot } = await import("@wechatbot/wechatbot");
    this.bot = new WeChatBot({
      storage: "file",
      storageDir: join(COMPANION_HOME, "wechat-bot"),
    });

    await this.bot.login({
      callbacks: {
        onQrUrl: async (url: string) => {
          try {
            this.qrCodeData = await QRCode.toDataURL(url, { width: 256, margin: 2 });
          } catch {
            this.qrCodeData = url;
          }
          console.log("[wechat] QR code ready for login scan");
        },
        onScanned: () => {
          console.log("[wechat] QR code scanned, waiting for confirmation...");
        },
      },
    });

    this.bot.onMessage(async (msg: { userId: string; text: string; type: string }) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        console.error("[wechat] Error handling message:", err);
      }
    });

    this.bot.start().catch((err: unknown) => {
      console.error("[wechat] Poll loop crashed:", err);
      this.running = false;
      this.starting = false;
      if (!this.intentionalStop) {
        this.scheduleReconnect();
      }
    });

    this.running = true;
    this.starting = false;
    this.reconnectDelay = MIN_RECONNECT_DELAY_MS;
    this.reconnectAttempt = 0;
    this.startedAt = Date.now();
    this.qrCodeData = null;
    this.sendQueue.setBot(this.bot);
    console.log("[wechat] Bot started and connected");
  }

  stop(): void {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    this.sendQueue.stop();
    if (!this.bot) return;
    try {
      this.bot.stop();
    } catch {
      // ignore
    }
    this.relay.cleanupAll();
    this.running = false;
    console.log("[wechat] Bot stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  get qrCode(): string | null {
    return this.qrCodeData;
  }

  private scheduleReconnect(): void {
    if (this.intentionalStop) return;
    this.reconnectAttempt++;
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      this.startError = `Failed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts. Use the web UI to re-login.`;
      console.error(`[wechat] ${this.startError}`);
      return;
    }
    const delay = this.reconnectDelay;
    console.log(`[wechat] Auto-reconnect attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      try {
        await this.doStart();
      } catch (err) {
        console.error("[wechat] Reconnect attempt failed:", err);
        if (!this.intentionalStop) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  async relogin(): Promise<void> {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    this.running = false;
    this.starting = false;
    if (this.bot) {
      try { this.bot.stop(); } catch { /* ignore */ }
    }
    this.relay.cleanupAll();
    try {
      if (this.bot?.storage) {
        await this.bot.storage.clear();
      }
    } catch (err) {
      console.error("[wechat] Failed to clear credentials:", err);
    }
    this.bot = null;
    this.qrCodeData = null;
    this.startError = null;
    this.reconnectAttempt = 0;
    this.reconnectDelay = MIN_RECONNECT_DELAY_MS;
    await this.start();
  }

  // ── Message Handling ──────────────────────────────────────────────────

  /** Handle inbound media messages (images, voice, files, videos) */
  private async handleMediaMessage(userId: string, msg: { userId: string; text: string; type: string; raw?: { images?: unknown[]; voices?: unknown[]; files?: unknown[]; videos?: unknown[] } }): Promise<void> {
    const sessionId = this.sessionManager.getActiveSessionId(userId);
    if (!sessionId) {
      this.sendQueue.enqueue(userId, "没有活跃的会话，发送 /new 创建新会话后再发图片/文件。");
      return;
    }
    const session = this.wsBridge.getSession(sessionId);
    if (!session) {
      this.sendQueue.enqueue(userId, "会话已过期，发送 /new 创建新会话。");
      return;
    }

    let mediaLabel = "";
    try {
      // Download media using the bot's built-in download API
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const media = await (this.bot as any).download(msg as any);
      if (!media || !media.data) {
        this.sendQueue.enqueue(userId, `⚠️ 无法下载${this.mediaTypeLabel(msg.type)}，请用文字描述。`);
        return;
      }

      mediaLabel = this.mediaTypeLabel(msg.type);
      const sizeLabel = media.data.length > 1024 * 1024
        ? `${(media.data.length / (1024 * 1024)).toFixed(1)}MB`
        : `${Math.round(media.data.length / 1024)}KB`;

      if (msg.type === "image") {
        this.relay.ensureRelay(sessionId, userId);
        await this.sendTyping(userId);
        const prompt = msg.text?.trim() || `请查看这张图片`;
        this.wsBridge.injectUserMessage(sessionId, `[用户发送了一张图片 (${sizeLabel})]\n${prompt}`);
        this.sendQueue.enqueue(userId, `📸 图片已发送给 Claude (${sizeLabel})`);
      } else if (msg.type === "voice") {
        const asrText = msg.text?.trim();
        if (asrText) {
          this.relay.ensureRelay(sessionId, userId);
          await this.sendTyping(userId);
          this.wsBridge.injectUserMessage(sessionId, `[语音转文字]\n${asrText}`);
          this.sendQueue.enqueue(userId, `🎤 语音已转文字发送 (${sizeLabel})`);
        } else {
          this.sendQueue.enqueue(userId, `⚠️ 语音识别失败，请用文字描述你的需求。`);
          return;
        }
      } else {
        const fileName = media.fileName || "未知文件";
        this.sendQueue.enqueue(userId, `📎 收到${mediaLabel}: ${fileName} (${sizeLabel})\n⚠️ Claude Code 暂不支持直接处理文件输入，请用文字描述你的需求。`);
        return;
      }

      const relayData = this.relay.getRelayData(sessionId);
      if (relayData) {
        relayData.turnStartTime = Date.now();
        relayData.lastUserFacingMessageTs = Date.now();
        this.relay.startHeartbeat(sessionId, userId);
      }
    } catch (err) {
      console.error("[wechat] Media download failed:", err);
      this.sendQueue.enqueue(userId, `⚠️ ${mediaLabel || this.mediaTypeLabel(msg.type)}下载失败，请用文字描述。`);
    }
  }

  private mediaTypeLabel(type: string): string {
    switch (type) {
      case "image": return "图片";
      case "voice": return "语音";
      case "file": return "文件";
      case "video": return "视频";
      default: return "媒体";
    }
  }

  private async handleMessage(msg: { userId: string; text: string; type: string; timestamp?: Date; raw?: { seq?: number; message_id?: number; from_user_id?: string; create_time_ms?: number; client_id?: string; images?: unknown[]; voices?: unknown[]; files?: unknown[]; videos?: unknown[] } }): Promise<void> {
    const { userId, type } = msg;
    const text = msg.text ?? "";

    // Old message filtering: discard messages older than process start
    if (msg.raw?.create_time_ms && msg.raw.create_time_ms < this.startedAt) return;

    // Message dedup based on message identity hash
    if (msg.raw) {
      const r = msg.raw;
      const hash = `${r.from_user_id ?? userId}|${r.message_id ?? ""}|${r.seq ?? ""}|${r.create_time_ms ?? ""}|${r.client_id ?? ""}`;
      const now = Date.now();
      const lastSeen = this.seenHashes.get(hash);
      if (lastSeen) return;
      this.seenHashes.set(hash, now);
      // Prune expired entries periodically
      if (this.seenHashes.size > 500) {
        for (const [k, ts] of this.seenHashes) {
          if (now - ts > DEDUP_TTL_MS) this.seenHashes.delete(k);
        }
      }
    }

    // Handle media messages (image, voice, file, video)
    if (type !== "text") {
      await this.handleMediaMessage(userId, msg);
      return;
    }

    if (!text.trim()) return;

    const settings = getSettings();
    if (settings.wechatAllowedUsers) {
      const allowed = settings.wechatAllowedUsers.split(",").map((s) => s.trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(userId)) {
        await this.sendQueue.enqueue(userId, "⛔ 权限不足，请联系管理员添加你的微信ID。");
        return;
      }
    }

    const parsed = parseCommand(text.trim());
    const userSession = this.sessionManager.getUserSession(userId);

    if (parsed.type === "message" && userSession && userSession.pendingAskQuestions.size > 0) {
      const trimmed = text.trim();
      const num = parseInt(trimmed, 10);
      if (trimmed === String(num) && num >= 1) {
        const handled = await this.tryAnswerAskUserQuestion(userId, userSession, num);
        if (handled) return;
      }
    }

    if (parsed.type === "message") {
      await this.handleUserMessage(userId, parsed.text);
    } else {
      await this.handleCommand(userId, parsed.command, parsed.args);
    }
  }

  private async handleUserMessage(userId: string, text: string): Promise<void> {
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    const sessionId = userSession.sessionIds[userSession.activeSessionIndex];

    if (!sessionId) {
      this.sendQueue.enqueue(userId, "没有活跃的会话，发送 /new 创建新会话。");
      return;
    }

    const session = this.wsBridge.getSession(sessionId);
    if (!session) {
      this.sessionManager.removeSession(userId, sessionId);
      this.sendQueue.enqueue(userId, "会话已过期，发送 /new 创建新会话。");
      return;
    }

    // Block messages to terminated sessions — no CLI process to handle them.
    if (!session.stateMachine.isActive()) {
      this.sendQueue.enqueue(userId, "会话已终止，发送 /new 创建新会话。");
      return;
    }

    this.relay.ensureRelay(sessionId, userId);
    await this.sendTyping(userId);
    this.wsBridge.injectUserMessage(sessionId, text);

    const relayData = this.relay.getRelayData(sessionId);
    if (relayData) {
      relayData.turnStartTime = Date.now();
      relayData.lastUserFacingMessageTs = Date.now();
      relayData.lastActiveToolName = "";
      this.relay.startHeartbeat(sessionId, userId);
    }
  }

  private async handleCommand(userId: string, cmd: string, args: string): Promise<void> {
    switch (cmd) {
      case "new": await this.cmdNewSession(userId, args); break;
      case "sessions": await this.cmdListSessions(userId); break;
      case "switch": await this.cmdSwitchSession(userId, args); break;
      case "kill": await this.cmdKillSession(userId); break;
      case "model": await this.cmdSetModel(userId, args); break;
      case "mode": await this.cmdSetPermissionMode(userId, args); break;
      case "allow": case "y": await this.cmdPermissionResponse(userId, "allow"); break;
      case "deny": case "n": await this.cmdPermissionResponse(userId, "deny"); break;
      case "pick": await this.cmdPick(userId, args); break;
      case "interrupt": await this.cmdInterrupt(userId); break;
      case "status": await this.cmdStatus(userId); break;
      case "dir": await this.cmdDir(userId, args); break;
      case "verbose": await this.cmdVerbose(userId); break;
      case "thinking": await this.cmdThinking(userId); break;
      case "effort": await this.cmdEffort(userId, args); break;
      case "tools": await this.cmdTools(userId, args); break;
      case "system-prompt": case "sp": await this.cmdSystemPrompt(userId, args); break;
      case "help": this.sendQueue.enqueue(userId, HELP_TEXT); break;
      case "reset": await this.cmdClear(userId); break;
      default: await this.handleUserMessage(userId, `/${cmd}${args ? " " + args : ""}`);
    }
  }

  // ── Command Implementations ───────────────────────────────────────────

  private async cmdNewSession(userId: string, args: string): Promise<void> {
    const settings = getSettings();
    const baseCwd = settings.wechatDefaultCwd || "";
    let cwd: string | undefined;

    if (args.trim() && baseCwd) {
      const folderName = args.trim();
      cwd = resolve(baseCwd, folderName);
      try { mkdirSync(cwd, { recursive: true }); } catch (err) {
        this.sendQueue.enqueue(userId, `创建目录失败: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else if (baseCwd) {
      cwd = baseCwd;
    }

    // Read stored per-user settings (tools, system-prompt, effort)
    const userSession = this.sessionManager.getUserSession(userId);
    const allowedTools = userSession?.allowedTools;
    const disallowedTools = userSession?.disallowedTools;
    const appendSystemPrompt = userSession?.appendSystemPrompt;
    const effort = userSession?.pendingEffort;

    const result: CreateSessionResult = await this.orchestrator.createSession({
      permissionMode: settings.wechatDefaultPermissionMode || "acceptEdits",
      ...(cwd ? { cwd } : {}),
      ...(allowedTools?.length ? { allowedTools } : {}),
      ...(disallowedTools?.length ? { disallowedTools } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      ...(effort ? { effort } : {}),
    });

    if (!result.ok) {
      this.sendQueue.enqueue(userId, `创建会话失败: ${result.error}`);
      return;
    }

    const sessionId = result.session.sessionId;
    const idx = this.sessionManager.addSession(userId, sessionId);
    // Set label if description provided
    if (args.trim()) {
      this.sessionManager.setSessionLabel(userId, sessionId, args.trim());
    }

    const session = this.wsBridge.getSession(sessionId);
    if (session) session.state.wechatUserId = userId;

    this.relay.ensureRelay(sessionId, userId);

    this.sendQueue.enqueue(userId, `✅ 会话已创建\n━━━━━━━━━━━━━━━\nID · ${sessionId.slice(0, 8)}...\n模型 · ${result.session.model || "default"}\n目录 · ${result.session.cwd}\n会话 #${idx + 1} / ${this.sessionManager.getUserSession(userId)!.sessionIds.length}`);
  }

  private async cmdListSessions(userId: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      this.sendQueue.enqueue(userId, "没有会话，发送 /new 创建新会话。");
      return;
    }

    function fmtTokens(n: number): string {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
      return String(n);
    }

    const lines: string[] = [`📋 会话列表 (${userSession.sessionIds.length})`];
    userSession.sessionIds.forEach((sid, i) => {
      const session = this.wsBridge.getSession(sid);
      const state = session?.state;
      const isActive = i === userSession.activeSessionIndex;

      if (!state) {
        lines.push("");
        lines.push(`${isActive ? "▶ " : "  "}#${i + 1} ${sid.slice(0, 8)}... (已断开)${isActive ? " ← 当前" : ""}`);
        return;
      }

      const phase = session.stateMachine?.phase ?? "unknown";
      const phaseEmoji = phase === "ready" ? "🟢" : phase === "streaming" ? "🔵" : phase === "awaiting_permission" ? "🟡" : "⚪";
      const phaseLabel: Record<string, string> = { ready: "就绪", streaming: "生成中", awaiting_permission: "等待审批", starting: "启动中", compacting: "压缩中" };
      const displayPhase = phaseLabel[phase] ?? phase;

      lines.push("");
      lines.push(`${isActive ? "▶ " : "  "}#${i + 1} ${sid.slice(0, 8)}...${isActive ? " ← 当前" : ""}`);
      lines.push(`  ${phaseEmoji} ${displayPhase} · ${state.model || "?"}`);
      lines.push(`  📁 ${state.cwd || "?"}`);

      const details: string[] = [];
      details.push(`轮次 ${state.num_turns ?? 0}`);
      details.push(`$${(state.total_cost_usd ?? 0).toFixed(4)}`);
      details.push(`↑${fmtTokens(state.input_tokens ?? 0)} ↓${fmtTokens(state.output_tokens ?? 0)}`);
      if (state.git_branch) details.push(state.git_branch);
      const pendingPerms = session.pendingPermissions.size;
      if (pendingPerms > 0) details.push(`⏳ ${pendingPerms} 待审批`);
      lines.push(`  ${details.join(" · ")}`);
    });
    lines.push("");
    lines.push("💬 /switch <n> 切换 · /status 详情");
    this.sendQueue.enqueue(userId, lines.join("\n"));
  }

  private async cmdSwitchSession(userId: string, args: string): Promise<void> {
    const index = parseInt(args, 10) - 1;
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || isNaN(index) || index < 0 || index >= userSession.sessionIds.length) {
      this.sendQueue.enqueue(userId, `无效的会话编号，使用 /sessions 查看会话列表。`);
      return;
    }
    const sid = this.sessionManager.switchSession(userId, index);
    this.sendQueue.enqueue(userId, `已切换到会话 #${index + 1}: ${sid!.slice(0, 8)}...`);
  }

  private async cmdKillSession(userId: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      this.sendQueue.enqueue(userId, "没有活跃的会话可以终止。");
      return;
    }
    const sessionId = userSession.sessionIds[userSession.activeSessionIndex];
    await this.orchestrator.killSession(sessionId);
    this.sessionManager.removeSession(userId, sessionId);
    const msg = userSession.sessionIds.length > 0
      ? `会话已终止，已切换到会话 #${userSession.activeSessionIndex + 1}。`
      : "会话已终止，没有更多会话。";
    this.sendQueue.enqueue(userId, msg);
  }

  private async cmdClear(userId: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      this.sendQueue.enqueue(userId, "没有活跃的会话，发送 /new 创建新会话。");
      return;
    }
    const oldSessionId = userSession.sessionIds[userSession.activeSessionIndex];
    const oldSession = this.wsBridge.getSession(oldSessionId);
    const cwd = oldSession?.state?.cwd;
    await this.orchestrator.killSession(oldSessionId);
    this.sessionManager.removeSession(userId, oldSessionId);

    const settings = getSettings();
    const result: CreateSessionResult = await this.orchestrator.createSession({
      permissionMode: settings.wechatDefaultPermissionMode || "acceptEdits",
      ...(cwd ? { cwd } : {}),
    });
    if (!result.ok) {
      this.sendQueue.enqueue(userId, `创建新会话失败: ${result.error}`);
      return;
    }
    const newSessionId = result.session.sessionId;
    const idx = this.sessionManager.addSession(userId, newSessionId);
    const newSession = this.wsBridge.getSession(newSessionId);
    if (newSession) newSession.state.wechatUserId = userId;
    this.relay.ensureRelay(newSessionId, userId);
    this.sendQueue.enqueue(userId, `🧹 上下文已清除，新会话已创建\n会话 · ${newSessionId.slice(0, 8)}... · 目录 · ${cwd || "默认"}`);
  }

  private async cmdSetModel(userId: string, args: string): Promise<void> {
    const model = args.trim();
    if (!model) { this.sendQueue.enqueue(userId, "用法: /model <名称>\n示例: /model claude-sonnet-4-6"); return; }
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    this.wsBridge.injectSetModel(sessionId, model);
    this.sendQueue.enqueue(userId, `模型已切换: ${model}`);
  }

  private async cmdSetPermissionMode(userId: string, args: string): Promise<void> {
    const mode = args.trim();
    if (!mode) { this.sendQueue.enqueue(userId, "用法: /mode <模式>\n选项: bypassPermissions, acceptEdits, plan, default"); return; }
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    this.wsBridge.injectSetPermissionMode(sessionId, mode);
    this.sendQueue.enqueue(userId, `权限模式已设为: ${mode}`);
  }

  private async cmdPermissionResponse(userId: string, behavior: "allow" | "deny"): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.pendingPermissions.size === 0) {
      this.sendQueue.enqueue(userId, "没有待审批的权限请求。标记为 ℹ️ 的操作是信息性通知，无需审批。");
      return;
    }
    while (userSession.pendingPermissions.size > 0) {
      const entry = userSession.pendingPermissions.entries().next().value!;
      const [requestId, pending] = entry;
      userSession.pendingPermissions.delete(requestId);
      const session = this.wsBridge.getSession(pending.sessionId);
      if (!session || !session.pendingPermissions.has(requestId)) {
        userSession.pendingAskQuestions.delete(requestId);
        this.sendQueue.enqueue(userId, "⚠️ 该权限请求已被系统取消。");
        continue;
      }
      this.wsBridge.injectPermissionResponse(pending.sessionId, requestId, behavior);
      const agentLabel = pending.agentId ? "[子任务] " : "";
      this.sendQueue.enqueue(userId, `${agentLabel}${behavior === "allow" ? "已批准 ✅" : "已拒绝 ❌"}`);
      return;
    }
    this.sendQueue.enqueue(userId, "所有待审批请求已被系统取消。");
  }

  private async cmdPick(userId: string, args: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.pendingAskQuestions.size === 0) {
      this.sendQueue.enqueue(userId, "没有待回答的问题。");
      return;
    }
    const trimmed = args.trim();
    if (!trimmed) { this.sendQueue.enqueue(userId, "用法: /pick <序号或自定义回答>\n示例: /pick 1 或 /pick 使用React框架"); return; }
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && trimmed === String(num)) {
      const handled = await this.tryAnswerAskUserQuestion(userId, userSession, num);
      if (!handled) this.sendQueue.enqueue(userId, "无效的选项编号。");
    } else {
      await this.submitAskUserAnswer(userId, userSession, trimmed);
    }
  }

  private async tryAnswerAskUserQuestion(userId: string, userSession: WeChatUserSession, num: number): Promise<boolean> {
    const entry = userSession.pendingAskQuestions.entries().next().value;
    if (!entry) return false;
    const [askRequestId, pending] = entry;
    const q = pending.questions[pending.currentIndex];
    const options = Array.isArray(q?.options) ? q.options : [];
    if (num < 1 || num > options.length) return false;
    const opt = options[num - 1]!;
    const selectedLabel = typeof opt === "object" && opt !== null ? String((opt as Record<string, string>).label ?? "") : String(opt);
    await this.submitAskUserAnswer(userId, userSession, selectedLabel);
    return true;
  }

  private async submitAskUserAnswer(userId: string, userSession: WeChatUserSession, selectedLabel: string): Promise<void> {
    const entry = userSession.pendingAskQuestions.entries().next().value;
    if (!entry) return;
    const [askRequestId, pending] = entry;
    pending.answers[String(pending.currentIndex)] = selectedLabel;
    const agentLabel = pending.agentId ? "[子任务] " : "";
    this.sendQueue.enqueue(userId, `✅ ${agentLabel}已选择 · ${selectedLabel}`);
    const nextIndex = pending.currentIndex + 1;
    if (nextIndex < pending.questions.length) {
      pending.currentIndex = nextIndex;
      this.sendQueue.enqueue(userId, `${agentLabel}${formatSingleQuestion(pending.questions, nextIndex)}`);
    } else {
      userSession.pendingAskQuestions.delete(askRequestId);
      userSession.pendingPermissions.delete(askRequestId);
      this.wsBridge.injectPermissionResponse(pending.sessionId, askRequestId, "allow", {
        questions: pending.questions,
        answers: pending.answers,
      });
    }
  }

  private async cmdInterrupt(userId: string): Promise<void> {
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    this.wsBridge.injectInterrupt(sessionId);
    this.sendQueue.enqueue(userId, "中断信号已发送，当前操作将被取消。");
  }

  private async cmdStatus(userId: string): Promise<void> {
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    const session = this.wsBridge.getSession(sessionId);
    if (!session) { this.sendQueue.enqueue(userId, "会话未找到。"); return; }
    const userSession = this.sessionManager.getUserSession(userId);
    const state = session.state;
    const phase = session.stateMachine?.phase ?? "unknown";
    const pendingPerms = session.pendingPermissions.size;
    const phaseEmoji = phase === "ready" ? "🟢" : phase === "streaming" ? "🔵" : phase === "awaiting_permission" ? "🟡" : "⚪";
    const phaseLabel: Record<string, string> = { ready: "就绪", streaming: "生成中", awaiting_permission: "等待审批", starting: "启动中", compacting: "压缩中" };

    function fmtTokens(n: number): string {
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
      return String(n);
    }

    const lines = [
      `📊 会话状态`,
      `━━━━━━━━━━━━━━━`,
      `ID · ${sessionId.slice(0, 8)}...`,
      `阶段 · ${phaseEmoji} ${phaseLabel[phase] ?? phase}`,
      `模型 · ${state.model || "?"}`,
      `权限 · ${state.permissionMode || "?"}`,
      `轮次 · ${state.num_turns ?? 0}`,
      `费用 · $${(state.total_cost_usd ?? 0).toFixed(4)}`,
      `Token · ↑${fmtTokens(state.input_tokens ?? 0)} ↓${fmtTokens(state.output_tokens ?? 0)}`,
      `目录 · ${state.cwd}`,
      `分支 · ${state.git_branch || "无"}`,
      `待审批 · ${pendingPerms}`,
      `工具通知 · ${(userSession?.verboseMode ?? false) ? "逐条" : "批量"}`,
      `思考显示 · ${(userSession?.thinkingMode ?? false) ? "开启" : "关闭"}`,
    ];
    this.sendQueue.enqueue(userId, lines.join("\n"));
  }

  private async cmdDir(userId: string, args: string): Promise<void> {
    const settings = getSettings();
    const baseCwd = settings.wechatDefaultCwd;
    if (!baseCwd) { this.sendQueue.enqueue(userId, "未配置默认工作目录，请在 设置 > 默认工作目录 中配置。"); return; }
    const subPath = args.trim();
    const targetDir = subPath ? resolve(baseCwd, subPath) : baseCwd;
    if (!targetDir.startsWith(resolve(baseCwd))) { this.sendQueue.enqueue(userId, "访问被拒绝: 路径超出默认工作目录范围。"); return; }
    if (!existsSync(targetDir)) { this.sendQueue.enqueue(userId, `目录不存在: ${subPath || baseCwd}`); return; }
    try {
      const recursive = subPath.includes("-r") || subPath.includes("--recursive");
      const cleanSubPath = subPath.replace(/-r\b|--recursive\b/g, "").trim();
      const actualDir = cleanSubPath ? resolve(baseCwd, cleanSubPath) : targetDir;
      const lines = this.listDirectory(actualDir, recursive, 0, 3);
      if (lines.length === 0) { this.sendQueue.enqueue(userId, `空目录: ${cleanSubPath || "(根目录)"}`); return; }
      const header = cleanSubPath ? `${cleanSubPath} 的内容:` : `默认目录的内容:`;
      this.sendQueue.enqueue(userId, [header, ...lines].join("\n"));
    } catch (err) {
      this.sendQueue.enqueue(userId, `列出目录失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cmdVerbose(userId: string): Promise<void> {
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    userSession.verboseMode = !userSession.verboseMode;
    this.sessionManager.persist();
    this.sendQueue.enqueue(userId, userSession.verboseMode
      ? "🔔 已切换到逐条模式 — 每个操作即时推送"
      : "🔕 已切换到批量模式 — 操作每3秒合并推送");
  }

  private async cmdThinking(userId: string): Promise<void> {
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    userSession.thinkingMode = !userSession.thinkingMode;
    this.sessionManager.persist();
    this.sendQueue.enqueue(userId, userSession.thinkingMode
      ? "🧠 思考显示已开启 — 将展示 AI 的推理过程"
      : "🧠 思考显示已关闭");
  }

  private async cmdEffort(userId: string, args: string): Promise<void> {
    const level = args.trim().toLowerCase();
    const validLevels = ["low", "medium", "high"];
    if (!level || !validLevels.includes(level)) {
      this.sendQueue.enqueue(userId, "用法: /effort <level>\n选项: low, medium, high");
      return;
    }
    const sessionId = this.getActiveSessionId(userId);
    if (!sessionId) return;
    // Inject as a user message since CLI doesn't support runtime effort changes
    // The next session created will use this setting
    this.sendQueue.enqueue(userId, `推理强度设为 ${level}\n⚠️ 此设置将在下次 /new 或 /reset 创建新会话时生效。`);
    // Store in session metadata for next session creation
    const userSession = this.sessionManager.getUserSession(userId);
    if (userSession) {
      userSession.pendingEffort = level;
    }
  }

  private async cmdTools(userId: string, args: string): Promise<void> {
    const parts = args.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase();

    if (!action || (action !== "allow" && action !== "deny" && action !== "list" && action !== "clear")) {
      this.sendQueue.enqueue(userId, "用法:\n  /tools allow Edit,Write,Bash — 允许指定工具\n  /tools deny WebSearch — 禁止指定工具\n  /tools list — 查看当前配置\n  /tools clear — 清除配置");
      return;
    }

    const userSession = this.sessionManager.getOrCreateUserSession(userId);

    if (action === "list") {
      const allowed = userSession.allowedTools ?? [];
      const denied = userSession.disallowedTools ?? [];
      const lines: string[] = ["🔧 工具配置"];
      lines.push(allowed.length > 0 ? `✅ 允许: ${allowed.join(", ")}` : "✅ 允许: (无限制)");
      lines.push(denied.length > 0 ? `❌ 禁止: ${denied.join(", ")}` : "❌ 禁止: (无)");
      lines.push("⚠️ 配置将在下次 /new 或 /reset 时生效");
      this.sendQueue.enqueue(userId, lines.join("\n"));
      return;
    }

    if (action === "clear") {
      userSession.allowedTools = undefined;
      userSession.disallowedTools = undefined;
      this.sessionManager.persist();
      this.sendQueue.enqueue(userId, "🔧 工具配置已清除");
      return;
    }

    const tools = parts.slice(1).flatMap((p) => p.split(",")).map((t) => t.trim()).filter(Boolean);
    if (tools.length === 0) {
      this.sendQueue.enqueue(userId, `请指定工具名称，如: /tools ${action} Edit,Write`);
      return;
    }

    if (action === "allow") {
      userSession.allowedTools = tools;
      this.sessionManager.persist();
      this.sendQueue.enqueue(userId, `✅ 已设置允许工具: ${tools.join(", ")}\n⚠️ 下次 /new 或 /reset 时生效`);
    } else {
      userSession.disallowedTools = tools;
      this.sessionManager.persist();
      this.sendQueue.enqueue(userId, `❌ 已设置禁止工具: ${tools.join(", ")}\n⚠️ 下次 /new 或 /reset 时生效`);
    }
  }

  private async cmdSystemPrompt(userId: string, args: string): Promise<void> {
    const prompt = args.trim();
    if (!prompt) {
      const userSession = this.sessionManager.getUserSession(userId);
      const current = userSession?.appendSystemPrompt;
      this.sendQueue.enqueue(userId, `用法: /system-prompt <追加的系统提示>\n${current ? `当前: ${current}` : "当前: (无)"}`);
      return;
    }
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    userSession.appendSystemPrompt = prompt;
    this.sessionManager.persist();
    this.sendQueue.enqueue(userId, `📝 系统提示已设置\n⚠️ 下次 /new 或 /reset 时生效`);
  }

  private listDirectory(dir: string, recursive: boolean, depth: number, maxDepth: number): string[] {
    if (depth > maxDepth) return [`  ${"│ ".repeat(depth)}... (max depth reached)`];
    const lines: string[] = [];
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }) as import("node:fs").Dirent[]; } catch {
      return [`  ${"│ ".repeat(depth)}(unreadable)`];
    }
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return String(a.name).localeCompare(String(b.name));
    });
    for (const entry of sorted) {
      const name = String(entry.name);
      const prefix = "  " + "│ ".repeat(depth);
      if (entry.isDirectory()) {
        lines.push(`${prefix}📁 ${name}/`);
        if (recursive) lines.push(...this.listDirectory(join(dir, name), true, depth + 1, maxDepth));
      } else {
        lines.push(`${prefix}📄 ${name}`);
      }
    }
    return lines;
  }

  private getActiveSessionId(userId: string): string | null {
    const sessionId = this.sessionManager.getActiveSessionId(userId);
    if (!sessionId) {
      this.sendQueue.enqueue(userId, "没有活跃的会话，发送 /new 创建新会话。");
      return null;
    }
    return sessionId;
  }

  private async sendTyping(userId: string): Promise<void> {
    if (!this.bot?.isRunning) return;
    try { await this.bot.sendTyping(userId); } catch { /* best-effort */ }
  }

  // ── Public API for routes ─────────────────────────────────────────────

  getStatus(): { running: boolean; starting: boolean; error: string | null; connectedUsers: number; qrCode: string | null; reconnecting: boolean } {
    return {
      running: this.running,
      starting: this.starting,
      error: this.startError,
      connectedUsers: this.sessionManager.userCount,
      qrCode: this.qrCodeData,
      reconnecting: this.reconnectTimer !== null,
    };
  }

  getSessions(): Array<{ userId: string; activeSession: string | null; sessionCount: number }> {
    return this.sessionManager.getAllSessions();
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    const sessionIds = this.sessionManager.deleteUser(userId);
    for (const sid of sessionIds) {
      try { await this.orchestrator.killSession(sid); } catch { /* ignore */ }
      this.relay.cleanupRelay(sid);
    }
  }
}
