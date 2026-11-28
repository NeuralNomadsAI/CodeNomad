import type { Accessor } from "solid-js"
import { generateUUID } from "../../lib/client-identity"
import { beginRemoteDictation, cancelRemoteDictation, canRelayRemoteDictation, readRemoteDictationChoice } from "../../lib/native/remote-dictation"
import type { VoiceInputEngine } from "./recording-controller"
import { createDictationSnapshot } from "./dictation-snapshot"

const remote = createDictationSnapshot(readRemoteDictationChoice)

export function useRemoteDictation(locale: () => string, active: Accessor<boolean>) {
  if (!canRelayRemoteDictation()) return undefined
  const { snapshot: choice } = remote
  remote.use(active)
  const relay: VoiceInputEngine = {
    canStart: () => choice() === "hex",
    createController(callbacks) {
      let pending = false
      const id = generateUUID()
      return {
        async startRecording() {
          if (pending) return
          pending = true
          callbacks.onStateChange("starting")
          try {
            const text = await beginRemoteDictation(id, locale())
            if (pending && text) callbacks.onTranscript(text)
          } catch {
            if (pending) callbacks.onError("promptInput.remoteDictation.error")
          } finally {
            if (pending) {
              pending = false
              callbacks.onStateChange("idle")
              remote.refresh()
            }
          }
        },
        stopRecording() {}, // Only the trusted window controls capture and releases text.
        cancelRecording() {
          if (!pending) return
          pending = false
          callbacks.onStateChange("idle")
          void cancelRemoteDictation(id).catch(() => {})
        },
      }
    },
  }
  return {
    choice,
    readFailed: remote.readFailed,
    async authorizeApi() {
      return await remote.readFresh() === "api"
    },
    route: (api: VoiceInputEngine) => remote.readFailed() ? undefined : choice() === "api" ? api : relay.canStart() ? relay : undefined,
  }
}
