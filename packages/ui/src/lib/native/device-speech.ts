import { invoke } from "@tauri-apps/api/core"
import { isDictationWindow, isElectronHost, isNativeApplicationWindow, isTauriHost } from "../runtime-env"
import type {
  DeviceSpeechAction, DeviceSpeechRequest, DeviceSpeechRequests, DeviceSpeechResponses, DeviceSpeechResult,
} from "../../../../desktop-speech/contract"

export type {
  DeviceSpeechError, DeviceSpeechOperation, DeviceSpeechSnapshot, HexPlan, SpeechEngine,
} from "../../../../desktop-speech/contract"

export function canConfigureDeviceSpeech() {
  return isNativeApplicationWindow() && (isTauriHost() || (isElectronHost() && typeof window.electronAPI?.deviceSpeech === "function"))
}

export async function requestDeviceSpeech<A extends DeviceSpeechAction>(
  action: A,
  data: DeviceSpeechRequests[A],
): Promise<DeviceSpeechResult<DeviceSpeechResponses[A]>> {
  if (!isNativeApplicationWindow() && !isDictationWindow()) return { ok: false, error: "unavailable" }
  const request = { ...data, action } as DeviceSpeechRequest
  try {
    if (isElectronHost()) {
      const send = window.electronAPI?.deviceSpeech
      return send ? await send(request) as DeviceSpeechResult<DeviceSpeechResponses[A]> : { ok: false, error: "unavailable" }
    }
    if (isTauriHost()) return await invoke("device_speech_request", { request })
  } catch { return { ok: false, error: "failed" } }
  return { ok: false, error: "unavailable" }
}

export function usesWebKitMicrophone() {
  return isTauriHost() && /\bLinux\b/.test(navigator.userAgent)
}

export function requestApiMicrophone(action: "authorizeApiMicrophone" | "revokeApiMicrophone", id: string) {
  const request = { action, id }
  if (isNativeApplicationWindow()) {
    return invoke<DeviceSpeechResult<null>>("device_speech_request", { request }).then(result => result.ok)
  }
  return Promise.resolve(false)
}
