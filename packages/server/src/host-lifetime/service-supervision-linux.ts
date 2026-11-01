import { lstat, readFile, realpath, readlink, unlink, open } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { SupervisionError, type SupervisionObservation } from "./service-supervision-contract"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { LinuxSupervisionLinger } from "./service-supervision-linux-linger"
import { linuxCommand, linuxUnitQuote, preparePosixSupervisionDirectory, readLinuxPrivate, writeLinuxPrivate, type LinuxCommand } from "./service-supervision-linux-native"
import { withLinuxSupervisionLock } from "./service-supervision-linux-lock"
import { readSupervisionHealth } from "./service-supervision-health"
import { lookupProcess } from "./process-identity"
import { privateStorage, type StoragePolicy } from "./storage"

const absolute = z.string().min(1).max(4096).refine(value => path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && !/[\x00-\x1f\\]/.test(value))
export const linuxRuntimeSchema = z.object({ node: absolute, guard: absolute, unitDirectory: absolute,
  environment: z.object({ HOME: absolute, XDG_CONFIG_HOME: absolute, XDG_STATE_HOME: absolute,
    XDG_DATA_HOME: absolute, XDG_CACHE_HOME: absolute, OPENCODE_TEST_HOME: absolute.optional() }).strict(),
}).strict()
export type LinuxSupervisionRuntime = z.infer<typeof linuxRuntimeSchema>

export function linuxSupervisionUnit(key: string, directory: string, runtime: LinuxSupervisionRuntime): string {
  if (!/^[a-f0-9]{64}$/.test(key)) throw new SupervisionError("invalid")
  const d = linuxRuntimeSchema.parse(runtime)
  return `[Unit]\nDescription=CodeNomad OpenCode ${key}\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=${[d.node, d.guard, directory, key].map(linuxUnitQuote).join(" ")}\nRestart=always\nRestartSec=2\nKillMode=process\nTimeoutStopSec=15\nStandardInput=null\nStandardOutput=null\nStandardError=null\n\n[Install]\nWantedBy=default.target\n`
}

export async function readLinuxSupervisionRuntime(store: ServiceSupervisionStore, policy: StoragePolicy = privateStorage) {
  const value = await readLinuxPrivate(path.join(store.directory, "linux.json"), policy)
  if (value === undefined) return
  return linuxRuntimeSchema.parse(value)
}

interface Dependencies {
  command: LinuxCommand
  health: typeof readSupervisionHealth
  lookup: typeof lookupProcess
  lock<T>(file: string, run: () => Promise<T>): Promise<T>
}
export class LinuxServiceSupervision {
  private readonly deps: Dependencies
  constructor(private readonly store: ServiceSupervisionStore, private readonly runtime: LinuxSupervisionRuntime,
    private readonly linger: Pick<LinuxSupervisionLinger, "reconcile" | "observe" | "retainReleased">,
    private readonly policy: StoragePolicy = privateStorage, overrides: Partial<Dependencies> = {}) {
    this.deps = { command: linuxCommand, health: readSupervisionHealth, lookup: lookupProcess,
      lock: (file, run) => withLinuxSupervisionLock(file, run, policy), ...overrides }
  }
  async prepareRuntime() {
    const d = linuxRuntimeSchema.parse(this.runtime), m = await this.store.read()
    if (m.namespace.platform !== "linux" || path.posix.join(d.environment.XDG_CONFIG_HOME, "opencode") !== m.namespace.configDirectory
      || path.posix.join(d.environment.XDG_STATE_HOME, "opencode") !== m.namespace.stateDirectory) throw new SupervisionError("conflict")
    const existing = await readLinuxSupervisionRuntime(this.store, this.policy)
    if (existing && JSON.stringify(existing) !== JSON.stringify(d)) throw new SupervisionError("conflict")
    if (!existing) await writeLinuxPrivate(path.join(this.store.directory, "linux.json"), d, this.policy)
  }
  private async unit() {
    const m = await this.store.read(), name = `codenomad-opencode-${m.key}.service`
    return { name, file: path.join(this.runtime.unitDirectory, name), text: linuxSupervisionUnit(m.key, this.store.directory, this.runtime) }
  }
  private async ownedUnit() {
    const unit = await this.unit()
    const wanted = path.join(this.runtime.unitDirectory, "default.target.wants", unit.name)
    const link = await lstat(wanted).catch(error => { if (error.code !== "ENOENT") throw error; return null })
    if (link && (!link.isSymbolicLink() || path.resolve(path.dirname(wanted), await readlink(wanted)) !== unit.file))
      throw new SupervisionError("conflict")
    const stat = await lstat(unit.file).catch(error => { if (error.code !== "ENOENT") throw error; return null })
    if (!stat) return { ...unit, exists: false }
    await this.policy.verify(unit.file, false)
    if (stat.size > 32768 || await readFile(unit.file, "utf8") !== unit.text) throw new SupervisionError("conflict")
    return { ...unit, exists: true }
  }
  private async loaded(name: string): Promise<Record<string, string>> {
    const text = await this.deps.command("/usr/bin/systemctl", ["--user", "show", name,
      "--property=LoadState,ActiveState,MainPID,FragmentPath,KillMode,UnitFileState,DropInPaths"])
    return Object.fromEntries(text.split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)] }))
  }
  async reconcile(expectedRevision: number) {
    await this.prepareRuntime()
    await this.deps.lock(path.join(this.store.directory, "admission.lock"), async () => {
      const manifest = await this.store.read()
      if (manifest.revision !== expectedRevision) throw new SupervisionError("conflict")
      if (manifest.desired === "unset") return
      let unit = await this.ownedUnit()
      const state = await this.loaded(unit.name)
      if (state.LoadState !== "not-found" && (state.FragmentPath !== unit.file || state.KillMode !== "process" || state.DropInPaths)) throw new SupervisionError("conflict")
      if (manifest.desired === "on") {
        const linger = await this.linger.reconcile(manifest)
        if (!["enabled", "external"].includes(linger)) throw new SupervisionError("busy")
        await preparePosixSupervisionDirectory(this.runtime.unitDirectory)
        // systemd's user directory can contain unrelated public unit files. Only
        // our leaf is private; refuse redirected parent chains and foreign files.
        if (await realpath(this.runtime.unitDirectory) !== this.runtime.unitDirectory) throw new SupervisionError("unsafe-storage")
        if (!unit.exists) {
          const handle = await open(unit.file, "wx", 0o600)
          try { await handle.writeFile(unit.text); await handle.sync() } finally { await handle.close() }
        }
        await this.ownedUnit()
        await this.deps.command("/usr/bin/systemctl", ["--user", "daemon-reload"])
        await this.deps.command("/usr/bin/systemctl", ["--user", "enable", unit.name])
        await this.deps.command("/usr/bin/systemctl", ["--user", "reset-failed", unit.name])
        await this.deps.command("/usr/bin/systemctl", ["--user", "start", unit.name])
        const after = await this.loaded(unit.name)
        if (after.FragmentPath !== unit.file || after.KillMode !== "process" || after.DropInPaths || after.UnitFileState !== "enabled"
          || !["active", "activating"].includes(after.ActiveState ?? "")) throw new SupervisionError("busy")
      } else {
        await this.linger.retainReleased(manifest)
        if (state.LoadState !== "not-found") {
          // Never disable/unlink before stop: systemd must retain KillMode=process
          // while stopping the foreground guard and cancelling Restart=always.
          await this.deps.command("/usr/bin/systemctl", ["--user", "stop", unit.name])
          if ((await this.loaded(unit.name)).ActiveState !== "inactive") throw new SupervisionError("busy")
          await this.deps.command("/usr/bin/systemctl", ["--user", "disable", unit.name])
        }
        unit = await this.ownedUnit()
        if (unit.exists) await unlink(unit.file)
        await this.deps.command("/usr/bin/systemctl", ["--user", "daemon-reload"])
        const after = await this.loaded(unit.name)
        if (after.LoadState !== "not-found" || after.ActiveState !== "inactive") throw new SupervisionError("busy")
        const linger = await this.linger.reconcile(manifest)
        if (["uncertain", "permission-required"].includes(linger)) throw new SupervisionError("busy")
        // Deferred rollback is an acknowledged OFF with a distinct visible cause.
      }
    })
    await this.store.acknowledge(expectedRevision)
  }

  async observe(): Promise<SupervisionObservation> {
    const manifest = await this.store.read(), health = await this.deps.health(path.join(manifest.namespace.stateDirectory, manifest.namespace.registrationName))
    let resources: SupervisionObservation["resources"] = "unknown", guard: SupervisionObservation["guard"] = "unknown"
    let detail: SupervisionObservation["detail"], artifactMissing = false
    for (const file of [this.runtime.node, this.runtime.guard]) {
      try { await this.policy.verify(file, false) } catch { artifactMissing = true }
    }
    try {
      const unit = await this.ownedUnit(), state = await this.loaded(unit.name)
      resources = !unit.exists && state.LoadState === "not-found" ? "absent"
        : unit.exists && state.FragmentPath === unit.file && state.KillMode === "process" && !state.DropInPaths && state.UnitFileState === "enabled" ? "installed" : "unknown"
      guard = state.ActiveState === "inactive" || state.ActiveState === "failed" ? "absent" : "unknown"
      if (state.ActiveState === "active") {
        const status = z.object({ revision: z.literal(manifest.revision), key: z.literal(manifest.key),
          guardPid: z.number().int().positive(), guardStart: z.string(),
          cause: z.enum(["native-service-disabled-or-unknown", "start-failed", "guard-failed", "service-unknown"]).nullable(),
          lastAttemptAt: z.string().datetime().optional(), retryAt: z.string().datetime().optional(),
        }).passthrough().parse(await readLinuxPrivate(path.join(this.store.directory, "linux-status.json"), this.policy))
        const owner = await this.deps.lookup(status.guardPid)
        if (String(status.guardPid) === state.MainPID && owner.state === "live" && owner.startIdentity === status.guardStart) {
          guard = "active"; detail = { cause: status.cause, lastAttemptAt: status.lastAttemptAt, retryAt: status.retryAt }
        }
      }
    } catch { /* Partial ownership or status evidence stays unknown. */ }
    const linuxLinger = await this.linger.observe().catch(() => "uncertain" as const)
    return { revision: manifest.revision, resources, guard, health, artifactMissing, linuxLinger, ...(detail ? { detail } : {}) }
  }
}
