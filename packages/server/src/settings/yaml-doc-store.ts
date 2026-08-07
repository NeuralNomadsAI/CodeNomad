import fs from "fs"
import path from "path"
import { randomUUID } from "node:crypto"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type { Logger } from "../logger"
import { applyMergePatch, isPlainObject } from "./merge-patch"

export type SettingsDoc = Record<string, unknown>

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

export class YamlDocStore {
  private cache: SettingsDoc = {}
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
    private readonly options: { throwOnPersistError?: boolean } = {},
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
      const parsed = parseYaml(content)
      this.cache = normalizeDoc(parsed)
      this.loaded = true
      return this.cache
    } catch (error) {
      this.logger.warn({ err: error, filePath: this.filePath }, "Failed to read YAML doc; using empty object")
      this.cache = {}
      this.loaded = true
      return this.cache
    }
  }

  get(): SettingsDoc {
    return this.load()
  }

  replace(next: unknown): SettingsDoc {
    const normalized = normalizeDoc(next)
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

  mergePatch(patch: unknown): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const current = this.get()
    const next = applyMergePatch(current, patch)
    return this.replace(next)
  }

  getOwner(owner: string): SettingsDoc {
    const doc = this.get()
    const value = (doc as any)?.[owner]
    return normalizeDoc(value)
  }

  replaceOwner(owner: string, value: unknown): SettingsDoc {
    const doc = this.get()
    const nextDoc: SettingsDoc = { ...doc, [owner]: normalizeDoc(value) }
    this.replace(nextDoc)
    return nextDoc[owner] as SettingsDoc
  }

  mergePatchOwner(owner: string, patch: unknown): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    const doc = this.get()
    const currentOwner = normalizeDoc((doc as any)?.[owner])
    const nextOwner = normalizeDoc(applyMergePatch(currentOwner, patch))
    const nextDoc: SettingsDoc = { ...doc, [owner]: nextOwner }
    this.replace(nextDoc)
    return nextOwner
  }

  private persist() {
    let tempPath: string | undefined
    try {
      let destination = this.filePath
      try {
        if (fs.lstatSync(this.filePath).isSymbolicLink()) {
          const target = fs.readlinkSync(this.filePath)
          destination = path.resolve(path.dirname(this.filePath), target)
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error
      }

      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const yaml = stringifyYaml(this.cache as any)
      const mode = fs.existsSync(destination) ? fs.statSync(destination).mode & 0o777 : 0o600
      tempPath = `${destination}.${process.pid}.${randomUUID()}.tmp`
      fs.writeFileSync(tempPath, ensureTrailingNewline(yaml), { encoding: "utf-8", mode })
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
