import type { Logger } from "../logger"
import type { EventBus } from "../events/bus"
import type { ConfigLocation } from "../config/location"
import { YamlDocStore, type SettingsDoc } from "./yaml-doc-store"
import { migrateSettingsLayout } from "./migrate"
import type { WorkspaceEventPayload } from "../api-types"

export type DocKind = "config" | "state"

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
    return kind === "config" ? this.configStore.get() : this.stateStore.get()
  }

  mergePatchDoc(kind: DocKind, patch: unknown): SettingsDoc {
    const updated = kind === "config" ? this.configStore.mergePatch(patch) : this.stateStore.mergePatch(patch)
    this.publish(kind, "*")
    return updated
  }

  getOwner(kind: DocKind, owner: string): SettingsDoc {
    return kind === "config" ? this.configStore.getOwner(owner) : this.stateStore.getOwner(owner)
  }

  mergePatchOwner(kind: DocKind, owner: string, patch: unknown): SettingsDoc {
    const updated =
      kind === "config" ? this.configStore.mergePatchOwner(owner, patch) : this.stateStore.mergePatchOwner(owner, patch)
    this.publish(kind, owner, updated)
    return updated
  }

  private publish(kind: DocKind, owner: string, value?: SettingsDoc) {
    if (!this.eventBus) return
    const type = kind === "config" ? "storage.configChanged" : "storage.stateChanged"
    const payload: WorkspaceEventPayload = {
      type,
      owner,
      value: value ?? this.getOwner(kind, owner),
    } as any
    this.eventBus.publish(payload)
  }
}
