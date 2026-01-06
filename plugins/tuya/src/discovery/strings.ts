import { DiscoveryState } from "./types";

export const DiscoveryStrings = {
  stateLabel: {
    [DiscoveryState.Candidate]: "Awaiting validation",
    [DiscoveryState.Verified]: "Validated",
    [DiscoveryState.Unverified]: "Added without validation",
  },
  stateDescription: {
    [DiscoveryState.Candidate]: "We have detected this camera and will validate a video stream URL.",
    [DiscoveryState.Verified]: "This camera has a validated video stream URL.",
    [DiscoveryState.Unverified]: "This camera was added without validation and may require troubleshooting.",
  },
  validationFailed: "Unable to validate the video stream URL.",
  validationSucceeded: "Validated the video stream URL.",
};
