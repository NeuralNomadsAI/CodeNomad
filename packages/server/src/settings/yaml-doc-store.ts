import fs from "fs"
import path from "path"
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
    this.cache = normalized
    this.loaded = true
    this.persist()
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
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const yaml = stringifyYaml(this.cache as any)
      fs.writeFileSync(this.filePath, ensureTrailingNewline(yaml), "utf-8")
    } catch (error) {
      this.logger.warn({ err: error, filePath: this.filePath }, "Failed to persist YAML doc")
    }
  }
}
