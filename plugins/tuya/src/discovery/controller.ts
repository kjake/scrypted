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
  onVerified?: (devId: string) => void;
};

export class DiscoveryController {
  private pending = new Set<string>();
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

  scheduleProbe(devId: string, options: { immediate?: boolean; force?: boolean } = {}): void {
    const record = this.registry.getRecord(devId);
    if (!record) return;
    if (!options.force && record.state === DiscoveryState.Verified) return;
    if (record.online === false) return;

    const now = Date.now();
    const backoffUntil = record.probe.backoffUntil ?? 0;
    const delayFromBackoff = Math.max(0, backoffUntil - now);
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
    if (this.pending.has(devId)) return;
    this.pending.add(devId);
    this.queue.push(devId);
    this.drainQueue(force);
  }

  private drainQueue(force?: boolean): void {
    while (this.inFlight < this.options.maxConcurrent && this.queue.length > 0) {
      const devId = this.queue.shift();
      if (!devId) continue;
      this.pending.delete(devId);
      this.inFlight += 1;
      void this.runProbe(devId, force).finally(() => {
        this.inFlight -= 1;
        this.drainQueue(force);
      });
    }
  }

  private async runProbe(devId: string, force?: boolean): Promise<void> {
    const record = this.registry.getRecord(devId);
    if (!record) return;
    if (!force && record.state === DiscoveryState.Verified) return;

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
