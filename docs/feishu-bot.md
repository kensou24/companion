# 飞书 / Lark Bot 集成教程

通过 Feishu Bot，你可以直接在飞书或 Lark 中控制 Claude Code / Codex 会话，无需打开浏览器。

支持私聊和群聊 @机器人 交互，使用 WebSocket 长连接，无需公网 IP 或反向代理。

---

## 配置

### 1. 创建飞书应用

1. 前往 [飞书开放平台](https://open.feishu.cn)（国际版使用 [Lark Developer](https://open.larksuite.com)）创建自建应用
2. 在 **权限管理** 中开启以下权限：
   - `im:message` — 获取与发送单聊、群聊消息
   - `im:message:send_as_bot` — 以应用身份发送消息
   - `im:resource` — 获取消息中的资源文件
   - `im:chat` — 获取会话信息
3. 在 **事件订阅** 中选择 **WebSocket 长连接** 模式，订阅 `im.message.receive_v1` 事件
4. 发布应用（企业内需要管理员审批）

### 2. 在 Companion 中配置

打开 Companion Web UI，导航到 **Integrations** 页面，点击 **Feishu Bot** 卡片，或直接访问 `#/integrations/feishu`。

填写以下信息：

| 字段 | 说明 |
|------|------|
| **App ID** | 飞书应用的 App ID（`cli_xxxxxxxx`） |
| **App Secret** | 飞书应用的 App Secret |
| **Domain** | `feishu`（国内版）或 `lark`（国际版） |
| **Bot Name** | 机器人名称（可选，用于群聊中 @机器人 的匹配） |

点击 **Start** 启动 Bot。首次连接成功后状态变为 **Running**。

### 3. 配置选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| **Enable Feishu Bot** | 服务器启动时自动启动 Bot | 关 |
| **Auto-approve safe tools** | 自动批准 Read、Glob、Grep 等只读操作 | 开启 |
| **Forward dangerous permissions** | Bash (rm)、Write、Edit 等转发飞书等待批准 | 开启 |
| **Allowed Users** | 飞书用户 open_id 白名单（逗号分隔），留空允许所有人 | 空 |
| **Default Permission Mode** | 新建会话的权限模式 | `acceptEdits` |
| **Default Working Directory** | /new 和 /dir 命令的基础目录 | 空 |

### 4. 服务器自动启动

勾选 **Enable Feishu Bot** 后，每次服务器重启会自动启动 Bot，无需手动操作。

---

## 使用

### 基本对话

**私聊：** 直接发送消息即可与当前 Claude Code 会话对话。

**群聊：** @机器人 后发送消息。

```
你: 你好，请帮我写一个 Python 脚本
Bot: 你好！我很乐意帮你编写 Python 脚本。请告诉我你需要这个脚本做什么？

你: 写一个读取当前目录下所有 .txt 文件并统计行数的脚本
Bot: [返回脚本内容]
```

### 命令

所有命令以 `/` 开头：

| 命令 | 说明 | 示例 |
|-------|------|------|
| `/new [folder]` | 创建新会话，可指定基础目录下的子文件夹 | `/new my-app` |
| `/sessions` | 列出所有会话（含上下文使用率） | `/sessions` |
| `/switch <n>` | 切换到第 n 个会话 | `/switch 2` |
| `/kill` | 终止当前会话 | `/kill` |
| `/reset` | 重置上下文（终止并新建会话，保持同目录） | `/reset` |
| `/model <name>` | 切换模型 | `/model claude-sonnet-4-6` |
| `/mode <mode>` | 切换权限模式 | `/mode bypassPermissions` |
| `/allow` 或 `/y` | 批准当前权限请求 | `/allow` |
| `/deny` 或 `/n` | 拒绝当前权限请求 | `/deny` |
| `/pick <n>` 或 `/pick <text>` | 回复 AskUserQuestion（按编号选择或输入自定义文本） | `/pick 1` |
| `/interrupt` | 中断当前操作 | `/interrupt` |
| `/status` | 查看当前会话状态 | `/status` |
| `/dir [path]` | 列出基础目录下的文件夹 | `/dir` 或 `/dir src` |
| `/verbose` | 切换详细模式（每个工具调用即时推送 vs 15 秒批量合并） | `/verbose` |
| `/thinking` | 切换是否显示 Claude 的思考过程 | `/thinking` |
| `/effort <level>` | 设置下次 /new 的推理力度（low/medium/high） | `/effort high` |
| `/tools allow <names>` | 添加工具自动批准列表 | `/tools allow Bash,Glob` |
| `/tools deny <names>` | 添加工具拒绝列表 | `/tools deny Write` |
| `/tools list` | 查看当前工具配置 | `/tools list` |
| `/tools clear` | 清空工具配置 | `/tools clear` |
| `/system-prompt <text>` | 设置下次 /new 的系统提示词（别名 `/sp`） | `/sp 请用中文回复` |
| `/help` | 查看所有命令 | `/help` |

### 默认目录与文件夹操作

在设置页配置 **Default Working Directory**（如 `/home/user/projects`）后：

```
你: /new my-app
Bot: Session created: abc12345...
      Model: default
      CWD: /home/user/projects/my-app
```

如果 `my-app` 文件夹不存在，会自动创建。

### 权限处理

当 Claude Code 需要执行操作时，Companion 会根据设置自动处理：

**自动批准（推荐开启）：**
- `Read` — 读取文件
- `Glob` — 搜索文件
- `Grep` — 搜索内容
- `WebSearch` — 搜索网页
- `Context7` — 查询文档
- `TodoRead`、`TaskList`、`TaskGet` — 任务读取

**需要批准（推荐开启 "Forward dangerous permissions"）：**
- `Bash`（含 rm、chmod 等危险命令）
- `Write` — 写入文件
- `Edit` — 编辑文件
- 其他未知工具

收到权限请求时，飞书会显示工具名称和操作内容，回复 `/allow` 或 `/deny`：

```
[Bash] rm -rf /tmp/old_logs
Approve? /allow or /deny
```

### 可用权限模式

| 模式 | 说明 |
|------|------|
| `acceptEdits` | 默认，自动批准文件编辑 |
| `bypassPermissions` | 跳过所有权限检查 |
| `plan` | 只读模式，需要确认才执行 |
| `default` | 使用 Claude Code 默认行为 |

---

## 功能特性

- **流式输出** — Claude 的回复实时推送，带有"正在处理"表情指示
- **工具调用通知** — 支持 15 秒批量合并或逐条推送（`/verbose` 切换）
- **AskUserQuestion 交互** — 显示编号选项，支持 `/pick` 选择或输入自定义文本
- **思考过程展示** — 开启 `/thinking` 后显示 Claude 的推理过程（截断至 800 字）
- **推理力度控制** — `/effort low/medium/high` 控制推理深度
- **上下文预警** — 上下文使用超过 80% 时自动提醒
- **工具进度心跳** — 长时间运行的工具每 60 秒发送进度
- **会话自动命名** — 首次对话后自动从用户消息中提取会话名称

---

## 常见问题

### Q: 如何获取飞书用户的 open_id？

启动 Bot 后，用户发送消息时后端日志会显示 open_id。也可以在设置页的 **Active Sessions** 列表中查看。

### Q: 消息没有回复？

1. 发送 `/status` 检查会话状态
2. 发送 `/sessions` 查看是否有会话
3. 如果没有会话，发送 `/new` 创建一个

### Q: 连接断开怎么办？

Bot 使用 WebSocket 长连接，会自动重连（最多 20 次，间隔最长 60 秒）。如果所有重连失败，需要在设置页手动重启。

### Q: 群聊中机器人不回复？

确保在群聊中 @机器人 后再发送消息。群聊中只有 @机器人 的消息会被处理。

### Q: 国内版和国际版的区别？

选择 `feishu` 域名使用 `open.feishu.cn` API，选择 `lark` 域名使用 `open.larksuite.com` API。两个版本功能完全一致，只是服务端地址不同。
