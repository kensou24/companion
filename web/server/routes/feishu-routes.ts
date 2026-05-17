// ─── Feishu Bot REST Routes ──────────────────────────────────────────────────
// Management endpoints for the Feishu (飞书/Lark) bot integration.

import type { Hono } from "hono";
import type { FeishuBridge } from "../feishu/feishu-bridge.js";

export function registerFeishuRoutes(api: Hono, feishuBridge: FeishuBridge): void {
  // GET /feishu/status — bot status
  api.get("/feishu/status", (c) => {
    const status = feishuBridge.getStatus();
    return c.json(status);
  });

  // POST /feishu/start — start the bot
  api.post("/feishu/start", async (c) => {
    if (feishuBridge.isRunning) {
      return c.json({ ok: true, message: "Already running" });
    }
    try {
      await feishuBridge.start();
      if (feishuBridge.isRunning) {
        return c.json({ ok: true });
      }
      const status = feishuBridge.getStatus();
      return c.json({ ok: false, error: status.error || "Failed to start" }, 500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 500);
    }
  });

  // POST /feishu/stop — stop the bot
  api.post("/feishu/stop", (c) => {
    feishuBridge.stop();
    return c.json({ ok: true });
  });

  // GET /feishu/config — get current config (secrets masked)
  api.get("/feishu/config", (c) => {
    const config = feishuBridge.getConfig();
    if (!config) {
      return c.json({ configured: false });
    }
    return c.json({
      configured: true,
      appId: config.appId ? `${config.appId.slice(0, 4)}****` : "",
      domain: config.domain || "feishu",
      botName: config.botName || "",
      hasAppSecret: !!config.appSecret,
    });
  });

  // PUT /feishu/config — update config
  api.put("/feishu/config", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (!body.appId || !body.appSecret) {
      return c.json({ error: "appId and appSecret are required" }, 400);
    }
    await feishuBridge.saveConfig({
      appId: String(body.appId),
      appSecret: String(body.appSecret),
      domain: typeof body.domain === "string" ? body.domain : "feishu",
      botName: typeof body.botName === "string" ? body.botName : undefined,
    });
    return c.json({ ok: true });
  });

  // GET /feishu/sessions — list Feishu user sessions
  api.get("/feishu/sessions", (c) => {
    const sessions = feishuBridge.getSessions();
    return c.json({ sessions });
  });

  // DELETE /feishu/sessions/:userId — clean up a user's sessions
  api.delete("/feishu/sessions/:userId", async (c) => {
    const userId = c.req.param("userId");
    await feishuBridge.deleteSessionsForUser(userId);
    return c.json({ ok: true });
  });
}
