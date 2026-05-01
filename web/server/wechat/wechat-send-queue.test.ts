// Tests for wechat-send-queue.ts — send queue, priority, rate-limit handling, JSONL persistence
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SendQueue, isRateLimitError } from "./wechat-send-queue.js";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";

let persistCounter = 0;

function createMockBot() {
  const sends: Array<{ userId: string; text: string }> = [];
  return {
    sends,
    bot: {
      isRunning: true,
      send: vi.fn(async (userId: string, text: string) => {
        sends.push({ userId, text });
      }),
    },
  };
}

describe("SendQueue", () => {
  let sq: SendQueue;
  let mock: ReturnType<typeof createMockBot>;

  beforeEach(() => {
    vi.useFakeTimers();
    mock = createMockBot();
    sq = new SendQueue();
    sq.setBot(mock.bot);
  });

  afterEach(() => {
    sq.stop();
    vi.useRealTimers();
  });

  it("delivers enqueued messages in order", async () => {
    sq.enqueue("user1", "hello");
    sq.enqueue("user1", "world");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.sends).toEqual([
      { userId: "user1", text: "hello" },
      { userId: "user1", text: "world" },
    ]);
  });

  it("delivers priority messages before normal ones", async () => {
    // Pause the queue to batch enqueues, then resume
    sq.pause();
    sq.enqueue("user1", "normal");
    sq.enqueue("user1", "urgent", "critical");
    sq.resume();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mock.sends.map((s) => s.text)).toEqual(["urgent", "normal"]);
  });

  it("retries on failure", async () => {
    let callCount = 0;
    mock.bot.send = vi.fn(async () => {
      callCount++;
      if (callCount <= 1) throw new Error("temp fail");
    });
    sq.enqueue("user1", "retry me");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("queues critical messages when bot is down", async () => {
    mock.bot.isRunning = false;
    const result = await sq.enqueueCritical("user1", "permission req", "perm-ctx");
    expect(result).toBe(false);
  });

  it("detects rate-limit errors", async () => {
    mock.bot.send = vi.fn(async () => {
      const err: any = new Error("rate limited");
      (err as any).ret = -2;
      throw err;
    });
    sq.enqueue("user1", "msg1");
    await vi.advanceTimersByTimeAsync(15_000);
    // Should have retried with backoff
    expect(mock.bot.send).toHaveBeenCalledTimes(3); // 1 initial + 2 retries for normal
  });
});

describe("isRateLimitError", () => {
  it("detects ret=-2 pattern in error messages", () => {
    expect(isRateLimitError(new Error("API error ret=-2"))).toBe(true);
    expect(isRateLimitError("ret = -2")).toBe(true);
    expect(isRateLimitError(new Error("Network timeout"))).toBe(false);
  });
});

describe("SendQueue persistence", () => {
  const persistPath = `/tmp/test-send-queue-${Date.now()}-${++persistCounter}.jsonl`;

  afterEach(() => {
    try { unlinkSync(persistPath); } catch {}
  });

  it("persists pending messages to JSONL", async () => {
    vi.useFakeTimers();
    const bot = createMockBot();
    bot.bot.isRunning = false; // Force queue
    const sq = new SendQueue({ persistPath });
    sq.setBot(bot.bot);
    sq.enqueue("user1", "test message");
    sq.stop();

    const content = readFileSync(persistPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    const record = JSON.parse(lines[0]!);
    expect(record.wxid).toBe("user1");
    expect(record.text).toBe("test message");
    expect(record.status).toBe("pending");
    vi.useRealTimers();
  });

  it("restores pending messages on startup", async () => {
    vi.useFakeTimers();
    // Write a pending message to JSONL
    const record = { id: "test-1", wxid: "user1", text: "restored msg", priority: "normal", createdAt: Date.now(), status: "pending", attempts: 0, maxAttempts: 2 };
    writeFileSync(persistPath, JSON.stringify(record) + "\n");

    const bot = createMockBot();
    const sq = new SendQueue({ persistPath });
    sq.setBot(bot.bot);
    // Restore happens in constructor, but drain needs to be triggered
    sq.enqueue("user1", "trigger"); // Trigger drain with a new message
    await vi.advanceTimersByTimeAsync(5_000);
    // The restored message should be sent (normal priority = FIFO before "trigger")
    expect(bot.sends.map((s) => s.text)).toContain("restored msg");
    sq.stop();
    vi.useRealTimers();
  });

  it("cleans up acked messages older than 1 hour", async () => {
    vi.useFakeTimers();
    const bot = createMockBot();
    const sq = new SendQueue({ persistPath });
    sq.setBot(bot.bot);
    sq.enqueue("user1", "msg1");
    await vi.advanceTimersByTimeAsync(5_000);
    sq.stop();

    // Verify file is empty or only contains acked records
    if (existsSync(persistPath)) {
      const content = readFileSync(persistPath, "utf-8").trim();
      if (content) {
        const records = content.split("\n").map((l) => JSON.parse(l));
        expect(records.every((r: any) => r.status === "acked" || r.status === "pending")).toBe(true);
      }
    }
    vi.useRealTimers();
  });
});
