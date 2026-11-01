import path from "node:path"
import { lstat } from "node:fs/promises"
import { z } from "zod"
import { SupervisionError, type SupervisionManifest } from "./service-supervision-contract"
import { withLinuxSupervisionLock } from "./service-supervision-linux-lock"
import { linuxCommand, readLinuxPrivate, writeLinuxPrivate, type LinuxCommand } from "./service-supervision-linux-native"
import { readSupervisionHealth } from "./service-supervision-health"
import { lookupProcess, type ProcessLookup } from "./process-identity"
import { readNativeScheduleIncarnation, sameNativeScheduleIncarnation } from "../opencode/missions/native-schedule-transport-identity"
import { privateStorage, type StoragePolicy } from "./storage"

const key = z.string().regex(/^[a-f0-9]{64}$/)
const registrySchema = z.object({ v: z.literal(1), user: z.string().regex(/^\d+$/), host: z.string(),
  phase: z.enum(["external", "enabling", "owned", "disabling", "uncertain", "disabled"]),
  fingerprint: z.string().nullable(), requests: z.array(key).max(256),
  released: z.array(z.object({ key, registration: z.string().max(4096),
    process: z.object({ pid: z.number().int().positive(), id: z.string().min(1), startIdentity: z.string().min(1) }).strict().nullable().default(null),
  }).strict()).max(256),
  deferred: z.boolean(),
}).strict()
type Registry = z.infer<typeof registrySchema>
export type LinuxLingerState = "enabled" | "external" | "disabled" | "deferred" | "uncertain" | "permission-required"
interface Dependencies {
  command: LinuxCommand
  fingerprint(): Promise<string | null>
  health: typeof readSupervisionHealth
  lookup: ProcessLookup
  identity: typeof releasedProcess
  lock<T>(file: string, run: () => Promise<T>): Promise<T>
}

async function releasedProcess(registration: string, lookup: ProcessLookup) {
  try {
    const stat = await lstat(registration)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    const before = readNativeScheduleIncarnation(registration), process = await lookup(before.pid)
    if (process.state === "live" && sameNativeScheduleIncarnation(before, readNativeScheduleIncarnation(registration)))
      return { pid: before.pid, id: before.id, startIdentity: process.startIdentity }
  } catch { /* Missing or damaged metadata leaves release ownership unknown. */ }
  return null
}

/** A single registry per UID/host, across every native service namespace. An
 * interrupted enable/disable remains uncertain and never acquires ownership. */
export class LinuxSupervisionLinger {
  private readonly deps: Dependencies
  constructor(private readonly root: string, private readonly user: string, private readonly host: string,
    username: string, private readonly policy: StoragePolicy = privateStorage, overrides: Partial<Dependencies> = {}) {
    if (!/^[A-Za-z0-9_.@-]+$/.test(username)) throw new SupervisionError("invalid")
    this.deps = { command: linuxCommand, health: readSupervisionHealth, lookup: lookupProcess, identity: releasedProcess,
      lock: (file, run) => withLinuxSupervisionLock(file, run, policy),
      fingerprint: async () => {
        try {
          const s = await lstat(`/var/lib/systemd/linger/${username}`, { bigint: true })
          if (!s.isFile() || s.isSymbolicLink() || s.uid !== 0n) throw new SupervisionError("unsafe-storage")
          return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}`
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
      }, ...overrides }
  }
  private async read(): Promise<Registry | undefined> {
    const raw = await readLinuxPrivate(path.join(this.root, "linux-linger.json"), this.policy)
    if (raw === undefined) return
    const r = registrySchema.parse(raw)
    if (r.user !== this.user || r.host !== this.host || new Set(r.requests).size !== r.requests.length)
      throw new SupervisionError("conflict")
    return r
  }
  private async enabled() {
    const value = await this.deps.command("/usr/bin/loginctl", ["show-user", this.user, "--property=Linger", "--value"])
    if (value !== "yes" && value !== "no") throw new SupervisionError("invalid")
    return value === "yes"
  }
  private save(r: Registry) { return writeLinuxPrivate(path.join(this.root, "linux-linger.json"), registrySchema.parse(r), this.policy) }

  /** Persist the live process before stopping its guard. Health failure and a
   * later deleted registration must preserve this independent native identity. */
  async retainReleased(manifest: SupervisionManifest): Promise<void> {
    await this.deps.lock(path.join(this.root, "linux-linger.lock"), async () => {
      const r = await this.read()
      if (!r || r.released.some(entry => entry.key === manifest.key)) return
      const registration = path.posix.join(manifest.namespace.stateDirectory, manifest.namespace.registrationName)
      r.released.push({ key: manifest.key, registration, process: await this.deps.identity(registration, this.deps.lookup) })
      await this.save(r)
    })
  }

  async observe(): Promise<LinuxLingerState> {
    await this.reconcileDeferred()
    const r = await this.read(), enabled = await this.enabled()
    if (!r) return enabled ? "external" : "disabled"
    if (r.phase === "enabling") return enabled ? "uncertain" : "permission-required"
    if (["disabling", "uncertain"].includes(r.phase)) return "uncertain"
    if (r.phase === "owned" && (!enabled || r.fingerprint !== await this.deps.fingerprint())) return "uncertain"
    return r.deferred ? "deferred" : enabled ? r.phase === "owned" ? "enabled" : "external" : "disabled"
  }

  /** Complete an already requested rollback during startup/status reconciliation.
   * Recheck all account-wide consumers and provenance under the same lock as ON. */
  async reconcileDeferred(): Promise<void> {
    await this.deps.lock(path.join(this.root, "linux-linger.lock"), async () => {
      const r = await this.read()
      if (!r?.deferred || r.phase !== "owned" || r.requests.length) return
      if (!await this.enabled() || r.fingerprint !== await this.deps.fingerprint()) {
        r.phase = "uncertain"; await this.save(r); return
      }
      await this.rollback(r)
    })
  }

  async reconcile(manifest: SupervisionManifest): Promise<LinuxLingerState> {
    return this.deps.lock(path.join(this.root, "linux-linger.lock"), async () => {
      let r = await this.read()
      let enabled = await this.enabled()
      if (!r) r = { v: 1, user: this.user, host: this.host, phase: enabled ? "external" : "disabled",
        fingerprint: null, requests: [], released: [], deferred: false }
      if (r.phase === "owned" && (!enabled || r.fingerprint !== await this.deps.fingerprint())) r.phase = "uncertain"
      if (r.phase === "disabling") r.phase = "uncertain"
      if (manifest.desired === "on") {
        if (!r.requests.includes(manifest.key)) r.requests.push(manifest.key)
        r.released = r.released.filter(value => value.key !== manifest.key)
        r.deferred = false
        if (r.phase === "enabling" && enabled) r.phase = "uncertain" // Lost ACK cannot prove who enabled it.
        await this.save(r)
        if (r.phase === "uncertain") return "uncertain"
        if (!enabled) {
          r.phase = "enabling"; r.fingerprint = null; await this.save(r)
          try { await this.deps.command("/usr/bin/loginctl", ["--no-ask-password", "enable-linger", this.user]) }
          catch { return "permission-required" }
          enabled = await this.enabled()
          if (!enabled || !(r.fingerprint = await this.deps.fingerprint())) return "uncertain"
          r.phase = "owned"; await this.save(r)
        }
        return r.phase === "owned" ? "enabled" : "external"
      }
      r.requests = r.requests.filter(value => value !== manifest.key)
      if (!r.released.some(value => value.key === manifest.key)) {
        const registration = path.posix.join(manifest.namespace.stateDirectory, manifest.namespace.registrationName)
        r.released.push({ key: manifest.key, registration, process: await this.deps.identity(registration, this.deps.lookup) })
      }
      await this.save(r)
      if (["enabling", "uncertain"].includes(r.phase)) return "uncertain"
      if (r.phase !== "owned" || r.requests.length) return enabled ? r.phase === "owned" ? "enabled" : "external" : "disabled"
      return this.rollback(r)
    })
  }

  private async rollback(r: Registry): Promise<LinuxLingerState> {
    // A session must really maintain the user manager. Closing/lingering-only
    // sessions do not qualify. Otherwise every released service must be absent.
    const sessions = (await this.deps.command("/usr/bin/loginctl", ["show-user", this.user, "--property=Sessions", "--value"])).split(/\s+/).filter(Boolean)
    let safe = false
    for (const id of sessions) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new SupervisionError("invalid")
      const state = await this.deps.command("/usr/bin/loginctl", ["show-session", id, "--property=State", "--value"])
      if (state === "active" || state === "online") safe = true
    }
    if (!safe) {
      safe = true
      for (const entry of r.released) {
        if (!entry.process) { safe = false; continue }
        const process = await this.deps.lookup(entry.process.pid)
        if (process.state === "unknown" || process.state === "live" && process.startIdentity === entry.process.startIdentity
          || (await this.deps.health(entry.registration)).state !== "absent") safe = false
      }
    }
    if (!safe) { r.deferred = true; await this.save(r); return "deferred" }
    // Revalidate the owned marker immediately before rollback.
    if (r.fingerprint !== await this.deps.fingerprint()) { r.phase = "uncertain"; await this.save(r); return "uncertain" }
    r.phase = "disabling"; await this.save(r)
    try { await this.deps.command("/usr/bin/loginctl", ["--no-ask-password", "disable-linger", this.user]) }
    catch { r.phase = "owned"; r.deferred = true; await this.save(r); return "permission-required" }
    if (await this.enabled()) return "uncertain"
    r.phase = "disabled"; r.fingerprint = null; r.deferred = false; r.released = []; await this.save(r)
    return "disabled"
  }
}
