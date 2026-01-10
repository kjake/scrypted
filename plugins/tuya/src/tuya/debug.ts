import packageJson from "../../package.json";

export function isDebugBuild(): boolean {
  return typeof packageJson.version === "string" && packageJson.version.endsWith("-debug");
}

export function logDebug(message: string, details?: unknown): void {
  if (!isDebugBuild()) return;
  if (details === undefined) {
    console.log(`[TuyaDebug] ${message}`);
  } else {
    console.log(`[TuyaDebug] ${message}`, details);
  }
}
