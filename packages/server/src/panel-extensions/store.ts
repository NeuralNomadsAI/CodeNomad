import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { ManifestSchema, PanelExtensionError, type PanelExtensionPackage } from "./archive"
import { PANEL_EXTENSION_LIMITS, type PanelExtensionSummary } from "./contract"

const RecordSchema = z.object({ manifest: ManifestSchema, html: z.string().max(PANEL_EXTENSION_LIMITS.htmlBytes),
  digest: z.string().regex(/^[a-f0-9]{64}$/), global: z.boolean(), projects: z.array(z.string().min(1).max(4096)).max(128) }).strict()
const StoreSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(PANEL_EXTENSION_LIMITS.installed) }).strict()
type Stored = z.infer<typeof RecordSchema>

export class PanelExtensionStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string, private readonly changed: () => void = () => {}) {}

  async list(project: string): Promise<PanelExtensionSummary[]> {
    return this.serialize(async () => (await this.read()).map(record => ({ manifest: record.manifest, digest: record.digest,
      global: record.global, project: record.projects.includes(project), enabled: record.global || record.projects.includes(project) })))
  }

  install(pkg: PanelExtensionPackage, previousDigest?: string): Promise<void> {
    return this.mutate(records => {
      const previous = records.find(record => record.manifest.id === pkg.manifest.id)
      if (previous?.digest !== previousDigest) throw new PanelExtensionError("conflict")
      if (previous?.digest === pkg.digest) return records
      // Replacing code revokes every grant, even if its declared permissions are unchanged.
      return [...records.filter(record => record !== previous), { ...pkg, global: false, projects: [] }]
    })
  }

  activate(id: string, digest: string, project: string, scope: "global" | "project", enabled: boolean): Promise<void> {
    return this.mutate(records => records.map(record => {
      if (record.manifest.id !== id) return record
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      return scope === "global" ? { ...record, global: enabled } : { ...record,
        projects: enabled ? [...new Set([...record.projects, project])] : record.projects.filter(value => value !== project) }
    }), id)
  }

  remove(id: string, digest: string): Promise<void> {
    return this.mutate(records => records.filter(record => {
      if (record.manifest.id !== id) return true
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      return false
    }), id)
  }

  async panel(id: string, digest: string, project: string): Promise<string> {
    return this.serialize(async () => {
      const record = (await this.read()).find(record => record.manifest.id === id)
      if (!record) throw new PanelExtensionError("missing")
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      if (!record.global && !record.projects.includes(project)) throw new PanelExtensionError("disabled")
      return record.html
    })
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

  private mutate(update: (records: Stored[]) => Stored[], requiredId?: string): Promise<void> {
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
      this.changed()
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
