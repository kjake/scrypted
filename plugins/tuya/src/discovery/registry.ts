import { Storage } from "@scrypted/sdk";
import { DiscoveryDeviceIdentity, DiscoveryRecord, DiscoveryState, FailureInfo, ProbeState } from "./types";

const STORAGE_KEY = "tuya.discovery.registry";

export class DiscoveryRegistry {
  private records = new Map<string, DiscoveryRecord>();

  constructor(private storage: Storage, private storageKey: string = STORAGE_KEY) {
    this.load();
  }

  private load(): void {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, DiscoveryRecord>;
      this.records = new Map(Object.entries(parsed ?? {}));
    } catch {
      this.records = new Map();
    }
  }

  private persist(): void {
    const payload: Record<string, DiscoveryRecord> = {};
    for (const [devId, record] of this.records) {
      payload[devId] = record;
    }
    this.storage.setItem(this.storageKey, JSON.stringify(payload));
  }

  getRecord(devId: string): DiscoveryRecord | undefined {
    return this.records.get(devId);
  }

  getRecords(): DiscoveryRecord[] {
    return Array.from(this.records.values());
  }

  getState(devId: string): DiscoveryState | undefined {
    return this.records.get(devId)?.state;
  }

  upsertCandidate(identity: DiscoveryDeviceIdentity, online?: boolean): DiscoveryRecord {
    const existing = this.records.get(identity.devId);
    const probe = existing?.probe ?? this.createProbeState();
    const record: DiscoveryRecord = {
      devId: identity.devId,
      identity,
      state: existing?.state ?? DiscoveryState.Candidate,
      online: online ?? existing?.online,
      probe,
      lastFailure: existing?.lastFailure,
    };
    this.records.set(identity.devId, record);
    this.persist();
    return record;
  }

  upsertCandidates(identities: DiscoveryDeviceIdentity[]): void {
    identities.forEach((identity) => this.upsertCandidate(identity));
  }

  updateOnline(devId: string, online: boolean): void {
    const record = this.records.get(devId);
    if (!record) return;
    record.online = online;
    this.records.set(devId, record);
    this.persist();
  }

  markVerified(devId: string, successAt: number): void {
    const record = this.records.get(devId);
    if (!record) return;
    record.state = DiscoveryState.Verified;
    record.probe.lastSuccessAt = successAt;
    record.probe.failureCount = 0;
    record.probe.backoffUntil = undefined;
    record.lastFailure = undefined;
    this.records.set(devId, record);
    this.persist();
  }

  markUnverified(devId: string): void {
    const record = this.records.get(devId);
    if (!record) return;
    record.state = DiscoveryState.Unverified;
    this.records.set(devId, record);
    this.persist();
  }

  recordProbeAttempt(devId: string, at: number): void {
    const record = this.records.get(devId);
    if (!record) return;
    record.probe.lastProbeAt = at;
    this.records.set(devId, record);
    this.persist();
  }

  recordFailure(devId: string, failure: FailureInfo, backoffUntil?: number): void {
    const record = this.records.get(devId);
    if (!record) return;
    record.lastFailure = failure;
    record.probe.failureCount = (record.probe.failureCount ?? 0) + 1;
    record.probe.backoffUntil = backoffUntil;
    this.records.set(devId, record);
    this.persist();
  }

  private createProbeState(): ProbeState {
    return {
      failureCount: 0,
    };
  }
}
