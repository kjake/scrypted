import { describe, expect, it } from "vitest";
import { isRtspUrl, parseRtspStatusLine } from "../rtspValidator";

describe("isRtspUrl", () => {
  it("accepts rtsp and rtsps URLs", () => {
    expect(isRtspUrl("rtsp://example.com/stream")).toBe(true);
    expect(isRtspUrl("rtsps://example.com/stream")).toBe(true);
  });

  it("rejects other schemes", () => {
    expect(isRtspUrl("http://example.com/stream")).toBe(false);
    expect(isRtspUrl("" as string)).toBe(false);
  });
});

describe("parseRtspStatusLine", () => {
  it("parses status code and text", () => {
    expect(parseRtspStatusLine("RTSP/1.0 200 OK")).toEqual({
      statusCode: 200,
      statusText: "OK",
    });
    expect(parseRtspStatusLine("RTSP/2.0 401 Unauthorized")).toEqual({
      statusCode: 401,
      statusText: "Unauthorized",
    });
  });

  it("returns empty object for non-RTSP lines", () => {
    expect(parseRtspStatusLine("HTTP/1.1 200 OK")).toEqual({});
  });
});
