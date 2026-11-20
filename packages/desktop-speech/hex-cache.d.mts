import type { DeviceSpeechCapabilities, DeviceSpeechOperation } from "./contract"

export function createHexCache(root: string): {
  capabilities(): DeviceSpeechCapabilities["hex"]
  prepare(planId: string, signal: AbortSignal, progress: (
    value: Extract<DeviceSpeechOperation, { state: "downloading" }> | { state: "verifying" }
  ) => void): Promise<void>
  transcribe(wav: Buffer, signal: AbortSignal): Promise<string>
}
