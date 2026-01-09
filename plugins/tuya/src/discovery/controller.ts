import { getBackoffMs } from "./backoff";
import { DiscoveryRegistry } from "./registry";
import { DiscoveryState, FailureInfo } from "./types";
import { RtspValidator } from "./rtspValidator";

export type StreamUrlProvider = (devId: string) => Promise<string>;

export type DiscoveryControllerOptions = {
  maxConcurrent: number;
  debounceMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;

  /**
   * Additional Tuya device categories that should be treated as camera-likely for probing.
   * Categories in this list are probed in addition to the built-in defaults.
   */
  cameraCategories?: string[];

  /**
   * If true, probes will be scheduled for all online devices (not recommended for large Tuya homes).
   * Force/manual probes always bypass category filtering regardless of this flag.
   */
  probeAllCategories?: boolean;

  onVerified?: (devId: string) => void;
};

export class DiscoveryController {
  private pending = new Map<string, boolean>();
  private queue: string[] = [];
  private inFlight = 0;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private registry: DiscoveryRegistry,
    private validator: RtspValidator,
    private getStreamUrl: StreamUrlProvider,
    private options: DiscoveryControllerOptions,
    private logger: Console,
  ) {}

  private isProbeEligible(record: any, force?: boolean): boolean {
    if (!record) return false;
    if (force) return true;

    // Always allow probes for force-confirmed/unverified devices when online.
    if (record.state === DiscoveryState.Unverified) return true;

    // Allow probing everything only when explicitly requested.
    if (this.options.probeAllCategories) return true;

    // Default: probe only camera-likely categories to avoid hammering Tuya for non-camera devices.
    const defaults = [
      "sp",
      "wf_sp",
      "wf_sub_sp",
      "cdsxj",
      "sxj4g",
      "dghsxj",
      "bjsxj",
      "ksdjsxj",
      "znwnsxj",
      "sp_wnq",
      "ksdjml",
      "dmsxj",
      "sp_Gsmart",
      "xcjly",
      "ipcsxj1",
      "cwsxj",
      "dpsxj",
      "ipcsxj2",
      "ydsxj",
      "mobilecam",
      "acc_ctrl_cam",
      "trailcam",
      "one_stop_solution_cam",
      "pettv",
    ];
    const allow = new Set<string>([...defaults, ...(this.options.cameraCategories ?? [])]);

    const category = record.identity?.category;
    if (typeof category !== "string") return false;
    if (allow.has(category)) return true;
    const lowered = category.toLowerCase();
    return lowered.includes("sxj") || lowered.includes("sp") || lowered.includes("cam");
  }

  scheduleProbe(devId: string, options: { immediate?: boolean; force?: boolean } = {}): void {
    const record = this.registry.getRecord(devId);
    if (!record) return;
    if (!options.force && record.state === DiscoveryState.Verified) return;
    if (record.online === false) return;

    // Only probe camera-likely devices by default. Manual/forced probes bypass this filter.
    if (!this.isProbeEligible(record, options.force)) return;

    const now = Date.now();
    const backoffUntil = record.probe.backoffUntil ?? 0;
    const delayFromBackoff = options.force ? 0 : Math.max(0, backoffUntil - now);
    const delay = options.immediate ? 0 : Math.max(this.options.debounceMs, delayFromBackoff);

    const existing = this.timers.get(devId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(devId);
      this.enqueueProbe(devId, options.force);
    }, delay);
    this.timers.set(devId, timer);
  }

  private enqueueProbe(devId: string, force?: boolean): void {
    if (this.pending.has(devId)) {
      if (force) {
        this.pending.set(devId, true);
      }
      return;
    }
    this.pending.set(devId, !!force);
    this.queue.push(devId);
    this.drainQueue();
  }

  private drainQueue(): void {
    while (this.inFlight < this.options.maxConcurrent && this.queue.length > 0) {
      const devId = this.queue.shift();
      if (!devId) continue;
      const force = this.pending.get(devId);
      this.pending.delete(devId);
      this.inFlight += 1;
      void this.runProbe(devId, force).finally(() => {
        this.inFlight -= 1;
        this.drainQueue();
      });
    }
  }

  private async runProbe(devId: string, force?: boolean): Promise<void> {
    const record = this.registry.getRecord(devId);
    if (!record) return;
    if (!force && record.state === DiscoveryState.Verified) return;
    if (!this.isProbeEligible(record, force)) return;

    const now = Date.now();
    this.registry.recordProbeAttempt(devId, now);

    try {
      const url = await this.getStreamUrl(devId);
      const result = await this.validator.validate(url);
      if (result.ok) {
        this.registry.markVerified(devId, Date.now());
        this.options.onVerified?.(devId);
        return;
      }

      const failure = this.createFailure(result.statusCode, result.error ?? "validation-failed");
      this.recordFailure(devId, failure);
    } catch (error) {
      const failure = this.createFailure(undefined, error instanceof Error ? error.message : "validation-error");
      this.recordFailure(devId, failure);
    }
  }

  private recordFailure(devId: string, failure: FailureInfo): void {
    const record = this.registry.getRecord(devId);
    if (!record) return;

    const failureCount = (record.probe.failureCount ?? 0) + 1;
    const backoffMs = getBackoffMs(failureCount, {
      baseMs: this.options.backoffBaseMs,
      maxMs: this.options.backoffMaxMs,
    });
    const backoffUntil = Date.now() + backoffMs;
    this.registry.recordFailure(devId, failure, backoffUntil);
  }

  private createFailure(statusCode?: number, message?: string): FailureInfo {
    return {
      time: Date.now(),
      statusCode,
      message,
    };
  }

  forceConfirm(devId: string): void {
    this.registry.markUnverified(devId);
  }
}
