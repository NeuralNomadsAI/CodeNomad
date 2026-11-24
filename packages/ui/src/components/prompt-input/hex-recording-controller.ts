import { blobToBase64 } from "../../lib/audio-utils"
import { startPcmCapture } from "../../lib/hex-capture"
import { claimMicrophone, microphoneErrorKey, MicrophoneUnavailable } from "../../lib/microphone-lease"
import { requestDeviceSpeech, usesWebKitMicrophone } from "../../lib/native/device-speech"
import { isElectronHost } from "../../lib/runtime-env"
import type { RecordingControllerCallbacks, VoiceInputController } from "./recording-controller"

export function createHexRecordingController(
  locale: string,
  callbacks: RecordingControllerCallbacks,
  send = requestDeviceSpeech,
  claim = claimMicrophone,
): VoiceInputController {
  const lifetime = new AbortController()
  let recording: Awaited<ReturnType<typeof startPcmCapture>> | undefined
  let id: string | undefined
  let timer: number | undefined
  let stopping = false
  let starting = false
  let lease: Awaited<ReturnType<typeof claimMicrophone>> | undefined
  let nativeCancellation: Promise<unknown> | undefined
  const current = () => !lifetime.signal.aborted

  async function releaseLease() {
    await nativeCancellation?.catch(() => {})
    await lease?.release().catch(() => {})
  }

  function settle() {
    if (!current()) return
    lifetime.abort()
    recording?.release()
    recording = undefined
    clearTimeout(timer)
    if (id) nativeCancellation = send("cancel", { id })
    if (!starting) void releaseLease()
    callbacks.onStateChange("idle")
  }

  function failure(permission = false) {
    if (!current()) return
    callbacks.onError(permission ? "promptInput.voiceInput.error.permission" : "promptInput.voiceInput.error.transcribe")
    settle()
  }

  async function poll(owner: string) {
    const result = await send("status", { id: owner })
    if (!current()) return
    if (!result.ok) { failure(); return }
    switch (result.value.state) {
      case "error": failure(); return
      case "transcribed":
        callbacks.onTranscript(result.value.text.trim())
        settle()
        return
      case "cancelled":
      case "stopping": settle(); return
    }
    timer = window.setTimeout(() => { void poll(owner) }, 200)
  }

  function stopRecording() {
    if (!current() || !id || !recording || stopping) return
    stopping = true
    const owner = id
    callbacks.onStateChange("transcribing")
    void recording.finish().then(blobToBase64).then(async wav => {
      if (!current()) return
      const result = await send("finish", { id: owner, wav })
      if (!result.ok) failure()
    }).catch(() => failure())
  }

  return {
    async startRecording() {
      if (!current() || id || starting) return
      if (usesWebKitMicrophone() && navigator.userActivation?.isActive !== true) {
        failure(true)
        return
      }
      starting = true
      callbacks.onStateChange("starting")
      try {
        lease = await claim("dictation", lifetime.signal)
        if (!current()) return
        const result = await send("start", { engine: "hex", locale, microphoneLeaseId: lease.id })
        if (!result.ok) { failure(); return }
        id = result.value.id
        if (!current()) { nativeCancellation = send("cancel", { id }); return }
        void poll(id)
        if (isElectronHost()) {
          const access = await window.electronAPI?.requestMicrophoneAccess?.()
          if (!current()) return
          if (access?.granted === false) { failure(true); return }
        }
        // Leave part of the native operation deadline for inference.
        recording = await startPcmCapture(lifetime.signal, () => failure(true), "hex", 110, stopRecording)
        if (!current()) { recording.release(); recording = undefined; return }
        callbacks.onStateChange("recording")
      } catch (error) {
        if (current() && error instanceof MicrophoneUnavailable) {
          callbacks.onError(microphoneErrorKey(error, "promptInput.voiceInput.error.permission"))
          settle()
        } else failure(error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError"))
      } finally {
        starting = false
        if (!current()) await releaseLease()
      }
    },
    stopRecording,
    cancelRecording: settle,
  }
}
