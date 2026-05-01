// Tests for wechat-health-monitor.ts — health check and graded auto-recovery
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HealthMonitor } from "./wechat-health-monitor.js";

describe("HealthMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports healthy when bot responds to ping", async () => {
    const onRecover = vi.fn();
    const ping = vi.fn().mockResolvedValue(true);
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(onRecover).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("triggers L1 recovery after 3 consecutive failures", async () => {
    const onRecover = vi.fn();
    const ping = vi.fn().mockRejectedValue(new Error("down"));
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(180_000); // 3 x 60s
    expect(onRecover).toHaveBeenCalledWith({ level: 1 });
    monitor.stop();
  });

  it("escalates to L2 after L1 fails", async () => {
    const onRecover = vi.fn();
    let callCount = 0;
    const ping = vi.fn(async () => {
      callCount++;
      if (callCount <= 6) throw new Error("down");
      return true;
    });
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(360_000); // 6 x 60s
    expect(onRecover).toHaveBeenCalledWith({ level: 1 });
    expect(onRecover).toHaveBeenCalledWith({ level: 2 });
    monitor.stop();
  });

  it("resets when health check succeeds after failures", async () => {
    const onRecover = vi.fn();
    let callCount = 0;
    const ping = vi.fn(async () => {
      callCount++;
      // First 2 fail, then succeed
      return callCount > 2;
    });
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(180_000); // 3 x 60s
    // 2 failures then success — no recovery triggered
    expect(onRecover).not.toHaveBeenCalled();
    monitor.stop();
  });

  it("stops monitoring when stop() is called", async () => {
    const onRecover = vi.fn();
    const ping = vi.fn().mockRejectedValue(new Error("down"));
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover });
    monitor.start();
    await vi.advanceTimersByTimeAsync(60_000);
    monitor.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    // Only 1 ping after stop (no more)
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("uses custom maxFailuresBeforeRecovery", async () => {
    const onRecover = vi.fn();
    const ping = vi.fn().mockRejectedValue(new Error("down"));
    const monitor = new HealthMonitor({ ping, intervalMs: 60_000, onRecover, maxFailuresBeforeRecovery: 5 });
    monitor.start();
    await vi.advanceTimersByTimeAsync(240_000); // 4 x 60s — not enough
    expect(onRecover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); // 5th check
    expect(onRecover).toHaveBeenCalledWith({ level: 1 });
    monitor.stop();
  });
});
