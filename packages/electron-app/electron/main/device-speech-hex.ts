import { createHexCache } from "../../../desktop-speech/hex-cache.mjs"
import { HexFailure } from "../../../desktop-speech/hex-files.mjs"
import { validWav } from "../../../desktop-speech/hex-process.mjs"
import type { DeviceSpeechDriver } from "./device-speech"

export function createHexSpeechDriver(root: string): DeviceSpeechDriver {
  const cache = createHexCache(root)
  return {
    capabilities: () => ({ hex: cache.capabilities() }),
    prepare: (plan, control) => cache.prepare(plan.id, control.signal, control.progress),
    async dictate(control) {
      control.progress({ state: "recording" })
      const wav = await control.waitForAudio()
      if (!wav) throw new HexFailure()
      control.progress({ state: "transcribing" })
      return cache.transcribe(wav, control.signal)
    },
  }
}

export function decodeHexAudio(input?: string): Buffer | undefined {
  if (!input) return
  const wav = Buffer.from(input, "base64")
  if (validWav(wav)) return wav
}
