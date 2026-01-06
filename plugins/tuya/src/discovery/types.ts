export enum DiscoveryState {
  Candidate = "candidate",
  Verified = "verified",
  Unverified = "unverified",
}

export type DiscoveryDeviceIdentity = {
  devId: string;
  name: string;
  category: string;
  productId?: string;
  icon?: string;
};

export type ProbeState = {
  lastProbeAt?: number;
  lastSuccessAt?: number;
  failureCount: number;
  backoffUntil?: number;
};

export type FailureInfo = {
  time: number;
  statusCode?: number;
  message?: string;
};

export type DiscoveryRecord = {
  devId: string;
  identity: DiscoveryDeviceIdentity;
  state: DiscoveryState;
  online?: boolean;
  probe: ProbeState;
  lastFailure?: FailureInfo;
};
