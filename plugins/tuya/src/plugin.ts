import sdk, {
  Device,
  DeviceProvider,
  ScryptedDeviceBase,
  ScryptedDeviceType,
  ScryptedInterface,
  ScryptedNativeId,
  Setting,
  Settings
} from "@scrypted/sdk";
import { StorageSettings } from "@scrypted/sdk/storage-settings";

import QRCode from "qrcode-svg";

import { TuyaDevice, TuyaLoginMethod, TuyaMessage, TuyaMessageProtocol, TuyaTokenInfo } from "./tuya/const";
import { TuyaLoginQRCode, TuyaSharingAPI } from "./tuya/sharing";
import { TuyaAccessory } from "./accessories/accessory";
import { TuyaCloudAPI } from "./tuya/cloud";
import { TUYA_COUNTRIES } from "./tuya/deprecated";
import { TuyaPulsarMessage } from "./tuya/pulsar";
import { createTuyaDevice } from "./accessories/factory";
import { TuyaMQ } from "./tuya/mq";
import { DiscoveryController } from "./discovery/controller";
import { DiscoveryRegistry } from "./discovery/registry";
import { DiscoveryState } from "./discovery/types";
import { NetRtspValidator } from "./discovery/rtspValidator";
import { TuyaWebRtcSignalingConfig } from "./tuya/webrtc";

const DISCOVERY_GROUP = "Camera Discovery";
const DISCOVERY_SELECTED_STORAGE_KEY = "tuya.discovery.selected";
const DISCOVERY_DIAGNOSTICS_STORAGE_KEY = "tuya.discovery.diagnostics";
const DISCOVERY_SETTING_SELECTED = "discovery.selected";
const DISCOVERY_SETTING_RETRY_SELECTED = "discovery.retrySelected";
const DISCOVERY_SETTING_FORCE_CONFIRM = "discovery.forceConfirmSelected";
const DISCOVERY_SETTING_REMOVE_SELECTED = "discovery.removeSelected";
const DISCOVERY_SETTING_RETRY_ALL = "discovery.retryAll";
const DISCOVERY_SETTING_EXPORT = "discovery.export";
const DISCOVERY_SETTING_DIAGNOSTICS = "discovery.diagnostics";

export class TuyaPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings {
  api: TuyaSharingAPI | TuyaCloudAPI | undefined;
  mq: TuyaMQ | undefined;
  devices = new Map<string, TuyaAccessory>();
  tuyaDevices = new Map<string, TuyaDevice>();
  tuyaHomeIds: string[] = [];
  discoveryRegistry = new DiscoveryRegistry(this.storage);
  discoveryController: DiscoveryController | undefined;
  private discoveryChoiceMap = new Map<string, string>();

  settingsStorage = new StorageSettings(this, {
    loginMethod: {
      title: "Login Method",
      type: 'radiobutton',
      choices: [TuyaLoginMethod.App, TuyaLoginMethod.Account],
      immediate: true,
      onPut: () => this.tryLogin()
    },
    userCode: {
      title: "User Code",
      description: "Required: You can find this information in Tuya (Smart Life) App -> Settings -> Account and Security -> User Code.",
      onPut: () => this.tryLogin()
    },
    qrCode: {
      title: "Login QR Code",
      type: 'html',
      description: "Scan with the Tuya (Smart Life) app to sign in.",
      readonly: true,
      noStore: true,
      immediate: true,
      mapGet(value) {
        if (value) {
          return new QRCode(`tuyaSmart--qrLogin?token=${(value as TuyaLoginQRCode).result.qrcode}`).svg({ container: "svg" })
        } else {
          return "Refresh browser to get the login QR Code"
        }
      },
    },
    qrCodeLoggedIn: {
      title: "Did scan QR Code?",
      type: "boolean",
      defaultValue: false,
      noStore: true,
      immediate: true,
      onPut: () => this.tryLogin({ loggedInClicked: true })
    },

    // Old development account config
    userId: {
      title: "User ID",
      type: 'string',
      description: "Required: You can find this information in Tuya IoT -> Cloud -> Devices -> Linked Devices.",
      onPut: () => this.tryLogin()
    },
    accessId: {
      title: "Access ID",
      type: 'string',
      description: "Requirerd: This is located on the main project.",
      onPut: () => this.tryLogin()
    },
    accessKey: {
      title: "Access Key/Secret",
      description: "Requirerd: This is located on the main project.",
      type: "password",
      onPut: () => this.tryLogin()
    },
    country: {
      title: "Country",
      description:
        "Required: This is the country where you registered your devices.",
      type: "string",
      choices: TUYA_COUNTRIES.map((value) => value.country),
      onPut: () => this.tryLogin()
    },

    // Token Storage
    tokenInfo: {
      hide: true,
      json: true
    },

    loggedIn: {
      title: "Logged in as: ",
      hide: true,
      noStore: true,
      type: "string",
      readonly: true
    }
  });

  constructor(nativeId?: string) {
    super(nativeId);
    this.tryLogin({ useTokenFromStorage: true });
  }

  async getSettings(): Promise<Setting[]> {
    const userCode = this.settingsStorage.values.userCode || "";
    var loginMethod = this.settingsStorage.values.loginMethod;
    const tokenInfo = this.settingsStorage.values.tokenInfo as TuyaTokenInfo | undefined;

    // If old version had userId, use TuyaLoginMethod.Account
    if (!loginMethod && !!this.settingsStorage.values.userId) {
      loginMethod = TuyaLoginMethod.Account
    } else if (!loginMethod) {
      // Else assign the default login method as app.
      loginMethod = TuyaLoginMethod.App
    }

    this.settingsStorage.settings.loginMethod.defaultValue = loginMethod;

    // Show new login method
    this.settingsStorage.settings.userCode.hide = loginMethod != TuyaLoginMethod.App;
    this.settingsStorage.settings.qrCode.hide = loginMethod != TuyaLoginMethod.App || !userCode || !!this.settingsStorage.values.tokenInfo;
    this.settingsStorage.settings.qrCodeLoggedIn.hide = this.settingsStorage.settings.qrCode.hide;

    // Show old login method
    this.settingsStorage.settings.userId.hide = loginMethod != TuyaLoginMethod.Account;
    this.settingsStorage.settings.accessId.hide = loginMethod != TuyaLoginMethod.Account;
    this.settingsStorage.settings.accessKey.hide = loginMethod != TuyaLoginMethod.Account;
    this.settingsStorage.settings.country.hide = loginMethod != TuyaLoginMethod.Account;
    this.settingsStorage.settings.loggedIn.hide = !tokenInfo;
    if (tokenInfo?.type === TuyaLoginMethod.App) {
      this.settingsStorage.settings.loggedIn.defaultValue = tokenInfo.username || tokenInfo.uid || "";
    } else if (tokenInfo?.type === TuyaLoginMethod.Account) {
      this.settingsStorage.settings.loggedIn.defaultValue = tokenInfo.uid || this.settingsStorage.values.userId || "";
    } else {
      this.settingsStorage.settings.loggedIn.defaultValue = "";
    }
    const baseSettings = await this.settingsStorage.getSettings();
    return [...baseSettings, ...this.getDiscoverySettings()];
  }

  async putSetting(key: string, value: string): Promise<void> {
    if (this.handleDiscoverySetting(key, value)) {
      return;
    }
    return this.settingsStorage.putSetting(key, value);
  }

  async getDevice(nativeId: string) {
    return this.devices.get(nativeId)
  }

  async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> {
    this.console.info(`[${this.name}] (${new Date().toLocaleString()}) Device with id '${nativeId}' was removed.`);
  }

  private async tryLogin(state: { useTokenFromStorage?: boolean, loggedInClicked?: boolean } = {}) {
    this.api = undefined;
    this.mq = undefined;
    this.log.clearAlerts();

    const { useTokenFromStorage, loggedInClicked } = state;

    let storeToken: TuyaTokenInfo | undefined = useTokenFromStorage ? this.settingsStorage.values.tokenInfo : undefined;

    if (!storeToken) {
      var method = this.settingsStorage.values.loginMethod;
      if (!method && !!this.settingsStorage.values.userId) {
        method = TuyaLoginMethod.Account
      } else if (!method) {
        method = TuyaLoginMethod.App
      }

      switch (method) {
        case TuyaLoginMethod.App:
          const userCode = this.settingsStorage.values.userCode;
          const qrCodeValue = this.settingsStorage.settings.qrCode.defaultValue as TuyaLoginQRCode | undefined;
          if (!userCode) {
            this.settingsStorage.settings.qrCode.defaultValue = undefined;
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
          } else if (!qrCodeValue || qrCodeValue.userCode != userCode) {
            this.settingsStorage.settings.qrCode.defaultValue = undefined;
            try {
              const qrCode = await TuyaSharingAPI.generateQRCode(userCode, this.settingsStorage.values.country);
              this.settingsStorage.settings.qrCode.defaultValue = qrCode;
            } catch (e) {
              this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Failed to fetch new QR Code.`, e);
            }
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
          } else if (loggedInClicked) {
            try {
              const token = await TuyaSharingAPI.fetchToken(qrCodeValue);
              storeToken = { type: TuyaLoginMethod.App, ...token };
              this.settingsStorage.settings.qrCode.defaultValue = undefined;
            } catch (e) {
              this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Failed to authenticate with QR Code.`, e);
              this.log.a("Failed to authenticate with credentials. Ensure you scanned the QR Code with Tuya (Smart Life) App and try again.");
            }
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
          }
          break;
        case TuyaLoginMethod.Account:
          try {
            const token = await TuyaCloudAPI.fetchToken(
              this.settingsStorage.values.userId,
              this.settingsStorage.values.accessId,
              this.settingsStorage.values.accessKey,
              this.settingsStorage.values.country
            )
            storeToken = { type: TuyaLoginMethod.Account, ...token };
          } catch (e) {
            this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Failed to authenticate.`, e);
            this.log.a("Failed to authenticate with credentials.");
          }
          break;
      }
    } else {
      this.console.info(`[${this.name}] (${new Date().toLocaleString()}) Using stored token for login.`);
    }

    this.settingsStorage.putSetting('tokenInfo', storeToken ? JSON.stringify(storeToken) : undefined);

    if (!storeToken) return;
    await this.initializeDevices(storeToken);
  }

  private async initializeDevices(token: TuyaTokenInfo) {
    switch (token.type) {
      case TuyaLoginMethod.App:
        this.api = new TuyaSharingAPI(
          token,
          (updatedToken) => {
            this.settingsStorage.putSetting("tokenInfo", JSON.stringify({ ...updatedToken, type: TuyaLoginMethod.App }))
          },
          () => {
            this.settingsStorage.putSetting("tokenInfo", undefined);
            this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Request reauthentication.`);
            this.onDeviceEvent(ScryptedInterface.Settings, undefined);
            this.log.a(`Reauthentication to Tuya required. Refresh plugin to retrieve new QR Code.`)
          }
        );
        break;
      case TuyaLoginMethod.Account:
        this.api = new TuyaCloudAPI(
          token,
          (updatedToken) => {
            this.settingsStorage.putSetting("tokenInfo", JSON.stringify({ ...updatedToken, type: TuyaLoginMethod.Account }))
          },
          () => {
            this.settingsStorage.putSetting("tokenInfo", undefined);
            this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Request reauthentication.`);
            this.log.a(`Reauthentication to Tuya required. Refresh plugin to log in again.`)
          }
        );
    }

    const devices = await this.api.fetchDevices();

    // Some Tuya endpoints return `status` in non-array shapes (or omit it).
    for (const d of devices as any[]) {
      const s = d?.status;

      if (Array.isArray(s)) {
        // ok
      } else if (Array.isArray(s?.status)) {
        // sometimes nested
        d.status = s.status;
      } else if (s && typeof s === 'object') {
        // map -> array of { code, value }
        d.status = Object.entries(s).map(([code, value]) => ({ code, value }));
      } else {
        d.status = [];
      }

      if (!Array.isArray(d.schema)) d.schema = [];
      if (!d.id && (d as any).devId) d.id = (d as any).devId;

      // Normalize status entries to { code, value }
      d.status = (d.status as any[]).map(s => {
        if (!s || typeof s !== 'object') return s;
        return {
          code: (s as any).code ?? (s as any).dpCode ?? (s as any).key,
          value: (s as any).value,
        };
      }).filter(s => s?.code);
    }

    devices.forEach((device) => {
      this.discoveryRegistry.upsertCandidate(
        {
          devId: device.id,
          name: device.name,
          category: device.category,
          productId: device.product_id,
          icon: device.icon,
        },
        device.online,
      );
    });

    this.discoveryController = new DiscoveryController(
      this.discoveryRegistry,
      new NetRtspValidator(),
      async (devId: string) => {
        if (!this.api) {
          throw new Error("Not authenticated with Tuya.");
        }
        const token = await this.api.getRTSP(devId);
        return token.url;
      },
      {
        maxConcurrent: 2,
        debounceMs: 10_000,
        backoffBaseMs: 15_000,
        backoffMaxMs: 10 * 60_000,
        onVerified: (devId: string) => {
          void this.upsertScryptedDevice(devId);
        },
      },
      this.console,
    );

    this.tuyaDevices = new Map(devices.map(device => [device.id, device]));

    this.discoveryRegistry.getRecords().forEach((record) => {
      if (record.online) {
        this.discoveryController?.scheduleProbe(record.devId, { immediate: true });
      }
    });

    this.devices = new Map(
      devices.flatMap(d => {
        const state = this.discoveryRegistry.getState(d.id);
        if (state !== DiscoveryState.Verified && state !== DiscoveryState.Unverified) {
          return [];
        }
        const device = createTuyaDevice(d, this);
        return device ? [[d.id, device] as [string, TuyaAccessory]] : [];
      })
    );

    await sdk.deviceManager.onDevicesChanged({
      devices: Array.from(this.devices.values()).map(d => ({ ...d.deviceSpecs, providerNativeId: this.nativeId }))
    });

    await Promise.all(Array.from(this.devices.values()).map(async (d) => {
      try {
        await d.updateAllValues();
      } catch (e) {
        this.console?.warn?.(
          `[${this.name}] updateAllValues failed for ${d?.tuyaDevice?.name ?? d?.nativeId ?? 'unknown'}: ${e}`
        );
      }
    }));

    try {
      if (this.api instanceof TuyaSharingAPI) {
        const api = this.api;
        const fetch = async () => {
          const homes = await api.queryHomes();
          this.tuyaHomeIds = homes.map(h => h.ownerId);
          return await api.fetchMqttConfig(this.tuyaHomeIds, devices.map(d => d.id));
        }
        this.mq = new TuyaMQ(fetch)
        this.mq.on("message", (mq, msg) => {
          const string = (msg as Buffer).toString('utf-8');
          try {
            const obj = JSON.parse(string) as TuyaMessage;
            if (!obj) return;
            this.onMessage(obj);
          } catch (e) {
            this.console?.warn?.(`[${this.name}] Failed to parse MQTT message: ${e}`);
          }
        });
        this.mq.on("error", (error) => {
          this.console.error(`[${this.name}] (${new Date().toLocaleString()}) failed to connect to mqtt, will retry.`, error)
        });
        await this.mq.start();
      }
    } catch {
      this.console.log(`[${this.name}] (${new Date().toLocaleString()}) Failed to connect to Mqtt. Will not observe live changes to devices.`);
    }
  }

  async getWebRTCSignalingConfig(deviceId: string): Promise<TuyaWebRtcSignalingConfig> {
    if (!this.api) {
      throw new Error("Not authenticated with Tuya.");
    }
    if (!(this.api instanceof TuyaSharingAPI)) {
      throw new Error("WebRTC signaling requires Tuya App login.");
    }
    if (!this.tuyaHomeIds.length) {
      const homes = await this.api.queryHomes();
      this.tuyaHomeIds = homes.map(h => h.ownerId);
    }

    const webrtc = await this.api.getWebRTCConfig(deviceId);
    const mqttConfig = await this.api.fetchMqttConfig(this.tuyaHomeIds, [deviceId]);

    return {
      deviceId,
      webrtc,
      mqtt: {
        url: mqttConfig.url,
        clientId: mqttConfig.clientId,
        username: mqttConfig.username,
        password: mqttConfig.password,
        uid: this.api.getUserId(),
      },
    };
  }

  private getDiscoverySettings(): Setting[] {
    const records = this.discoveryRegistry.getRecords();
    const counts = {
      verified: records.filter(r => r.state === DiscoveryState.Verified).length,
      unverified: records.filter(r => r.state === DiscoveryState.Unverified).length,
      candidates: records.filter(r => r.state === DiscoveryState.Candidate).length,
      offline: records.filter(r => r.online === false).length,
    };

    const summary = `Verified: ${counts.verified} • Unverified: ${counts.unverified} • Candidates: ${counts.candidates} • Offline: ${counts.offline}`;

    const { choices, selectedLabel } = this.buildDiscoveryChoiceLabels(records);

    // If nothing is selected yet, default to the first selectable device.
    if (!this.storage.getItem(DISCOVERY_SELECTED_STORAGE_KEY) && choices.length) {
      const firstDevId = this.discoveryChoiceMap.get(choices[0]);
      if (firstDevId) {
        this.storage.setItem(DISCOVERY_SELECTED_STORAGE_KEY, firstDevId);
      }
    }

    // Recompute selectedLabel after defaulting.
    const recomputed = this.buildDiscoveryChoiceLabels(records);
    const diagnostics = this.storage.getItem(DISCOVERY_DIAGNOSTICS_STORAGE_KEY) ?? "";

    const selectionSetting: Setting = {
      key: DISCOVERY_SETTING_SELECTED,
      group: DISCOVERY_GROUP,
      title: "Target Device",
      type: "string",
      description: recomputed.choices.length
        ? "Choose a candidate or unverified device to manage."
        : "No candidates or unverified devices available.",
      choices: recomputed.choices,
      value: recomputed.selectedLabel,
    };
    return [
      {
        key: "discovery.summary",
        group: DISCOVERY_GROUP,
        title: "Discovery Summary",
        readonly: true,
        value: summary,
      },
      selectionSetting,
      {
        key: DISCOVERY_SETTING_RETRY_SELECTED,
        group: DISCOVERY_GROUP,
        title: "Retry Selected",
        type: "button",
        description: "Retry validation for the selected device.",
      },
      {
        key: DISCOVERY_SETTING_FORCE_CONFIRM,
        group: DISCOVERY_GROUP,
        title: "Force Confirm Selected",
        type: "button",
        description: "Allow the selected device without validation.",
      },
      {
        key: DISCOVERY_SETTING_REMOVE_SELECTED,
        group: DISCOVERY_GROUP,
        title: "Remove/Unconfirm Selected",
        type: "button",
        description: "Remove the candidate or unconfirm a force-confirmed device.",
      },
      {
        key: DISCOVERY_SETTING_RETRY_ALL,
        group: DISCOVERY_GROUP,
        title: "Retry Discovery Now",
        type: "button",
        description: "Retry validation for all candidates.",
      },
      {
        key: DISCOVERY_SETTING_EXPORT,
        group: DISCOVERY_GROUP,
        title: "Export Diagnostics",
        type: "button",
        description: "Generate a redacted diagnostics snapshot.",
      },
      {
        key: DISCOVERY_SETTING_DIAGNOSTICS,
        group: DISCOVERY_GROUP,
        title: "Diagnostics (JSON)",
        type: "textarea",
        readonly: true,
        value: diagnostics,
      },
    ];
  }

  private buildDiscoveryChoiceLabels(
    records: ReturnType<DiscoveryRegistry["getRecords"]>
  ): { choices: string[]; selectedLabel?: string } {
    // Rebuild label -> devId map each time settings are rendered.
    this.discoveryChoiceMap.clear();

    const selectedDevId = this.storage.getItem(DISCOVERY_SELECTED_STORAGE_KEY) ?? "";
    const choices: string[] = [];
    let selectedLabel: string | undefined;

    const labelCounts = new Map<string, number>();
    const selectableRecords = records.filter((r) =>
      r.state === DiscoveryState.Candidate || r.state === DiscoveryState.Unverified
    );

    for (const record of selectableRecords) {
      const stateLabel = record.state === DiscoveryState.Unverified ? "Force confirmed" : "Candidate";
      const statusLabel = record.online === false ? "Offline" : "Online";
      const name = record.identity?.name || "Unknown device";
      const baseLabel = `${name} (${stateLabel}, ${statusLabel}, ${this.redactDevId(record.devId)})`;

      const count = labelCounts.get(baseLabel) ?? 0;
      labelCounts.set(baseLabel, count + 1);
      const label = count > 0 ? `${baseLabel} #${count + 1}` : baseLabel;

      choices.push(label);
      this.discoveryChoiceMap.set(label, record.devId);

      if (record.devId === selectedDevId) {
        selectedLabel = label;
      }
    }

    return { choices, selectedLabel };
  }

  private handleDiscoverySetting(key: string, value: string): boolean {
    if (key === DISCOVERY_SETTING_SELECTED) {
      const devId = value ? this.discoveryChoiceMap.get(value) : undefined;
      if (devId) {
        this.storage.setItem(DISCOVERY_SELECTED_STORAGE_KEY, devId);
      } else {
        this.storage.removeItem(DISCOVERY_SELECTED_STORAGE_KEY);
      }

      this.onDeviceEvent(ScryptedInterface.Settings, undefined);
      return true;
    }

    if (key === DISCOVERY_SETTING_RETRY_SELECTED) {
      const devId = this.storage.getItem(DISCOVERY_SELECTED_STORAGE_KEY);
      if (devId && this.discoveryController) {
        this.discoveryController.scheduleProbe(devId, { immediate: true, force: true });
      }
      return true;
    }

    if (key === DISCOVERY_SETTING_FORCE_CONFIRM) {
      const devId = this.storage.getItem(DISCOVERY_SELECTED_STORAGE_KEY);
      if (devId && this.discoveryController) {
        this.discoveryController.forceConfirm(devId);
        void this.upsertScryptedDevice(devId);
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
      }
      return true;
    }

    if (key === DISCOVERY_SETTING_REMOVE_SELECTED) {
      const devId = this.storage.getItem(DISCOVERY_SELECTED_STORAGE_KEY);
      if (!devId) return true;
      const record = this.discoveryRegistry.getRecord(devId);
      if (!record) return true;
      if (record.state === DiscoveryState.Candidate) {
        this.discoveryRegistry.removeRecord(devId);
      } else {
        this.discoveryRegistry.resetToCandidate(devId);
        void this.removeScryptedDevice(devId);
      }
      this.onDeviceEvent(ScryptedInterface.Settings, undefined);
      return true;
    }

    if (key === DISCOVERY_SETTING_RETRY_ALL) {
      if (this.discoveryController) {
        this.discoveryRegistry.getRecords().forEach(record => {
          if (record.state === DiscoveryState.Verified) return;
          this.discoveryController?.scheduleProbe(record.devId, { immediate: true });
        });
      }
      return true;
    }

    if (key === DISCOVERY_SETTING_EXPORT) {
      const diagnostics = this.buildDiscoveryDiagnostics();
      this.storage.setItem(DISCOVERY_DIAGNOSTICS_STORAGE_KEY, diagnostics);
      this.onDeviceEvent(ScryptedInterface.Settings, undefined);
      return true;
    }

    if (key === DISCOVERY_SETTING_DIAGNOSTICS) {
      return true;
    }

    return false;
  }

  private buildDiscoveryDiagnostics(): string {
    const snapshot = {
      generatedAt: new Date().toISOString(),
      summary: {
        verified: 0,
        forceConfirmed: 0,
        candidates: 0,
        offline: 0,
      },
      records: [] as Array<Record<string, unknown>>,
    };

    for (const record of this.discoveryRegistry.getRecords()) {
      if (record.state === DiscoveryState.Verified) snapshot.summary.verified += 1;
      if (record.state === DiscoveryState.Unverified) snapshot.summary.forceConfirmed += 1;
      if (record.state === DiscoveryState.Candidate) snapshot.summary.candidates += 1;
      if (record.online === false) snapshot.summary.offline += 1;

      snapshot.records.push({
        devId: this.redactDevId(record.devId),
        name: record.identity?.name,
        category: record.identity?.category,
        productId: record.identity?.productId,
        state: record.state,
        online: record.online,
        probe: {
          lastProbeAt: record.probe?.lastProbeAt,
          lastSuccessAt: record.probe?.lastSuccessAt,
          failureCount: record.probe?.failureCount,
          backoffUntil: record.probe?.backoffUntil,
        },
        lastFailure: record.lastFailure
          ? {
              time: record.lastFailure.time,
              statusCode: record.lastFailure.statusCode,
              message: record.lastFailure.message,
            }
          : undefined,
      });
    }

    return JSON.stringify(snapshot, null, 2);
  }

  private redactDevId(devId: string): string {
    if (!devId) return "";
    if (devId.length <= 4) return devId;
    const suffixLength = devId.length <= 6 ? devId.length : 6;
    return `…${devId.slice(-suffixLength)}`;
  }

  private async removeScryptedDevice(devId: string): Promise<void> {
    if (!this.devices.has(devId)) return;
    this.devices.delete(devId);
    await sdk.deviceManager.onDeviceRemoved(devId);
  }

  private async upsertScryptedDevice(devId: string): Promise<void> {
    if (this.devices.has(devId)) return;
    const tuyaDevice = this.tuyaDevices.get(devId);
    if (!tuyaDevice) return;
    const device = createTuyaDevice(tuyaDevice, this);
    if (!device) return;
    this.devices.set(devId, device);

    await sdk.deviceManager.onDevicesChanged({
      devices: Array.from(this.devices.values()).map(d => ({ ...d.deviceSpecs, providerNativeId: this.nativeId })),
    });

    try {
      await device.updateAllValues();
    } catch (e) {
      this.console?.warn?.(
        `[${this.name}] updateAllValues failed for ${device?.tuyaDevice?.name ?? device?.nativeId ?? 'unknown'}: ${e}`
      );
    }
  }

  private onMessage(message: TuyaMessage) {
    this.console.debug("Received new message", JSON.stringify(message));
    if (message.protocol === TuyaMessageProtocol.DEVICE) {
      const device = this.devices.get(message.data.devId);
      void device?.updateStatus(message.data.status).catch((e) => {
        this.console?.warn?.(`[${this.name}] updateStatus failed for ${message.data.devId}: ${e}`);
      });
    } else if (message.protocol === TuyaMessageProtocol.OTHER || message.protocol === TuyaMessageProtocol.LEGACY) {
      const devId = message.data?.bizData?.devId;
      if (!devId) return;
      const device = this.devices.get(devId);
      const bizCode = message.data?.bizCode;
      if (!bizCode) return;
      if (bizCode === "online" || bizCode === "offline") {
        const isOnline = bizCode === "online";
        if (device) {
          device.online = isOnline;
        }
        this.discoveryRegistry.updateOnline(devId, isOnline);
        if (isOnline) {
          this.discoveryController?.scheduleProbe(devId);
        }
      } else if (bizCode === "delete") {
        this.tuyaDevices.delete(devId);
        this.discoveryRegistry.removeRecord(devId);
        void this.removeScryptedDevice(devId);
        if (this.storage.getItem(DISCOVERY_SELECTED_STORAGE_KEY) === devId) {
          this.storage.removeItem(DISCOVERY_SELECTED_STORAGE_KEY);
        }
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
      } else if (bizCode === "nameUpdate") {
        if (!device) return;
        const name = message.data.bizData?.name;
        if (!name) return;
        device.deviceSpecs.name = name;
        void sdk.deviceManager.onDevicesChanged({
          devices: Array.from(this.devices.values()).map(d => ({ ...d.deviceSpecs, providerNativeId: this.nativeId })),
        });
      }
    } else {
      this.console.log("Unknown message received.", message);
    }
  }
}
