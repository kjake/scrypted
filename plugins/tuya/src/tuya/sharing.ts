import { Axios, Method } from "axios";
import { RTSPToken, TuyaDevice, TuyaDeviceFunction, TuyaDeviceSchema, TuyaDeviceStatus, TuyaResponse } from "./const";
import { TuyaWebRtcConfig } from "./webrtc";
import { getEndPointWithCountryName } from "./deprecated";
import { isCameraCategory } from "../discovery/cameraCategories";
import { logDebug } from "./debug";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomInt, randomUUID } from "node:crypto";
import { MqttConfig } from "./mq";

export type TuyaSharingTokenInfo = {
  userCode: string;
  uid: string;
  terminalId: string;
  username: string;
  endpoint: string;
  mqttHost?: string;
  cookies?: string[];
  email?: string;
  country?: string;
}

export type TuyaLoginQRCode = { userCode: string } & TuyaResponse<{ qrcode: string }>

export class TuyaSharingAPI {
  private static clientId = "HA_3y9q4ak7g4ephrvke";

  private session: Axios;
  private tokenInfo: TuyaSharingTokenInfo;
  private updateToken: (token: TuyaSharingTokenInfo) => void;
  private requiresReauthentication: () => void;

  constructor(
    initialTokenInfo: TuyaSharingTokenInfo,
    updateToken: (token: TuyaSharingTokenInfo) => void,
    requiresReauth: () => void
  ) {
    this.tokenInfo = initialTokenInfo;
    this.updateToken = updateToken;
    this.requiresReauthentication = requiresReauth;
    this.session = new Axios({
      baseURL: this.tokenInfo.endpoint
    });
  }

  public async fetchDevices(): Promise<TuyaDevice[]> {
    await this.getAppInfo();

    const devices: {
      deviceId: string;
      deviceName: string;
      category: string;
      productId?: string;
      uuid?: string;
    }[] = [];

    const homes = await this.getHomeList();
    for (const home of homes ?? []) {
      const rooms = await this.getRoomList(String(home.gid));
      for (const room of rooms ?? []) {
        for (const device of room.deviceList ?? []) {
          if (!device?.deviceId || !device.category) continue;
          if (!isCameraCategory(device.category)) continue;
          if (!devices.find(d => d.deviceId === device.deviceId)) {
            devices.push(device);
          }
        }
      }
    }

    const shared = await this.getSharedHomeList();
    for (const sharedHome of shared?.securityWebCShareInfoList ?? []) {
      for (const device of sharedHome.deviceInfoList ?? []) {
        if (!device?.deviceId || !device.category) continue;
        if (!isCameraCategory(device.category)) continue;
        if (!devices.find(d => d.deviceId === device.deviceId)) {
          devices.push(device);
        }
      }
    }

    const mapped = devices.map((device) => ({
      id: device.deviceId,
      name: device.deviceName,
      local_key: "",
      category: device.category,
      product_id: device.productId ?? "",
      product_name: device.productId ?? "",
      sub: false,
      uuid: device.uuid ?? "",
      online: true,
      icon: "",
      ip: "",
      time_zone: "",
      active_time: 0,
      create_time: 0,
      update_time: 0,
      status: [],
      schema: [],
      uid: this.tokenInfo.uid,
      biz_type: 0,
      owner_id: "",
    }));

    return Promise.all(mapped.map(p => this.updateDeviceSpecs(p).catch(() => p)));
  }

  public async sendCommands(deviceId: string, commands: TuyaDeviceStatus[]): Promise<boolean> {
    return this._request<boolean>("post", `/v1.1/m/thing/${deviceId}/commands`, undefined, { commands })
      .then(r => !!r.success && !!r.result)
      .catch(() => false)
  }

  public async getRTSP(deviceId: string): Promise<RTSPToken> {
    const response = await this._request<{ url: string }>(
      "post",
      `/v1.0/m/ipc/${deviceId}/stream/actions/allocate`,
      undefined,
      { type: "rtsp" }
    );

    if (response.success) {
      return {
        url: response.result.url,
        expires: (response?.t ?? 0) + 30_000, // This will expire in 30 seconds.
      };
    } else {
      throw new Error(`Failed to retrieve RTSP for camera ${deviceId}`)
    }
  }

  public async fetchMqttConfig(_: string[], __: string[]): Promise<MqttConfig> {
    const host = this.getJarvisHost();
    const cookieHeader = this.tokenInfo.cookies?.length ? this.tokenInfo.cookies.join("; ") : undefined;
    logDebug("mqttConfig request", { host, cookieHeader });
    const response = await this.session.request({
      method: "POST",
      baseURL: `https://${host}`,
      url: "/api/jarvis/mqtt",
      data: "{}",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "*/*",
        Origin: `https://${host}`,
        Referer: `https://${host}/playback`,
        "X-Requested-With": "XMLHttpRequest",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });

    logDebug("mqttConfig response", {
      status: response.status,
      cookies: response.headers?.["set-cookie"] ?? [],
      raw: response.data,
    });

    const raw = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    const result = raw?.result as { msid?: string; password?: string } | undefined;
    if (!raw?.success || !result?.msid || !result?.password) {
      throw new Error(raw?.errorMsg || "Failed to fetch MQTT Config");
    }
    if (!this.tokenInfo.mqttHost) {
      throw new Error("MQTT host not available from login response.");
    }

    return {
      url: `wss://${this.tokenInfo.mqttHost}/mqtt`,
      clientId: `web_${result.msid}`,
      username: `web_${result.msid}`,
      password: result.password,
      topics: [`/av/u/${result.msid}`],
    };
  }

  public async getWebRTCConfig(deviceId: string): Promise<TuyaWebRtcConfig> {
    const host = this.getJarvisHost();
    const clientTraceId = randomUUID();
    logDebug("webrtcConfig request", { deviceId, clientTraceId, host });
    const response = await this.jarvisRequest<TuyaWebRtcConfig>(host, "/api/jarvis/config", {
      devId: deviceId,
      clientTraceId,
    });
    return response;
  }

  public getUserId(): string {
    return this.tokenInfo.uid;
  }

  async queryHomes() {
    const response = await this._request<[{ uid: string, id: number, ownerId: string, name: string }]>("GET", "/v1.0/m/life/users/homes");
    return response?.result || [];
  }

  private async updateDeviceSpecs(device: TuyaDevice): Promise<TuyaDevice> {
    const schemas = new Map<string, TuyaDeviceSchema>();

    try {
      const response = await this._request<{ status: TuyaDeviceFunction[], functions: TuyaDeviceFunction[] }>("get", `/v1.1/m/life/${device.id}/specifications`);

      for (const { code, type, values } of [...response.result.status, ...response.result.functions]) {
        const read = response.result.status.find(r => r.code == code);
        const write = response.result.functions.find(f => f.code == code);
        try {
          schemas.set(code, {
            code,
            mode: !!read && !!write ? "rw" : !!write ? "w" : "r",
            type: type as any,
            specs: JSON.parse(values)
          });
        } catch {
          continue;
        }
      }
    } catch {
      logDebug("specifications fetch failed", { deviceId: device.id, name: device.name });
    }
    device.schema = Array.from(schemas.values());
    return device;
  }

  private getJarvisHost(): string {
    const endpoint = getEndPointWithCountryName(this.tokenInfo.country ?? "United States");
    logDebug("jarvisEndpoint", endpoint);
    try {
      const host = new URL(endpoint).host;
      logDebug("jarvisHost", host);
      logDebug("jarvisUrl", `https://${host}/api/jarvis/config`);
      return host;
    } catch {
      const host = endpoint.replace(/^https?:\/\//, "");
      logDebug("jarvisHost", host);
      logDebug("jarvisUrl", `https://${host}/api/jarvis/config`);
      return host;
    }
  }

  private async jarvisPost<T>(path: string, data?: Record<string, any>): Promise<T> {
    const host = this.getJarvisHost();
    const cookieHeader = this.tokenInfo.cookies?.length ? this.tokenInfo.cookies.join("; ") : undefined;
    logDebug("jarvisPost request", { path, data, host, cookieHeader });
    const response = await this.session.request({
      method: "POST",
      baseURL: `https://${host}`,
      url: path,
      data: data ? JSON.stringify(data) : undefined,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "*/*",
        Origin: `https://${host}`,
        Referer: `https://${host}/playback`,
        "X-Requested-With": "XMLHttpRequest",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    logDebug("jarvisPost response", {
      path,
      status: response.status,
      cookies: response.headers?.["set-cookie"] ?? [],
      raw: response.data,
    });
    const raw = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    if (!raw?.success) {
      throw new Error(raw?.errorMsg || `Jarvis request failed: ${path}`);
    }
    return raw.result as T;
  }

  private async getAppInfo(): Promise<void> {
    await this.jarvisPost("/api/customized/web/app/info");
  }

  private async getHomeList(): Promise<{ gid: number }[]> {
    return this.jarvisPost<{ gid: number }[]>("/api/new/common/homeList");
  }

  private async getRoomList(homeId: string): Promise<{ deviceList?: { deviceId: string; deviceName: string; category: string; productId?: string; uuid?: string }[] }[]> {
    return this.jarvisPost("/api/new/common/roomList", { homeId });
  }

  private async getSharedHomeList(): Promise<{ securityWebCShareInfoList?: { deviceInfoList?: { deviceId: string; deviceName: string; category: string; productId?: string; uuid?: string }[] }[] }> {
    return this.jarvisPost("/api/new/playback/shareList");
  }

  private async jarvisRequest<T = any>(host: string, path: string, data: Record<string, any>): Promise<T> {
    const url = `https://${host}${path}`;
    logDebug("jarvisRequest", { url, data });
    const cookieHeader = this.tokenInfo.cookies?.length ? this.tokenInfo.cookies.join("; ") : undefined;
    const response = await this.session.request({
      method: "POST",
      baseURL: `https://${host}`,
      url: path,
      data: JSON.stringify(data),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "*/*",
        Origin: `https://${host}`,
        Referer: `https://${host}/playback`,
        "X-Requested-With": "XMLHttpRequest",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });

    logDebug("jarvisResponse", { status: response.status, raw: response.data });
    const payload = JSON.parse(response.data) as { success?: boolean; result?: T; errorMsg?: string };
    if (!payload?.success || !payload.result) {
      throw new Error(payload?.errorMsg || "Failed to fetch WebRTC configuration.");
    }
    return payload.result;
  }

  private async _request<T = any>(
    method: Method,
    path: string,
    params?: { [k: string]: any },
    body?: { [k: string]: any },
    skipRefreshToken?: boolean
  ): Promise<TuyaResponse<T>> {
    const rid = randomUUID();
    const sid = "";
    const md5 = createHash("md5");
    const ridRefreshToken = rid;
    md5.update(ridRefreshToken, "utf-8");
    const hashKey = md5.digest("hex");
    const secret = _secretGenerating(rid, sid, hashKey);

    var queryEncData = "";
    if (params && Object.keys(params).length > 0) {
      queryEncData = _aesGcmEncrypt(_formToJson(params), secret);
      params = { "encdata": queryEncData };
    }

    var bodyEncData = ""
    if (body && Object.keys(body).length > 0) {
      bodyEncData = _aesGcmEncrypt(_formToJson(body), secret);
      body = { "encdata": bodyEncData };
    }

    const t = Date.now();

    const headers = new Map<string, string>();
    headers.set("X-appKey", TuyaSharingAPI.clientId)
    headers.set("X-requestId", rid)
    headers.set("X-sid", sid)
    headers.set("X-time", t.toString())
    headers.set("X-sign", _restfulSign(hashKey, queryEncData, bodyEncData, headers));

    logDebug("sharingRequest", { method, path, params, body });
    const response = await this.session.request({
      method,
      url: path,
      params: !params || !Object.keys(params).length ? undefined : params,
      headers: Object.fromEntries(headers),
      data: !body || !Object.keys(body).length ? undefined : JSON.stringify(body)
    });

    logDebug("sharingResponse", { path, status: response.status, raw: response.data });
    const ret = response.data ? JSON.parse(response.data) as TuyaResponse<string> : undefined;
    if (!ret) throw Error(`Failed to receive response`);

    return {
      ...ret,
      result: typeof ret.result == "string" ? JSON.parse(_aesGcmDencrypt(ret.result, secret)) as T : ret.result
    };
  }

  private async refreshTokenIfNeeded() {}

  static async generateQRCode(userCode: string, countryName?: string): Promise<TuyaLoginQRCode> {
    const endpoint = getEndPointWithCountryName(countryName ?? "United States");
    const host = new URL(endpoint).host;
    logDebug("generateQRCode request", { userCode, country: countryName ?? "United States", host });
    const session = new Axios({ baseURL: `https://${host}` });
    const response = await session.request({
      method: "POST",
      url: "/api/login/security/QCtoken",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "*/*",
        Origin: `https://${host}`,
        Referer: `https://${host}/login`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    logDebug("generateQRCode response", {
      status: response.status,
      cookies: response.headers?.["set-cookie"] ?? [],
      raw: response.data,
    });
    const raw = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
    if (!raw?.success) throw Error(raw?.errorMsg || "Failed to fetch qr code with user code.");
    const data: TuyaResponse<{ qrcode: string }> = {
      success: raw.success,
      t: raw.t,
      result: { qrcode: raw.result },
    };
    return { userCode, ...data }
  }

  static async fetchToken(qrCodeLogin: TuyaLoginQRCode, countryName?: string): Promise<TuyaSharingTokenInfo> {
    const endpoint = getEndPointWithCountryName(countryName ?? "United States");
    const host = new URL(endpoint).host;
    const session = new Axios({ baseURL: `https://${host}` });
    const payload = JSON.stringify({ token: qrCodeLogin.result.qrcode });
    logDebug("pollLogin request", { userCode: qrCodeLogin.userCode, host, payload });

    for (let i = 0; i < 60; i += 1) {
      const response = await session.request({
        method: "POST",
        url: "/api/login/poll",
        data: payload,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Accept: "*/*",
          Origin: `https://${host}`,
          Referer: `https://${host}/login`,
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      logDebug("pollLogin response", {
        attempt: i + 1,
        status: response.status,
        cookies: response.headers?.["set-cookie"] ?? [],
        raw: response.data,
      });

      const raw = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
      if (raw?.success && raw?.result) {
        const result = raw.result as {
          uid?: string;
          username?: string;
          email?: string;
          receiver?: string;
          sid?: string;
          domain?: {
            mobileApiUrl?: string;
            mobileMqttsUrl?: string;
          };
        };

        const expectedUser = qrCodeLogin.userCode.trim().toLowerCase();
        const actualUser = (result.email || result.username || result.receiver || "").trim().toLowerCase();
        if (expectedUser && actualUser && expectedUser !== actualUser) {
          throw new Error(`QR login mismatch. Expected ${qrCodeLogin.userCode} but authenticated ${actualUser}.`);
        }

        const cookies = response.headers?.["set-cookie"];
        if (result.uid) {
          return {
            userCode: qrCodeLogin.userCode,
            uid: result.uid,
            terminalId: result.sid ?? "",
            endpoint: result.domain?.mobileApiUrl ?? endpoint,
            username: result.username ?? result.email ?? "",
            mqttHost: result.domain?.mobileMqttsUrl,
            cookies: Array.isArray(cookies) ? cookies : cookies ? [cookies] : [],
            email: result.email,
            country: countryName,
          };
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw Error("Timed out waiting for QR code scan.");
  }
}

function _formToJson(content: Record<string, any>) {
  return JSON.stringify(content, null, 0);
}

function _secretGenerating(rid: string, sid: string, hashKey: string) {
  let message = hashKey;
  const mod = 16;

  if (sid != "") {
    const sidLength = sid.length;
    const length = sidLength < mod ? sidLength : mod;
    let ecode = "";
    for (let i = 0; i < length; i++) {
      const idx = sid.charCodeAt(i) % mod;
      ecode += sid[idx];
    }
    message += "_";
    message += ecode;
  }

  const checksum = createHmac('sha256', rid).update(message, "utf-8").digest();
  const secret = checksum.toString('hex');
  return secret.substring(0, 16);
}

function _randomNonce(e: number = 32) {
  const t = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
  const a = t.length;
  let n: string = "";
  for (let i = 0; i < e; i++) {
    n += t[randomInt(0, a)];
  }
  return Buffer.from(n, "utf-8");
}

function _aesGcmEncrypt(rawData: string, secret: string) {
  const nonce = _randomNonce(12);
  const cipher = createCipheriv('aes-128-gcm', Buffer.from(secret, "utf-8"), nonce);
  const encrypted = Buffer.concat([cipher.update(rawData, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, authTag]).toString('base64');
}

function _aesGcmDencrypt(cipherData: string, secret: string) {
  const cypherBuffer = Buffer.from(cipherData, 'base64');
  const nonce = cypherBuffer.subarray(0, 12);
  const cipherText = cypherBuffer.subarray(12);
  const decipher = createDecipheriv('aes-128-gcm', Buffer.from(secret, "utf-8"), nonce);
  decipher.setAuthTag(cipherText.subarray(-16));
  const encryptedData = cipherText.subarray(0, -16);
  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString('utf8');
}

function _restfulSign(
  hashKey: string,
  queryEncData: string,
  bodyEncData: string,
  data: Map<string, string>
) {
  const headers = ["X-appKey", "X-requestId", "X-sid", "X-time", "X-token"];
  var headerSign: string[] = [];

  for (const item of headers) {
    const val = data.get(item) || "";
    if (val) headerSign.push(`${item}=${val}`);
  }

  var signStr = headerSign.join("||");

  if (queryEncData) signStr += queryEncData;
  if (bodyEncData) signStr += bodyEncData;

  return createHmac('sha256', hashKey)
    .update(signStr, "utf-8")
    .digest('hex')
}
