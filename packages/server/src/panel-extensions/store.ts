import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { ManifestSchema, PanelExtensionError, type PanelExtensionPackage } from "./archive"
import { lockMemoryRepository } from "../memory/lock"
import { PANEL_EXTENSION_LIMITS, type PanelExtensionPermission, type PanelExtensionSummary } from "./contract"

const RecordSchema = z.object({ manifest: ManifestSchema, html: z.string().max(PANEL_EXTENSION_LIMITS.htmlBytes),
  digest: z.string().regex(/^[a-f0-9]{64}$/), global: z.boolean(),
  // Read old folder grants without broadening consent; discard them on the next explicit write.
  projects: z.array(z.string().min(1).max(4096)).max(128).optional(),
  // API 4 `panel.preferences`: validated on read, so an invalid entry alone reads as `{}`.
  preferences: z.unknown().optional(),
  // API 4 `panel.notes`: this installation's notes directory, `notes/<key>`. Kept by replacement, gone with the
  // record: the catalogue write alone commits a removal, and a reinstall never finds the old notes.
  notes: z.string().uuid().optional() }).strict().transform(({ projects: _projects, ...record }) => record)
const StoreSchema = z.object({ version: z.literal(1), records: z.array(RecordSchema).max(PANEL_EXTENSION_LIMITS.installed) }).strict()
type Stored = z.infer<typeof RecordSchema>
type Preferences = Record<string, unknown>
// API 4 `panel.notes`: one file per package and project identity, beside the catalogue.
const NoteSchema = z.object({ sessionID: z.string().min(1).max(256), title: z.string().max(256), text: z.string().min(1),
  revision: z.number().int().min(1), updated: z.number().int().min(0) }).strict()
// `revision`: the highest one issued in this project, kept after deletions so it is never issued twice.
// An inconsistent file (a session twice, a revision above the mark) fails closed like a corrupt one.
const NotesSchema = z.object({ version: z.literal(1), revision: z.number().int().min(0), notes: z.array(NoteSchema).max(PANEL_EXTENSION_LIMITS.notes) }).strict()
  .refine(file => new Set(file.notes.map(note => note.sessionID)).size === file.notes.length && file.notes.every(note => note.revision <= file.revision))
export type PanelStoredNote = z.infer<typeof NoteSchema>
export type PanelNoteChange = { status: "saved"; revision: number } | { status: "conflict"; note: { text: string; revision: number } | null }
  | { status: "too-large" } | { status: "full" }
const Project = /^[a-f0-9]{64}$/
/** A note's session title: at most 256 UTF-16 units, never half a surrogate pair. */
export const noteTitle = (title: string) => title.slice(0, 256).replace(/[\ud800-\udbff]$/, "")

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
  private released: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string, private readonly changed: () => void = () => {},
    private readonly notesChanged: (id: string) => void = () => {}) {}

  async list(): Promise<PanelExtensionSummary[]> {
    return this.serialize(async () => (await this.read()).map(record => ({ manifest: record.manifest, digest: record.digest,
      enabled: record.global })))
  }

  install(pkg: PanelExtensionPackage, previousDigest?: string): Promise<void> {
    return this.mutate(records => {
      const previous = records.find(record => record.manifest.id === pkg.manifest.id)
      if (previous?.digest !== previousDigest) throw new PanelExtensionError("conflict")
      if (previous?.digest === pkg.digest) return records
      // Replacing code revokes every grant, even if its declared permissions are unchanged, and resets its preferences.
      return [...records.filter(record => record !== previous), { ...pkg, global: false, notes: previous?.notes ?? randomUUID() }]
    })
  }

  activate(id: string, digest: string, enabled: boolean): Promise<void> {
    return this.mutate(records => records.map(record => {
      if (record.manifest.id !== id) return record
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      return { ...record, global: enabled }
    }), id)
  }

  /**
   * Removal also deletes the package's notes; replacement and deactivation keep them. Dropping the
   * record drops their key, so they are gone once the catalogue is written; their files go after.
   */
  remove(id: string, digest: string): Promise<void> {
    let key: string | undefined
    return this.mutate(records => records.filter(record => {
      if (record.manifest.id !== id) return true
      if (record.digest !== digest) throw new PanelExtensionError("conflict")
      key = record.notes
      return false
    }), id, true, async () => { if (key) await fs.rm(this.notesDirectory(key), { recursive: true, force: true }).catch(() => {}) })
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

  /** The enabled package's notes in `project`, newest first. A corrupt file throws `unavailable` and is kept. */
  async notes(id: string, digest: string, project: string): Promise<PanelStoredNote[]> {
    return this.locked(async () => {
      const key = granted(await this.read(), id, digest, "panel.notes").notes
      return key ? (await this.readNotes(key, project)).notes.sort((a, b) => b.updated - a.updated || b.revision - a.revision) : []
    })
  }

  /**
   * Replaces `sessionID`'s note when its current revision is `revision` (0 when it has
   * none); empty text deletes it. Revisions grow past every one the project issued,
   * deleted notes' included, so a recreated note never takes a stale writer's.
   */
  async setNote(id: string, digest: string, project: string, sessionID: string, revision: number,
    next: { title: string; text: string }, guard?: { check(): Promise<void>; final(): void }): Promise<PanelNoteChange> {
    if (Buffer.byteLength(next.text) > PANEL_EXTENSION_LIMITS.noteBytes) return { status: "too-large" }
    if (!Project.test(project)) throw new PanelExtensionError("invalid")
    return this.locked(async () => {
      let key = granted(await this.read(), id, digest, "panel.notes").notes
      if (!key) {
        // A record from before notes had a key gets one now.
        const created = key = randomUUID()
        await this.mutateLocked(records => records.map(record => record.manifest.id === id ? { ...record, notes: created } : record), undefined, false)
      }
      return this.changeNote(id, key, project, sessionID, revision, next, guard)
    })
  }

  private async changeNote(id: string, key: string, project: string, sessionID: string, revision: number,
    next: { title: string; text: string }, guard?: { check(): Promise<void>; final(): void }): Promise<PanelNoteChange> {
    const { notes, revision: issued } = await this.readNotes(key, project)
    // The caller's authority, revalidated where nothing else can write first, before any answer.
    await guard?.check()
    const current = notes.find(note => note.sessionID === sessionID)
    if ((current?.revision ?? 0) !== revision) return { status: "conflict", note: current ? { text: current.text, revision: current.revision } : null }
    const others = notes.filter(note => note !== current)
    if (!next.text) {
      if (current) await this.writeNotes(id, key, project, others, issued, guard?.final)
      return { status: "saved", revision: 0 }
    }
    if (!current && notes.length >= PANEL_EXTENSION_LIMITS.notes) return { status: "full" }
    const now = Date.now(), note = { sessionID, title: noteTitle(next.title), text: next.text, revision: Math.max(now, issued + 1), updated: now }
    await this.writeNotes(id, key, project, [...others, note], note.revision, guard?.final)
    return { status: "saved", revision: note.revision }
  }

  private notesDirectory(key: string) { return path.join(this.directory, "notes", key) }

  /**
   * `operation` in this store's queue under the profile's cross-process lock (agent memory's), so
   * backends sharing the profile change the catalogue and notes one at a time. A slow release (Windows
   * sharing retries) delays the answer at most 250 ms and never changes it; the next acquisition awaits it.
   */
  private locked<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      await this.released
      await fs.mkdir(this.directory, { recursive: true })
      const release = await lockMemoryRepository(path.join(this.directory, "catalogue"))
      try { return await operation() } finally {
        const releasing = this.released = release().catch(() => {})
        await Promise.race([releasing, new Promise(resolve => setTimeout(resolve, 250))])
      }
    })
  }

  private async readNotes(key: string, project: string): Promise<{ notes: PanelStoredNote[]; revision: number }> {
    if (!Project.test(project)) throw new PanelExtensionError("invalid")
    try {
      return NotesSchema.parse(JSON.parse(await fs.readFile(path.join(this.notesDirectory(key), `${project}.json`), "utf8")))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { notes: [], revision: 0 }
      throw new PanelExtensionError("unavailable")
    }
  }

  private async writeNotes(id: string, key: string, project: string, notes: PanelStoredNote[], revision: number, final?: () => void) {
    const directory = this.notesDirectory(key)
    await this.replace(directory, path.join(directory, `${project}.json`), JSON.stringify({ version: 1, revision, notes }), final)
    this.notesChanged(id)
  }

  /** Atomic replacement; `final` may still refuse once the bytes are staged, right before the rename. */
  private async replace(directory: string, file: string, text: string, final?: () => void) {
    await fs.mkdir(directory, { recursive: true })
    const temporary = path.join(directory, `${randomUUID()}.tmp`)
    // The rename commits: nothing awaited after it can turn a committed write into a failure.
    try {
      await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 })
      final?.()
      await fs.rename(temporary, file)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
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

  /** `after` runs once the catalogue is written: best-effort cleanup that changes nothing anyone reads. */
  private mutate(update: (records: Stored[]) => Stored[], requiredId?: string, notify = true, after?: () => Promise<void>): Promise<void> {
    return this.locked(async () => {
      await this.mutateLocked(update, requiredId, notify)
      await after?.()
    })
  }

  private async mutateLocked(update: (records: Stored[]) => Stored[], requiredId: string | undefined, notify: boolean): Promise<void> {
    const records = await this.read()
    if (requiredId && !records.some(record => record.manifest.id === requiredId)) throw new PanelExtensionError("missing")
    const next = update(records)
    if (!StoreSchema.safeParse({ version: 1, records: next }).success) throw new PanelExtensionError("limit")
    const text = JSON.stringify({ version: 1, records: next })
    if (Buffer.byteLength(text) > PANEL_EXTENSION_LIMITS.storageBytes) throw new PanelExtensionError("limit")
    await this.replace(this.directory, path.join(this.directory, "installed.json"), text)
    if (notify) this.changed()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    // ponytail: one profile-wide IO queue; separate package files if catalogue throughput ever matters.
    // Reads join writes too: Windows cannot atomically replace an open catalogue.
    const work = this.tail.then(operation)
    this.tail = work.catch(() => {})
    return work
  }
}

/** The installed, enabled exact package declaring `permission`; anything else is `unavailable`. */
function granted(records: Stored[], id: string, digest: string, permission: "panel.preferences" | "panel.notes" = "panel.preferences"): Stored {
  const record = records.find(record => record.manifest.id === id)
  if (!record || record.digest !== digest || !record.global
    || !(record.manifest.permissions as readonly string[]).includes(permission)) throw new PanelExtensionError("unavailable")
  return record
}
