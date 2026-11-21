import { invoke } from "@tauri-apps/api/core"
import { isSpeechEngine, type DeviceSpeechResponses, type DeviceSpeechResult, type MicrophoneRequest } from "../../../../desktop-speech/contract"
import { maxRemoteDictationTextBytes, type RemoteDictationRequest, type SettleRemoteDictation } from "../../../../desktop-speech/remote-contract"
import { isDictationWindow, isElectronHost, isRemoteWindow, isTauriHost } from "../runtime-env"

export function canRelayRemoteDictation(): boolean {
  if (typeof window === "undefined" || !isRemoteWindow()) return false
  return (isElectronHost() && typeof window.electronAPI?.remoteDictation === "function")
    || (isTauriHost() && window.__CODENOMAD_REMOTE_DICTATION__ === true)
}

async function request(request: RemoteDictationRequest): Promise<unknown> {
  if (!canRelayRemoteDictation()) throw new Error("Remote dictation is unavailable")
  if (isElectronHost()) return window.electronAPI!.remoteDictation!(request)
  return invoke("remote_dictation_request", { request })
}

export async function requestRemoteMicrophone<A extends MicrophoneRequest>(input: A) {
  return await request(input) as DeviceSpeechResult<DeviceSpeechResponses[A["action"]]>
}

export async function readRemoteDictationChoice() {
  const choice = await request({ action: "read" })
  if (choice !== null && typeof choice !== "string") throw new Error("Invalid remote dictation choice")
  return isSpeechEngine(choice) ? choice : null
}

export async function beginRemoteDictation(id: string, locale: string): Promise<string | null> {
  const text = await request({ action: "begin", id, locale })
  if (text === null) return null
  if (typeof text !== "string" || text.length > maxRemoteDictationTextBytes
    || new TextEncoder().encode(text).length > maxRemoteDictationTextBytes) throw new Error("Invalid dictation transcript")
  return text
}

export async function cancelRemoteDictation(id: string): Promise<void> {
  await request({ action: "cancel", id })
}

export async function settleRemoteDictation(request: SettleRemoteDictation): Promise<void> {
  if (isDictationWindow()) {
    if (isElectronHost() && window.electronAPI?.settleRemoteDictation) {
      await window.electronAPI.settleRemoteDictation(request)
      return
    }
    if (isTauriHost()) {
      await invoke("settle_remote_dictation", { request })
      return
    }
  }
  throw new Error("Remote dictation sheet is unavailable")
}
