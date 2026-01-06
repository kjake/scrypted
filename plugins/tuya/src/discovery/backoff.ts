export type BackoffOptions = {
  baseMs: number;
  maxMs: number;
  multiplier?: number;
  jitterRatio?: number;
};

export function getBackoffMs(failureCount: number, options: BackoffOptions): number {
  if (failureCount <= 0) return 0;
  const multiplier = options.multiplier ?? 2;
  const jitterRatio = options.jitterRatio ?? 0.2;
  const raw = options.baseMs * Math.pow(multiplier, Math.max(0, failureCount - 1));
  const capped = Math.min(raw, options.maxMs);
  const jitter = capped * jitterRatio * (Math.random() - 0.5) * 2;
  return Math.max(0, Math.round(capped + jitter));
}
