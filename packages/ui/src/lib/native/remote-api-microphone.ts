import { invoke } from "@tauri-apps/api/core"
import { generateUUID } from "../client-identity"
import { isRemoteWindow } from "../runtime-env"
import { usesWebKitMicrophone } from "./device-speech"
import { canRelayRemoteDictation } from "./remote-dictation"

const MAX_BASE64_LENGTH = Math.ceil((44 + 24 * 16_000 * 2) / 3) * 4
const denied = () => new DOMException("Microphone permission denied", "NotAllowedError")

export const usesNativeRemoteApiMicrophone = () => usesWebKitMicrophone() && isRemoteWindow()
export const remoteApiMicrophoneAvailable = () => window.isSecureContext && canRelayRemoteDictation()

type StartAction = "startApiMicrophone" | "startApiInputTest"

export async function startRemoteApiMicrophone(start: StartAction, signal: AbortSignal, ended: () => void, limit: () => void, leaseId?: string) {
  signal.throwIfAborted()
  if (!remoteApiMicrophoneAvailable() || window !== window.top || navigator.userActivation?.isActive !== true) throw denied()
  const id = leaseId ?? generateUUID()
  const request = <T>(action: StartAction | "statusApiMicrophone" | "finishApiMicrophone" | "revokeApiMicrophone") =>
    invoke<T>("remote_dictation_request", { request: { action, id } })
  let timer: number | undefined
  let released = false
  let finishing = false
  let limited = false
  const release = () => {
    if (released) return
    released = true
    clearTimeout(timer)
    signal.removeEventListener("abort", release)
    void request("revokeApiMicrophone").catch(() => {})
  }
  signal.addEventListener("abort", release, { once: true })
  try {
    await request(start)
    if (signal.aborted) {
      // A queued native start can settle after the earlier revoke.
      void request("revokeApiMicrophone").catch(() => {})
      signal.throwIfAborted()
    }
  } catch (error) {
    release()
    if (error === "permissionDenied") throw denied()
    throw error
  }
  const watch = async () => {
    try {
      const state = await request<unknown>("statusApiMicrophone")
      if (released || finishing) return
      if (state === "limitReached") {
        if (!limited) {
          limited = true
          limit()
        }
      } else if (state !== "recording") { ended(); return }
      timer = window.setTimeout(watch, limited ? 1000 : 250)
    } catch {
      if (!released && !finishing) ended()
    }
  }
  timer = window.setTimeout(watch, 250)
  return {
    async finish() {
      finishing = true
      clearTimeout(timer)
      try {
        signal.throwIfAborted()
        const wav = await request<unknown>("finishApiMicrophone")
        signal.throwIfAborted()
        if (typeof wav !== "string" || !wav.length || wav.length > MAX_BASE64_LENGTH) throw new Error("Invalid microphone audio")
        return new Blob([Uint8Array.from(atob(wav), byte => byte.charCodeAt(0))], { type: "audio/wav" })
      } finally { release() }
    },
    release,
  }
}
