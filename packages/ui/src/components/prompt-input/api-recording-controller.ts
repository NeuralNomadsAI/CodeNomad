import { serverApi } from "../../lib/api-client"
import { blobToBase64, createMediaRecorder, supportedRecordingType } from "../../lib/audio-utils"
import { hexCaptureAvailable, startPcmCapture } from "../../lib/hex-capture"
import { getMicrophone, stopTracks } from "../../lib/microphone"
import { claimMicrophone, microphoneErrorKey } from "../../lib/microphone-lease"
import { usesWebKitMicrophone } from "../../lib/native/device-speech"
import { remoteApiMicrophoneAvailable, startRemoteApiMicrophone, usesNativeRemoteApiMicrophone } from "../../lib/native/remote-api-microphone"
import { isDesktopHost, isElectronHost } from "../../lib/runtime-env"
import { createRecordingController, type RecordingControllerCallbacks } from "./recording-controller"

const needsPcm = () => usesWebKitMicrophone() && !supportedRecordingType()

export function apiCaptureAvailable() {
  return typeof window !== "undefined" && (isDesktopHost() || Boolean(navigator.locks)) &&
    (usesNativeRemoteApiMicrophone() ? remoteApiMicrophoneAvailable()
    : needsPcm() ? hexCaptureAvailable()
    : typeof window.MediaRecorder !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function")
}

export function createApiRecordingController(
  callbacks: RecordingControllerCallbacks, purpose: "dictation" | "test" = "dictation", authorize?: () => Promise<boolean>,
) {
  return createRecordingController({
    isElectron: isElectronHost,
    authorize,
    claimMicrophone: signal => claimMicrophone(purpose, signal),
    microphoneErrorKey: error => microphoneErrorKey(error, "promptInput.voiceInput.error.permission"),
    requestMicAccess: async () => window.electronAPI?.requestMicrophoneAccess?.(),
    getUserMedia: (signal, leaseId) => getMicrophone(signal, true, "api", leaseId),
    // 24 seconds at mono 16 kHz/16-bit leaves room for base64 + JSON in the 1 MiB server limit.
    capturePcm: usesNativeRemoteApiMicrophone()
      ? (signal, ended, limit, leaseId) => startRemoteApiMicrophone(
        purpose === "test" ? "startApiInputTest" : "startApiMicrophone", signal, ended, limit, leaseId,
      )
      : needsPcm() ? (signal, ended, limit, leaseId) => startPcmCapture(signal, ended, "api", 24, limit, leaseId) : undefined,
    setupRecorder: (stream, handlers) => {
      const recorder = createMediaRecorder(stream as MediaStream)
      recorder.addEventListener("dataavailable", event => handlers.onDataAvailable(event.data))
      recorder.addEventListener("stop", handlers.onStop)
      recorder.addEventListener("error", handlers.onError)
      return {
        start: () => recorder.start(250),
        stop: () => { if (recorder.state !== "inactive") recorder.stop() },
        get mimeType() { return recorder.mimeType },
      }
    },
    stopTracks: stream => stopTracks(stream as MediaStream | null),
    blobToBase64,
    transcribe: (input, signal) => serverApi.transcribeAudio(input, signal),
  }, callbacks)
}
