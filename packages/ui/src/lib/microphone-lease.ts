import { isMicrophonePurpose, type MicrophonePurpose } from "../../../desktop-speech/contract"
import { generateUUID } from "./client-identity"
import { requestDeviceSpeech } from "./native/device-speech"
import { requestRemoteMicrophone } from "./native/remote-dictation"
import { isDesktopHost, isRemoteWindow } from "./runtime-env"

export type { MicrophonePurpose } from "../../../desktop-speech/contract"

type Reason = MicrophonePurpose | "busy" | "unavailable"
export class MicrophoneUnavailable extends Error {
  constructor(readonly reason: Reason) {
    super(reason)
  }
}

export function microphoneErrorKey(error: unknown, fallback: string) {
  return error instanceof MicrophoneUnavailable ? `voice.microphone.${error.reason}` : fallback
}

type Release = () => void | Promise<void>
type Admit = (id: string, purpose: MicrophonePurpose) => Promise<Release>

// Hold the local admission until both the capture and its external lease have closed.
export function createMicrophoneLeases(admit: Admit) {
  let occupied: MicrophonePurpose | undefined
  return async (purpose: MicrophonePurpose, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (occupied) throw new MicrophoneUnavailable(occupied)
    occupied = purpose
    const id = generateUUID()
    let close: Release | undefined
    let closing: Promise<void> | undefined
    const release = () => closing ??= Promise.resolve().then(() => close?.()).finally(() => {
      occupied = undefined
    })
    try {
      close = await admit(id, purpose)
      signal.throwIfAborted()
      return { id, release }
    } catch (error) {
      await release()
      throw error
    }
  }
}

const lockName = "codenomad:microphone"
const purposeKey = `${lockName}:purpose`

async function admitBrowser(_id: string, purpose: MicrophonePurpose): Promise<Release> {
  if (!navigator.locks || !window.isSecureContext) throw new MicrophoneUnavailable("unavailable")
  return new Promise((resolve, reject) => {
    const request = navigator.locks.request(lockName, { ifAvailable: true, mode: "exclusive" }, async lock => {
      if (!lock) {
        let active: unknown
        try { active = localStorage.getItem(purposeKey) } catch { /* Metadata is optional; Web Locks owns admission. */ }
        throw new MicrophoneUnavailable(isMicrophonePurpose(active) ? active : "busy")
      }
      try { localStorage.setItem(purposeKey, purpose) } catch { /* Same-origin lock remains authoritative. */ }
      let unlock!: () => void
      const done = new Promise<void>(settle => { unlock = settle })
      resolve(async () => { unlock(); await request })
      await done
      try { localStorage.removeItem(purposeKey) } catch { /* Metadata is replaced by the next holder. */ }
    })
    void request.catch(reject)
  })
}

async function admitDesktop(id: string, purpose: MicrophonePurpose): Promise<Release> {
  const remote = isRemoteWindow()
  const release = async () => {
    try {
      if (remote) await requestRemoteMicrophone({ action: "releaseMicrophone", id })
      else await requestDeviceSpeech("releaseMicrophone", { id })
    } catch { /* The native document lifetime also revokes the lease. */ }
  }
  try {
    const result = remote ? await requestRemoteMicrophone({ action: "claimMicrophone", id, purpose })
      : await requestDeviceSpeech("claimMicrophone", { id, purpose })
    if (result?.ok && result.value?.busy === null) return release
    if (result?.ok && isMicrophonePurpose(result.value?.busy)) throw new MicrophoneUnavailable(result.value.busy)
  } catch (error) {
    if (error instanceof MicrophoneUnavailable) throw error
  }
  // A lost or unrecognized response can still have admitted this exact request.
  await release()
  throw new MicrophoneUnavailable("unavailable")
}

/** Retain the lease through permission and close audio capture before releasing it. */
export const claimMicrophone = createMicrophoneLeases((id, purpose) =>
  isDesktopHost() ? admitDesktop(id, purpose) : admitBrowser(id, purpose))
