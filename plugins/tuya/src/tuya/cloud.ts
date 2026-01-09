import { Axios, Method } from "axios";
import {
  TuyaDeviceStatus,
  RTSPToken,
  TuyaDevice,
  TuyaResponse,
  TuyaDeviceFunction,
  TuyaDeviceSchema
} from "./const";
import { TuyaWebRtcConfig } from "./webrtc";
import { getEndPointWithCountryName } from "./deprecated";
import { randomBytes, createHmac, hash } from "node:crypto";
import { createHash, createPublicKey, publicEncrypt } from "node:crypto";

/**
 * @deprecated Will eventually be removed in favor of Sharing SDK
 */
export type TuyaCloudTokenInfo = {
  uid: string;
  country: string;
  clientId: string;
  clientSecret: string;
  cookies?: string[];
}

/**
 * @deprecated Will eventually be removed in favor of Sharing SDK
 */
export class TuyaCloudAPI {
  private readonly nonce: string;
  private client: Axios;
  private tokenInfo: TuyaCloudTokenInfo;
  private updateToken: (token: TuyaCloudTokenInfo) => void;
  private requiresReauthentication: () => void;

  constructor(
    initialTokenInfo: TuyaCloudTokenInfo, 
    updateToken: (token: TuyaCloudTokenInfo) => void, 
    requiresReauth: () => void
  ) {
    this.tokenInfo = initialTokenInfo;
    this.updateToken = updateToken;
    this.requiresReauthentication = requiresReauth;
    this.nonce = randomBytes(16).toString('hex');
    this.client = new Axios({
      baseURL: getEndPointWithCountryName(this.tokenInfo.country),
      timeout: 5 * 1e3,
    });
  }

  private get isSessionValid(): boolean {
    return true;
  }

  // Set Device Status

  public async sendCommands(
    deviceId: string,
    commands: TuyaDeviceStatus[]
  ): Promise<boolean> {
    return this._request<boolean>(
      "POST",
      `/v1.0/devices/${deviceId}/commands`,
      undefined,
      { commands }
    )
    .then(r => !!r.success && !!r.result)
    .catch(() => false)
  }

  // Get Devices

  public async fetchDevices(): Promise<TuyaDevice[]> {
    let response = await this._request<TuyaDevice[]>("get", `/v1.0/users/${this.tokenInfo.uid}/devices`);

    if (!response.success) {
      throw Error(`Failed to fetch Device configurations.`);
    }

    let devices = response.result;

    for (var i = 0; i < devices.length; i++) {
      var device = devices[i];
      const response = await this._request<{ category?: string; functions?: TuyaDeviceFunction[] }>("get", `/v1.0/devices/${device.id}/functions`);
      if (!response.success) continue;
      const functions = response.result?.functions;
      if (Array.isArray(functions)) {
        const statusCodes = new Set((device.status || []).map(s => s.code));
        const schemas: TuyaDeviceSchema[] = [];
        for (const fn of functions) {
          if (!fn?.code) continue;
          let specs: any = {};
          if (typeof fn.values === "string" && fn.values.length) {
            try {
              specs = JSON.parse(fn.values);
            } catch {
              continue;
            }
          }
          schemas.push({
            code: fn.code,
            mode: statusCodes.has(fn.code) ? "rw" : "w",
            type: fn.type as any,
            specs
          });
        }
        device.schema = schemas;
      } else {
        device.schema = [];
      }
      devices[i] = device;
    }
    return devices;
  }

  // Camera Functions

  public async getRTSP(cameraId: string): Promise<RTSPToken> {
    const response = await this._request<{ url: string }>(
      "POST",
      `/v1.0/devices/${cameraId}/stream/actions/allocate`,
      { type: "rtsp" }
    );

    if (response.success) {
      return {
        url: response.result.url,
        expires: (response?.t ?? 0) + 30_000, // This will expire in 30 seconds.
      };
    } else {
      throw new Error(`Failed to retrieve RTSP for camera ID: ${cameraId}`)
    }
  }

  public async getWebRTCConfig(_: string): Promise<TuyaWebRtcConfig> {
    throw new Error("WebRTC signaling is not available for the Tuya developer account login.");
  }

  // Tuya IoT Cloud Requests API

  private async _request<T = any>(
    method: Method,
    path: string,
    query: { [k: string]: any } = {},
    body: { [k: string]: any } = {}
  ): Promise<TuyaResponse<T>> {
    const timestamp = Date.now().toString();
    const headers = { client_id: this.tokenInfo.clientId };

    const stringToSign = getStringToSign(
      method,
      path,
      query,
      headers,
      body
    );

    const hashed = createHmac("sha256", this.tokenInfo.clientSecret);
    hashed.update(
      this.tokenInfo.clientId +
      timestamp +
      this.nonce +
      stringToSign,
    )

    const sign = hashed.digest('hex').toUpperCase();

    let requestHeaders = {
      client_id: this.tokenInfo.clientId,
      sign: sign,
      sign_method: "HMAC-SHA256",
      t: timestamp,
      access_token: "",
      "Signature-Headers": Object.keys(headers).join(":"),
      nonce: this.nonce,
    };

    return this.client
      .request<TuyaResponse<T>>({
        method,
        url: path,
        data: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
        params: query,
        headers: requestHeaders,
        responseType: "json",
        transformResponse: (data) => JSON.parse(data),
      })
      .then((value) => {
        return value.data;
      });
  }

  private async refreshAccessTokenIfNeeded() {}

  static async fetchToken(
    username?: string,
    password?: string,
    country?: string
  ): Promise<TuyaCloudTokenInfo> {
    if (!username || !password || !country) throw Error('Missing credential information.');
    const endpoint = getEndPointWithCountryName(country);
    const host = new URL(endpoint).host;
    const session = new Axios({ baseURL: `https://${host}` });
    console.log(`[TuyaCloud] login start username=${username} country=${country} host=${host}`);

    const tokenPayload = {
      countryCode: country,
      username,
      isUid: false,
    };
    console.log(`[TuyaCloud] login tokenRequest=${JSON.stringify(tokenPayload)}`);
    const tokenResponse = await session.request({
      method: "POST",
      url: "/api/login/token",
      data: JSON.stringify(tokenPayload),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "*/*",
        Origin: `https://${host}`,
        Referer: `https://${host}/login`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    console.log(`[TuyaCloud] login tokenStatus=${tokenResponse.status}`);
    console.log(`[TuyaCloud] login tokenResponseCookies=${JSON.stringify(tokenResponse.headers?.["set-cookie"] ?? [])}`);
    console.log(`[TuyaCloud] login tokenResponseRaw=${tokenResponse.data}`);
    const tokenPayloadResponse = typeof tokenResponse.data === "string" ? JSON.parse(tokenResponse.data) : tokenResponse.data;
    if (!tokenPayloadResponse?.success || !tokenPayloadResponse?.result?.token || !tokenPayloadResponse?.result?.pbKey) {
      throw new Error(tokenPayloadResponse?.errorMsg || "Failed to fetch login token.");
    }

    const hashedPassword = createHash("md5").update(password).digest("hex");
    const publicKey = createPublicKey({
      key: `-----BEGIN PUBLIC KEY-----\n${tokenPayloadResponse.result.pbKey}\n-----END PUBLIC KEY-----`,
      format: "pem",
    });
    const encryptedPassword = publicEncrypt(publicKey, Buffer.from(hashedPassword)).toString("hex");

    const loginPayload = {
      countryCode: country,
      passwd: encryptedPassword,
      token: tokenPayloadResponse.result.token,
      ifencrypt: 1,
      options: "{\"group\":1}",
      ...(username.includes("@") ? { email: username } : { mobile: username }),
    };
    console.log(`[TuyaCloud] login payload=${JSON.stringify(loginPayload)}`);

    const loginResponse = await session.request({
      method: "POST",
      url: username.includes("@") ? "/api/private/email/login" : "/api/private/phone/login",
      data: JSON.stringify(loginPayload),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "*/*",
        Origin: `https://${host}`,
        Referer: `https://${host}/login`,
        "X-Requested-With": "XMLHttpRequest",
      },
    });

    const loginRaw = typeof loginResponse.data === "string" ? JSON.parse(loginResponse.data) : loginResponse.data;
    console.log(`[TuyaCloud] login responseStatus=${loginResponse.status}`);
    console.log(`[TuyaCloud] login responseCookies=${JSON.stringify(loginResponse.headers?.["set-cookie"] ?? [])}`);
    console.log(`[TuyaCloud] login responseRaw=${loginResponse.data}`);
    if (!loginRaw?.success || !loginRaw?.result?.uid) {
      throw new Error(loginRaw?.errorMsg || "Failed to login with credentials.");
    }

    const cookies = loginResponse.headers?.["set-cookie"];
    return {
      uid: loginRaw.result.uid,
      country,
      clientId: loginRaw.result.clientId ?? "",
      clientSecret: "",
      cookies: Array.isArray(cookies) ? cookies : cookies ? [cookies] : [],
    };
  }
}

/**
 * @deprecated Will eventually be removed in favor of Sharing SDK
 */
function getStringToSign(
  method: Method,
  path: string,
  query: { [k: string]: any } = {},
  headers: { [k: string]: string } = {},
  body: { [k: string]: any } = {}
): string {
  const isQueryEmpty = Object.keys(query).length == 0;
  const isHeaderEmpty = Object.keys(headers).length == 0;
  const isBodyEmpty = Object.keys(body).length == 0;
  const httpMethod = method.toUpperCase();
  const url =
    path +
    (isQueryEmpty
      ? ""
      : "?" +
      Object.keys(query)
        .map((key) => `${key}=${query[key]}`)
        .join("&"));
  const contentHashed = hash("sha256", isBodyEmpty ? "" : JSON.stringify(body));
  const headersParsed = Object.keys(headers)
    .map((key) => `${key}:${headers[key]}`)
    .join("\n");
  const headersStr = isHeaderEmpty ? "" : headersParsed + "\n";
  const signStr = [httpMethod, contentHashed, headersStr, url].join("\n");
  return signStr;
}
