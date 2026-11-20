import fs from "fs"
import path from "path"
import { randomUUID } from "node:crypto"
import { stringify as stringifyYaml } from "yaml"
import type { Logger } from "../logger"
import { applyMergePatch, isPlainObject } from "./merge-patch"
import { parseSettingsYaml } from "./parse-yaml"

export type SettingsDoc = Record<string, unknown>

export class SettingsReadError extends Error {
  constructor() {
    super("Settings document could not be read authoritatively")
  }
}

function ensureTrailingNewline(content: string): string {
  if (!content) return "\n"
  return content.endsWith("\n") ? content : `${content}\n`
}

function normalizeDoc(input: unknown): SettingsDoc {
  if (!isPlainObject(input)) {
    return {}
  }
  return input
}

export function resolveWriteDestination(filePath: string): string {
  let current = path.resolve(filePath)
  const seen = new Set<string>()

  while (true) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error: any) {
      if (error?.code === "ENOENT") return current
      throw error
    }
    if (!stat.isSymbolicLink()) return current
    if (seen.has(current)) throw new Error(`Circular settings symlink: ${filePath}`)
    seen.add(current)
    current = path.resolve(path.dirname(current), fs.readlinkSync(current))
  }
}

export class YamlDocStore {
  private cache: SettingsDoc = {}
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    private readonly options: { throwOnPersistError?: boolean; normalize?: (doc: SettingsDoc, beforeMerge?: SettingsDoc) => SettingsDoc } = {},
  ) {}

  load(): SettingsDoc {
    if (this.loaded) {
      return this.cache
    }

    try {
      if (!fs.existsSync(this.filePath)) {
        this.cache = {}
        this.loaded = true
        return this.cache
      }

      const content = fs.readFileSync(this.filePath, "utf-8")
      const parsed = parseSettingsYaml(content)
      this.cache = this.normalize(parsed)
      this.loaded = true
      return this.cache
    } catch {
      // Parser diagnostics can include config credentials.
      this.logger.warn({ filePath: this.filePath }, "Failed to read YAML doc; using empty object")
      this.cache = {}
      this.loaded = true
      return this.cache
    }
  }

  get(): SettingsDoc {
    return this.load()
  }

  replace(next: unknown): SettingsDoc {
    return this.persistDoc(next)
  }

  private persistDoc(next: unknown, beforeMerge?: SettingsDoc): SettingsDoc {
    const normalized = this.normalize(next, beforeMerge)
    const previousCache = this.cache
    const previousLoaded = this.loaded
    this.cache = normalized
    this.loaded = true
    try {
      this.persist()
    } catch (error) {
      this.cache = previousCache
      this.loaded = previousLoaded
      throw error
    }
    return this.cache
  }

  private normalize(value: unknown, beforeMerge?: SettingsDoc): SettingsDoc {
    const doc = normalizeDoc(value)
    return this.options.normalize?.(doc, beforeMerge) ?? doc
  }

  mergePatch(patch: unknown): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const current = this.get()
    const next = applyMergePatch(current, patch)
    return this.persistDoc(next, current)
  }

  getOwner(owner: string): SettingsDoc {
    const doc = this.get()
    const value = (doc as any)?.[owner]
    return normalizeDoc(value)
  }

  /** Fresh, read-only authority; the forgiving display cache is not a CAS base. */
  getAuthoritativeOwner(owner: string, { refreshCache = true } = {}): SettingsDoc {
    const doc = this.readAuthoritative()
    if (Object.prototype.hasOwnProperty.call(doc, owner) && !isPlainObject(doc[owner])) throw new SettingsReadError()
    // Publish a refreshed cache only after a successful, valid document read.
    // The following synchronous owner merge therefore retains external fields.
    if (refreshCache) {
      this.cache = doc
      this.loaded = true
    }
    return doc[owner] as SettingsDoc ?? {}
  }

  /**
   * The document as it is on disk now, published as the cache: the base of a write, so a
   * stale display cache is never written back. Unreadable or invalid documents throw.
   */
  reloadAuthoritative(): SettingsDoc {
    const doc = this.readAuthoritative()
    this.cache = doc
    this.loaded = true
    return doc
  }

  private readAuthoritative(): SettingsDoc {
    let content: string
    try {
      content = fs.readFileSync(this.filePath, "utf-8")
    } catch (error: any) {
      // Only an actually missing path is empty authority. A dangling symlink,
      // permission failure or directory must not authorize a destructive repair.
      if (error?.code === "ENOENT") {
        try {
          fs.lstatSync(this.filePath)
        } catch (statError: any) {
          if (statError?.code === "ENOENT") return {}
        }
      }
      throw new SettingsReadError()
    }

    let doc: unknown
    try {
      doc = parseSettingsYaml(content)
    } catch {
      throw new SettingsReadError()
    }
    if (!isPlainObject(doc)) throw new SettingsReadError()
    return doc
  }

  replaceOwner(owner: string, value: unknown): SettingsDoc {
    const doc = this.get()
    const nextDoc: SettingsDoc = { ...doc, [owner]: normalizeDoc(value) }
    return this.replace(nextDoc)[owner] as SettingsDoc
  }

  mergePatchOwner(owner: string, patch: unknown): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const doc = this.get()
    const currentOwner = normalizeDoc((doc as any)?.[owner])
    const nextOwner = normalizeDoc(applyMergePatch(currentOwner, patch))
    const nextDoc: SettingsDoc = { ...doc, [owner]: nextOwner }
    return this.persistDoc(nextDoc, doc)[owner] as SettingsDoc
  }

  private persist() {
    let tempPath: string | undefined
    try {
      const destination = resolveWriteDestination(this.filePath)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const yaml = stringifyYaml(this.cache as any)
      const mode = fs.existsSync(destination) ? fs.statSync(destination).mode & 0o777 : 0o600
      tempPath = `${destination}.${process.pid}.${randomUUID()}.tmp`
      fs.writeFileSync(tempPath, ensureTrailingNewline(yaml), { encoding: "utf-8", mode })
      if (process.platform !== "win32") fs.chmodSync(tempPath, mode)
      fs.renameSync(tempPath, destination)
    } catch (error) {
      this.logger.warn({ err: error, filePath: this.filePath }, "Failed to persist YAML doc")
      if (this.options.throwOnPersistError) throw error
    } finally {
      if (tempPath) {
        try {
          fs.rmSync(tempPath, { force: true })
        } catch (error) {
          this.logger.warn({ err: error, tempPath }, "Failed to remove temporary YAML doc")
        }
      }
    }
  }
}
