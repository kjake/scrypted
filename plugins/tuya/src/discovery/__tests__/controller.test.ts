import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoveryController } from "../controller";
import { DiscoveryRegistry } from "../registry";
import { DiscoveryState } from "../types";
import { RtspValidator } from "../rtspValidator";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
}

describe("DiscoveryController transitions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves a candidate to verified on successful probe", async () => {
    const registry = new DiscoveryRegistry(new MemoryStorage());
    registry.upsertCandidate({
      devId: "device-1",
      name: "Camera",
      category: "camera",
      productId: "prod",
    });

    const validator: RtspValidator = {
      validate: vi.fn().mockResolvedValue({ ok: true, statusCode: 200 }),
    };
    const getStreamUrl = vi.fn().mockResolvedValue("rtsp://example.com/stream");
    const onVerified = vi.fn();

    const controller = new DiscoveryController(
      registry,
      validator,
      getStreamUrl,
      {
        maxConcurrent: 1,
        debounceMs: 0,
        backoffBaseMs: 1000,
        backoffMaxMs: 10000,
        onVerified,
      },
      console,
    );

    controller.scheduleProbe("device-1", { immediate: true });
    await vi.runAllTimersAsync();

    expect(registry.getState("device-1")).toBe(DiscoveryState.Verified);
    expect(onVerified).toHaveBeenCalledWith("device-1");
  });

  it("force confirms and re-verifies an unverified device", async () => {
    const registry = new DiscoveryRegistry(new MemoryStorage());
    registry.upsertCandidate({
      devId: "device-2",
      name: "Camera 2",
      category: "camera",
      productId: "prod",
    });

    const validator: RtspValidator = {
      validate: vi.fn().mockResolvedValue({ ok: true, statusCode: 200 }),
    };
    const getStreamUrl = vi.fn().mockResolvedValue("rtsp://example.com/stream");

    const controller = new DiscoveryController(
      registry,
      validator,
      getStreamUrl,
      {
        maxConcurrent: 1,
        debounceMs: 0,
        backoffBaseMs: 1000,
        backoffMaxMs: 10000,
      },
      console,
    );

    controller.forceConfirm("device-2");
    expect(registry.getState("device-2")).toBe(DiscoveryState.Unverified);

    controller.scheduleProbe("device-2", { immediate: true });
    await vi.runAllTimersAsync();

    expect(registry.getState("device-2")).toBe(DiscoveryState.Verified);
  });

  it("does not apply force probes to other queued devices", async () => {
    const registry = new DiscoveryRegistry(new MemoryStorage());
    registry.upsertCandidate({
      devId: "device-3",
      name: "Camera 3",
      category: "camera",
      productId: "prod",
    });
    registry.upsertCandidate({
      devId: "device-4",
      name: "Camera 4",
      category: "camera",
      productId: "prod",
    });
    registry.markVerified("device-4", Date.now());

    const validator: RtspValidator = {
      validate: vi.fn().mockResolvedValue({ ok: true, statusCode: 200 }),
    };
    const getStreamUrl = vi.fn().mockResolvedValue("rtsp://example.com/stream");

    const controller = new DiscoveryController(
      registry,
      validator,
      getStreamUrl,
      {
        maxConcurrent: 1,
        debounceMs: 0,
        backoffBaseMs: 1000,
        backoffMaxMs: 10000,
      },
      console,
    );

    controller.scheduleProbe("device-3", { immediate: true, force: true });
    controller.scheduleProbe("device-4", { immediate: true });
    await vi.runAllTimersAsync();

    expect(getStreamUrl).toHaveBeenCalledTimes(1);
    expect(getStreamUrl).toHaveBeenCalledWith("device-3");
  });
});
