import { connect, MqttClient } from "mqtt";
import { randomBytes } from "node:crypto";
import { logDebug } from "./debug";

export type TuyaWebRtcIceServer = {
  urls: string;
  credential?: string;
  username?: string;
  ttl?: number;
};

export type TuyaWebRtcConfig = {
  auth: string;
  motoId: string;
  p2pConfig: {
    ices: TuyaWebRtcIceServer[];
  };
};

export type TuyaWebRtcMqttConfig = {
  url: string;
  clientId: string;
  username: string;
  password: string;
  uid: string;
};

export type TuyaWebRtcSignalingConfig = {
  deviceId: string;
  webrtc: TuyaWebRtcConfig;
  mqtt: TuyaWebRtcMqttConfig;
};

type TuyaMqttFrameHeader = {
  type: string;
  from: string;
  to: string;
  sessionid: string;
  moto_id: string;
  tid: string;
  seq: number;
  rtx: number;
};

type TuyaMqttFrame = {
  header: TuyaMqttFrameHeader;
  msg: string;
};

type TuyaMqttMessage = {
  protocol: number;
  pv: string;
  t: number;
  data: TuyaMqttFrame;
};

type TuyaOfferFrame = {
  mode: "webrtc";
  sdp: string;
  stream_type: number;
  auth: string;
  token: TuyaWebRtcIceServer[];
  replay: { is_replay: number };
  datachannel_enable: boolean;
};

type TuyaAnswerFrame = {
  mode: "webrtc";
  sdp: string;
};

type TuyaCandidateFrame = {
  mode: "webrtc";
  candidate: string;
};

export class TuyaWebRtcSignalingClient {
  private client?: MqttClient;
  private readonly sessionId = randomBytes(16).toString("hex");
  private readonly publishTopic: string;
  private readonly subscribeTopic: string;

  onAnswer?: (answer: TuyaAnswerFrame) => void;
  onCandidate?: (candidate: TuyaCandidateFrame) => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;

  constructor(private config: TuyaWebRtcSignalingConfig) {
    this.publishTopic = `/av/moto/${config.webrtc.motoId}/u/${config.deviceId}`;
    this.subscribeTopic = `/av/u/${config.mqtt.uid}`;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      logDebug("webrtc mqtt connect", {
        url: this.config.mqtt.url,
        clientId: this.config.mqtt.clientId,
        username: this.config.mqtt.username,
        subscribeTopic: this.subscribeTopic,
      });
      const client = connect(this.config.mqtt.url, {
        clientId: this.config.mqtt.clientId,
        username: this.config.mqtt.username,
        password: this.config.mqtt.password,
      });

      client.on("connect", () => {
        client.subscribe(this.subscribeTopic, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      client.on("message", (_, payload) => {
        this.handleMessage(payload.toString("utf8"));
      });

      client.on("error", (error) => {
        this.onError?.(error);
      });

      client.on("close", () => {
        this.onDisconnect?.();
      });

      this.client = client;
    });
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    this.sendDisconnect();
    this.client.end(true);
    this.client.removeAllListeners();
    this.client = undefined;
  }

  async sendOffer(sdp: string, streamType = 0, enableDataChannel = false): Promise<void> {
    const message: TuyaOfferFrame = {
      mode: "webrtc",
      sdp,
      stream_type: streamType,
      auth: this.config.webrtc.auth,
      token: this.config.webrtc.p2pConfig.ices,
      replay: { is_replay: 0 },
      datachannel_enable: enableDataChannel,
    };
    logDebug("webrtc sendOffer", { streamType, enableDataChannel });
    this.publish("offer", 302, message);
  }

  async sendCandidate(candidate: string): Promise<void> {
    const message: TuyaCandidateFrame = {
      mode: "webrtc",
      candidate,
    };
    logDebug("webrtc sendCandidate", { candidate });
    this.publish("candidate", 302, message);
  }

  async sendDisconnect(): Promise<void> {
    logDebug("webrtc sendDisconnect");
    this.publish("disconnect", 302, { mode: "webrtc" });
  }

  private publish(type: string, protocol: number, message: object) {
    if (!this.client) return;
    logDebug("webrtc publish", { type, protocol, topic: this.publishTopic });
    const header: TuyaMqttFrameHeader = {
      type,
      from: this.config.mqtt.uid,
      to: this.config.deviceId,
      sessionid: this.sessionId,
      moto_id: this.config.webrtc.motoId,
      tid: "",
      seq: 0,
      rtx: 0,
    };

    const payload: TuyaMqttMessage = {
      protocol,
      pv: "2.2",
      t: Date.now(),
      data: {
        header,
        msg: JSON.stringify(message),
      },
    };

    this.client.publish(this.publishTopic, JSON.stringify(payload), {
      qos: 1,
      retain: false,
    });
  }

  private handleMessage(payload: string) {
    let message: TuyaMqttMessage;
    try {
      message = JSON.parse(payload);
    } catch (error) {
      logDebug("webrtc message parse failed", error);
      return;
    }

    if (message?.data?.header?.sessionid !== this.sessionId) return;

    const type = message.data.header.type;
    if (type === "answer") {
      try {
        const answer = JSON.parse(message.data.msg) as TuyaAnswerFrame;
        this.onAnswer?.(answer);
      } catch (error) {
        this.onError?.(error as Error);
      }
      return;
    }

    if (type === "candidate") {
      try {
        const candidate = JSON.parse(message.data.msg) as TuyaCandidateFrame;
        candidate.candidate = candidate.candidate.replace(/^a=/, "").replace(/\r$/, "");
        this.onCandidate?.(candidate);
      } catch (error) {
        this.onError?.(error as Error);
      }
      return;
    }

    if (type === "disconnect") {
      this.onDisconnect?.();
    }
  }
}
