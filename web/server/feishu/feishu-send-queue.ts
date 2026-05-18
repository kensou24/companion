// ─── Feishu Send Queue ──────────────────────────────────────────────────────
// Serialized send queue with priority support and rate-limit handling for
// Feishu (Lark) bot messaging. Simpler than WeChat — no JSONL persistence.

import type { FeishuSendQueueItem } from "./types.js";

/** Default minimum interval between sends (1 second for Feishu). */
const DEFAULT_SEND_MIN_INTERVAL_MS = 1_000;
/** Cooldown after hitting a rate limit. */
const RATE_LIMIT_COOLDOWN_MS = 5_000;
/** Maximum backoff for rate-limit retries. */
const RATE_LIMIT_MAX_BACKOFF_MS = 30_000;

/** Check if an error looks like a Feishu rate-limit response (code 99991400 or similar). */
export function isFeishuRateLimitError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // Feishu SDK wraps errors with a code field
    if (typeof e.code === "number" && e.code === 99991400) return true;
    // Fallback: check message string
    const s = err instanceof Error ? err.message : String(err);
    if (/rate\s*limit/i.test(s) || /99991400/.test(s)) return true;
  }
  return false;
}

export interface FeishuSendQueueOptions {
  /** Minimum interval between sends in ms (default 1000). */
  minInterval?: number;
}

export class FeishuSendQueue {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private queue: FeishuSendQueueItem[] = [];
  private sending = false;
  private lastSendTs = 0;
  private rateLimitCoolDownUntil = 0;
  private stopped = false;
  private minIntervalMs: number;

  constructor(opts?: FeishuSendQueueOptions) {
    this.minIntervalMs = opts?.minInterval ?? DEFAULT_SEND_MIN_INTERVAL_MS;
  }

  /** Inject the Feishu SDK client (typed as any until we import it dynamically). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setClient(client: any): void {
    this.client = client;
  }

  // ── Enqueue helpers ────────────────────────────────────────────────────

  /** Enqueue a plain text message. */
  enqueue(chatId: string, text: string, priority?: boolean): void {
    this.queue.push({ chatId, text, priority });
    this.drain();
  }

  /** Enqueue a text message and return its Feishu message_id after it's sent. */
  enqueueWithMessageId(chatId: string, text: string, priority?: boolean): Promise<string | null> {
    return new Promise((resolve) => {
      this.queue.push({ chatId, text, priority, _messageIdResolve: resolve });
      this.drain();
    });
  }

  /** Recall (delete) a previously sent message. Best-effort — errors are swallowed. */
  async recallMessage(messageId: string): Promise<void> {
    if (!this.client || !messageId) return;
    try {
      await this.client.im.message.delete({ path: { message_id: messageId } });
    } catch { /* best-effort */ }
  }

  /** Enqueue an interactive card message. cardJson should be a serialized Feishu card JSON string. */
  enqueueCard(chatId: string, cardJson: string, priority?: boolean): void {
    this.queue.push({ chatId, text: "", priority, card: cardJson });
    this.drain();
  }

  /**
   * Enqueue a media message (image or file).
   * @param chatId   Feishu chat / receive_id
   * @param type     "image" or "file"
   * @param data     Binary content
   * @param fileName Required for file type, optional for image
   */
  enqueueMedia(
    chatId: string,
    type: "image" | "file",
    data: Buffer,
    fileName?: string,
    priority?: boolean,
  ): void {
    this.queue.push({
      chatId,
      text: "",
      priority,
      media: { type, data, fileName },
    });
    this.drain();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /** Stop processing the queue (drain will not run). */
  stop(): void {
    this.stopped = true;
  }

  /** Resume processing after a stop. */
  resume(): void {
    this.stopped = false;
    this.drain();
  }

  // ── Internal drain loop ────────────────────────────────────────────────

  private async drain(): Promise<void> {
    if (this.sending || this.stopped) return;
    this.sending = true;
    let deferred = false;

    try {
      while (this.queue.length > 0) {
        // Priority items first
        const prioIdx = this.queue.findIndex((m) => m.priority);
        const item = prioIdx >= 0 ? this.queue.splice(prioIdx, 1)[0]! : this.queue.shift()!;

        if (!this.client) {
          // No client yet — re-queue and retry later
          this.queue.unshift(item);
          setTimeout(() => this.drain(), 3_000);
          deferred = true;
          return;
        }

        // Rate-limit cooldown gate
        const now = Date.now();
        if (now < this.rateLimitCoolDownUntil) {
          this.queue.unshift(item);
          const waitMs = this.rateLimitCoolDownUntil - now;
          setTimeout(() => this.drain(), waitMs);
          deferred = true;
          return;
        }

        // Enforce minimum send interval
        const sinceLast = Date.now() - this.lastSendTs;
        if (sinceLast < this.minIntervalMs) {
          await new Promise((r) => setTimeout(r, this.minIntervalMs - sinceLast));
        }

        // Send with retry
        const maxRetries = item.priority ? 4 : 2;
        let sent = false;
        let rateLimitHit = false;
        let messageId: string | null = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            messageId = await this.sendItem(item);
            sent = true;
            this.lastSendTs = Date.now();
            break;
          } catch (err) {
            if (isFeishuRateLimitError(err)) {
              rateLimitHit = true;
              if (attempt < maxRetries) {
                const backoffMs = Math.min(
                  2_000 * Math.pow(2, attempt),
                  RATE_LIMIT_MAX_BACKOFF_MS,
                );
                await new Promise((r) => setTimeout(r, backoffMs));
              }
            } else {
              console.error(
                `[feishu-send] Send failed (attempt ${attempt + 1}/${maxRetries + 1}):`,
                err instanceof Error ? err.message : err,
              );
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
          // Recovered from rate limit — clear cooldown
          this.rateLimitCoolDownUntil = 0;
        }

        if (!sent) {
          console.warn(
            `[feishu-send] Dropping message to ${item.chatId} after ${maxRetries + 1} failed attempts`,
          );
        }

        item._resolve?.(sent ? "ok" : "failed");
        item._messageIdResolve?.(sent ? messageId : null);
      }
    } finally {
      this.sending = false;
      if (!deferred && this.queue.length > 0) {
        this.drain();
      }
    }
  }

  // ── Send via Feishu SDK ────────────────────────────────────────────────

  /** Dispatch a single queue item through the Feishu client. Returns the message_id if available. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sendItem(item: FeishuSendQueueItem): Promise<string | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resp: any = null;
    if (item.card) {
      // Interactive card message
      resp = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: item.chatId,
          msg_type: "interactive",
          content: item.card,
        },
      });
    } else if (item.media) {
      // Media message — upload first, then send reference
      const media = item.media;
      if (media.type === "image") {
        const uploadResp = await this.client.im.image.create({
          data: { image_type: "message", image: media.data },
        });
        const imageKey = uploadResp?.data?.image_key;
        resp = await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: item.chatId,
            msg_type: "image",
            content: JSON.stringify({ image_key: imageKey }),
          },
        });
      } else {
        // File upload
        const uploadResp = await this.client.im.file.create({
          data: {
            file_type: "stream",
            file_name: media.fileName || "file",
            file: media.data,
          },
        });
        const fileKey = uploadResp?.data?.file_key;
        resp = await this.client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: item.chatId,
            msg_type: "file",
            content: JSON.stringify({ file_key: fileKey }),
          },
        });
      }
    } else if (item.text) {
      // Plain text message
      resp = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: item.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: item.text }),
        },
      });
    }
    return resp?.data?.message_id ?? null;
  }
}
