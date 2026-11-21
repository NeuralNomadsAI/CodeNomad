import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { isSpeechLocale, maxDeviceSpeechTextBytes, resolveSystemSpeechLocale, type DeviceSpeechCapabilities, type DeviceSpeechError } from "../../../desktop-speech/contract"
import type { DeviceSpeechDriver, SpeechOperationControl } from "./device-speech"

const maxFrame = 512 * 1024 // JSON escaping of up to 64 KiB of text.
type Capability = Omit<DeviceSpeechCapabilities, "hex">

export class SystemSpeechFailure extends Error {
  constructor(readonly code: DeviceSpeechError) { super(code) }
}

export function createSystemSpeechDriver(resources: string): DeviceSpeechDriver {
  const program = join(resources, "server", "desktop-speech",
    process.platform === "win32" ? "codenomad-system-speech.exe" : "codenomad-system-speech")
  let probe: { until: number; value: Capability } | undefined
  function discover(): Capability {
    if (process.platform !== "win32" && process.platform !== "darwin")
      return { system: "unavailable", systemReason: "platformUnsupported" }
    if (!existsSync(program)) return { system: "unavailable", systemReason: "runtimeUnavailable" }
    const child = spawnSync(program, ["probe"], {
      windowsHide: true, timeout: 2500, killSignal: "SIGKILL", maxBuffer: 16 * 1024,
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    })
    try {
      if (child.status === 0) {
        const locales: unknown = JSON.parse(child.stdout).value
        if (Array.isArray(locales) && locales.length <= 256 && locales.every(isSpeechLocale))
          return locales.length ? { system: "ready", systemLocales: locales } : { system: "unavailable", systemReason: "noRecognizer" }
      }
    } catch { /* Fail closed if the helper protocol is invalid. */ }
    return { system: "unavailable", systemReason: "runtimeUnavailable" }
  }
  function system(): Capability {
    if (!probe || probe.until <= Date.now()) probe = { value: discover(), until: Date.now() + 1500 }
    return probe.value
  }
  return {
    capabilities: () => ({ ...system(), hex: { state: "unavailable" } }),
    async prepare() { throw new SystemSpeechFailure("unavailable") },
    async dictate(engine, locale, control) {
      if (engine !== "system") throw new SystemSpeechFailure("unavailable")
      const caps = system()
      if (caps.system !== "ready") throw new SystemSpeechFailure("unavailable")
      const resolved = resolveSystemSpeechLocale(caps.systemLocales ?? [], locale)
      if (!resolved) throw new SystemSpeechFailure("localeUnavailable")
      return runSystemDictation(program, ["dictate", resolved], control)
    },
  }
}

export function runSystemDictation(program: string, args: readonly string[], control: SpeechOperationControl): Promise<string> {
  if (control.signal.aborted) return Promise.reject(new SystemSpeechFailure("failed"))
  const child = spawn(program, args, { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
  return new Promise((resolve, reject) => {
    let stop: NodeJS.Timeout | undefined
    let failure: SystemSpeechFailure | undefined
    let output: string | undefined
    let buffer = Buffer.alloc(0)
    const finish = () => child.stdin.write("finish\n")
    const cancel = () => {
      if (stop) return
      child.stdin.destroy()
      stop = setTimeout(() => child.kill("SIGKILL"), 750).unref()
    }
    const fail = () => { failure = new SystemSpeechFailure("failed"); cancel() }
    const limit = setTimeout(fail, 150_000).unref()
    child.once("error", fail)
    child.stdin.on("error", () => { /* A closing helper may already have published a result. */ })
    child.stdout.on("error", fail)
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure || control.signal.aborted) return
      buffer = Buffer.concat([buffer, chunk])
      for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10)) {
        if (end >= maxFrame) { fail(); return }
        const frame = buffer.subarray(0, end)
        buffer = buffer.subarray(end + 1)
        try {
          if (output !== undefined || failure) throw new Error()
          const result = JSON.parse(frame.toString("utf8"))
          if (result?.progress?.state === "recording") {
            const text: unknown = result.progress.text
            if (text === undefined) control.progress({ state: "recording" })
            else if (typeof text === "string" && Buffer.byteLength(text) <= maxDeviceSpeechTextBytes)
              control.progress({ state: "recording", text })
            else throw new Error()
          } else if (result?.progress?.state === "transcribing") {
            control.progress({ state: "transcribing" })
          } else if (typeof result?.value === "string" && Buffer.byteLength(result.value) <= maxDeviceSpeechTextBytes) {
            output = result.value
          } else if (result?.error === "permissionDenied" || result?.error === "localeUnavailable" || result?.error === "failed") {
            failure = new SystemSpeechFailure(result.error)
          } else throw new Error()
        } catch { fail(); return }
      }
      if (buffer.length >= maxFrame) fail()
    })
    child.once("close", code => {
      clearTimeout(stop)
      clearTimeout(limit)
      control.signal.removeEventListener("abort", cancel)
      control.finish.removeEventListener("abort", finish)
      if (failure) reject(failure)
      else if (code !== 0 || buffer.length || output === undefined || control.signal.aborted)
        reject(new SystemSpeechFailure("failed"))
      else resolve(output)
    })
    control.signal.addEventListener("abort", cancel, { once: true })
    if (control.finish.aborted) finish()
    else control.finish.addEventListener("abort", finish, { once: true })
  })
}
