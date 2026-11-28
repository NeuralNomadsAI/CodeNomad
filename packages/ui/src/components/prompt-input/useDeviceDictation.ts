import type { Accessor } from "solid-js"
import { requestDeviceSpeech, type DeviceSpeechSnapshot } from "../../lib/native/device-speech"
import { isElectronHost, isLocalWindow, isTauriHost } from "../../lib/runtime-env"
import { createHexRecordingController } from "./hex-recording-controller"
import { hexCaptureAvailable } from "../../lib/hex-capture"
import type { VoiceInputEngine } from "./recording-controller"
import { createDictationSnapshot } from "./dictation-snapshot"

export function canUseHexDictation(snapshot: DeviceSpeechSnapshot | undefined): boolean {
  return snapshot?.engine === "hex" && snapshot.hex.state === "ready" && hexCaptureAvailable()
}

const device = createDictationSnapshot(async () => {
  const result = await requestDeviceSpeech("read", {})
  return result.ok ? result.value : undefined
})

export function useDeviceDictation(locale: () => string, active: Accessor<boolean>) {
  if (!isLocalWindow() || (!isTauriHost() && !(isElectronHost() && window.electronAPI?.deviceSpeech))) return
  const { snapshot } = device
  device.use(active)
  const hex: VoiceInputEngine = {
    canStart: () => canUseHexDictation(snapshot()),
    createController: callbacks => createHexRecordingController(locale(), callbacks),
  }
  return {
    readFailed: device.readFailed,
    choice: () => snapshot()?.engine,
    async authorizeApi() {
      return (await device.readFresh())?.engine === "api"
    },
    route: (api: VoiceInputEngine) => {
      if (device.readFailed()) return
      const choice = snapshot()?.engine
      return choice === "api" ? api : choice === "hex" ? hex : undefined
    },
  }
}
