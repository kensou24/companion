// Tests for wechat-command-handler.ts — command parsing and formatting
import { describe, it, expect } from "vitest";
import { parseCommand, formatSessionList, formatSessionName, formatSingleQuestion, HELP_TEXT } from "./wechat-command-handler.js";

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
    expect(result).toEqual({ type: "command", command: "y", args: "" });
  });

  it("handles /deny alias /n", () => {
    const result = parseCommand("/n");
    expect(result).toEqual({ type: "command", command: "n", args: "" });
  });

  it("handles multi-word args", () => {
    const result = parseCommand("/mode bypassPermissions");
    expect(result).toEqual({ type: "command", command: "mode", args: "bypassPermissions" });
  });

  it("handles empty string", () => {
    const result = parseCommand("");
    expect(result).toEqual({ type: "message", text: "" });
  });

  // Additional tests matching the existing wechat-bridge.test.ts behavior
  it("identifies plain text messages", () => {
    const result = parseCommand("Hello, how are you?");
    expect(result).toEqual({ type: "message", text: "Hello, how are you?" });
  });

  it("handles command case-insensitively", () => {
    const result = parseCommand("/HELP");
    expect(result).toEqual({ type: "command", command: "help", args: "" });
  });

  it("handles text starting with space", () => {
    const result = parseCommand(" /not a command");
    expect(result).toEqual({ type: "message", text: " /not a command" });
  });

  it("parses /dir with path argument", () => {
    const result = parseCommand("/dir src/components");
    expect(result).toEqual({ type: "command", command: "dir", args: "src/components" });
  });

  it("parses /dir with recursive flag", () => {
    const result = parseCommand("/dir -r src");
    expect(result).toEqual({ type: "command", command: "dir", args: "-r src" });
  });

  it("handles /pick with numeric argument", () => {
    const result = parseCommand("/pick 1");
    expect(result).toEqual({ type: "command", command: "pick", args: "1" });
  });

  it("handles /pick with free-text argument", () => {
    const result = parseCommand("/pick 使用React框架");
    expect(result).toEqual({ type: "command", command: "pick", args: "使用React框架" });
  });

  it("handles unknown commands", () => {
    const result = parseCommand("/foobar extra args");
    expect(result).toEqual({ type: "command", command: "foobar", args: "extra args" });
  });
});

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
    expect(result).toContain("Bug排查");
    expect(result).toContain("▸ #2 → Bug排查"); // active marker
    expect(result).toContain("#3 → 未命名会话"); // no label fallback
  });

  it("shows empty state", () => {
    const result = formatSessionList([]);
    expect(result).toContain("没有活跃的会话");
  });

  it("shows context usage emoji indicators", () => {
    const sessions = [
      { index: 0, label: "high", contextPct: 85, isActive: true },
      { index: 1, label: "medium", contextPct: 65, isActive: false },
      { index: 2, label: "low", contextPct: 30, isActive: false },
    ];
    const result = formatSessionList(sessions);
    // >=80: red, >=60: yellow, <60: green
    expect(result).toContain("🔴");
    expect(result).toContain("🟡");
    expect(result).toContain("🟢");
  });
});

describe("formatSessionName", () => {
  it("returns the first line as-is if short", () => {
    expect(formatSessionName("Fix the login bug")).toBe("Fix the login bug");
  });

  it("truncates to 30 chars with ellipsis", () => {
    const long = "This is a very long message that exceeds thirty characters easily";
    const result = formatSessionName(long);
    expect(result.length).toBe(30);
    expect(result.endsWith("...")).toBe(true);
  });

  it("takes only the first line", () => {
    const multiline = "Fix login\nAdd tests\nDeploy";
    expect(formatSessionName(multiline)).toBe("Fix login");
  });

  it("returns empty for empty input", () => {
    expect(formatSessionName("")).toBe("");
  });

  it("returns empty for whitespace-only input", () => {
    expect(formatSessionName("   ")).toBe("");
  });

  it("handles exactly 30 chars", () => {
    const exact = "a".repeat(30);
    expect(formatSessionName(exact)).toBe(exact);
  });

  it("handles 31 chars", () => {
    const over = "a".repeat(31);
    const result = formatSessionName(over);
    expect(result.length).toBe(30);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("HELP_TEXT", () => {
  it("contains all expected command sections", () => {
    expect(HELP_TEXT).toContain("/new");
    expect(HELP_TEXT).toContain("/sessions");
    expect(HELP_TEXT).toContain("/switch");
    expect(HELP_TEXT).toContain("/allow");
    expect(HELP_TEXT).toContain("/deny");
    expect(HELP_TEXT).toContain("/help");
  });
});

describe("formatSingleQuestion", () => {
  // MCP AskUserQuestion sends options as plain strings, not { label, description } objects.
  // The web UI handles both formats in PermissionBanner.tsx — WeChat must too.
  it("formats string options from MCP AskUserQuestion", () => {
    const questions = [
      {
        question: "Should the frobnosticator run on startup?",
        options: ["Yes, run automatically", "No, only on demand"],
      },
    ];
    const result = formatSingleQuestion(questions, 0);
    expect(result).toContain("❓ Should the frobnosticator run on startup?");
    expect(result).toContain("① Yes, run automatically");
    expect(result).toContain("② No, only on demand");
  });

  it("formats object options with label and description", () => {
    const questions = [
      {
        question: "Which approach?",
        options: [
          { label: "Option A", description: "Faster" },
          { label: "Option B", description: "Safer" },
        ],
      },
    ];
    const result = formatSingleQuestion(questions, 0);
    expect(result).toContain("① Option A");
    expect(result).toContain("   Faster");
    expect(result).toContain("② Option B");
    expect(result).toContain("   Safer");
  });

  it("shows multi-question index when more than one question", () => {
    const questions = [
      { question: "Q1?", options: ["A", "B"] },
      { question: "Q2?", options: ["C", "D"] },
    ];
    const result = formatSingleQuestion(questions, 0);
    expect(result).toContain("[1/2]");
  });
});
