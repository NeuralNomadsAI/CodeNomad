import { createSignal } from "solid-js"
import { isMicrophonePurpose, type MicrophonePurpose } from "../../../desktop-speech/contract"
import { generateUUID } from "./client-identity"
import { requestDeviceSpeech } from "./native/device-speech"
import { requestRemoteMicrophone } from "./native/remote-dictation"
import { isDesktopHost, isElectronHost, isRemoteWindow } from "./runtime-env"

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
export function createMicrophoneLeases(admit: Admit, onChange?: (purpose: MicrophonePurpose | undefined) => void) {
  let occupied: MicrophonePurpose | undefined
  return async (purpose: MicrophonePurpose, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (occupied) throw new MicrophoneUnavailable(occupied)
    occupied = purpose
    onChange?.(purpose)
    const id = generateUUID()
    let close: Release | undefined
    let closing: Promise<void> | undefined
    const release = () => closing ??= Promise.resolve().then(() => close?.()).finally(() => {
      occupied = undefined
      onChange?.(undefined)
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
const usesNativeLease = () => isDesktopHost() && !(isElectronHost() && isRemoteWindow()
  && (window.electronAPI?.remoteMicrophoneLease !== true || typeof window.electronAPI.remoteDictation !== "function"))

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

const [localPurpose, setLocalPurpose] = createSignal<MicrophonePurpose>()
const [browserPurpose, setBrowserPurpose] = createSignal<MicrophonePurpose | "busy">()
let readVersion = 0

/** Display hint only: only a claim grants capture. A stale storage value is not
 * sufficient to report a held lock after another document has been closed. */
export async function refreshMicrophoneUse() {
  if (typeof navigator === "undefined" || typeof navigator.locks?.query !== "function" || localPurpose()) return
  const version = ++readVersion
  try {
    const { held } = await navigator.locks.query()
    if (version !== readVersion || localPurpose()) return
    const purpose = localStorage.getItem(purposeKey)
    setBrowserPurpose(held?.some(lock => lock.name === lockName) ? isMicrophonePurpose(purpose) ? purpose : "busy" : undefined)
  } catch {
    if (version === readVersion) setBrowserPurpose(undefined)
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (event.key !== purposeKey && event.key !== null) return
    if (event.newValue) void refreshMicrophoneUse()
    else {
      readVersion++
      setBrowserPurpose(undefined)
    }
  })
  void refreshMicrophoneUse()
}

export const microphoneUse = () => localPurpose() ?? browserPurpose()

/** Retain the lease through permission and close audio capture before releasing it. */
export const claimMicrophone = createMicrophoneLeases(
  async (id, purpose) => {
    if (!usesNativeLease()) return admitBrowser(id, purpose)
    const release = await admitDesktop(id, purpose)
    if (purpose === "conversation") return release
    // Native admission stays authoritative; mirror it for same-origin windows such as Preferences.
    const unmirror = await admitBrowser(id, purpose).catch(() => undefined)
    return async () => {
      try { await release() } finally { await unmirror?.() }
    }
  },
  purpose => {
    readVersion++
    setLocalPurpose(purpose)
    if (!purpose) void refreshMicrophoneUse()
  },
)
