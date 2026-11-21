import type { MicrophoneRequest } from "./contract"

export type RemoteDictationRequest = MicrophoneRequest
  | { action: "read" }
  | { action: "begin"; id: string; locale: string }
  | { action: "cancel"; id: string }

export type SettleRemoteDictation =
  | { action: "complete"; text: string }
  | { action: "cancel" }
  | { action: "settings" }

export const maxRemoteDictationTextBytes = 64 * 1024
