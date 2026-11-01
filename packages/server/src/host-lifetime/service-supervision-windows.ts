import { execFile } from "node:child_process"
import { lstat, open, readFile, link, rm } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { ServiceSupervisionStore } from "./service-supervision-store"
import { SupervisionError, type SupervisionObservation } from "./service-supervision-contract"
import { readSupervisionHealth, supervisionReleasePreserved } from "./service-supervision-health"
import { lookupProcess } from "./process-identity"
import { privateStorage, type StoragePolicy } from "./storage"
import { readWindowsRecovery } from "./service-supervision-windows-recovery"
import { supervisionArtifactPolicy } from "./service-supervision-runtime"
import { wslRuntimeSchema, readWslSupervisionSample } from "./service-supervision-wsl"

const absolute = z.string().max(4096).refine(value => /^[A-Za-z]:\\/.test(value)
  && path.win32.normalize(value) === value && !/[\x00-\x1f"]/.test(value) && !value.slice(2).includes(":"))
// The execution-host resolver supplies only these native paths. Never persist a
// profile's environment, PATH, OPENCODE_CONFIG_CONTENT or credentials.
const environmentSchema = z.object({
  SystemRoot: absolute, WINDIR: absolute, COMSPEC: absolute, HOME: absolute, USERPROFILE: absolute,
  APPDATA: absolute, LOCALAPPDATA: absolute, XDG_CONFIG_HOME: absolute, XDG_STATE_HOME: absolute,
  XDG_DATA_HOME: absolute, XDG_CACHE_HOME: absolute, TEMP: absolute, TMP: absolute,
  OPENCODE_TEST_HOME: absolute.optional(),
}).strict()
const descriptorSchema = z.object({ v: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), directory: absolute,
  powershell: absolute, script: absolute, node: absolute, probe: absolute, environment: environmentSchema,
  wsl: wslRuntimeSchema.optional() }).strict()
export type WindowsSupervisionRuntime = Pick<z.infer<typeof descriptorSchema>, "powershell" | "script" | "node" | "probe" | "environment" | "wsl">

export async function readWindowsSupervisionRuntime(store: ServiceSupervisionStore, policy: StoragePolicy = privateStorage): Promise<WindowsSupervisionRuntime | undefined> {
  const file = path.join(store.directory, "windows.json")
  try { await policy.verify(file, false) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  if ((await lstat(file)).size > 32768) throw new SupervisionError("invalid")
  const manifest = await store.read(), descriptor = descriptorSchema.parse(JSON.parse(await readFile(file, "utf8")))
  if (descriptor.key !== manifest.key || descriptor.directory !== store.directory) throw new SupervisionError("conflict")
  const { powershell, script, node, probe, environment, wsl } = descriptor
  return { powershell, script, node, probe, environment, ...(wsl ? { wsl } : {}) }
}

/** Internal execution-host adapter. Its caller acquires the exact namespace and
 * durable, owned CodeNomad runtime artifacts, independently of Settings profiles.
 * Preference controls always go through the shared store before reconcile(). */
export class WindowsServiceSupervision {
  constructor(private readonly store: ServiceSupervisionStore, private readonly runtime: WindowsSupervisionRuntime,
    private readonly policy: StoragePolicy = privateStorage, private readonly artifactPolicy: StoragePolicy = supervisionArtifactPolicy) {}

  private async descriptor() {
    if (process.platform !== "win32") throw new SupervisionError("invalid")
    const manifest = await this.store.read()
    if (!["win32", "wsl"].includes(manifest.namespace.platform)) throw new SupervisionError("invalid")
    const descriptor = descriptorSchema.parse({ ...this.runtime, v: 1, key: manifest.key, directory: this.store.directory })
    if (Buffer.byteLength(JSON.stringify(descriptor)) > 32768) throw new SupervisionError("invalid")
    if (descriptor.wsl ? manifest.namespace.platform !== "wsl" || descriptor.wsl.distro !== manifest.namespace.distro
      || descriptor.wsl.user !== manifest.namespace.user
      || path.posix.join(descriptor.wsl.environment.XDG_CONFIG_HOME, "opencode") !== manifest.namespace.configDirectory
      || path.posix.join(descriptor.wsl.environment.XDG_STATE_HOME, "opencode") !== manifest.namespace.stateDirectory
      : manifest.namespace.platform !== "win32" || path.win32.join(descriptor.environment.XDG_CONFIG_HOME, "opencode").toLowerCase() !== manifest.namespace.configDirectory.toLowerCase()
      || path.win32.join(descriptor.environment.XDG_STATE_HOME, "opencode").toLowerCase() !== manifest.namespace.stateDirectory.toLowerCase())
      throw new SupervisionError("conflict")
    for (const file of [descriptor.powershell, descriptor.script, descriptor.node, descriptor.probe]) {
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new SupervisionError("unsafe-storage")
      if (file !== descriptor.powershell) await this.artifactPolicy.verify(file, false)
    }
    return descriptor
  }

  private async provision(): Promise<z.infer<typeof descriptorSchema>> {
    const descriptor = await this.descriptor(), file = path.join(this.store.directory, "windows.json")
    try {
      await this.policy.verify(file, false)
      const stat = await lstat(file)
      if (stat.size > 32768) throw new SupervisionError("invalid")
      const existing = descriptorSchema.parse(JSON.parse(await readFile(file, "utf8")))
      if (JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new SupervisionError("conflict")
      return descriptor
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    // Publish a complete immutable descriptor without replacing a competing
    // writer. The temporary hard link is removed before the private-file check.
    const temporary = path.join(this.store.directory, `${randomUUID()}.tmp`)
    let exists = false
    try {
      const handle = await open(temporary, "wx", 0o600)
      try { await handle.writeFile(JSON.stringify(descriptor)); await handle.sync() } finally { await handle.close() }
      await this.policy.verify(temporary, false)
      await link(temporary, file).catch(error => { if (error.code !== "EEXIST") throw error; exists = true })
    } finally { await rm(temporary, { force: true }) }
    if (exists) return this.provision()
    await this.policy.verify(file, false)
    return descriptor
  }

  /** Publishes inert private runtime metadata; installs no OS task or preference. */
  async prepareRuntime(): Promise<void> { await this.provision() }

  private async run(mode: "install" | "remove" | "observe", revision: number) {
    const d = mode === "observe" ? await this.descriptor() : await this.provision()
    return new Promise<{ main: string; recovery: string }>((resolve, reject) => {
      execFile(d.powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", d.script,
        "-Directory", d.directory, "-Key", d.key, "-Mode", mode, "-Revision", String(revision)], {
        windowsHide: true, timeout: mode === "remove" ? 20_000 : 15_000, maxBuffer: 32768,
        env: { SystemRoot: d.environment.SystemRoot, WINDIR: d.environment.WINDIR,
          PSModulePath: path.join(d.environment.SystemRoot, "System32/WindowsPowerShell/v1.0/Modules") },
      }, (error, stdout) => {
        // Native stderr/exception text can contain private data. Only fixed
        // adapter failures cross this boundary; exact intent remains readable.
        if (error) {
          const failure = new SupervisionError("busy")
          try {
            Object.assign(failure, { cause: z.object({ state: z.literal("failing"), cause: z.literal("windows-resource-operation"),
              line: z.number().int().nonnegative() }).strict().parse(JSON.parse(stdout.trim())) })
          } catch { /* Preserve only the fixed error when native evidence is incomplete. */ }
          return reject(failure)
        }
        try { resolve(z.object({ main: z.string(), recovery: z.string() }).strict().parse(JSON.parse(stdout.trim()))) }
        catch { reject(new SupervisionError("invalid")) }
      })
    })
  }

  async reconcile(expectedRevision: number): Promise<void> {
    const manifest = await this.store.read()
    if (manifest.revision !== expectedRevision) throw new SupervisionError("conflict")
    if (manifest.desired === "unset") return
    const releasing = manifest.desired === "off" && this.runtime.wsl
      ? await readWslSupervisionSample(manifest, this.runtime.wsl) : undefined
    const tasks = await this.run(manifest.desired === "on" ? "install" : "remove", expectedRevision)
    if (manifest.desired === "on" ? [tasks.main, tasks.recovery].some(state => state === "absent" || state === "Disabled")
      : tasks.main !== "absent" || tasks.recovery !== "absent") throw new SupervisionError("busy")
    if (releasing && this.runtime.wsl) {
      const after = await readWslSupervisionSample(manifest, this.runtime.wsl)
      if (!supervisionReleasePreserved(releasing, after)) throw new SupervisionError("busy")
    }
    // Ack is separately serialized with OFF and Start; a changed intent wins.
    await this.store.acknowledge(expectedRevision)
  }

  async observe(): Promise<SupervisionObservation> {
    const manifest = await this.store.read()
    const registration = path.join(manifest.namespace.stateDirectory, manifest.namespace.registrationName)
    const health = this.runtime.wsl ? await readWslSupervisionSample(manifest, this.runtime.wsl).then(value => value.health)
      .catch(() => ({ state: "unknown" as const })) : await readSupervisionHealth(registration)
    let artifactMissing = false
    for (const file of [this.runtime.script, this.runtime.node, this.runtime.probe]) {
      try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) artifactMissing = true }
      catch { artifactMissing = true }
    }
    let resources: SupervisionObservation["resources"] = "unknown", guard: SupervisionObservation["guard"] = "unknown"
    let detail: SupervisionObservation["detail"]
    try {
      const tasks = await this.run("observe", manifest.revision)
      resources = tasks.main === "absent" && tasks.recovery === "absent" ? "absent"
        : [tasks.main, tasks.recovery].every(state => !["absent", "Disabled"].includes(state)) ? "installed" : "unknown"
      guard = tasks.main !== "Running" ? "absent" : "unknown"
      if (tasks.main === "Running") {
        const file = path.join(this.store.directory, "windows-status.json")
        await this.policy.verify(file, false)
        if ((await lstat(file)).size > 32768) throw new Error()
        const status = z.object({ v: z.literal(1), key: z.literal(manifest.key), revision: z.literal(manifest.revision),
          guardPid: z.number().int().positive(), guardStart: z.string().regex(/^win32:\d+$/),
          cause: z.enum(["native-service-disabled-or-unknown", "start-failed", "guard-failed", "service-unknown", "wsl-forwarding-unavailable"]).nullable(),
          lastAttemptAt: z.string().datetime({ offset: true }).nullable().optional(),
          retryAt: z.string().datetime({ offset: true }).nullable().optional(),
        }).passthrough().parse(JSON.parse(await readFile(file, "utf8")))
        const process = await lookupProcess(status.guardPid)
        if (process.state === "live" && process.startIdentity === status.guardStart) {
          guard = "active"
          detail = { cause: status.cause, ...(status.lastAttemptAt ? { lastAttemptAt: status.lastAttemptAt } : {}),
            ...(status.retryAt ? { retryAt: status.retryAt } : {}) }
        }
      }
    } catch { /* exact owned resource evidence is required */ }
    const recoveryNextTickAt = manifest.desired === "on" && (guard !== "active" || artifactMissing)
      ? await readWindowsRecovery(this.runtime, this.store.directory, manifest.key).catch(() => undefined) : undefined
    return { revision: manifest.revision, resources, guard, health, ...(detail ? { detail } : {}), artifactMissing,
      ...(recoveryNextTickAt ? { recoveryNextTickAt } : {}) }
  }
}
