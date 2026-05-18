// Shared types for Feishu bridge modules.

import type { WsBridge } from "../ws-bridge.js";
import type { SessionOrchestrator } from "../session-orchestrator.js";

export interface FeishuUserSession {
  sessionIds: string[];
  activeSessionIndex: number;
  pendingPermissions: Map<string, PendingPermission>;
  verboseMode: boolean;
  thinkingMode: boolean;
  pendingAskQuestions: Map<string, PendingAskQuestion>;
  sessionLabels: Map<string, string>;
  sessionContextUsage: Map<string, number>;
  /** Pending effort level for next session creation */
  pendingEffort?: string;
  /** Tool allowlist for next session creation */
  allowedTools?: string[];
  /** Tool denylist for next session creation */
  disallowedTools?: string[];
  /** Append system prompt for next session creation */
  appendSystemPrompt?: string;
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

export interface FeishuRelayData {
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

export interface FeishuSendQueueItem {
  chatId: string;
  text: string;
  priority?: boolean;
  _resolve?: (result: "ok" | "failed") => void;
  /** Resolves with the Feishu message_id after successful send */
  _messageIdResolve?: (messageId: string | null) => void;
  /** Optional media content to send instead of or alongside text */
  media?: FeishuMediaContent;
  /** Serialized Feishu card JSON string — when set, sent as msg_type="interactive" */
  card?: string;
}

export interface FeishuMediaContent {
  type: "image" | "file" | "audio" | "video" | "rich_text";
  data: Buffer;
  fileName?: string;
  caption?: string;
  /** Feishu-rich text segments (used when type is "rich_text") */
  richTextSections?: FeishuRichTextSection[];
}

export interface FeishuRichTextSection {
  content: string;
  /** Optional Feishu text style flags (bold, italic, etc.) */
  style?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    code?: boolean;
  };
  /** Optional hyperlink */
  href?: string;
}

export interface FeishuBridgeDeps {
  wsBridge: WsBridge;
  orchestrator: SessionOrchestrator;
}

export interface FeishuConfig {
  /** Feishu app ID */
  appId: string;
  /** Feishu app secret */
  appSecret: string;
  /** Feishu verification token for event subscription */
  verificationToken?: string;
  /** Feishu encrypt key for event subscription */
  encryptKey?: string;
  /** Public domain for Feishu callback URL */
  domain: string;
  /** Callback path for Feishu event subscription (default: /feishu/event) */
  eventPath?: string;
  /** Bot name displayed in messages */
  botName?: string;
}

export interface FeishuMessageContext {
  /** Feishu chat / group ID (chat_xxx) */
  chatId: string;
  /** Feishu user ID of the message sender (ou_xxx) */
  userId: string;
  /** Feishu message ID (om_xxx) */
  messageId: string;
  /** Chat type: "p2p" for direct messages, "group" for group chats */
  chatType: "p2p" | "group";
  /** Message type: "text", "image", "file", etc. */
  messageType: string;
  /** Root message ID for threaded replies */
  rootMessageId?: string;
  /** Parent message ID for replies */
  parentMessageId?: string;
  /** Whether the message mentions the bot (for group chats) */
  mentionBot?: boolean;
}
