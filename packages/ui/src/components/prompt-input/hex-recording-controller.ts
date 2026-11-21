import { blobToBase64 } from "../../lib/audio-utils"
import { hexCaptureAvailable, startPcmCapture } from "../../lib/hex-capture"
import { claimMicrophone, microphoneErrorKey, MicrophoneUnavailable } from "../../lib/microphone-lease"
import { requestDeviceSpeech, usesWebKitMicrophone, type LocalSpeechEngine } from "../../lib/native/device-speech"
import { isElectronHost } from "../../lib/runtime-env"
import type { RecordingControllerCallbacks, VoiceInputController } from "./recording-controller"

export { hexCaptureAvailable }

export function createNativeRecordingController(
  engine: LocalSpeechEngine,
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
  let nativeRecording = false
  let lastPreview: string | undefined
  let lastPreviewAt = -Infinity
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
    if (!result.ok) { failure(result.error === "permissionDenied"); return }
    switch (result.value.state) {
      case "error": failure(result.value.error === "permissionDenied"); return
      case "transcribed":
        callbacks.onTranscript(result.value.text.trim())
        settle()
        return
      case "cancelled":
      case "stopping": settle(); return
      case "recording":
        if (engine === "system" && !stopping) {
          if (!nativeRecording) {
            nativeRecording = true
            callbacks.onStateChange("recording")
          }
          const text = result.value.text
          // Coalesce changing hypotheses for the polite live region.
          const now = performance.now()
          if (callbacks.onRecordingPreview && text !== undefined && text !== lastPreview && now - lastPreviewAt >= 1000) {
            lastPreview = text
            lastPreviewAt = now
            const characters = Array.from(text.trim())
            callbacks.onRecordingPreview(characters.length > 120 ? `…${characters.slice(-120).join("")}` : characters.join(""))
          }
        }
        break
      case "transcribing":
        if (engine === "system" && !stopping) {
          stopping = true
          callbacks.onStateChange("transcribing")
        }
        break
    }
    timer = window.setTimeout(() => { void poll(owner) }, 200)
  }

  function stopRecording() {
    if (!current() || !id || (!recording && !nativeRecording) || stopping) return
    stopping = true
    const owner = id
    callbacks.onStateChange("transcribing")
    void (recording?.finish().then(blobToBase64) ?? Promise.resolve(undefined)).then(async wav => {
      if (!current()) return
      const result = await send("finish", wav ? { id: owner, wav } : { id: owner })
      if (!result.ok) failure(result.error === "permissionDenied")
    }).catch(() => failure())
  }

  return {
    async startRecording() {
      if (!current() || id || starting) return
      if (engine === "hex" && usesWebKitMicrophone() && navigator.userActivation?.isActive !== true) {
        failure(true)
        return
      }
      starting = true
      callbacks.onStateChange("starting")
      try {
        lease = await claim("dictation", lifetime.signal)
        if (!current()) return
        const result = await send("start", { engine, locale, microphoneLeaseId: lease.id })
        if (!result.ok) { failure(result.error === "permissionDenied"); return }
        id = result.value.id
        if (!current()) { nativeCancellation = send("cancel", { id }); return }
        void poll(id)
        if (engine === "system") return
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
