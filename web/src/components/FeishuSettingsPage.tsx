import { useEffect, useState, useCallback } from "react";
import { api, type AppSettings } from "../api.js";

interface FeishuStatus {
  running: boolean;
  starting: boolean;
  error: string | null;
  connectedUsers: number;
  reconnecting: boolean;
  hasConfig: boolean;
}

interface FeishuConfig {
  configured: boolean;
  appId?: string;
  domain?: string;
  botName?: string;
  hasAppSecret?: boolean;
}

interface FeishuUserSession {
  userId: string;
  activeSession: string | null;
  sessionCount: number;
}

interface FeishuSettingsPageProps {
  embedded?: boolean;
}

export function FeishuSettingsPage({ embedded = false }: FeishuSettingsPageProps) {
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [config, setConfig] = useState<FeishuConfig | null>(null);
  const [sessions, setSessions] = useState<FeishuUserSession[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Config form
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [domain, setDomain] = useState("feishu");
  const [botName, setBotName] = useState("");
  const [configDirty, setConfigDirty] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const [s, c, sess, sett] = await Promise.all([
        api.getFeishuStatus(),
        api.getFeishuConfig(),
        api.getFeishuSessions(),
        api.getSettings(),
      ]);
      setStatus(s);
      setConfig(c);
      setSessions(sess.sessions);
      setSettings(sett);
      if (c.configured && !configDirty) {
        setAppId(c.appId?.replace(/\*{4}/, "") || "");
        setDomain(c.domain || "feishu");
        setBotName(c.botName || "");
      }
      if (s.error && !s.running && !s.starting) {
        setError(s.error);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [configDirty]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const handleStart = async () => {
    setLoading(true);
    setError("");
    try {
      await api.startFeishu();
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await api.stopFeishu();
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const handleSaveConfig = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      setError("App ID and App Secret are required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await api.updateFeishuConfig({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        domain: domain.trim() || "feishu",
        botName: botName.trim() || undefined,
      });
      setConfigDirty(false);
      setAppSecret("");
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };

  const handleToggle = async (field: string, value: boolean) => {
    try {
      await api.updateSettings({ [field]: value });
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSettingChange = async (patch: Record<string, unknown>) => {
    try {
      await api.updateSettings(patch);
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleDeleteSession = async (userId: string) => {
    try {
      await api.deleteFeishuSession(userId);
      await loadStatus();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className={`${embedded ? "h-full" : "h-[100dvh]"} bg-cc-bg text-cc-fg font-sans-ui antialiased overflow-y-auto`}>
      <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10 pb-safe">
        <h1 className="text-xl font-semibold text-cc-fg mb-1">飞书 Bot</h1>
        <p className="text-sm text-cc-muted mb-6">
          通过飞书机器人控制 Claude Code 会话。使用 WebSocket 长连接，无需公网 IP。
        </p>

        {error && (
          <div className="mb-4 px-3 py-2 rounded-lg bg-cc-error/10 border border-cc-error/20 text-xs text-cc-error">
            {error}
          </div>
        )}

        {/* Bot Status */}
        <section className="mb-6 p-4 rounded-xl border border-cc-border/80 bg-cc-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${status?.running ? "bg-cc-success" : status?.reconnecting ? "bg-orange-400 animate-pulse" : status?.starting ? "bg-yellow-400 animate-pulse" : "bg-cc-muted/40"}`} />
              <span className="text-sm font-medium">
                {status?.running ? "Running" : status?.reconnecting ? "Reconnecting..." : status?.starting ? "Starting..." : "Stopped"}
              </span>
              {status?.running && (
                <span className="text-xs text-cc-muted">
                  {status.connectedUsers} user{status.connectedUsers !== 1 ? "s" : ""} connected
                </span>
              )}
            </div>
            <div className="flex gap-2">
              {!status?.running && !status?.starting && !status?.reconnecting ? (
                <button
                  onClick={handleStart}
                  disabled={loading || !config?.configured}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/15 border border-cc-primary/30 text-cc-fg hover:bg-cc-primary/25 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Start
                </button>
              ) : status?.running ? (
                <button
                  onClick={handleStop}
                  disabled={loading}
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-error/15 border border-cc-error/30 text-cc-fg hover:bg-cc-error/25 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Stop
                </button>
              ) : null}
            </div>
          </div>
          {status?.error && !status.running && !status.starting && (
            <p className="mt-2 text-xs text-cc-error">{status.error}</p>
          )}
        </section>

        {/* App Credentials */}
        <section className="mb-6 p-4 rounded-xl border border-cc-border/80 bg-cc-card">
          <h2 className="text-sm font-medium mb-3">应用凭证</h2>
          <p className="text-xs text-cc-muted mb-3">
            在 <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer" className="text-cc-primary underline">飞书开放平台</a> 创建企业自建应用，获取 App ID 和 App Secret。
          </p>
          <div className="space-y-3">
            <div>
              <label htmlFor="feishu-app-id" className="block text-sm mb-1">App ID</label>
              <input
                id="feishu-app-id"
                type="text"
                value={appId}
                onChange={(e) => { setAppId(e.target.value); setConfigDirty(true); }}
                placeholder="cli_xxxxxxxxxxxx"
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              />
            </div>
            <div>
              <label htmlFor="feishu-app-secret" className="block text-sm mb-1">App Secret</label>
              <input
                id="feishu-app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => { setAppSecret(e.target.value); setConfigDirty(true); }}
                placeholder={config?.hasAppSecret ? "•••••••• (已配置)" : "输入 App Secret"}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="feishu-domain" className="block text-sm mb-1">域名</label>
                <select
                  id="feishu-domain"
                  value={domain}
                  onChange={(e) => { setDomain(e.target.value); setConfigDirty(true); }}
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
                >
                  <option value="feishu">飞书 (中国)</option>
                  <option value="lark">Lark (海外)</option>
                </select>
              </div>
              <div>
                <label htmlFor="feishu-bot-name" className="block text-sm mb-1">机器人名称</label>
                <input
                  id="feishu-bot-name"
                  type="text"
                  value={botName}
                  onChange={(e) => { setBotName(e.target.value); setConfigDirty(true); }}
                  placeholder="可选"
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
                />
              </div>
            </div>
            <button
              onClick={handleSaveConfig}
              disabled={loading || (!appId.trim() && !config?.configured)}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-primary/15 border border-cc-primary/30 text-cc-fg hover:bg-cc-primary/25 transition-colors disabled:opacity-50 cursor-pointer"
            >
              {config?.configured ? "Update Credentials" : "Save Credentials"}
            </button>
          </div>
        </section>

        {/* Settings */}
        <section className="mb-6 p-4 rounded-xl border border-cc-border/80 bg-cc-card">
          <h2 className="text-sm font-medium mb-3">设置</h2>
          <div className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings?.feishuEnabled)}
                onChange={(e) => handleToggle("feishuEnabled", e.target.checked)}
                className="accent-cc-primary"
              />
              <div>
                <div className="text-sm">启用飞书机器人</div>
                <div className="text-xs text-cc-muted">服务器启动时自动连接飞书</div>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings?.feishuAutoApproveSafe)}
                onChange={(e) => handleToggle("feishuAutoApproveSafe", e.target.checked)}
                className="accent-cc-primary"
              />
              <div>
                <div className="text-sm">自动批准安全工具</div>
                <div className="text-xs text-cc-muted">Read、Glob、Grep 等操作自动批准</div>
              </div>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={Boolean(settings?.feishuForwardDangerous)}
                onChange={(e) => handleToggle("feishuForwardDangerous", e.target.checked)}
                className="accent-cc-primary"
              />
              <div>
                <div className="text-sm">转发危险权限请求</div>
                <div className="text-xs text-cc-muted">Bash (rm)、Write、Edit 等操作转发到飞书审批</div>
              </div>
            </label>
            <div className="pt-2">
              <label htmlFor="feishu-allowed-users" className="block text-sm mb-1">允许的用户</label>
              <p className="text-xs text-cc-muted mb-1.5">逗号分隔的飞书用户 open_id。留空则允许所有用户。</p>
              <input
                id="feishu-allowed-users"
                type="text"
                value={settings?.feishuAllowedUsers ?? ""}
                placeholder="e.g. ou_abc123,ou_def456"
                onBlur={(e) => handleSettingChange({ feishuAllowedUsers: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onChange={(e) => setSettings((prev) => prev ? { ...prev, feishuAllowedUsers: e.target.value } : prev)}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              />
            </div>
            <div className="pt-2">
              <label htmlFor="feishu-permission-mode" className="block text-sm mb-1">默认权限模式</label>
              <p className="text-xs text-cc-muted mb-1.5">新会话的默认权限模式。</p>
              <select
                id="feishu-permission-mode"
                value={settings?.feishuDefaultPermissionMode ?? "acceptEdits"}
                onChange={(e) => handleSettingChange({ feishuDefaultPermissionMode: e.target.value })}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              >
                <option value="acceptEdits">Accept Edits</option>
                <option value="bypassPermissions">Bypass Permissions</option>
                <option value="plan">Plan</option>
                <option value="default">Default</option>
              </select>
            </div>
            <div className="pt-2">
              <label htmlFor="feishu-default-cwd" className="block text-sm mb-1">默认工作目录</label>
              <p className="text-xs text-cc-muted mb-1.5">/new 和 /dir 命令的基础目录。/new &lt;folder&gt; 会在此路径下创建子目录。</p>
              <input
                id="feishu-default-cwd"
                type="text"
                value={settings?.feishuDefaultCwd ?? ""}
                placeholder="e.g. /home/user/projects"
                onBlur={(e) => handleSettingChange({ feishuDefaultCwd: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                onChange={(e) => setSettings((prev) => prev ? { ...prev, feishuDefaultCwd: e.target.value } : prev)}
                className="w-full px-3 py-1.5 text-sm rounded-lg border border-cc-border bg-cc-bg text-cc-fg placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-primary/50"
              />
            </div>
          </div>
        </section>

        {/* Setup Guide */}
        <section className="mb-6 p-4 rounded-xl border border-cc-border/80 bg-cc-card">
          <h2 className="text-sm font-medium mb-3">配置指南</h2>
          <ol className="text-xs text-cc-muted space-y-2 list-decimal list-inside">
            <li>在 <a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer" className="text-cc-primary underline">飞书开放平台</a> 创建企业自建应用</li>
            <li>在 <strong>权限管理</strong> 中开通: <code className="px-1 py-0.5 bg-cc-hover rounded text-cc-fg">im:message</code>、<code className="px-1 py-0.5 bg-cc-hover rounded text-cc-fg">im:message:send_as_bot</code>、<code className="px-1 py-0.5 bg-cc-hover rounded text-cc-fg">im:resource</code>、<code className="px-1 py-0.5 bg-cc-hover rounded text-cc-fg">im:chat</code></li>
            <li>在 <strong>事件与回调</strong> 中订阅 <code className="px-1 py-0.5 bg-cc-hover rounded text-cc-fg">im.message.receive_v1</code>，选择<strong>使用长连接接收事件</strong></li>
            <li>发布应用版本（需要管理员审批）</li>
            <li>在上方填写 App ID 和 App Secret，点击保存</li>
            <li>开启「启用飞书机器人」并点击 Start</li>
          </ol>
        </section>

        {/* Active Sessions */}
        {sessions.length > 0 && (
          <section className="p-4 rounded-xl border border-cc-border/80 bg-cc-card">
            <h2 className="text-sm font-medium mb-3">活跃的飞书会话</h2>
            <div className="space-y-2">
              {sessions.map((s) => (
                <div key={s.userId} className="flex items-center justify-between px-3 py-2 rounded-lg bg-cc-hover/50">
                  <div>
                    <div className="text-xs font-mono text-cc-fg">{s.userId.slice(0, 20)}...</div>
                    <div className="text-xs text-cc-muted">
                      {s.sessionCount} session{s.sessionCount !== 1 ? "s" : ""}
                      {s.activeSession ? ` (active: ${s.activeSession.slice(0, 8)}...)` : ""}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteSession(s.userId)}
                    className="px-2 py-1 text-xs rounded border border-cc-error/30 text-cc-error hover:bg-cc-error/10 transition-colors cursor-pointer"
                  >
                    Kill
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
