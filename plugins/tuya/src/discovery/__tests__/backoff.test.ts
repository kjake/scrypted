import { afterEach, describe, expect, it, vi } from "vitest";
import { getBackoffMs } from "../backoff";

describe("getBackoffMs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero when there are no failures", () => {
    expect(getBackoffMs(0, { baseMs: 1000, maxMs: 10000 })).toBe(0);
  });

  it("applies exponential backoff and caps at max", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    expect(getBackoffMs(1, { baseMs: 1000, maxMs: 10000 })).toBe(1000);
    expect(getBackoffMs(2, { baseMs: 1000, maxMs: 10000 })).toBe(2000);
    expect(getBackoffMs(5, { baseMs: 1000, maxMs: 10000 })).toBe(10000);
  });

  it("adds jitter when configured", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);

    expect(
      getBackoffMs(1, { baseMs: 1000, maxMs: 10000, jitterRatio: 0.2 }),
    ).toBe(1200);
  });
});
