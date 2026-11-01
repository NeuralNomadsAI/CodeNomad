import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { ManifestSchema, PanelExtensionError, type PanelExtensionPackage } from "./archive"
import { PANEL_EXTENSION_LIMITS, type PanelExtensionPermission, type PanelExtensionSummary } from "./contract"
import type { NativeMutationAuthority } from "../opencode/native-mutation-authority"

const RecordSchema = z.object({ manifest: ManifestSchema, html: z.string().max(PANEL_EXTENSION_LIMITS.htmlBytes),
  digest: z.string().regex(/^[a-f0-9]{64}$/), global: z.boolean(),
  // Read old folder grants without broadening consent; discard them on the next explicit write.
  projects: z.array(z.string().min(1).max(4096)).max(128).optional(),
  // API 4 `panel.preferences`: validated on read, so an invalid entry alone reads as `{}`.
  preferences: z.unknown().optional() }).strict().transform(({ projects: _projects, ...record }) => record)
const StoreSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(PANEL_EXTENSION_LIMITS.installed) }).strict()
type Stored = z.infer<typeof RecordSchema>
type Preferences = Record<string, unknown>

/** A plain JSON object serialized within the preferences budget, else the reason it is refused. */
function preferencesOf(value: unknown): Preferences | "invalid" | "too-large" {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return "invalid"
  let text: string
  try { text = JSON.stringify(value) } catch { return "invalid" }
  if (Buffer.byteLength(text) > PANEL_EXTENSION_LIMITS.preferencesBytes) return "too-large"
  return JSON.parse(text) as Preferences
}

export class PanelExtensionStore {
  private tail: Promise<unknown> = Promise.resolve()
  private authorities = new Map<string, Set<AbortController>>()
  constructor(private readonly directory: string, private readonly changed: () => void = () => {}) {}

  async list(): Promise<PanelExtensionSummary[]> {
    return this.serialize(async () => (await this.read()).map(record => ({ manifest: record.manifest, digest: record.digest,
      enabled: record.global })))
  }

  install(pkg: PanelExtensionPackage, previousDigest?: string): Promise<void> {
    this.revoke(pkg.manifest.id)
    return this.mutate(records => {
      const previous = records.find(record => record.manifest.id === pkg.manifest.id)
      if (previous?.digest !== previousDigest) throw new PanelExtensionError("conflict")
      if (previous?.digest === pkg.digest) return records
      // Replacing code revokes every grant, even if its declared permissions are unchanged, and resets its preferences.
      return [...records.filter(record => record !== previous), { ...pkg, global: false }]
    })
  }

  activate(id: string, digest: string, enabled: boolean): Promise<void> {
    this.revoke(id)
    return this.mutate(records => records.map(record => {
      if (record.manifest.id !== id) return record
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      return { ...record, global: enabled }
    }), id)
  }

  remove(id: string, digest: string): Promise<void> {
    this.revoke(id)
    return this.mutate(records => records.filter(record => {
      if (record.manifest.id !== id) return true
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      return false
    }), id)
  }

  async panel(id: string, digest: string): Promise<string> {
    return this.serialize(async () => {
      const record = (await this.read()).find(record => record.manifest.id === id)
      if (!record) throw new PanelExtensionError("missing")
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      if (!record.global) throw new PanelExtensionError("disabled")
      return record.html
    })
  }

  /** The exact enabled package, granted `permission` by its manifest's API version. */
  async authorize(id: string, digest: string, permission: PanelExtensionPermission): Promise<PanelExtensionSummary> {
    const entry = (await this.list()).find(entry => entry.manifest.id === id)
    if (!entry) throw new PanelExtensionError("missing")
    if (entry.digest !== digest) throw new PanelExtensionError("conflict")
    if (!entry.enabled || !(entry.manifest.permissions as readonly string[]).includes(permission)) {
      throw new PanelExtensionError("disabled")
    }
    return entry
  }

  /** Trusted in-process lease; revoke synchronously when a consent-changing write is requested. */
  async captureMutationAuthority(id: string, digest: string): Promise<NativeMutationAuthority & { signal: AbortSignal; dispose(): void }> {
    return this.captureAuthority(id, digest, "bundles.manage")
  }

  async captureReadAuthority(id: string, digest: string) {
    return this.captureAuthority(id, digest, "bundles.read")
  }

  private async captureAuthority(id: string, digest: string, permission: "bundles.read" | "bundles.manage") {
    const controller = new AbortController(), leases = this.authorities.get(id) ?? new Set<AbortController>()
    leases.add(controller); this.authorities.set(id, leases)
    const dispose = () => {
      controller.abort(); leases.delete(controller)
      if (!leases.size && this.authorities.get(id) === leases) this.authorities.delete(id)
    }
    const assertCurrent = () => controller.signal.throwIfAborted()
    const revalidate = async () => { assertCurrent(); const entry = await this.authorize(id, digest, permission); assertCurrent(); return entry }
    try {
      const entry = await revalidate()
      const canManage = (entry.manifest.permissions as readonly string[]).includes("bundles.manage")
      return { signal: controller.signal, assertCurrent, revalidate: async () => { await revalidate() }, dispose, canManage }
    }
    catch (error) { dispose(); throw error }
  }

  private revoke(id: string): void {
    const leases = this.authorities.get(id)
    this.authorities.delete(id)
    for (const lease of leases ?? []) lease.abort()
  }

  /**
   * The enabled package's own preferences (`{}` when none, or when only that entry
   * is invalid). Any other authority failure, or a corrupt store, throws without rewriting.
   */
  async preferences(id: string, digest: string): Promise<Preferences> {
    return this.serialize(async () => {
      const value = granted(await this.read(), id, digest).preferences
      const preferences = value === undefined ? {} : preferencesOf(value)
      return typeof preferences === "string" ? {} : preferences
    })
  }

  /** Replaces the whole object. Kept on deactivation; replacement and removal drop the record's preferences. */
  async setPreferences(id: string, digest: string, value: unknown): Promise<"saved" | "invalid" | "too-large"> {
    const preferences = preferencesOf(value)
    if (typeof preferences === "string") return preferences
    // Display state only: no catalogue change event, so mounted panels and leases stay as they are.
    await this.mutate(records => {
      granted(records, id, digest)
      return records.map(record => record.manifest.id === id ? { ...record, preferences } : record)
    }, undefined, false)
    return "saved"
  }

  private async read(): Promise<Stored[]> {
    try {
      const file = path.join(this.directory, "installed.json")
      if ((await fs.stat(file)).size > PANEL_EXTENSION_LIMITS.storageBytes) throw new PanelExtensionError("limit")
      const parsed = StoreSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))
      if (new Set(parsed.records.map(record => record.manifest.id)).size !== parsed.records.length) throw new PanelExtensionError("invalid")
      return parsed.records
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      // Corrupt state is never silently replaced by an empty catalogue.
      throw new PanelExtensionError("unavailable")
    }
  }

  private mutate(update: (records: Stored[]) => Stored[], requiredId?: string, notify = true): Promise<void> {
    return this.serialize(async () => {
      const records = await this.read()
      if (requiredId && !records.some(record => record.manifest.id === requiredId)) throw new PanelExtensionError("missing")
      const next = update(records)
      if (!StoreSchema.safeParse({ version: 1, records: next }).success) throw new PanelExtensionError("limit")
      const text = JSON.stringify({ version: 1, records: next })
      if (Buffer.byteLength(text) > PANEL_EXTENSION_LIMITS.storageBytes) throw new PanelExtensionError("limit")
      await fs.mkdir(this.directory, { recursive: true })
      const temporary = path.join(this.directory, `${randomUUID()}.tmp`)
      try {
        await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 })
        await fs.rename(temporary, path.join(this.directory, "installed.json"))
      } finally { await fs.rm(temporary, { force: true }) }
      if (notify) this.changed()
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // ponytail: one profile-wide IO queue; separate package files if catalogue throughput ever matters.
    // Reads join writes too: Windows cannot atomically replace an open catalogue.
    const work = this.tail.then(operation)
    this.tail = work.catch(() => {})
    return work
  }
}

/** The installed, enabled exact package declaring `panel.preferences`; anything else is `unavailable`. */
function granted(records: Stored[], id: string, digest: string): Stored {
  const record = records.find(record => record.manifest.id === id)
  if (!record || record.digest !== digest || !record.global
    || !(record.manifest.permissions as readonly string[]).includes("panel.preferences")) throw new PanelExtensionError("unavailable")
  return record
}
