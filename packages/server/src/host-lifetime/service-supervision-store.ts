import { constants } from "node:fs"
import { lstat, mkdir, open, rename, rm, rmdir } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { privateStorage, type StoragePolicy } from "./storage"
import { mutateWindowsSupervisionFile } from "./service-supervision-windows-gate"
import { withLinuxSupervisionLock } from "./service-supervision-linux-lock"
import { withMacosSupervisionLock } from "./service-supervision-macos-native"
import {
  applySupervisionControl, initialSupervisionManifest, parseSupervisionManifest, SUPERVISION_MANIFEST_BYTES,
  SupervisionError, type SupervisionControl, type SupervisionManifest, type SupervisionNamespace, type SupervisionTarget,
} from "./service-supervision-contract"

/** Private service-wide intent storage. The root is provisioned by the execution
 * host independently of every CodeNomad profile. This store never starts/stops a
 * service, installs an OS resource, or acknowledges an unobserved side effect. */
export class ServiceSupervisionStore {
  readonly directory: string
  private readonly initial: SupervisionManifest
  constructor(root: string, namespace: SupervisionNamespace, target: SupervisionTarget,
    private readonly policy: StoragePolicy = privateStorage, private readonly nativeHelper?: string,
    private readonly namespaceMutation?: (update: (bytes: string | null) => Promise<string>) => Promise<void>) {
    if (!path.isAbsolute(root)) throw new SupervisionError("unsafe-storage")
    this.initial = initialSupervisionManifest(namespace, target)
    this.directory = path.join(root, this.initial.key)
  }

  private async prepare(): Promise<void> {
    try {
      const root = path.dirname(this.directory)
      // POSIX's privateStorage checks the leaf; check all ancestors for redirects
      // as well. The Windows evaluator additionally verifies their owner/DACL.
      for (let current = root; ;) {
        const stat = await lstat(current)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error()
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
      await this.policy.verify(root, true)
      await mkdir(this.directory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error })
      await this.policy.verify(this.directory, true)
    } catch { throw new SupervisionError("unsafe-storage") }
  }

  async read(): Promise<SupervisionManifest> {
    await this.prepare()
    return this.readPrepared()
  }

  private async readPrepared(): Promise<SupervisionManifest> {
    const file = path.join(this.directory, "manifest.json")
    try { await this.policy.verify(file, false) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(this.initial)
      throw new SupervisionError("unsafe-storage")
    }
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = await handle.stat(), named = await lstat(file)
      if (!stat.isFile() || stat.size > SUPERVISION_MANIFEST_BYTES || stat.ino !== named.ino || stat.dev !== named.dev)
        throw new SupervisionError("unsafe-storage")
      const bytes = Buffer.alloc(SUPERVISION_MANIFEST_BYTES + 1)
      let size = 0
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, null)
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      if (size > SUPERVISION_MANIFEST_BYTES) throw new SupervisionError("invalid")
      let value: SupervisionManifest
      try { value = parseSupervisionManifest(JSON.parse(bytes.subarray(0, size).toString("utf8"))) }
      catch { throw new SupervisionError("invalid") }
      if (value.key !== this.initial.key) throw new SupervisionError("conflict")
      return value
    } finally { await handle.close() }
  }

  /** Persist intent before calling an OS adapter. A lost reply is read by exact
   * request ID; an absent receipt remains unknown, never proof of no effect. */
  control(control: SupervisionControl, assertCurrent: () => void = () => {}): Promise<SupervisionManifest> {
    return this.mutate(current => {
      assertCurrent()
      return applySupervisionControl(current, control)
    })
  }

  async request(requestID: string): Promise<SupervisionManifest | undefined> {
    if (!/^[a-f0-9-]{36}$/i.test(requestID)) throw new SupervisionError("invalid")
    const value = await this.read()
    return value.receipt?.control.requestID === requestID ? value : undefined
  }

  /** The adapter calls this only after its exact resource/guard read-back. It
   * must use the same observed revision, including for an OFF release. */
  acknowledge(expectedRevision: number): Promise<SupervisionManifest> {
    return this.mutate(current => {
      if (current.revision !== expectedRevision) throw new SupervisionError("conflict")
      return parseSupervisionManifest({ ...current, reconciledRevision: expectedRevision,
        ...(current.attempt?.revision === expectedRevision ? { attempt: { ...current.attempt, cause: null } } : {}) })
    })
  }

  /** Persist only fixed diagnostics. Adapter exception text can contain secrets. */
  recordAttempt(expectedRevision: number, cause: "adapter-failed" | null): Promise<SupervisionManifest> {
    return this.mutate(current => {
      if (current.revision !== expectedRevision) throw new SupervisionError("conflict")
      return parseSupervisionManifest({ ...current, reconciledRevision: null,
        attempt: { revision: expectedRevision, at: new Date().toISOString(), cause } })
    })
  }

  private async mutate(update: (value: SupervisionManifest) => SupervisionManifest): Promise<SupervisionManifest> {
    await this.prepare()
    if (process.platform === "win32") {
      const mutate = async () => {
        await this.readPrepared()
        const file = path.join(this.directory, "admission.lock")
        // Existing files must retain their private, non-linked identity. A new
        // handle inherits the verified directory's private DACL.
        await this.policy.verify(file, false).catch(error => {
          if (error.code !== "ENOENT") throw new SupervisionError("unsafe-storage")
        })
        let next: SupervisionManifest | undefined
        const publish = async (bytes: string | null) => {
          if (this.initial.namespace.platform !== "wsl") await this.policy.verify(file, false)
          const current = await this.readPrepared()
          if (bytes !== null) {
            let parsed: SupervisionManifest
            try { parsed = parseSupervisionManifest(JSON.parse(bytes)) } catch { throw new SupervisionError("invalid") }
            if (JSON.stringify(parsed) !== JSON.stringify(current)) throw new SupervisionError("conflict")
          } else if (current.revision !== 0) throw new SupervisionError("conflict")
          next = parseSupervisionManifest(update(current))
          return JSON.stringify(next)
        }
        if (this.initial.namespace.platform === "wsl") {
          if (!this.namespaceMutation) throw new SupervisionError("invalid")
          await this.namespaceMutation(publish)
        } else await mutateWindowsSupervisionFile(path.join(this.directory, "manifest.json"), publish)
        return next!
      }
      return mutate()
    }
    if (process.platform === "linux") return withLinuxSupervisionLock(path.join(this.directory, "admission.lock"),
      () => this.writeMutation(update), this.policy)
    if (process.platform === "darwin") return withMacosSupervisionLock(path.join(this.directory, "admission.lock"),
      () => this.writeMutation(update), this.policy, this.nativeHelper)
    const gate = path.join(this.directory, "manifest-mutation")
    // ponytail: POSIX metadata writers still require explicit abandoned-gate
    // recovery; use their OS advisory lock when the native adapter is integrated.
    try { await mkdir(gate, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new SupervisionError("busy")
      throw new SupervisionError("unsafe-storage")
    }
    try {
      await this.policy.verify(gate, true)
      return await this.writeMutation(update)
    } finally { await rmdir(gate) }
  }

  private async writeMutation(update: (value: SupervisionManifest) => SupervisionManifest): Promise<SupervisionManifest> {
    let temporary: string | undefined
    try {
      const current = await this.readPrepared()
      const next = update(current)
      if (JSON.stringify(next) === JSON.stringify(current)) return next
      const bytes = JSON.stringify(parseSupervisionManifest(next))
      temporary = path.join(this.directory, `${randomUUID()}.tmp`)
      const handle = await open(temporary, "wx", 0o600)
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await this.policy.verify(temporary, false)
      await this.policy.verify(this.directory, true)
      await rename(temporary, path.join(this.directory, "manifest.json"))
      return next
    } finally {
      if (temporary) await rm(temporary, { force: true })
    }
  }
}
