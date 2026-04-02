import type { Logger } from "../logger"
import type { EventBus } from "../events/bus"
import type { ConfigLocation } from "../config/location"
import { z } from "zod"
import { YamlDocStore, type SettingsDoc } from "./yaml-doc-store"
import { migrateSettingsLayout } from "./migrate"
import type { WorkspaceEventPayload } from "../api-types"
import { sanitizeConfigOwner } from "./public-config"

export type DocKind = "config" | "state"

const CanonicalLogLevelSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function normalizeServerConfigOwner(value: SettingsDoc): SettingsDoc {
  if (!isPlainObject(value)) {
    return {}
  }

  const next: SettingsDoc = { ...value }
  const parsedLogLevel = CanonicalLogLevelSchema.safeParse(next.logLevel)
  if (parsedLogLevel.success) {
    next.logLevel = parsedLogLevel.data
  } else if (typeof next.logLevel === "string") {
    next.logLevel = "DEBUG"
  }
  return next
}

function normalizeConfigDoc(doc: SettingsDoc): SettingsDoc {
  if (!isPlainObject(doc)) {
    return {}
  }

  if (!isPlainObject(doc.server)) {
    return doc
  }

  return {
    ...doc,
    server: normalizeServerConfigOwner(doc.server as SettingsDoc),
  }
}

export class SettingsService {
  private readonly configStore: YamlDocStore
  private readonly stateStore: YamlDocStore

  constructor(
    private readonly location: ConfigLocation,
    private readonly eventBus: EventBus | undefined,
    private readonly logger: Logger,
  ) {
    migrateSettingsLayout(location, logger)
    this.configStore = new YamlDocStore(location.configYamlPath, logger.child({ component: "settings-config" }))
    this.stateStore = new YamlDocStore(location.stateYamlPath, logger.child({ component: "settings-state" }))
  }

  getDoc(kind: DocKind): SettingsDoc {
    if (kind !== "config") {
      return this.stateStore.get()
    }

    const current = this.configStore.get()
    const normalized = normalizeConfigDoc(current)
    if (!isDeepEqual(current, normalized)) {
      this.configStore.replace(normalized)
    }
    return normalized
  }

  mergePatchDoc(kind: DocKind, patch: unknown): SettingsDoc {
    const updated =
      kind === "config"
        ? this.configStore.replace(normalizeConfigDoc(this.configStore.mergePatch(patch)))
        : this.stateStore.mergePatch(patch)
    this.publish(kind, "*")
    return updated
  }

  getOwner(kind: DocKind, owner: string): SettingsDoc {
    if (kind !== "config") {
      return this.stateStore.getOwner(owner)
    }

    return owner === "server"
      ? normalizeServerConfigOwner(this.getDoc("config").server as SettingsDoc)
      : this.getDoc("config")[owner] as SettingsDoc
  }

  mergePatchOwner(kind: DocKind, owner: string, patch: unknown): SettingsDoc {
    const updated =
      kind === "config"
        ? owner === "server"
          ? this.configStore.replaceOwner(owner, normalizeServerConfigOwner(this.configStore.mergePatchOwner(owner, patch)))
          : this.configStore.mergePatchOwner(owner, patch)
        : this.stateStore.mergePatchOwner(owner, patch)
    this.publish(kind, owner, updated)
    return updated
  }

  private publish(kind: DocKind, owner: string, value?: SettingsDoc) {
    if (!this.eventBus) return
    const type = kind === "config" ? "storage.configChanged" : "storage.stateChanged"
    const nextValue = value ?? this.getOwner(kind, owner)
    const payload: WorkspaceEventPayload = {
      type,
      owner,
      value: kind === "config" ? sanitizeConfigOwner(owner, nextValue) : nextValue,
    } as any
    this.eventBus.publish(payload)
  }
}
