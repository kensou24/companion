// ─── WeChat Health Monitor ───────────────────────────────────────────────
// Periodic health check with graded auto-recovery.
// Level 1: restart bot connection
// Level 2: request QR re-login
// Level 3: full bridge restart

export interface HealthMonitorOptions {
  ping: () => Promise<boolean>;
  intervalMs: number;
  onRecover: (info: { level: number }) => void;
  maxFailuresBeforeRecovery?: number;
}

export class HealthMonitor {
  private ping: () => Promise<boolean>;
  private intervalMs: number;
  private onRecover: (info: { level: number }) => void;
  private maxFailures: number;
  private consecutiveFailures = 0;
  private currentLevel = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: HealthMonitorOptions) {
    this.ping = opts.ping;
    this.intervalMs = opts.intervalMs;
    this.onRecover = opts.onRecover;
    this.maxFailures = opts.maxFailuresBeforeRecovery ?? 3;
  }

  start(): void {
    this.stop();
    this.consecutiveFailures = 0;
    this.currentLevel = 0;
    this.timer = setInterval(() => this.check(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.consecutiveFailures = 0;
    this.currentLevel = 0;
  }

  reset(): void {
    this.consecutiveFailures = 0;
    this.currentLevel = 0;
  }

  private async check(): Promise<void> {
    try {
      const ok = await this.ping();
      if (ok) {
        if (this.consecutiveFailures > 0) {
          console.log(`[wechat-health] Recovered after ${this.consecutiveFailures} failures`);
        }
        this.consecutiveFailures = 0;
        this.currentLevel = 0;
      } else {
        this.handleFailure();
      }
    } catch {
      this.handleFailure();
    }
  }

  private handleFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.maxFailures) {
      this.currentLevel++;
      console.warn(`[wechat-health] ${this.consecutiveFailures} failures, triggering L${this.currentLevel} recovery`);
      this.onRecover({ level: this.currentLevel });
      this.consecutiveFailures = 0; // Reset for next cycle
    }
  }
}
