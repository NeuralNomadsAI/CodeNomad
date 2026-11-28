import { generateUUID } from "./client-identity"
import { requestApiMicrophone, usesWebKitMicrophone } from "./native/device-speech"

const frameReleases = new WeakMap<MediaStream, () => void>()
const denied = () => new DOMException("Microphone permission denied", "NotAllowedError")

function releaseMicrophoneFrame(stream: MediaStream) {
  frameReleases.get(stream)?.()
  frameReleases.delete(stream)
}

export function stopTracks(stream: MediaStream | null) {
  stream?.getTracks().forEach(track => track.stop())
  if (stream) releaseMicrophoneFrame(stream)
}

export async function getMicrophone(
  signal: AbortSignal,
  audio: boolean | MediaTrackConstraints = true,
  engine: "api" | "hex" = "api",
  leaseId?: string,
): Promise<MediaStream> {
  signal.throwIfAborted()
  if (!usesWebKitMicrophone()) return navigator.mediaDevices.getUserMedia({ audio })
  if (window !== window.top || (engine === "api" && navigator.userActivation?.isActive !== true)) throw denied()

  const id = engine === "api" ? leaseId ?? generateUUID() : undefined
  const frame = document.createElement("iframe")
  frame.hidden = true
  let admitted = false
  const release = () => {
    signal.removeEventListener("abort", release)
    frame.remove()
    if (id && admitted) {
      admitted = false
      void requestApiMicrophone("revokeApiMicrophone", id).catch(() => {})
    }
  }
  signal.addEventListener("abort", release, { once: true })
  try {
    if (id) {
      admitted = await requestApiMicrophone("authorizeApiMicrophone", id)
      if (!admitted) throw denied()
    }
    signal.throwIfAborted()
    // Local WebKit capture is owned by this temporary frame. Remote Linux
    // windows use the separate native recorder and never receive a media stream.
    document.body.append(frame)
    const devices = frame.contentWindow?.navigator.mediaDevices
    if (!devices) throw denied()
    const stream = await devices.getUserMedia({ audio })
    if (signal.aborted) {
      stream.getTracks().forEach(track => track.stop())
      signal.throwIfAborted()
    }
    frameReleases.set(stream, release)
    for (const track of stream.getAudioTracks()) {
      track.addEventListener("ended", () => {
        if (stream.getAudioTracks().every(track => track.readyState === "ended")) releaseMicrophoneFrame(stream)
      })
    }
    return stream
  } catch (error) {
    release()
    throw error
  }
}
