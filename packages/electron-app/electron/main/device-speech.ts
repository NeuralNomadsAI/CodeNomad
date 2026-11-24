import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { SelectionLock } from "./profile-transition"
import { decodeHexAudio } from "./device-speech-hex"
import { HexFailure } from "../../../desktop-speech/hex-files.mjs"
import {
  isSpeechEngine, maxDeviceSpeechTextBytes, type DeviceSpeechCapabilities, type DeviceSpeechError,
  type DeviceSpeechOperation, type DeviceSpeechRequest, type DeviceSpeechResponses,
  type DeviceSpeechResult, type HexPlan, type MicrophonePurpose, type SpeechEngine,
} from "../../../desktop-speech/contract"

const unavailable: DeviceSpeechCapabilities = { hex: { state: "unavailable" } }
const ok = <T>(value: T) => ({ ok: true, value } as const)
const error = (error: DeviceSpeechError) => ({ ok: false, error } as const)
const terminal = (state: DeviceSpeechOperation["state"]) =>
  state === "prepared" || state === "transcribed" || state === "cancelled" || state === "error"

export interface SpeechOperationControl {
  signal: AbortSignal
  waitForAudio(): Promise<Buffer | undefined>
  progress(value: Extract<DeviceSpeechOperation, { state: "downloading" | "recording" }> |
    { state: "transcribing" | "verifying" }): void
}
export interface DeviceSpeechDriver {
  // Read-only discovery. A plan id covers the exact components, retained partial bytes and approved sources.
  capabilities(): DeviceSpeechCapabilities
  prepare(plan: HexPlan, control: SpeechOperationControl): Promise<void>
  stop?(): Promise<void>
  // Resolve after inference has stopped.
  dictate(control: SpeechOperationControl): Promise<string>
}

export class DeviceSpeechPreference {
  constructor(private path: string) {}

  read(): { engine: SpeechEngine | null; revision: string } {
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
      if (value?.version !== 1 || typeof value.engine !== "string" ||
          typeof value.revision !== "string" || !/^[a-f0-9-]{36}$/.test(value.revision)) {
        throw new Error("Invalid speech preference")
      }
      return { engine: isSpeechEngine(value.engine) ? value.engine : null, revision: value.revision }
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
  audio?: Buffer
  lease?: NodeJS.Timeout
  state: DeviceSpeechOperation
  reason?: "failed"
}

export class DeviceSpeech {
  private slots = new Map<"prepare" | "start", Slot>()
  private microphone?: { owner: number; id: string; purpose: MicrophonePurpose; expiresAt?: number }

  constructor(private preference: DeviceSpeechPreference, private hexDriver?: DeviceSpeechDriver,
    private now = Date.now) {}

  private currentMicrophone() {
    if (this.microphone?.expiresAt !== undefined && this.now() >= this.microphone.expiresAt) this.microphone = undefined
    return this.microphone
  }

  authorizeRendererMicrophone(owner: number): boolean {
    const lease = this.currentMicrophone()
    if (lease?.owner !== owner) return false
    lease.expiresAt = undefined
    return true
  }

  private capabilities(): DeviceSpeechCapabilities {
    return this.hexDriver?.capabilities() ?? unavailable
  }

  request(owner: number, input: DeviceSpeechRequest, remote = false): DeviceSpeechResult<DeviceSpeechResponses[keyof DeviceSpeechResponses]> {
    try {
      const snapshot = () => ({ engine: this.preference.read().engine, ...this.capabilities() })
      switch (input.action) {
        case "claimMicrophone": {
          const busy = this.currentMicrophone()?.purpose ?? (this.active("start") ? "dictation" : null)
          if (!busy) this.microphone = { owner, id: input.id, purpose: input.purpose, expiresAt: remote ? this.now() + 10_000 : undefined }
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
          if (input.engine === "hex" && current.hex.state !== "ready") return error("unavailable")
          const refused = this.preference.select(input.engine)
          if (!refused && input.engine !== "hex") void this.stopHex()
          return refused ? error(refused) : ok({ ...current, engine: input.engine })
        }
        case "prepare": {
          if (this.active("prepare") || this.active("start")) return error("busy")
          const hex = snapshot().hex
          const driver = this.hexDriver
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
          if (this.active("start") || this.active("prepare")) return error("busy")
          const lease = this.currentMicrophone()
          if (lease && !(lease.owner === owner && lease.id === input.microphoneLeaseId && lease.purpose === "dictation")) {
            return error("busy")
          }
          if (!lease && input.microphoneLeaseId) return error("notOwned")
          const current = snapshot()
          const driver = this.hexDriver
          if (!driver || current.engine !== "hex" || current.hex.state !== "ready") return error("unavailable")
          return ok(this.begin(owner, "start", async (control) => {
            const text = await driver.dictate(control)
            return Buffer.byteLength(text) <= maxDeviceSpeechTextBytes ? { state: "transcribed", text } : { state: "error", error: "failed" }
          }))
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
            if (!(slot.audio = decodeHexAudio(input.wav))) return error("failed")
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

  async revokeAll(): Promise<void> {
    this.microphone = undefined
    for (const slot of this.slots.values()) this.revoke(slot.owner)
    await this.stopHex()
  }

  private stopHex(): Promise<void> | undefined {
    const slot = this.slots.get("start")
    if (slot) this.abort(slot)
    return this.hexDriver?.stop?.()
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
  ) => Promise<DeviceSpeechOperation>) {
    const previous = this.slots.get(operation)
    if (previous) this.clear(previous)
    const slot: Slot = { owner, operation, id: randomUUID(), abort: new AbortController(), finish: new AbortController(),
      state: { state: "starting" } }
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
      signal: slot.abort.signal,
      waitForAudio: async () => {
        const signal = AbortSignal.any([slot.abort.signal, slot.finish.signal])
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
        const audio = slot.audio
        slot.audio = undefined
        return slot.abort.signal.aborted ? undefined : audio
      },
      progress: (value) => {
        if (!slot.abort.signal.aborted && !terminal(slot.state.state) &&
            (operation === "prepare" ? value.state === "downloading" || value.state === "verifying" :
              (value.state === "recording" && !slot.finish.signal.aborted) || value.state === "transcribing")) slot.state = value
      },
    }, settle)).then(settle, cause => settle({ state: "error", error: cause instanceof HexFailure ? cause.code : "failed" }))
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
