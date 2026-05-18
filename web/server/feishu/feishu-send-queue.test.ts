import { describe, it, expect, vi, beforeEach } from "vitest";
import { FeishuSendQueue, isFeishuRateLimitError } from "./feishu-send-queue.js";

function mockClient(messageId = "om_test123") {
  return {
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          data: { message_id: messageId },
        }),
        delete: vi.fn().mockResolvedValue({}),
      },
      image: {
        create: vi.fn().mockResolvedValue({
          data: { image_key: "img_key_123" },
        }),
      },
      file: {
        create: vi.fn().mockResolvedValue({
          data: { file_key: "file_key_123" },
        }),
      },
    },
  };
}

describe("FeishuSendQueue", () => {
  let queue: FeishuSendQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new FeishuSendQueue({ minInterval: 0 });
  });

  // ── recallMessage ──────────────────────────────────────────────────────

  describe("recallMessage", () => {
    it("calls im.message.delete with the given message_id", async () => {
      const client = mockClient();
      queue.setClient(client);

      await queue.recallMessage("om_abc");

      expect(client.im.message.delete).toHaveBeenCalledWith({
        path: { message_id: "om_abc" },
      });
    });

    it("does nothing when no client is set", async () => {
      await expect(queue.recallMessage("om_abc")).resolves.toBeUndefined();
    });

    it("does nothing when messageId is empty", async () => {
      const client = mockClient();
      queue.setClient(client);

      await queue.recallMessage("");

      expect(client.im.message.delete).not.toHaveBeenCalled();
    });

    it("swallows errors from the API", async () => {
      const client = mockClient();
      client.im.message.delete = vi.fn().mockRejectedValue(new Error("forbidden"));
      queue.setClient(client);

      await expect(queue.recallMessage("om_abc")).resolves.toBeUndefined();
    });
  });

  // ── enqueueWithMessageId ───────────────────────────────────────────────

  describe("enqueueWithMessageId", () => {
    it("resolves with the message_id after sending", async () => {
      const client = mockClient("om_sent456");
      queue.setClient(client);

      const msgId = await queue.enqueueWithMessageId("chat_1", "hello");

      expect(msgId).toBe("om_sent456");
      expect(client.im.message.create).toHaveBeenCalledTimes(1);
    });

    it("sends as priority and resolves with message_id", async () => {
      const client = mockClient("om_prio789");
      queue.setClient(client);

      const msgId = await queue.enqueueWithMessageId("chat_1", "urgent", true);

      expect(msgId).toBe("om_prio789");
    });
  });

  // ── isFeishuRateLimitError ─────────────────────────────────────────────

  describe("isFeishuRateLimitError", () => {
    it("detects Feishu rate-limit error code 99991400", () => {
      expect(isFeishuRateLimitError({ code: 99991400 })).toBe(true);
    });

    it("detects rate limit in error message string", () => {
      expect(isFeishuRateLimitError(new Error("rate limit exceeded"))).toBe(true);
    });

    it("returns false for non-rate-limit errors", () => {
      expect(isFeishuRateLimitError(new Error("network error"))).toBe(false);
    });
  });
});
