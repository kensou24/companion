# WeChat 交互优化设计

**日期**: 2026-05-01
**状态**: Draft
**范围**: wechat-bridge 架构拆分、消息可靠性、流式响应、会话管理、错误恢复

## 背景

`wechat-bridge.ts` 当前有 2098 行，承载了会话管理、消息路由、事件处理、权限控制、发送队列等全部职责。随着功能增长（子任务权限队列、工具进度通知、流式体验），单文件架构已成为维护瓶颈，也限制了后续优化空间。

## 优化总览

按依赖关系排序（前置项是后续项的基础）：

| 优先级 | 优化项 | 类别 | 预估工作量 |
|--------|--------|------|-----------|
| 1 | 架构拆分 | 代码架构 | 中 |
| 2 | 消息可靠性保障 | 稳定性 | 中 |
| 3 | 流式响应体验 | 用户体验 | 小 |
| 4 | 多会话/上下文管理 | 用户体验 | 小 |
| 5 | 错误恢复与降级 | 稳定性 | 中 |

---

## 优化 1：架构拆分

### 目标

将 `wechat-bridge.ts`（2098 行）拆分为 5 个独立模块，每个模块单一职责、可独立测试。

### 模块划分

```
web/server/wechat/
├── wechat-bridge.ts            (~200行) 编排入口
│   - Bot 生命周期管理（start/stop/relogin）
│   - 顶层事件总线订阅
│   - 协调子模块调用
│
├── wechat-session-manager.ts   (~250行) 会话管理
│   - WeChat 用户 → Claude 会话映射
│   - 会话创建、切换、列表
│   - 会话持久化（JSON 文件读写）
│   - 用户会话状态（verboseMode, thinkingMode 等）
│
├── wechat-relay.ts             (~400行) 事件中继
│   - 从 ensureRelay() 提取全部逻辑
│   - 事件 → WeChat 消息转换
│   - 流式文本累积
│   - 工具通知（batch/verbose 模式）
│   - 权限请求路由
│
├── wechat-send-queue.ts        (~200行) 发送队列
│   - 序列化发送（min interval pacing）
│   - 限流检测与指数退避
│   - 优先级队列（权限 > 普通）
│   - 消息分片（4000 字符限制）
│
└── wechat-command-handler.ts   (~200行) 命令处理
    - 命令解析（/new, /sessions, /switch, /verbose 等）
    - 命令执行与响应生成
    - 帮助信息
```

**保持不变**：`wechat-formatter.ts` 继续作为独立的纯函数模块。

### 接口设计

```typescript
// wechat-session-manager.ts
interface ISessionManager {
  getActiveSession(wxid: string): WeChatUserSession | null;
  createSession(wxid: string, cwd?: string, description?: string): Promise<string>;
  switchSession(wxid: string, index: number): string | null;
  listSessions(wxid: string): SessionInfo[];
  updateState(wxid: string, partial: Partial<UserSessionState>): void;
}

// wechat-send-queue.ts
interface ISendQueue {
  enqueue(wxid: string, text: string, priority?: 'normal' | 'critical'): void;
  drain(): void;
  pause(): void;
  resume(): void;
  setBot(bot: WeChatBot): void;
}

// wechat-relay.ts
interface IRelay {
  setup(sessionId: string, wxid: string): void;
  teardown(sessionId: string): void;
  injectMessage(sessionId: string, text: string, images?: ImageData[]): void;
}

// wechat-command-handler.ts
interface ICommandHandler {
  parse(text: string): ParsedCommand | null;
  execute(wxid: string, command: ParsedCommand): Promise<CommandResult>;
}
```

### 迁移策略

1. 创建 `wechat/` 目录，新建 5 个模块文件
2. 逐个提取功能到对应模块，保持 `wechat-bridge.ts` 作为门面
3. 每提取一个模块，运行测试确认无回归
4. 最后将 `wechat-bridge.ts` 瘦身为编排层
5. 更新所有 import 路径

---

## 优化 2：消息可靠性保障

### 目标

确保消息不丢失，服务端重启后可恢复。

### 持久化发送队列

**存储**：JSONL 文件，路径 `~/.companion/wechat-send-queue.jsonl`

每条记录格式：
```json
{
  "id": "uuid",
  "wxid": "user-id",
  "text": "消息内容",
  "priority": "critical",
  "createdAt": 1771153996875,
  "status": "pending",
  "attempts": 0,
  "maxAttempts": 5,
  "lastAttemptAt": null
}
```

### ACK 确认机制

```
enqueue(msg) → 写入 JSONL → drain() 发送 → SDK 成功 → 标记 "acked" → 下次清理时删除
                                        → SDK 失败 → 重试 (exponential backoff)
                                        → 超过 maxAttempts → 标记 "failed" + 降级处理
```

### 超时降级

权限请求特殊处理：
- 60s 未成功投递 → 检查工具类型
  - 安全工具（Read/Glob/Grep）→ 自动批准
  - 危险工具（Bash/Write/Edit）→ 自动拒绝，通知用户

### 重启恢复

服务端启动时：
1. 读取 JSONL 文件，筛选 `status: "pending"`
2. 按 `createdAt` 排序，重新入队
3. 关键消息优先发送

### 清理策略

每次 drain 完成后，删除所有 `status: "acked"` 且超过 1 小时的记录。

---

## 优化 3：流式响应体验

### 目标

长回复时提供实时预览，而非等待完整回复。

### 分段发送策略

```
文本累积器开始累积 Claude 流式输出
    ↓
触发条件（满足任一）：
  - 累积字符 ≥ 500
  - 距上次发送 ≥ 5 秒
  - 收到 result（回复结束）
    ↓
发送预览消息：
  "📝 [预览] 让我分析一下这个问题..."
  + 后缀 "[✏️ 编辑中...]"
    ↓
回复结束时：
  发送完整格式化版本（替换预览内容）
```

### 跳过规则

以下情况不发送预览，直接等待最终回复：
- 总回复长度 < 500 字符
- 回复在首次触发前已完成
- 包含大量代码块（code-heavy）的回复 → 等待完整版本以保持格式

### 心跳调整

- 有预览消息时：心跳间隔从 30s 延长到 60s
- 预览本身就是一个进度信号，无需额外心跳

### 配置

```typescript
const STREAMING_CONFIG = {
  PREVIEW_MIN_CHARS: 500,      // 最少累积字符数
  PREVIEW_MAX_INTERVAL_MS: 5000, // 最长等待时间
  SHORT_REPLY_THRESHOLD: 500,   // 短回复跳过阈值
  PREVIEW_SUFFIX: '\n\n[✏️ 编辑中...]',
};
```

---

## 优化 4：多会话/上下文管理

### 目标

改善多会话场景下的操作体验。

### `/sessions` 命令增强

输出格式：
```
📌 会话列表
━━━━━━━━━━━━━━━━━━
  #1 → 编码优化          [72% 🟡] 10分钟前
▸ #2 → Bug排查           [45% 🟢] 1小时前
  #3 → 文档撰写          [15% 🟢] 2小时前
━━━━━━━━━━━━━━━━━━
💡 /switch 1  切换会话
💡 /compact   压缩上下文
💡 /new 描述  新建会话
```

**上下文百分比**：从流式事件中的 `usage` 数据提取，格式化为百分比+颜色标签：
- 🟢 < 60% 充裕
- 🟡 60-80% 注意
- 🔴 > 80% 建议 /compact

**会话标题**：取该会话第一条用户消息的前 20 字符，作为标题。

### `/new` 命令增强

支持带描述创建：
```
/new 编码优化        → 创建标题为"编码优化"的新会话
/new                  → 创建空白新会话（现有行为）
```

### `/switch N` 简写

新增简写命令，等同于 `/sessions` 后选择编号：
```
/switch 2  → 切换到会话 #2
```

---

## 优化 5：错误恢复与降级

### 目标

SDK 崩溃后自动恢复，无需人工干预。

### 健康检查

```typescript
// 每 60s 执行一次
async function healthCheck(): Promise<'healthy' | 'degraded' | 'down'> {
  if (!bot) return 'down';
  try {
    await bot.ping(); // 或发送测试消息给 self
    return 'healthy';
  } catch {
    return 'degraded';
  }
}
```

连续 3 次检查失败（3 分钟）→ 触发恢复流程。

### 分级恢复

```
Level 1: SDK 重连
  → bot.restart() 或重新初始化 SDK
  → 等待 30s 检查恢复
  → 失败 → 进入 Level 2

Level 2: 重新登录
  → 向活跃用户推送 QR 码图片
  → 等待用户扫码（超时 5 分钟）
  → 成功 → 恢复服务
  → 超时 → 进入 Level 3

Level 3: 完全重启 Bridge
  → 销毁所有会话 relay
  → 清理 SDK 状态
  → 重新初始化整个 Bridge
  → 通知用户 "已重新启动"
```

### 状态通知

向活跃用户推送系统消息：
- `"⚠️ 连接中断，正在自动恢复..."` → 恢复开始
- `"✅ 连接已恢复"` → 恢复成功
- `"❌ 恢复失败，请手动重启"` → 恢复失败

### 优雅降级

恢复期间：
- 所有收到的用户消息入持久化队列（与优化 2 联动）
- 恢复后按顺序处理积压消息
- 向用户确认积压消息数量：`"📋 已恢复连接，正在处理 3 条积压消息..."`

### 登录态检测

区分两种故障：
- **SDK 崩溃**（进程异常）：直接进入 L1 恢复
- **登录过期**（二维码过期）：跳过 L1，直接进入 L2

检测方式：SDK 重连后如果返回登录相关错误码，判定为登录过期。

---

## 实施顺序

```
Phase 1: 架构拆分（优化 1）
  ↓ 拆分完成后
Phase 2: 消息可靠性（优化 2） ← 基于新的 wechat-send-queue.ts 模块
  ↓ 并行
Phase 3a: 流式响应（优化 3）   ← 基于新的 wechat-relay.ts 模块
Phase 3b: 会话管理（优化 4）   ← 基于新的 wechat-session-manager.ts 模块
  ↓ 消息可靠性完成后
Phase 4: 错误恢复（优化 5）    ← 依赖持久化队列
```
