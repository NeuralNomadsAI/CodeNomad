import { createHexCache } from "../../../desktop-speech/hex-cache.mjs"
import { HexFailure } from "../../../desktop-speech/hex-files.mjs"
import { validWav } from "../../../desktop-speech/hex-process.mjs"
import { stopWindowsProcessTree } from "../../../server/src/process-tree"
import type { DeviceSpeechDriver } from "./device-speech"

export function createHexSpeechDriver(root: string, isSelected: () => boolean): DeviceSpeechDriver {
  const cache = createHexCache(root, {
    isSelected,
    stopTree: process.platform === "win32" ? (pid, startedBy) => stopWindowsProcessTree(pid, startedBy, 1_500) : undefined,
  })
  return {
    capabilities: () => ({ hex: cache.capabilities() }),
    prepare: (plan, control) => cache.prepare(plan.id, control.signal, control.progress),
    stop: cache.stop,
    dictate(control) {
      return cache.use(control.signal, async transcribe => {
        control.progress({ state: "recording" })
        const wav = await control.waitForAudio()
        if (!wav) throw new HexFailure()
        control.progress({ state: "transcribing" })
        return transcribe(wav)
      })
    },
  }
}

export function decodeHexAudio(input?: string): Buffer | undefined {
  if (!input) return
  const wav = Buffer.from(input, "base64")
  if (validWav(wav)) return wav
}
