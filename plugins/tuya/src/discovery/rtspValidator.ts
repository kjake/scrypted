import net from "node:net";
import tls from "node:tls";

export type RtspValidationResult = {
  ok: boolean;
  statusCode?: number;
  statusLine?: string;
  error?: string;
};

export interface RtspValidator {
  validate(url: string, timeoutMs?: number): Promise<RtspValidationResult>;
}

export type ParsedStatusLine = {
  statusCode?: number;
  statusText?: string;
};

export function parseRtspStatusLine(line: string): ParsedStatusLine {
  const match = line.match(/RTSP\/\d+\.\d+\s+(\d{3})\s*(.*)/i);
  if (!match) return {};
  return {
    statusCode: Number(match[1]),
    statusText: match[2]?.trim(),
  };
}

export function isRtspUrl(url: string): boolean {
  return url.startsWith("rtsp://") || url.startsWith("rtsps://");
}

export class NetRtspValidator implements RtspValidator {
  constructor(private defaultTimeoutMs = 5000) {}

  async validate(url: string, timeoutMs: number = this.defaultTimeoutMs): Promise<RtspValidationResult> {
    if (!isRtspUrl(url)) {
      return { ok: false, error: "invalid-scheme" };
    }

    const parsed = new URL(url);
    const port = Number(parsed.port) || (parsed.protocol === "rtsps:" ? 322 : 554);
    const payload = `OPTIONS ${url} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: Scrypted Tuya Discovery\r\n\r\n`;

    return new Promise((resolve) => {
      const onResult = (result: RtspValidationResult) => {
        cleanup();
        resolve(result);
      };

      const socket = parsed.protocol === "rtsps:"
        ? tls.connect({ host: parsed.hostname, port })
        : net.connect({ host: parsed.hostname, port });

      const timer = setTimeout(() => {
        onResult({ ok: false, error: "timeout" });
        socket.destroy();
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
      };

      socket.once("error", (error) => {
        onResult({ ok: false, error: error.message });
      });

      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString("utf8");
        const endIndex = buffer.indexOf("\r\n");
        if (endIndex === -1) return;
        const statusLine = buffer.slice(0, endIndex);
        const parsedStatus = parseRtspStatusLine(statusLine);
        const statusCode = parsedStatus.statusCode;
        if (!statusCode) {
          onResult({ ok: false, statusLine, error: "invalid-status" });
          socket.end();
          return;
        }
        const ok = statusCode === 200 || statusCode === 401 || statusCode === 405;
        onResult({ ok, statusCode, statusLine });
        socket.end();
      });

      socket.on("connect", () => {
        socket.write(payload);
      });
    });
  }
}
