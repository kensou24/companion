// ─── Feishu Bridge Orchestrator ────────────────────────────────────────────
// Lifecycle management + wiring for Feishu (飞书/Lark) integration.
// Uses the official Lark OAPI SDK with WebSocket transport (no public IP needed).

import type { WsBridge } from "../ws-bridge.js";
import type { SessionOrchestrator, CreateSessionResult } from "../session-orchestrator.js";
import { COMPANION_HOME } from "../paths.js";
import { getSettings } from "../settings-manager.js";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import type { FeishuUserSession, FeishuConfig } from "./types.js";
import { FeishuSessionManager } from "./feishu-session-manager.js";
import { FeishuSendQueue } from "./feishu-send-queue.js";
import { Relay } from "./feishu-relay.js";
import { parseCommand, formatSessionName, formatSingleQuestion, HELP_TEXT } from "./feishu-command-handler.js";

export { parseCommand, formatSessionName, formatSingleQuestion } from "./feishu-command-handler.js";

const PERSIST_PATH = join(COMPANION_HOME, "feishu-sessions.json");
const CONFIG_PATH = join(COMPANION_HOME, "feishu-config.json");

const MIN_RECONNECT_DELAY_MS = 2_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 20;

export class FeishuBridge {
  private wsBridge: WsBridge;
  private orchestrator: SessionOrchestrator;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private running = false;
  private starting = false;
  private startError: string | null = null;
  private config: FeishuConfig | null = null;
  // Reconnect
  private reconnectDelay = MIN_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalStop = false;
  private reconnectAttempt = 0;
  // Message dedup
  private seenMessageIds = new Map<string, number>();
  private startedAt = Date.now();
  // Bot open_id (discovered at startup)
  private botOpenId: string | null = null;
  // Modules
  private sessionManager: FeishuSessionManager;
  private sendQueue: FeishuSendQueue;
  private relay: Relay;

  constructor(wsBridge: WsBridge, orchestrator: SessionOrchestrator) {
    this.wsBridge = wsBridge;
    this.orchestrator = orchestrator;
    this.sessionManager = new FeishuSessionManager({ persistPath: PERSIST_PATH });
    this.sendQueue = new FeishuSendQueue();
    this.relay = new Relay({
      wsBridge,
      sessionManager: this.sessionManager,
      sendQueue: this.sendQueue,
      sendTyping: this.sendTyping.bind(this),
    });
    this.loadConfig();
  }

  // ── Config ────────────────────────────────────────────────────────────

  private loadConfig(): void {
    if (!existsSync(CONFIG_PATH)) return;
    try {
      const content = require("fs").readFileSync(CONFIG_PATH, "utf-8");
      this.config = JSON.parse(content) as FeishuConfig;
    } catch {
      // ignore malformed config
    }
  }

  getConfig(): FeishuConfig | null {
    return this.config;
  }

  async saveConfig(config: FeishuConfig): Promise<void> {
    this.config = config;
    const dir = join(CONFIG_PATH, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    require("fs").writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running || this.starting) return;
    if (!this.config?.appId || !this.config?.appSecret) {
      this.startError = "飞书 App ID 或 App Secret 未配置。请在设置页面配置。";
      return;
    }
    this.intentionalStop = false;
    this.reconnectAttempt = 0;
    this.starting = true;
    this.startError = null;

    this.doStart().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[feishu] Failed to start:", message);
      this.starting = false;
      this.startError = message;
    });
  }

  private async doStart(): Promise<void> {
    const { Client, WSClient } = await import("@larksuiteoapi/node-sdk");

    const domain = this.config!.domain === "lark" ? "https://open.larksuite.com" : undefined;

    // Create the Feishu client
    this.client = new Client({
      appId: this.config!.appId,
      appSecret: this.config!.appSecret,
      domain,
    });

    // Discover bot open_id for mention detection
    try {
      const resp = await this.client.request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      }, undefined as never);
      const bot = (resp as Record<string, unknown>)?.bot as Record<string, unknown> | undefined
        ?? ((resp as Record<string, unknown>)?.data as Record<string, unknown> | undefined)?.bot as Record<string, unknown> | undefined;
      if (bot?.open_id) {
        this.botOpenId = bot.open_id as string;
        console.log(`[feishu] Bot open_id: ${this.botOpenId}`);
      }
    } catch (err) {
      console.warn("[feishu] Could not fetch bot info:", err instanceof Error ? err.message : err);
    }

    // Use WebSocket client for receiving events (no public IP needed)
    const wsClient = new WSClient({
      appId: this.config!.appId,
      appSecret: this.config!.appSecret,
      domain,
      loggerLevel: "warn" as never,
    });

    // Register event handlers
    wsClient.start({
      eventDispatcher: new (await import("@larksuiteoapi/node-sdk")).EventDispatcher({}).register({
        "im.message.receive_v1": async (data: unknown) => {
          try {
            await this.handleIncomingMessage(data);
          } catch (err) {
            console.error("[feishu] Error handling message:", err);
          }
        },
      }),
    });

    this.sendQueue.setClient(this.client);
    this.running = true;
    this.starting = false;
    this.reconnectDelay = MIN_RECONNECT_DELAY_MS;
    this.reconnectAttempt = 0;
    this.startedAt = Date.now();
    console.log("[feishu] Bot started via WebSocket");
  }

  stop(): void {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    this.sendQueue.stop();
    this.running = false;
    this.relay.cleanupAll();
    console.log("[feishu] Bot stopped");
  }

  get isRunning(): boolean {
    return this.running;
  }

  private scheduleReconnect(): void {
    if (this.intentionalStop) return;
    this.reconnectAttempt++;
    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      this.startError = `飞书重连失败 (${MAX_RECONNECT_ATTEMPTS} 次)，请重新启动。`;
      console.error(`[feishu] ${this.startError}`);
      return;
    }
    const delay = this.reconnectDelay;
    console.log(`[feishu] Reconnect attempt ${this.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      try {
        await this.doStart();
      } catch (err) {
        console.error("[feishu] Reconnect failed:", err);
        if (!this.intentionalStop) this.scheduleReconnect();
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── Message Handling ──────────────────────────────────────────────────

  private async handleIncomingMessage(data: unknown): Promise<void> {
    const msg = data as Record<string, unknown>;
    // SDK v2 event format: { message, sender, ... } at top level
    // SDK v1 / wrapped format: { event: { message, sender, ... } }
    const event = (msg?.event as Record<string, unknown> | undefined) ?? msg;
    if (!event) return;

    const sender = event.sender as Record<string, unknown> | undefined;
    const message = event.message as Record<string, unknown> | undefined;
    if (!sender || !message) return;

    const userId = (sender.sender_id as Record<string, unknown>)?.open_id as string || sender.sender_id as string;
    const chatId = message.chat_id as string;
    const messageId = message.message_id as string;
    const chatType = message.chat_type as string; // "p2p" or "group"
    const msgType = message.message_type as string;
    const createTime = Number(message.create_time) || 0;
    const mentions = message.mentions as Array<Record<string, string>> | undefined;

    // Dedup
    const now = Date.now();
    if (this.seenMessageIds.has(messageId)) return;
    this.seenMessageIds.set(messageId, now);
    if (this.seenMessageIds.size > 500) {
      for (const [k, ts] of this.seenMessageIds) {
        if (now - ts > 5 * 60 * 1000) this.seenMessageIds.delete(k);
      }
    }

    // Old message filter
    if (createTime > 0 && createTime < this.startedAt) return;

    // Group message: only respond when mentioned
    if (chatType === "group") {
      const isBotMentioned = mentions?.some((m) => {
        const id = typeof m.id === "object" && m.id !== null ? (m.id as Record<string, string>).open_id : m.id;
        return id === this.botOpenId || m.name === this.config?.botName;
      }) ?? false;
      if (!isBotMentioned) return;
    }

    // Parse message content
    let text = "";
    try {
      const content = JSON.parse((message.content as string) || "{}");
      if (msgType === "text") {
        text = content.text || "";
      } else if (msgType === "post") {
        // Rich text: extract text from all sections
        const post = content.zh_cn || content.en_us || content.content || content;
        if (post.content) {
          for (const section of post.content) {
            for (const elem of section) {
              if (elem.tag === "text") text += elem.text || "";
              else if (elem.tag === "at") text += `@${elem.user_name || ""} `;
            }
            text += "\n";
          }
        }
      } else if (msgType === "interactive") {
        // Card message: extract text from card elements
        const elements = content.elements || [];
        for (const el of elements) {
          if (el.tag === "markdown" && el.content) text += el.content + "\n";
          else if (el.tag === "div" && el.text?.content) text += el.text.content + "\n";
        }
      } else {
        // Image, file, audio, etc.
        text = `[${msgType}]`;
      }
    } catch {
      text = (message.content as string) || "";
    }

    // Strip bot mention from text
    if (chatType === "group" && this.botOpenId) {
      text = text.replace(new RegExp(`@_user_\\d+`, "g"), "").trim();
    }
    text = text.trim();
    if (!text) return;

    // Access control
    const settings = getSettings();
    if (settings.feishuAllowedUsers) {
      const allowed = settings.feishuAllowedUsers.split(",").map((s) => s.trim()).filter(Boolean);
      if (allowed.length > 0 && !allowed.includes(userId)) {
        await this.sendQueue.enqueue(chatId, "⛔ 权限不足，请联系管理员添加你的飞书 ID。");
        return;
      }
    }

    // Route to command or message handler
    const parsed = parseCommand(text);
    const userSession = this.sessionManager.getUserSession(userId);

    if (parsed.type === "message" && userSession && userSession.pendingAskQuestions.size > 0) {
      const num = parseInt(text, 10);
      if (String(num) === text && num >= 1) {
        const handled = await this.tryAnswerAskUserQuestion(userId, userSession, num);
        if (handled) return;
      }
    }

    if (parsed.type === "message") {
      await this.handleUserMessage(userId, chatId, parsed.text);
    } else {
      await this.handleCommand(userId, chatId, parsed.command, parsed.args);
    }
  }

  private async handleUserMessage(userId: string, chatId: string, text: string): Promise<void> {
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    const sessionId = userSession.sessionIds[userSession.activeSessionIndex];

    if (!sessionId) {
      this.sendQueue.enqueue(chatId, "没有活跃的会话，发送 /new 创建新会话。");
      return;
    }

    const session = this.wsBridge.getSession(sessionId);
    if (!session) {
      this.sessionManager.removeSession(userId, sessionId);
      this.sendQueue.enqueue(chatId, "会话已过期，发送 /new 创建新会话。");
      return;
    }

    // Block messages to terminated sessions — no CLI process to handle them.
    // Without this guard the "thinking" indicator and heartbeat start but
    // the result event never fires, leaving the heartbeat spinning forever.
    if (!session.stateMachine.isActive()) {
      this.sendQueue.enqueue(chatId, "会话已终止，发送 /new 创建新会话。");
      return;
    }

    this.relay.ensureRelay(sessionId, userId, chatId);
    await this.sendTyping(chatId);

    // Send "processing" indicator
    const relayData = this.relay.getRelayData(sessionId);
    if (relayData) {
      this.sendQueue.enqueue(chatId, "⏳ 处理中", true);
    }

    this.wsBridge.injectUserMessage(sessionId, text);

    if (relayData) {
      relayData.turnStartTime = Date.now();
      relayData.lastUserFacingMessageTs = Date.now();
      this.relay.startHeartbeat(sessionId, chatId);
    }
  }

  private async handleCommand(userId: string, chatId: string, cmd: string, args: string): Promise<void> {
    switch (cmd) {
      case "new": await this.cmdNewSession(userId, chatId, args); break;
      case "sessions": await this.cmdListSessions(userId, chatId); break;
      case "switch": await this.cmdSwitchSession(userId, chatId, args); break;
      case "kill": await this.cmdKillSession(userId, chatId); break;
      case "model": await this.cmdSetModel(userId, chatId, args); break;
      case "mode": await this.cmdSetPermissionMode(userId, chatId, args); break;
      case "allow": case "y": await this.cmdPermissionResponse(userId, chatId, "allow"); break;
      case "deny": case "n": await this.cmdPermissionResponse(userId, chatId, "deny"); break;
      case "pick": await this.cmdPick(userId, chatId, args); break;
      case "interrupt": await this.cmdInterrupt(userId, chatId); break;
      case "status": await this.cmdStatus(userId, chatId); break;
      case "dir": await this.cmdDir(userId, chatId, args); break;
      case "verbose": await this.cmdVerbose(userId, chatId); break;
      case "thinking": await this.cmdThinking(userId, chatId); break;
      case "effort": await this.cmdEffort(userId, chatId, args); break;
      case "tools": await this.cmdTools(userId, chatId, args); break;
      case "system-prompt": case "sp": await this.cmdSystemPrompt(userId, chatId, args); break;
      case "help": this.sendQueue.enqueue(chatId, HELP_TEXT); break;
      case "reset": await this.cmdClear(userId, chatId); break;
      default: await this.handleUserMessage(userId, chatId, `/${cmd}${args ? " " + args : ""}`);
    }
  }

  // ── Command Implementations (same logic as WeChat, keyed by chatId) ────

  private async cmdNewSession(userId: string, chatId: string, args: string): Promise<void> {
    const settings = getSettings();
    const baseCwd = settings.feishuDefaultCwd || "";
    let cwd: string | undefined;

    if (args.trim() && baseCwd) {
      cwd = resolve(baseCwd, args.trim());
      try { mkdirSync(cwd, { recursive: true }); } catch (err) {
        this.sendQueue.enqueue(chatId, `创建目录失败: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    } else if (baseCwd) {
      cwd = baseCwd;
    }

    const userSession = this.sessionManager.getUserSession(userId);
    const allowedTools = userSession?.allowedTools;
    const disallowedTools = userSession?.disallowedTools;
    const appendSystemPrompt = userSession?.appendSystemPrompt;
    const effort = userSession?.pendingEffort;

    const result: CreateSessionResult = await this.orchestrator.createSession({
      permissionMode: settings.feishuDefaultPermissionMode || "acceptEdits",
      ...(cwd ? { cwd } : {}),
      ...(allowedTools?.length ? { allowedTools } : {}),
      ...(disallowedTools?.length ? { disallowedTools } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      ...(effort ? { effort } : {}),
    });

    if (!result.ok) {
      this.sendQueue.enqueue(chatId, `创建会话失败: ${result.error}`);
      return;
    }

    const sessionId = result.session.sessionId;
    const idx = this.sessionManager.addSession(userId, sessionId);
    if (args.trim()) this.sessionManager.setSessionLabel(userId, sessionId, args.trim());

    const session = this.wsBridge.getSession(sessionId);
    if (session) session.state.feishuUserId = userId;

    this.relay.ensureRelay(sessionId, userId, chatId);
    this.sendQueue.enqueue(chatId, `✅ 会话已创建\n━━━━━━━━━━━━━━━\nID · ${sessionId.slice(0, 8)}...\n模型 · ${result.session.model || "default"}\n目录 · ${result.session.cwd}\n会话 #${idx + 1} / ${this.sessionManager.getUserSession(userId)!.sessionIds.length}`);
  }

  private async cmdListSessions(userId: string, chatId: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      this.sendQueue.enqueue(chatId, "没有会话，发送 /new 创建新会话。");
      return;
    }
    // Reuse WeChat's session list format
    const sessions = userSession.sessionIds.map((sid, i) => {
      const session = this.wsBridge.getSession(sid);
      const ctxPct = session?.state.context_used_percent ?? 0;
      const isActive = i === userSession.activeSessionIndex;
      const label = userSession.sessionLabels.get(sid) || sid.slice(0, 8);
      return { index: i, label, contextPct: ctxPct, isActive };
    });
    const { formatSessionList } = await import("./feishu-command-handler.js");
    this.sendQueue.enqueue(chatId, formatSessionList(sessions));
  }

  private async cmdSwitchSession(userId: string, chatId: string, args: string): Promise<void> {
    const index = parseInt(args, 10) - 1;
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || isNaN(index) || index < 0 || index >= userSession.sessionIds.length) {
      this.sendQueue.enqueue(chatId, "无效的会话编号，使用 /sessions 查看会话列表。");
      return;
    }
    this.sessionManager.switchSession(userId, index);
    this.sendQueue.enqueue(chatId, `已切换到会话 #${index + 1}`);
  }

  private async cmdKillSession(userId: string, chatId: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      this.sendQueue.enqueue(chatId, "没有活跃的会话可以终止。");
      return;
    }
    const sessionId = userSession.sessionIds[userSession.activeSessionIndex];
    await this.orchestrator.killSession(sessionId);
    this.sessionManager.removeSession(userId, sessionId);
    this.sendQueue.enqueue(chatId, userSession.sessionIds.length > 0 ? "会话已终止。" : "会话已终止，没有更多会话。");
  }

  private async cmdClear(userId: string, chatId: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.sessionIds.length === 0) {
      this.sendQueue.enqueue(chatId, "没有活跃的会话，发送 /new 创建新会话。");
      return;
    }
    const oldSessionId = userSession.sessionIds[userSession.activeSessionIndex];
    const oldSession = this.wsBridge.getSession(oldSessionId);
    const cwd = oldSession?.state?.cwd;
    await this.orchestrator.killSession(oldSessionId);
    this.sessionManager.removeSession(userId, oldSessionId);

    const settings = getSettings();
    const result: CreateSessionResult = await this.orchestrator.createSession({
      permissionMode: settings.feishuDefaultPermissionMode || "acceptEdits",
      ...(cwd ? { cwd } : {}),
    });
    if (!result.ok) {
      this.sendQueue.enqueue(chatId, `创建新会话失败: ${result.error}`);
      return;
    }
    const newSessionId = result.session.sessionId;
    this.sessionManager.addSession(userId, newSessionId);
    const newSession = this.wsBridge.getSession(newSessionId);
    if (newSession) newSession.state.feishuUserId = userId;
    this.relay.ensureRelay(newSessionId, userId, chatId);
    this.sendQueue.enqueue(chatId, `🧹 上下文已清除，新会话已创建`);
  }

  private async cmdSetModel(userId: string, chatId: string, args: string): Promise<void> {
    const model = args.trim();
    if (!model) { this.sendQueue.enqueue(chatId, "用法: /model <名称>"); return; }
    const sessionId = this.getActiveSessionId(userId, chatId);
    if (!sessionId) return;
    this.wsBridge.injectSetModel(sessionId, model);
    this.sendQueue.enqueue(chatId, `模型已切换: ${model}`);
  }

  private async cmdSetPermissionMode(userId: string, chatId: string, args: string): Promise<void> {
    const mode = args.trim();
    if (!mode) { this.sendQueue.enqueue(chatId, "用法: /mode <模式>\n选项: bypassPermissions, acceptEdits, plan, default"); return; }
    const sessionId = this.getActiveSessionId(userId, chatId);
    if (!sessionId) return;
    this.wsBridge.injectSetPermissionMode(sessionId, mode);
    this.sendQueue.enqueue(chatId, `权限模式已设为: ${mode}`);
  }

  private async cmdPermissionResponse(userId: string, chatId: string, behavior: "allow" | "deny"): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.pendingPermissions.size === 0) {
      this.sendQueue.enqueue(chatId, "没有待审批的权限请求。");
      return;
    }
    const entry = userSession.pendingPermissions.entries().next().value;
    if (!entry) return;
    const [requestId, pending] = entry;
    userSession.pendingPermissions.delete(requestId);
    this.wsBridge.injectPermissionResponse(pending.sessionId, requestId, behavior);
    this.sendQueue.enqueue(chatId, behavior === "allow" ? "已批准 ✅" : "已拒绝 ❌");
  }

  private async cmdPick(userId: string, chatId: string, args: string): Promise<void> {
    const userSession = this.sessionManager.getUserSession(userId);
    if (!userSession || userSession.pendingAskQuestions.size === 0) {
      this.sendQueue.enqueue(chatId, "没有待回答的问题。");
      return;
    }
    const trimmed = args.trim();
    if (!trimmed) { this.sendQueue.enqueue(chatId, "用法: /pick <序号或自定义回答>"); return; }
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && String(num) === trimmed) {
      const handled = await this.tryAnswerAskUserQuestion(userId, userSession, num);
      if (!handled) this.sendQueue.enqueue(chatId, "无效的选项编号。");
    } else {
      await this.submitAskUserAnswer(userId, userSession, trimmed);
    }
  }

  private async tryAnswerAskUserQuestion(userId: string, userSession: FeishuUserSession, num: number): Promise<boolean> {
    const entry = userSession.pendingAskQuestions.entries().next().value;
    if (!entry) return false;
    const [, pending] = entry;
    const q = pending.questions[pending.currentIndex];
    const options = Array.isArray(q?.options) ? q.options : [];
    if (num < 1 || num > options.length) return false;
    const opt = options[num - 1]!;
    const label = typeof opt === "object" && opt !== null ? String((opt as Record<string, string>).label ?? "") : String(opt);
    await this.submitAskUserAnswer(userId, userSession, label);
    return true;
  }

  private async submitAskUserAnswer(userId: string, userSession: FeishuUserSession, selectedLabel: string): Promise<void> {
    const entry = userSession.pendingAskQuestions.entries().next().value;
    if (!entry) return;
    const [askRequestId, pending] = entry;
    pending.answers[String(pending.currentIndex)] = selectedLabel;
    this.sendQueue.enqueue(this.getChatIdForUser(userId), `✅ 已选择 · ${selectedLabel}`);
    const nextIndex = pending.currentIndex + 1;
    if (nextIndex < pending.questions.length) {
      pending.currentIndex = nextIndex;
      this.sendQueue.enqueue(this.getChatIdForUser(userId), formatSingleQuestion(pending.questions, nextIndex));
    } else {
      userSession.pendingAskQuestions.delete(askRequestId);
      userSession.pendingPermissions.delete(askRequestId);
      this.wsBridge.injectPermissionResponse(pending.sessionId, askRequestId, "allow", {
        questions: pending.questions,
        answers: pending.answers,
      });
    }
  }

  private async cmdInterrupt(userId: string, chatId: string): Promise<void> {
    const sessionId = this.getActiveSessionId(userId, chatId);
    if (!sessionId) return;
    this.wsBridge.injectInterrupt(sessionId);
    this.sendQueue.enqueue(chatId, "中断信号已发送。");
  }

  private async cmdStatus(userId: string, chatId: string): Promise<void> {
    const sessionId = this.getActiveSessionId(userId, chatId);
    if (!sessionId) return;
    const session = this.wsBridge.getSession(sessionId);
    if (!session) { this.sendQueue.enqueue(chatId, "会话未找到。"); return; }
    const state = session.state;
    const phase = session.stateMachine?.phase ?? "unknown";
    const phaseLabel: Record<string, string> = { ready: "就绪", streaming: "生成中", awaiting_permission: "等待审批", starting: "启动中" };
    this.sendQueue.enqueue(chatId, [
      `📊 会话状态`,
      `━━━━━━━━━━━━━━━`,
      `ID · ${sessionId.slice(0, 8)}...`,
      `阶段 · ${phaseLabel[phase] ?? phase}`,
      `模型 · ${state.model || "?"}`,
      `轮次 · ${state.num_turns ?? 0}`,
      `费用 · $${(state.total_cost_usd ?? 0).toFixed(4)}`,
      `目录 · ${state.cwd}`,
    ].join("\n"));
  }

  private async cmdDir(userId: string, chatId: string, args: string): Promise<void> {
    const settings = getSettings();
    const baseCwd = settings.feishuDefaultCwd;
    if (!baseCwd) { this.sendQueue.enqueue(chatId, "未配置默认工作目录。"); return; }
    const targetDir = args.trim() ? resolve(baseCwd, args.trim()) : baseCwd;
    if (!existsSync(targetDir)) { this.sendQueue.enqueue(chatId, `目录不存在: ${args.trim()}`); return; }
    try {
      const entries = readdirSync(targetDir, { withFileTypes: true });
      const lines = entries.sort((a, b) => a.name.localeCompare(b.name)).map((e) => e.isDirectory() ? `📁 ${e.name}/` : `📄 ${e.name}`);
      this.sendQueue.enqueue(chatId, lines.length > 0 ? lines.join("\n") : "空目录");
    } catch (err) {
      this.sendQueue.enqueue(chatId, `列出目录失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async cmdVerbose(userId: string, chatId: string): Promise<void> {
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    userSession.verboseMode = !userSession.verboseMode;
    this.sessionManager.persist();
    this.sendQueue.enqueue(chatId, userSession.verboseMode ? "🔔 已切换到逐条模式" : "🔕 已切换到批量模式");
  }

  private async cmdThinking(userId: string, chatId: string): Promise<void> {
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    userSession.thinkingMode = !userSession.thinkingMode;
    this.sessionManager.persist();
    this.sendQueue.enqueue(chatId, userSession.thinkingMode ? "🧠 思考显示已开启" : "🧠 思考显示已关闭");
  }

  private async cmdEffort(userId: string, chatId: string, args: string): Promise<void> {
    const level = args.trim().toLowerCase();
    if (!level || !["low", "medium", "high"].includes(level)) {
      this.sendQueue.enqueue(chatId, "用法: /effort <level>\n选项: low, medium, high");
      return;
    }
    const userSession = this.sessionManager.getUserSession(userId);
    if (userSession) userSession.pendingEffort = level;
    this.sendQueue.enqueue(chatId, `推理强度设为 ${level}\n⚠️ 下次 /new 时生效。`);
  }

  private async cmdTools(userId: string, chatId: string, args: string): Promise<void> {
    const parts = args.trim().split(/\s+/);
    const action = parts[0]?.toLowerCase();
    if (!action || !["allow", "deny", "list", "clear"].includes(action)) {
      this.sendQueue.enqueue(chatId, "用法:\n  /tools allow Edit,Write\n  /tools deny WebSearch\n  /tools list\n  /tools clear");
      return;
    }
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    if (action === "list") {
      const allowed = userSession.allowedTools ?? [];
      const denied = userSession.disallowedTools ?? [];
      this.sendQueue.enqueue(chatId, `🔧 工具配置\n✅ 允许: ${allowed.join(", ") || "(无限制)"}\n❌ 禁止: ${denied.join(", ") || "(无)"}`);
      return;
    }
    if (action === "clear") {
      userSession.allowedTools = undefined;
      userSession.disallowedTools = undefined;
      this.sessionManager.persist();
      this.sendQueue.enqueue(chatId, "🔧 工具配置已清除");
      return;
    }
    const tools = parts.slice(1).flatMap((p) => p.split(",")).map((t) => t.trim()).filter(Boolean);
    if (tools.length === 0) { this.sendQueue.enqueue(chatId, `请指定工具名称`); return; }
    if (action === "allow") userSession.allowedTools = tools;
    else userSession.disallowedTools = tools;
    this.sessionManager.persist();
    this.sendQueue.enqueue(chatId, `🔧 已设置${action === "allow" ? "允许" : "禁止"}工具: ${tools.join(", ")}\n⚠️ 下次 /new 时生效`);
  }

  private async cmdSystemPrompt(userId: string, chatId: string, args: string): Promise<void> {
    const prompt = args.trim();
    if (!prompt) {
      const userSession = this.sessionManager.getUserSession(userId);
      this.sendQueue.enqueue(chatId, `用法: /system-prompt <文本>\n当前: ${userSession?.appendSystemPrompt || "(无)"}`);
      return;
    }
    const userSession = this.sessionManager.getOrCreateUserSession(userId);
    userSession.appendSystemPrompt = prompt;
    this.sessionManager.persist();
    this.sendQueue.enqueue(chatId, `📝 系统提示已设置\n⚠️ 下次 /new 时生效`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private getActiveSessionId(userId: string, chatId: string): string | null {
    const sessionId = this.sessionManager.getActiveSessionId(userId);
    if (!sessionId) {
      this.sendQueue.enqueue(chatId, "没有活跃的会话，发送 /new 创建新会话。");
      return null;
    }
    return sessionId;
  }

  private getChatIdForUser(userId: string): string {
    const userSession = this.sessionManager.getUserSession(userId);
    if (userSession) {
      const sessionId = userSession.sessionIds[userSession.activeSessionIndex];
      if (sessionId) {
        const chatId = this.relay.getChatId(sessionId);
        if (chatId) return chatId;
      }
    }
    return userId;
  }

  private async sendTyping(chatId: string): Promise<void> {
    if (!this.client) return;
    try {
      // Feishu typing indicator: add an emoji reaction
      await this.client.im.messageReaction.create({
        data: { reaction_type: "emoji", reaction_id: "OnIt" },
        path: { message_id: chatId },
      });
    } catch { /* best-effort */ }
  }

  // ── Public API ────────────────────────────────────────────────────────

  getStatus() {
    return {
      running: this.running,
      starting: this.starting,
      error: this.startError,
      connectedUsers: this.sessionManager.userCount,
      reconnecting: this.reconnectTimer !== null,
      hasConfig: !!this.config?.appId,
    };
  }

  getSessions(): Array<{ userId: string; activeSession: string | null; sessionCount: number }> {
    return this.sessionManager.getAllSessions();
  }

  async deleteSessionsForUser(userId: string): Promise<void> {
    const sessionIds = this.sessionManager.deleteUser(userId);
    for (const sid of sessionIds) {
      this.relay.cleanupRelay(sid);
    }
  }
}
