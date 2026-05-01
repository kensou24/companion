// ─── Re-export barrel for backward compatibility ────────────────────────
// The WeChat bridge implementation has been split into modular files under
// web/server/wechat/. This file re-exports the public API so that existing
// imports (index.ts, routes.ts, wechat-bridge.test.ts) continue to work.

export { WeChatBridge } from "./wechat/wechat-bridge.js";
export { parseCommand, formatSessionName, formatSingleQuestion } from "./wechat/wechat-command-handler.js";
export { isRateLimitError } from "./wechat/wechat-send-queue.js";
export { extractToolResults, isDangerousTool } from "./wechat/wechat-relay.js";
