import sdk, {
  ScryptedDeviceBase,
  VideoCamera,
  MotionSensor,
  BinarySensor,
  MediaObject,
  MediaStreamOptions,
  MediaStreamUrl,
  ScryptedMimeTypes,
  ResponseMediaStreamOptions,
  OnOff,
  DeviceProvider,
  Online,
  Logger,
  Intercom,
  ScryptedNativeId,
  Device,
  ScryptedDeviceType,
  ScryptedInterface,
  RTCAVSignalingSetup,
  RTCSessionControl,
  RTCSignalingChannel,
  RTCSignalingOptions,
  RTCSignalingSendIceCandidate,
  RTCSignalingSession,
} from "@scrypted/sdk";
import { connectRTCSignalingClients } from "@scrypted/common/src/rtc-signaling";
import { TuyaAccessory } from "./accessory";
import { TuyaDeviceStatus } from "../tuya/const";
import { TuyaWebRtcSignalingClient } from "../tuya/webrtc";

// TODO: Allow setting motion info based on dp name?
const SCHEMA_CODE = {
  MOTION_ON: ['motion_switch', 'pir_sensitivity', 'motion_sensitivity'],
  MOTION_DETECT: ['movement_detect_pic'],
  // Indicates that this is possibly a doorbell
  DOORBELL: ['doorbell_ring_exist'],
  // Notifies when a doorbell ring occurs.
  DOORBELL_RING: ['doorbell_pic'],
  // Notifies when a doorbell ring or motion occurs.
  ALARM_MESSAGE: ['alarm_message'],
  LIGHT_ON: ['floodlight_switch'],
  LIGHT_BRIGHT: ['floodlight_lightness'],
  INDICATOR: ["basic_indicator"]
};

class TuyaRTCSessionControl implements RTCSessionControl {
  constructor(private signaling: TuyaWebRtcSignalingClient) {}

  async setPlayback(_: { audio: boolean; video: boolean }): Promise<void> {}

  async getRefreshAt(): Promise<number | void> {
    return undefined;
  }

  async extendSession(): Promise<void> {}

  async endSession(): Promise<void> {
    await this.signaling.disconnect();
  }
}

function createTuyaOfferSetup(iceServers: RTCIceServer[]): RTCAVSignalingSetup {
  return {
    type: "offer",
    configuration: {
      iceServers,
    },
    audio: {
      direction: "recvonly",
    },
    video: {
      direction: "recvonly",
    },
  };
}

export class TuyaCamera extends TuyaAccessory implements DeviceProvider, VideoCamera, BinarySensor, MotionSensor, OnOff, RTCSignalingChannel {
  private lightAccessory: ScryptedDeviceBase | undefined;

  get deviceSpecs(): Device {
    const indicatorSchema = !!this.getSchema(...SCHEMA_CODE.INDICATOR);
    const motionSchema = !!this.getSchema(...SCHEMA_CODE.MOTION_ON);
    const doorbellSchema = !!this.getSchema(...SCHEMA_CODE.DOORBELL) && !!this.getSchema(...SCHEMA_CODE.ALARM_MESSAGE, ...SCHEMA_CODE.DOORBELL_RING);

    return {
      ...super.deviceSpecs,
      type: doorbellSchema ? ScryptedDeviceType.Doorbell : ScryptedDeviceType.Camera,
      interfaces: [
        ...super.deviceSpecs.interfaces,
        ScryptedInterface.VideoCamera,
        ScryptedInterface.DeviceProvider,
        ScryptedInterface.RTCSignalingChannel,
        indicatorSchema ? ScryptedInterface.OnOff : null,
        motionSchema ? ScryptedInterface.MotionSensor : null,
        doorbellSchema ? ScryptedInterface.BinarySensor : null,
      ]
        .filter((p): p is ScryptedInterface => !!p)
    }
  }

  async getDevice(nativeId: ScryptedNativeId) {
    if (nativeId === this.nativeId + "-light") {
      return this.lightAccessory;
    } else {
      throw new Error("Light not found")
    }
  }

  async releaseDevice(id: string, nativeId: ScryptedNativeId): Promise<void> { }

  // OnOff Status Indicator
  async turnOff(): Promise<void> {
    const indicatorSchema = this.getSchema(...SCHEMA_CODE.INDICATOR);
    if (!indicatorSchema || indicatorSchema.mode == "r") return;
    await this.sendCommands({ code: indicatorSchema.code, value: false })
  }

  async turnOn(): Promise<void> {
    const indicatorSchema = this.getSchema(...SCHEMA_CODE.INDICATOR);
    if (!indicatorSchema || indicatorSchema.mode == "r") return;
    await this.sendCommands({ code: indicatorSchema.code, value: true })
  }

  // Video Camera
  async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
    // Always create new rtsp since it can only be used once and we only have 30 seconds before we can
    // use it.
    if (!this.tuyaDevice.online) {
      this.log.e(`${this.name} is currently offline. Will not be able to stream until device is back online.`);
      throw new Error(`Failed to stream ${this.name}: Camera is offline.`);
    }

    const rtsps = await this.plugin.api?.getRTSP(this.tuyaDevice.id);

    if (!rtsps) {
      this.log.e("There was an error retreiving camera's live feed camera feed.");
      throw new Error(`Failed to capture stream for ${this.name}: RTSPS link not found.`);
    }

    return this.createMediaObject(
      {
        url: rtsps.url,
        container: "rtsp",
        mediaStreamOptions: (await this.getVideoStreamOptions())[0],
      } satisfies MediaStreamUrl,
      ScryptedMimeTypes.MediaStreamUrl
    );
  }

  async getVideoStreamOptions(): Promise<[ResponseMediaStreamOptions]> {
    return [
      {
        id: "cloud-rtsp",
        name: "Cloud RTSP",
        container: "rtsp",
        video: {
          codec: "h264",
        },
        audio: {
          codec: "pcm_mulaw",
        },
        source: "cloud",
        tool: "ffmpeg",
      },
    ];
  }

  async startRTCSignalingSession(session: RTCSignalingSession): Promise<RTCSessionControl> {
    if (!this.tuyaDevice.online) {
      throw new Error(`Failed to stream ${this.name}: Camera is offline.`);
    }

    const signalingConfig = await this.plugin.getWebRTCSignalingConfig(this.tuyaDevice.id);
    const signaling = new TuyaWebRtcSignalingClient(signalingConfig);
    await signaling.connect();

    let answerSdp = "";
    let answerResolve: ((sdp: string) => void) | undefined;
    let answerReject: ((error: Error) => void) | undefined;

    const answerPromise = new Promise<string>((resolve, reject) => {
      answerResolve = resolve;
      answerReject = reject;
    });

    const options: RTCSignalingOptions = {
      requiresOffer: true,
      disableTrickle: false,
    };

    signaling.onAnswer = (answer) => {
      answerResolve?.(answer.sdp);
    };
    signaling.onDisconnect = () => {
      answerReject?.(new Error("Tuya signaling session ended."));
    };
    signaling.onError = (error) => {
      answerReject?.(error);
    };

    const tuyaSession: RTCSignalingSession = {
      __proxy_props: {
        options,
      },
      options,
      createLocalDescription: async (
        type: "offer" | "answer",
        _: RTCAVSignalingSetup,
        sendIceCandidate?: RTCSignalingSendIceCandidate
      ): Promise<RTCSessionDescriptionInit> => {
        if (type !== "answer") {
          throw new Error("Tuya cameras only support RTC answer.");
        }

        if (sendIceCandidate) {
          signaling.onCandidate = (candidate) => {
            sendIceCandidate({
              candidate: candidate.candidate,
              sdpMid: "0",
              sdpMLineIndex: 0,
            });
          };
        }

        return {
          type: "answer",
          sdp: answerSdp,
        };
      },
      setRemoteDescription: async (description: RTCSessionDescriptionInit) => {
        if (!description.sdp) {
          throw new Error("Missing RTC offer for Tuya WebRTC session.");
        }

        await signaling.sendOffer(description.sdp);
        answerSdp = await answerPromise;
      },
      addIceCandidate: async (candidate: RTCIceCandidateInit) => {
        if (!candidate.candidate) return;
        await signaling.sendCandidate(candidate.candidate);
      },
      getOptions: async () => options,
    };

    const iceServers = signalingConfig.webrtc.p2pConfig.ices.map((ice) => ({
      urls: ice.urls,
      username: ice.username,
      credential: ice.credential,
    }));

    await connectRTCSignalingClients(
      this.console,
      session,
      createTuyaOfferSetup(iceServers),
      tuyaSession,
      {}
    );

    return new TuyaRTCSessionControl(signaling);
  }

  async updateStatus(status: TuyaDeviceStatus[]): Promise<void> {
    const statusArray: TuyaDeviceStatus[] = Array.isArray(status) ? status : [];
    await super.updateStatus(statusArray);

    const indicatorSchema = this.getSchema(...SCHEMA_CODE.INDICATOR);
    if (indicatorSchema) {
      const indicatorStatus = statusArray.find(s => s.code === indicatorSchema.code);
      indicatorStatus && (this.on = indicatorStatus.value === true)
    }

    const motionSchema = this.getSchema(...SCHEMA_CODE.MOTION_DETECT);
    if (this.getSchema(...SCHEMA_CODE.MOTION_ON) && motionSchema) {
      const motionStatus = statusArray.find(s => s.code === motionSchema.code);
      const isNonTrivialString = (v: any) => typeof v === 'string' && v.length > 1;
      motionStatus && isNonTrivialString(motionStatus.value) && this.debounce(
        motionSchema,
        10 * 1000,
        () => this.motionDetected = true,
        () => this.motionDetected = false,
      )
    }

    const doorbellNotifSchema = this.getSchema(...SCHEMA_CODE.ALARM_MESSAGE, ...SCHEMA_CODE.DOORBELL_RING);
    if (this.getSchema(...SCHEMA_CODE.DOORBELL) && doorbellNotifSchema) {
      const doorbellStatus = statusArray.find(s => [...SCHEMA_CODE.ALARM_MESSAGE, ...SCHEMA_CODE.DOORBELL_RING].includes(s.code));
      const isNonTrivialString = (v: any) => typeof v === 'string' && v.length > 1;
      doorbellStatus && isNonTrivialString(doorbellStatus.value) && this.debounce(
        doorbellNotifSchema,
        10 * 1000,
        () => this.binaryState = true,
        () => this.binaryState = false
      );
    }

    const lightSchema = this.getSchema(...SCHEMA_CODE.LIGHT_ON);
    if (lightSchema) {
      const plugin = this.plugin;
      const deviceId = this.tuyaDevice.id;

      if (!this.lightAccessory) {
        this.lightAccessory = Object.assign(
          new ScryptedDeviceBase(this.tuyaDevice.id + "-light"),
          {
            turnOff: async function () {
              await plugin.api?.sendCommands(deviceId, [{ code: lightSchema.code, value: false }])
            },
            turnOn: async function () {
              await plugin.api?.sendCommands(deviceId, [{ code: lightSchema.code, value: true }])
            },
          } satisfies OnOff & Online
        );

        await sdk.deviceManager.onDeviceDiscovered(
          {
            providerNativeId: this.tuyaDevice.id,
            name: this.tuyaDevice.name + " Light",
            nativeId: this.lightAccessory.nativeId,
            info: this.deviceSpecs.info,
            type: ScryptedDeviceType.Light,
            interfaces: [
              ScryptedInterface.OnOff,
              ScryptedInterface.Online
            ]
          }
        )
      }

      const lightStatus = statusArray.find(s => s.code === lightSchema.code);
      lightStatus && (this.lightAccessory.on = !!lightStatus.value);
    }
  }
}
