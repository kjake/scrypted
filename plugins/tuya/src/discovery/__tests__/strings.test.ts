import { describe, expect, it } from "vitest";
import { DiscoveryStrings } from "../strings";
import { DiscoveryState } from "../types";

describe("DiscoveryStrings", () => {
  it("maps user-facing labels for every state", () => {
    expect(DiscoveryStrings.stateLabel[DiscoveryState.Candidate]).toBeDefined();
    expect(DiscoveryStrings.stateLabel[DiscoveryState.Verified]).toBeDefined();
    expect(DiscoveryStrings.stateLabel[DiscoveryState.Unverified]).toBeDefined();
  });

  it("maps user-facing descriptions for every state", () => {
    expect(DiscoveryStrings.stateDescription[DiscoveryState.Candidate]).toContain("video stream URL");
    expect(DiscoveryStrings.stateDescription[DiscoveryState.Verified]).toContain("video stream URL");
    expect(DiscoveryStrings.stateDescription[DiscoveryState.Unverified]).toContain("without validation");
  });

  it("exposes validation outcome strings", () => {
    expect(DiscoveryStrings.validationFailed).toContain("video stream URL");
    expect(DiscoveryStrings.validationSucceeded).toContain("video stream URL");
  });
});
