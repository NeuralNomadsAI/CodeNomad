import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { SelectionLock } from "./profile-transition"
import { decodeHexAudio } from "./device-speech-hex"
import { SystemSpeechFailure } from "./device-speech-system"
import { HexFailure } from "../../../desktop-speech/hex-files.mjs"
import {
  isSpeechEngine, resolveSystemSpeechLocale, type DeviceSpeechCapabilities, type DeviceSpeechError,
  type DeviceSpeechOperation, type DeviceSpeechRequest, type DeviceSpeechResponses,
  type DeviceSpeechResult, type HexPlan, type LocalSpeechEngine, type MicrophonePurpose, type SpeechEngine,
} from "../../../desktop-speech/contract"

const unavailable: DeviceSpeechCapabilities = { system: "unavailable", hex: { state: "unavailable" } }
const ok = <T>(value: T) => ({ ok: true, value } as const)
const error = (error: DeviceSpeechError) => ({ ok: false, error } as const)
const terminal = (state: DeviceSpeechOperation["state"]) =>
  state === "prepared" || state === "transcribed" || state === "cancelled" || state === "error"

export interface SpeechOperationControl {
  signal: AbortSignal
  finish: AbortSignal
  waitForAudio(): Promise<Buffer | undefined>
  revokePermission(): void
  progress(value: Extract<DeviceSpeechOperation, { state: "downloading" }> |
    { state: "recording" | "transcribing" | "verifying" }): void
}
export interface DeviceSpeechDriver {
  // Read-only discovery. A plan id covers the exact components, retained partial bytes and approved sources.
  capabilities(): DeviceSpeechCapabilities
  prepare(plan: HexPlan, control: SpeechOperationControl): Promise<void>
  // Resolve after capture and inference have stopped. Observe live OS permission; never fall back to API.
  dictate(engine: LocalSpeechEngine, locale: string, control: SpeechOperationControl): Promise<string>
}

export class DeviceSpeechPreference {
  constructor(private path: string) {}

  read(): { engine: SpeechEngine; revision: string } {
    let fd: number
    try { fd = openSync(this.path, "r") } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { engine: "api", revision: "" }
      throw cause
    }
    try {
      const buffer = Buffer.alloc(257)
      const size = readSync(fd, buffer, 0, buffer.length, null)
      if (size === buffer.length) throw new Error("Speech preference is oversized")
      const value = JSON.parse(buffer.toString("utf8", 0, size))
      if (value?.version !== 1 || !isSpeechEngine(value.engine) ||
          typeof value.revision !== "string" || !/^[a-f0-9-]{36}$/.test(value.revision)) {
        throw new Error("Invalid speech preference")
      }
      return { engine: value.engine, revision: value.revision }
    } finally { closeSync(fd) }
  }

  select(engine: SpeechEngine, expectedRevision?: string): DeviceSpeechError | undefined {
    const revision = randomUUID()
    const temporary = `${this.path}.${revision}.tmp`
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const lock = SelectionLock.acquire(directory, Date.now)
    if (!lock) return "busy"
    try {
      const current = this.read()
      if (expectedRevision !== undefined && current.revision !== expectedRevision) return "planChanged"
      writeFileSync(temporary, JSON.stringify({ version: 1, engine, revision }), { flag: "wx", mode: 0o600 })
      renameSync(temporary, this.path)
    } finally {
      lock.release()
      rmSync(temporary, { force: true })
    }
  }
}

type Slot = {
  id: string
  owner: number
  operation: "prepare" | "start"
  abort: AbortController
  finish: AbortController
  expectsAudio?: boolean
  audio?: Buffer
  lease?: NodeJS.Timeout
  state: DeviceSpeechOperation
  reason?: "permissionDenied" | "failed"
}

export class DeviceSpeech {
  private slots = new Map<"prepare" | "start", Slot>()
  private microphone?: { owner: number; id: string; purpose: MicrophonePurpose }

  constructor(private preference: DeviceSpeechPreference, private driver?: DeviceSpeechDriver, private hexDriver?: DeviceSpeechDriver) {}

  private capabilities(): DeviceSpeechCapabilities {
    const fallback = this.driver?.capabilities() ?? unavailable
    return this.hexDriver ? { ...fallback, hex: this.hexDriver.capabilities().hex } : fallback
  }

  request(owner: number, input: DeviceSpeechRequest): DeviceSpeechResult<DeviceSpeechResponses[keyof DeviceSpeechResponses]> {
    try {
      const snapshot = () => ({ engine: this.preference.read().engine, ...this.capabilities() })
      switch (input.action) {
        case "claimMicrophone": {
          const busy = this.microphone?.purpose ?? (this.active("start") ? "dictation" : null)
          if (!busy) this.microphone = { owner, id: input.id, purpose: input.purpose }
          return ok({ busy })
        }
        case "releaseMicrophone": {
          if (this.microphone?.owner === owner && this.microphone.id === input.id) this.microphone = undefined
          return ok(null)
        }
        case "read": return ok(snapshot())
        case "select": {
          if (this.active("prepare")) return error("busy")
          const current = snapshot()
          if ((input.engine === "system" && current.system !== "ready") ||
              (input.engine === "hex" && current.hex.state !== "ready")) return error("unavailable")
          const refused = this.preference.select(input.engine)
          return refused ? error(refused) : ok({ ...current, engine: input.engine })
        }
        case "prepare": {
          if (this.active("prepare")) return error("busy")
          const hex = snapshot().hex
          const driver = this.hexDriver ?? this.driver
          if (!driver || hex.state === "unavailable") return error("unavailable")
          if (input.planId !== hex.plan.id) return error("planChanged")
          const { revision } = this.preference.read()
          return ok(this.begin(owner, "prepare", async (control, complete) => {
            if (hex.state === "needsPreparation") await driver.prepare(hex.plan, control)
            if (control.signal.aborted) return { state: "cancelled" }
            if (driver.capabilities().hex.state !== "ready") return { state: "error", error: "failed" }
            const refused = this.preference.select("hex", revision)
            if (refused) return { state: "error", error: refused }
            complete({ state: "prepared" })
            return { state: "prepared" }
          }))
        }
        case "start": {
          if (this.active("start")) return error("busy")
          const lease = this.microphone
          if (lease && !(lease.owner === owner && lease.id === input.microphoneLeaseId && lease.purpose === "dictation")) {
            return error("busy")
          }
          if (!lease && input.microphoneLeaseId) return error("notOwned")
          const current = snapshot()
          const driver = current.engine === "hex" ? this.hexDriver ?? this.driver : this.driver
          if (!driver || current.engine === "api" || (input.engine && current.engine !== input.engine) ||
              (current.engine === "system" ? current.system !== "ready" : current.hex.state !== "ready")) return error("unavailable")
          const engine = current.engine
          if (engine === "system" && current.systemLocales && !resolveSystemSpeechLocale(current.systemLocales, input.locale))
            return error("localeUnavailable")
          return ok(this.begin(owner, "start", async (control) => {
            const text = await driver.dictate(engine, input.locale, control)
            return Buffer.byteLength(text) <= 64 * 1024 ? { state: "transcribed", text } : { state: "error", error: "failed" }
          }, engine === "hex" && !!this.hexDriver))
        }
        default: {
          const slot = [...this.slots.values()].find(slot => slot.id === input.id && slot.owner === owner)
          if (!slot) return error("notOwned")
          if (input.action === "status") {
            if (!terminal(slot.state.state) && !slot.abort.signal.aborted) this.renew(slot)
            return ok(slot.state)
          }
          if (input.action === "cancel") {
            const receipt = slot.state.state === "prepared" ? slot.state : null
            if (terminal(slot.state.state)) this.clear(slot)
            else this.abort(slot)
            return ok(receipt)
          } else {
            if (slot.operation !== "start" || slot.abort.signal.aborted || terminal(slot.state.state)) return error("unavailable")
            if (slot.finish.signal.aborted) return error("busy")
            if (slot.expectsAudio) {
              if (!(slot.audio = decodeHexAudio(input.wav))) return error("failed")
            } else if (input.wav !== undefined) return error("unavailable")
            slot.finish.abort()
          }
          return ok(null)
        }
      }
    } catch { return error("failed") }
  }

  revoke(owner: number, documentGone = true): void {
    if (documentGone) this.revokeRendererMicrophone(owner)
    for (const slot of this.slots.values()) {
      if (slot.owner !== owner) continue
      if (terminal(slot.state.state)) this.clear(slot)
      else {
        slot.owner = -1
        this.abort(slot)
      }
    }
  }

  revokeAll(): void {
    this.microphone = undefined
    for (const slot of this.slots.values()) this.revoke(slot.owner)
  }

  revokeRendererMicrophone(owner: number): void {
    if (this.microphone?.owner === owner) this.microphone = undefined
  }

  private active(operation: Slot["operation"]): boolean {
    const slot = this.slots.get(operation)
    return !!slot && !terminal(slot.state.state)
  }

  private begin(owner: number, operation: Slot["operation"], run: (
    control: SpeechOperationControl, complete: (value: DeviceSpeechOperation) => void,
  ) => Promise<DeviceSpeechOperation>, expectsAudio = false) {
    const previous = this.slots.get(operation)
    if (previous) this.clear(previous)
    const slot: Slot = { owner, operation, id: randomUUID(), abort: new AbortController(), finish: new AbortController(),
      state: { state: "starting" }, expectsAudio }
    this.slots.set(operation, slot)
    this.renew(slot)
    const limit = setTimeout(() => this.abort(slot, "failed"), operation === "start" ? 150_000 : 7_200_000).unref()
    const settle = (value: DeviceSpeechOperation) => {
      if (terminal(slot.state.state)) return
      clearTimeout(limit)
      clearTimeout(slot.lease)
      slot.audio = undefined
      slot.state = slot.reason ? { state: "error", error: slot.reason } : slot.abort.signal.aborted ? { state: "cancelled" } : value
      slot.lease = setTimeout(() => this.clear(slot), 30_000).unref()
    }
    void Promise.resolve().then(() => slot.abort.signal.aborted ? { state: "cancelled" } as const : run({
      signal: slot.abort.signal, finish: slot.finish.signal,
      waitForAudio: async () => {
        const signal = AbortSignal.any([slot.abort.signal, slot.finish.signal])
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        const audio = slot.audio
        slot.audio = undefined
        return slot.abort.signal.aborted ? undefined : audio
      },
      revokePermission: () => this.abort(slot, "permissionDenied"),
      progress: (value) => {
        if (!slot.abort.signal.aborted && !terminal(slot.state.state) &&
            (operation === "prepare" ? value.state === "downloading" || value.state === "verifying" :
              value.state === "recording" || value.state === "transcribing")) slot.state = value
      },
    }, settle)).then(settle, cause => settle({ state: "error", error: cause instanceof HexFailure || cause instanceof SystemSpeechFailure ? cause.code : "failed" }))
    return { id: slot.id }
  }

  private abort(slot: Slot, reason?: Slot["reason"]) {
    if (terminal(slot.state.state) || slot.abort.signal.aborted) return
    slot.reason = reason
    slot.state = { state: "stopping" }
    slot.audio = undefined
    slot.abort.abort()
  }

  private renew(slot: Slot) {
    clearTimeout(slot.lease)
    slot.lease = setTimeout(() => this.abort(slot), 30_000).unref()
  }

  private clear(slot: Slot) {
    clearTimeout(slot.lease)
    if (this.slots.get(slot.operation) === slot) this.slots.delete(slot.operation)
  }
}
