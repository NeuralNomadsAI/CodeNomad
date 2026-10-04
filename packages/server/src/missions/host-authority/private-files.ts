import { execFileSync } from "node:child_process"
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs"
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises"
import path from "node:path"
import { TextDecoder } from "node:util"
import { HostStorage, privateStorage, type StoragePolicy } from "../../host-lifetime/storage"
import { MAX_BYTES, validateScope } from "../../host-lifetime/protocol"
import { windowsStorageScript, verifyWindowsStorageEvidence } from "../../host-lifetime/windows-storage"
import { canonicalAuthority, authorityDigest } from "../authority-protocol"
import { deny, HostAuthorityError, parseDocument, type HostAuthorityDescriptor, type HostDocument } from "./model"

const FILE = "missions-authority.json"
const IDENTITY = "missions-authority.identity"
const LOCK = "missions-authority-cas"
export const physical = (value: string) => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value)

/** Same Windows owner/DACL/reparse evaluator as privateStorage, but synchronous
 * for the mandatory final publication fence. No cached asynchronous approval. */
export function verifyPrivateSync(file: string, directory: boolean): void {
  try {
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) deny("unsafe-storage")
    if (process.platform === "win32") {
      const { script, ancestorCount } = windowsStorageScript(file)
      const executable = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe")
      const raw = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        windowsHide: true, timeout: 5_000, maxBuffer: 256 * 1024, encoding: "utf8",
        env: { ...process.env, PSModulePath: path.join(path.dirname(executable), "Modules") },
      })
      verifyWindowsStorageEvidence(raw, directory, ancestorCount)
    } else if (!process.getuid || stat.uid !== process.getuid() || (stat.mode & 0o077)) deny("unsafe-storage")
  } catch { deny("private-storage-unavailable") }
}
export interface PrivateFilePolicy extends StoragePolicy { verifySync(file: string, directory: boolean): void }
const nativePolicy: PrivateFilePolicy = { ...privateStorage, verifySync: verifyPrivateSync }

/** Internal storage engine; policy substitution is for isolated tests ONLY.
 * Production construction defaults to the genuine privateStorage/DACL policy. */
export class ProtectedAuthorityFiles {
  private readonly storage: HostStorage
  readonly descriptor: HostAuthorityDescriptor
  constructor(root: string, descriptor: HostAuthorityDescriptor, private readonly policy = nativePolicy) {
    validateScope(descriptor.scope)
    this.descriptor = JSON.parse(canonicalAuthority(descriptor))
    Object.freeze(this.descriptor.scope); Object.freeze(this.descriptor)
    this.storage = new HostStorage(root, this.descriptor.scope, policy)
  }
  get directory(): string { return this.storage.directory }
  private get identity(): string { return physical(this.directory) }
  async check(): Promise<void> {
    try {
      await this.policy.verify(this.directory, true)
      if (physical(await realpath(this.directory)) !== this.identity
        || physical(await realpath(path.dirname(this.descriptor.scope.configIdentity))) !== this.descriptor.physicalProfile) deny("profile-moved")
      // HostStorage.initialize checks ancestors only during preparation; reads and
      // later writes must not follow a newly replaced ancestor either.
      for (let current of [this.directory, path.dirname(this.descriptor.scope.configIdentity)]) {
        while (true) {
          const stat = await lstat(current)
          if (stat.isSymbolicLink() || !stat.isDirectory()) deny("unsafe-storage")
          const parent = path.dirname(current); if (parent === current) break; current = parent
        }
      }
    } catch { deny("private-storage-unavailable") }
  }
  private checkSync(): void {
    this.policy.verifySync(this.directory, true)
    if (physical(realpathSync(this.directory)) !== this.identity
      || physical(realpathSync(path.dirname(this.descriptor.scope.configIdentity))) !== this.descriptor.physicalProfile) deny("profile-moved")
    for (let current of [this.directory, path.dirname(this.descriptor.scope.configIdentity)]) {
      while (true) {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()) deny("unsafe-storage")
        const parent = path.dirname(current); if (parent === current) break; current = parent
      }
    }
  }
  async read(): Promise<HostDocument | undefined> {
    await this.check()
    try {
      const value = await this.storage.read<unknown>(FILE)
      const marker = await this.storage.read<unknown>(IDENTITY)
      if (value === undefined) { if (marker !== undefined) deny("key-lost"); return undefined }
      const doc = parseDocument(value, this.descriptor, this.identity)
      this.matchMarker(marker, doc)
      return doc
    } catch (error) { if (error instanceof HostAuthorityError) throw error; deny("storage-invalid") }
  }
  private matchMarker(marker: unknown, doc: HostDocument): void {
    if (canonicalAuthority(marker) !== canonicalAuthority({ installationID: doc.installationID, descriptorDigest: authorityDigest(this.descriptor) })) deny("installation-mismatch")
  }
  private verifiedSync(name: string, maximum: number): unknown {
    const file = path.join(this.directory, name)
    this.policy.verifySync(file, false)
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const stat = fstatSync(fd), named = lstatSync(file)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum || stat.ino !== named.ino || stat.dev !== named.dev) deny("storage-invalid")
      const bytes = Buffer.alloc(maximum + 1)
      let size = 0
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, size)
        if (!count) break
        size += count
      }
      if (size > maximum) deny("storage-invalid")
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)))
    } finally { closeSync(fd) }
  }
  readSync(underOwnClaim = false): HostDocument {
    try {
      this.checkSync()
      if (!underOwnClaim) {
        try { lstatSync(path.join(this.directory, LOCK)); deny("writer-pending") }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      }
      const doc = parseDocument(this.verifiedSync(FILE, MAX_BYTES), this.descriptor, this.identity)
      this.matchMarker(this.verifiedSync(IDENTITY, 4096), doc)
      return doc
    } catch (error) { if (error instanceof HostAuthorityError) throw error; deny("storage-invalid") }
  }
  /** null means proven absence. Unknown files, stale locks or a crashed writer
   * never become absence; no TTL/PID takeover, cleanup or implicit repair. */
  async cas(expectedRevision: number | null, change: (current: HostDocument | undefined) => Promise<HostDocument>, fence: () => void,
    initialize = false, denial = false): Promise<HostDocument> {
    if (initialize) { try { await this.storage.initialize() } catch { deny("private-storage-unavailable") } }
    await this.check()
    const lock = path.join(this.directory, LOCK)
    try { await mkdir(lock, { mode: 0o700 }) } catch { deny("exclusive-claim-unavailable") }
    const identity = await lstat(lock)
    let release = true
    try {
      await this.policy.verify(lock, true)
      const before = await this.read()
      if ((before?.revision ?? null) !== expectedRevision) deny("revision-conflict")
      const after = await change(before)
      if (after.revision !== (before?.revision ?? 0) + 1) deny("revision-conflict")
      // A fixed local denial toggle always fits. Native receipt quotas remain
      // owned by NativeMissionAuthorityStore, not another host journal engine.
      // Keep the host document inside canonicalAuthority's 128 KiB bound and
      // reserve local denial growth. No variable-size native denial receipt is
      // allocated here: those reservations belong to the native core.
      canonicalAuthority({ ...after, revoked: true, mirror: after.mirror && { ...after.mirror, disabled: true } }, 128 * 1024 - (denial ? 0 : 4096))
      parseDocument(after, this.descriptor, this.identity)
      await this.check()
      const fresh = await this.read()
      if ((fresh === undefined) !== (before === undefined) || fresh && authorityDigest(fresh) !== authorityDigest(before)) deny("revision-conflict")
      const named = await lstat(lock)
      if (named.ino !== identity.ino || named.dev !== identity.dev || named.isSymbolicLink()) deny("exclusive-claim-lost")
      fence()
      release = false
      if (!before) await this.storage.atomic(IDENTITY, { installationID: after.installationID, descriptorDigest: authorityDigest(this.descriptor) })
      await this.storage.atomic(FILE, after)
      release = true
      return after
    } finally {
      // A write with an unknown outcome deliberately parks the lock; explicit
      // offline reconciliation is required. Do not overwrite/retry after errors.
      if (release) {
        const named = await lstat(lock)
        if (named.ino !== identity.ino || named.dev !== identity.dev) deny("exclusive-claim-lost")
        await rmdir(lock)
      }
    }
  }
}
