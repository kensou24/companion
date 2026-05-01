// ─── WeChat Session Manager ────────────────────────────────────────────────
// Manages WeChat user session mappings, persistence, and state.
// Extracted from WeChatBridge for modular architecture.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  WeChatUserSession,
  PersistedMapping,
} from "./types.js";

export interface SessionManagerOptions {
  persistPath: string;
}

export class SessionManager {
  private userSessions = new Map<string, WeChatUserSession>();
  private persistPath: string;
  private userIdBySession = new Map<string, string>();

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

  /** Map from sessionId to userId for reverse lookups */
  getUserIdBySession(sessionId: string): string | undefined {
    return this.userIdBySession.get(sessionId);
  }

  /** Set the userIdBySession mapping */
  setUserIdForSession(sessionId: string, userId: string): void {
    this.userIdBySession.set(sessionId, userId);
  }

  /** Delete a userIdBySession mapping */
  deleteSessionMapping(sessionId: string): void {
    this.userIdBySession.delete(sessionId);
  }

  addSession(userId: string, sessionId: string): number {
    const session = this.getOrCreateUserSession(userId);
    session.sessionIds.push(sessionId);
    this.userIdBySession.set(sessionId, userId);
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
    this.userIdBySession.delete(sessionId);
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

  /** Delete all sessions for a user */
  deleteUser(userId: string): string[] {
    const session = this.userSessions.get(userId);
    if (!session) return [];
    const sessionIds = [...session.sessionIds];
    for (const sid of sessionIds) {
      this.userIdBySession.delete(sid);
    }
    this.userSessions.delete(userId);
    this.persist();
    return sessionIds;
  }

  /** Number of connected users */
  get userCount(): number {
    return this.userSessions.size;
  }

  /** Get all sessions info for routes */
  getAllSessions(): Array<{ userId: string; activeSession: string | null; sessionCount: number }> {
    return Array.from(this.userSessions.entries()).map(([userId, us]) => ({
      userId,
      activeSession: us.sessionIds[us.activeSessionIndex] ?? null,
      sessionCount: us.sessionIds.length,
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
        for (const sid of mapping.sessionIds) {
          this.userIdBySession.set(sid, userId);
        }
      }
      console.log(`[wechat-session] Restored ${this.userSessions.size} user session mappings`);
    } catch (err) {
      console.error("[wechat-session] Failed to restore:", err);
    }
  }
}
