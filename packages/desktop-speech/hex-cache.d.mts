import type { DeviceSpeechCapabilities, DeviceSpeechOperation } from "./contract"

export function createHexCache(root: string, options?: {
  isSelected?: () => boolean
  stopTree?: (pid: number, startedBy: Date) => Promise<unknown>
}): {
  capabilities(): DeviceSpeechCapabilities["hex"]
  prepare(planId: string, signal: AbortSignal, progress: (
    value: Extract<DeviceSpeechOperation, { state: "downloading" }> | { state: "verifying" }
  ) => void): Promise<void>
  use(signal: AbortSignal, capture: (transcribe: (wav: Buffer) => Promise<string>) => Promise<string>): Promise<string>
  stop(): Promise<void>
}
