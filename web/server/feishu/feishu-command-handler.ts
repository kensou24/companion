// ─── Feishu Command Handler ───────────────────────────────────────────────
// Command parsing and formatting for Feishu bridge commands.
// Extracted from FeishuBridge for modular architecture.

import type { ParsedCommand } from "./types.js";

/** Parse an incoming Feishu text into command or plain message. */
export function parseCommand(text: string): ParsedCommand {
  if (!text.startsWith("/")) return { type: "message", text };
  const parts = text.slice(1).split(/\s+/);
  const command = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1).join(" ");
  return { type: "command", command, args };
}

/** Generate a short session name from the first user message. */
export function formatSessionName(firstMessage: string): string {
  if (!firstMessage?.trim()) return "";
  // Take first line, truncate to 30 chars
  const firstLine = firstMessage.split("\n")[0]!.trim();
  if (firstLine.length <= 30) return firstLine;
  return firstLine.slice(0, 27) + "...";
}

// Circled numbers for AskUserQuestion formatting
const CIRCLED_NUMS = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
function circledNum(n: number): string {
  return n < CIRCLED_NUMS.length ? CIRCLED_NUMS[n]! : `${n + 1}.`;
}

/** Format a single question from an AskUserQuestion input for Feishu display. */
export function formatSingleQuestion(questions: Array<Record<string, unknown>>, index: number): string {
  const q = questions[index];
  if (!q) return "";

  const parts: string[] = [];
  const questionText = String(q.question ?? "");
  if (questions.length > 1) {
    parts.push(`❓ [${index + 1}/${questions.length}] ${questionText}`);
  } else {
    parts.push(`❓ ${questionText}`);
  }
  parts.push("");

  const options = Array.isArray(q.options) ? q.options : [];
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]!;
    const isObj = typeof opt === "object" && opt !== null;
    const label = isObj ? String((opt as Record<string, string>).label ?? "") : String(opt);
    const desc = isObj ? String((opt as Record<string, string>).description ?? "") : "";
    if (desc) {
      parts.push(`${circledNum(i)} ${label}`);
      parts.push(`   ${desc}`);
    } else {
      parts.push(`${circledNum(i)} ${label}`);
    }
  }
  parts.push(`${circledNum(options.length)} 其他`);
  parts.push("   输入 /pick <自定义回答>");

  parts.push("");
  parts.push("💬 回复序号选择 (如: 1) 或 /pick <自定义回答>");
  return parts.join("\n");
}

/** Format a session list for the /sessions command display. */
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

export const HELP_TEXT = `🤖 Companion 飞书 Bot
━━━━━━━━━━━━━━━━━━

支持私聊和群聊，在群聊中请 @机器人 触发回复。

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
  /effort <level> — 设置推理强度 (low/medium/high)
  /tools [allow|deny] <列表> — 管理工具白/黑名单
  /system-prompt <文本> — 追加系统提示

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
直接发送文字即可与当前会话对话。
支持发送图片、文件等媒体消息。`;
