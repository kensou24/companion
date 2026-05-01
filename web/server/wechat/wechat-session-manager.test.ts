// Tests for wechat-session-manager.ts — session mapping, persistence, and state management
import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "./wechat-session-manager.js";

let testCounter = 0;

describe("SessionManager", () => {
  let sm: SessionManager;

  beforeEach(() => {
    testCounter++;
    sm = new SessionManager({
      persistPath: `/tmp/test-wechat-sessions-${Date.now()}-${testCounter}.json`,
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
      const path = `/tmp/test-wechat-persist-${Date.now()}-${++testCounter}.json`;
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

  describe("getUserIdsForSession", () => {
    it("finds all users associated with a session", () => {
      sm.addSession("user1", "sess-1");
      sm.addSession("user2", "sess-1");
      sm.addSession("user2", "sess-2");
      expect(sm.getUserIdsForSession("sess-1").sort()).toEqual(["user1", "user2"]);
      expect(sm.getUserIdsForSession("sess-2")).toEqual(["user2"]);
      expect(sm.getUserIdsForSession("sess-999")).toEqual([]);
    });
  });

  describe("listSessionInfo", () => {
    it("returns session info with labels and context", () => {
      sm.addSession("user1", "sess-1");
      sm.addSession("user1", "sess-2");
      sm.setSessionLabel("user1", "sess-1", "编码");
      sm.setContextUsage("user1", "sess-1", 72);
      const info = sm.listSessionInfo("user1");
      expect(info).toHaveLength(2);
      expect(info[0]).toEqual({
        id: "sess-1",
        index: 0,
        label: "编码",
        contextPct: 72,
        isActive: true,
      });
      expect(info[1].isActive).toBe(false);
    });

    it("returns empty array for unknown user", () => {
      expect(sm.listSessionInfo("unknown")).toEqual([]);
    });
  });
});
