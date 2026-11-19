import type { Accessor } from "solid-js"
import { requestDeviceSpeech, resolveSystemSpeechLocale, type DeviceSpeechSnapshot, type LocalSpeechEngine } from "../../lib/native/device-speech"
import { isElectronHost, isLocalWindow, isTauriHost } from "../../lib/runtime-env"
import { createNativeRecordingController, hexCaptureAvailable } from "./hex-recording-controller"
import type { VoiceInputEngine } from "./recording-controller"
import { createDictationSnapshot } from "./dictation-snapshot"

export function availableLocalDictation(snapshot: DeviceSpeechSnapshot | undefined, locale: string): LocalSpeechEngine | undefined {
  if (snapshot?.engine === "hex" && snapshot.hex.state === "ready" && hexCaptureAvailable()) return "hex"
  if (snapshot?.engine === "system" && snapshot.system === "ready"
    && resolveSystemSpeechLocale(snapshot.systemLocales ?? [], locale)) return "system"
}

const device = createDictationSnapshot(async () => {
  const result = await requestDeviceSpeech("read", {})
  return result.ok ? result.value : undefined
})

export function useDeviceDictation(locale: () => string, active: Accessor<boolean>) {
  if (!isLocalWindow() || (!isTauriHost() && !(isElectronHost() && window.electronAPI?.deviceSpeech))) return
  const { snapshot } = device
  device.use(active)
  const engine = (kind: LocalSpeechEngine): VoiceInputEngine => ({
    canStart: () => availableLocalDictation(snapshot(), locale()) === kind,
    createController: callbacks => createNativeRecordingController(kind, locale(), callbacks),
  })
  const system = engine("system"), hex = engine("hex")
  return {
    snapshot,
    languageMissing: () => {
      const current = snapshot()
      return current?.engine === "system" && current.system === "ready" &&
        !resolveSystemSpeechLocale(current.systemLocales ?? [], locale())
    },
    async authorizeApi() {
      const fresh = await device.readFresh()
      if (fresh?.engine === "api") return true
      device.refresh()
      return false
    },
    route: (api: VoiceInputEngine) => {
      const choice = snapshot()?.engine
      return choice === "api" ? api : choice === "system" ? system : choice === "hex" ? hex : undefined
    },
  }
}
