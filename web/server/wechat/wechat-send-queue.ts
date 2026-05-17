// ─── WeChat Send Queue ────────────────────────────────────────────────────
// Serialized send queue with priority support, rate-limit handling, and
// critical message retry. Extracted from WeChatBridge for modular architecture.

import { splitForWeChat } from "../wechat-formatter.js";
import type { SendQueueItem, CriticalPendingItem } from "./types.js";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const SEND_MIN_INTERVAL_MS = 2_000;
const RATE_LIMIT_COOLDOWN_MS = 10_000;
const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

interface PersistedRecord {
  id: string;
  wxid: string;
  text: string;
  priority: "normal" | "critical";
  createdAt: number;
  status: "pending" | "acked" | "failed";
  attempts: number;
  maxAttempts: number;
}

/** Check if an error is a WeChat API rate-limit signal (ret=-2). */
export function isRateLimitError(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err);
  return /ret\s*=\s*-2/i.test(s);
}

export interface SendQueueOptions {
  persistPath?: string;
}

export class SendQueue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private bot: any = null;
  private queue: SendQueueItem[] = [];
  private sending = false;
  private criticalPending: CriticalPendingItem[] = [];
  private criticalRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSendTs = 0;
  private rateLimitCoolDownUntil = 0;
  private stopped = false;
  private persistPath: string | undefined;
  private recordIdCounter = 0;

  constructor(opts?: SendQueueOptions) {
    this.persistPath = opts?.persistPath;
    if (this.persistPath) {
      this.restorePending();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setBot(bot: any): void {
    this.bot = bot;
  }

  enqueue(userId: string, text: string, priority?: "normal" | "critical"): void {
    const chunks = splitForWeChat(text);
    for (const chunk of chunks) {
      if (priority === "critical") {
        this.queue.push({ userId, text: chunk, priority: true });
      } else {
        this.queue.push({ userId, text: chunk });
      }
      this.appendRecord({
        id: `sq-${++this.recordIdCounter}`,
        wxid: userId,
        text: chunk,
        priority: priority ?? "normal",
        createdAt: Date.now(),
        status: "pending",
        attempts: 0,
        maxAttempts: priority === "critical" ? 6 : 3,
      });
    }
    this.drain();
  }

  /** Enqueue a media item (image, file, or video) for sending. */
  enqueueMedia(userId: string, media: { type: "image" | "file" | "video"; data: Buffer; fileName?: string; caption?: string }, priority?: boolean): void {
    this.queue.push({ userId, text: "", priority, media });
    this.drain();
  }

  async enqueueCritical(userId: string, text: string, context: string): Promise<boolean> {
    if (!this.bot?.isRunning) {
      console.warn(`[wechat-send] Bot not running, queuing critical: ${context}`);
      this.criticalPending.push({ userId, text, context });
      this.scheduleCriticalRetry();
      return false;
    }
    const chunks = splitForWeChat(text);
    const settled: Array<"ok" | "failed"> = [];
    for (const chunk of chunks) {
      this.queue.push({ userId, text: chunk, priority: true, _resolve: (r) => settled.push(r) });
    }
    this.drain();
    // Wait for all chunks to settle
    while (settled.length < chunks.length) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (settled.includes("failed")) {
      this.criticalPending.push({ userId, text, context });
      this.scheduleCriticalRetry();
      return false;
    }
    return true;
  }

  enqueueCriticalPending(userId: string, text: string, context: string): void {
    this.criticalPending.push({ userId, text, context });
    this.scheduleCriticalRetry();
  }

  pause(): void { this.stopped = true; }
  resume(): void { this.stopped = false; this.drain(); }

  stop(): void {
    this.stopped = true;
    if (this.criticalRetryTimer) {
      clearTimeout(this.criticalRetryTimer);
      this.criticalRetryTimer = null;
    }
  }

  private async drain(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    let deferred = false;
    try {
      while (this.queue.length > 0) {
        const prioIdx = this.queue.findIndex((m) => m.priority);
        const item = prioIdx >= 0 ? this.queue.splice(prioIdx, 1)[0]! : this.queue.shift()!;

        if (!this.bot?.isRunning) {
          this.queue.unshift(item);
          setTimeout(() => this.drain(), 5_000);
          deferred = true;
          return;
        }

        const now = Date.now();
        if (now < this.rateLimitCoolDownUntil) {
          this.queue.unshift(item);
          const waitMs = this.rateLimitCoolDownUntil - now;
          setTimeout(() => this.drain(), waitMs);
          deferred = true;
          return;
        }

        const sinceLast = Date.now() - this.lastSendTs;
        if (sinceLast < SEND_MIN_INTERVAL_MS) {
          await new Promise((r) => setTimeout(r, SEND_MIN_INTERVAL_MS - sinceLast));
        }

        const maxRetries = item.priority ? 5 : 2;
        let sent = false;
        let rateLimitHit = false;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            if (item.media) {
              // Send media via bot.reply or bot.send with media content
              const m = item.media;
              if (m.type === "image") {
                await this.bot.send(item.userId, { image: m.data, caption: m.caption });
              } else if (m.type === "video") {
                await this.bot.send(item.userId, { video: m.data, caption: m.caption });
              } else {
                await this.bot.send(item.userId, { file: m.data, fileName: m.fileName || "file", caption: m.caption });
              }
            } else {
              await this.bot.send(item.userId, item.text);
            }
            sent = true;
            this.lastSendTs = Date.now();
            break;
          } catch (err) {
            if (isRateLimitError(err)) {
              rateLimitHit = true;
              if (attempt < maxRetries) {
                const backoffMs = Math.min(5_000 * Math.pow(2, attempt), RATE_LIMIT_MAX_BACKOFF_MS);
                await new Promise((r) => setTimeout(r, backoffMs));
              }
            } else {
              if (attempt < maxRetries) {
                await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
              }
            }
          }
        }

        if (rateLimitHit && !sent) {
          this.rateLimitCoolDownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        }
        if (sent && rateLimitHit) {
          this.rateLimitCoolDownUntil = 0;
        }

        this.appendRecord({
          id: `sq-${this.recordIdCounter}`,
          wxid: item.userId,
          text: item.text,
          priority: item.priority ? "critical" : "normal",
          createdAt: Date.now(),
          status: sent ? "acked" : "failed",
          attempts: 1,
          maxAttempts: 1,
        });

        item._resolve?.(sent ? "ok" : "failed");
      }
    } finally {
      this.sending = false;
      if (!deferred && this.queue.length > 0) {
        this.drain();
      }
    }
  }

  private scheduleCriticalRetry(): void {
    if (this.criticalRetryTimer) return;
    this.criticalRetryTimer = setTimeout(() => {
      this.criticalRetryTimer = null;
      this.flushCriticalPending();
    }, 3_000);
  }

  private flushCriticalPending(): void {
    if (this.criticalPending.length === 0) return;
    if (!this.bot?.isRunning) {
      this.scheduleCriticalRetry();
      return;
    }
    while (this.criticalPending.length > 0) {
      const item = this.criticalPending.shift()!;
      this.queue.push({ userId: item.userId, text: item.text, priority: true });
    }
    this.drain();
  }

  // ── JSONL Persistence ──────────────────────────────────────────────────

  private appendRecord(record: PersistedRecord): void {
    if (!this.persistPath) return;
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.persistPath, JSON.stringify(record) + "\n");
    } catch (err) {
      console.error("[wechat-send] Failed to persist record:", err);
    }
  }

  private restorePending(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const content = readFileSync(this.persistPath, "utf-8").trim();
      if (!content) return;
      const lines = content.split("\n");
      let restored = 0;
      const keptRecords: string[] = [];
      const oneHourAgo = Date.now() - 3_600_000;

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as PersistedRecord;
          if (record.status === "pending") {
            // Re-enqueue pending messages
            this.queue.push({ userId: record.wxid, text: record.text, priority: record.priority === "critical" ? true : undefined });
            restored++;
          }
          // Keep acked records less than 1 hour old for audit
          if (record.status === "acked" && record.createdAt > oneHourAgo) {
            keptRecords.push(line);
          }
        } catch {
          // Skip malformed lines
        }
      }

      // Rewrite file with only kept records
      if (keptRecords.length < lines.length) {
        try {
          if (keptRecords.length === 0) {
            unlinkSync(this.persistPath);
          } else {
            writeFileSync(this.persistPath, keptRecords.join("\n") + "\n");
          }
        } catch {
          // Ignore cleanup errors
        }
      }

      if (restored > 0) {
        console.log(`[wechat-send] Restored ${restored} pending messages from JSONL`);
      }
    } catch (err) {
      console.error("[wechat-send] Failed to restore pending messages:", err);
    }
  }
}
