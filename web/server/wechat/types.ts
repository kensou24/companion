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
