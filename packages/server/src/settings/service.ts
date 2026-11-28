import type { Logger } from "../logger"
import type { EventBus } from "../events/bus"
import type { ConfigLocation } from "../config/location"
import { z } from "zod"
import { YamlDocStore, SettingsReadError, type SettingsDoc } from "./yaml-doc-store"
import type { PermissionRule } from "@opencode/client"
import { migrateSettingsLayout } from "./migrate"
import type { WorkspaceEventPayload } from "../api-types"
import { sanitizeConfigOwner } from "./public-config"
import { applyMergePatch } from "./merge-patch"
import { preserveLegacyTranscriptDefaults } from "./transcript-preset-defaults"
import { compactRemoteProjectHistory } from "./remote-project-history"
import { readAdmissionEnvironment } from "./admission-environment"
import { ServerFlagReader } from "./server-flag-reader"
import { canonicalScope } from "../host-lifetime/protocol"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { claimServerIdentity } from "./server-identity"
import path from "node:path"
import { lstatSync, statSync } from "node:fs"
import { assertVoiceConversationPatch } from "../speech/voice-conversation-config"

export type DocKind = "config" | "state"
export const SESSION_FAVORITES_OWNER = "sessionFavorites"
export const SESSION_PERMISSION_BLOCKS_OWNER = "sessionPermissionBlocks"
/** Refuses a config write by throwing, given the authoritative document and the would-be result. */
export type ConfigWriteCheck = (before: SettingsDoc, after: SettingsDoc) => void

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
  } else if (next.logLevel !== undefined) {
    next.logLevel = "DEBUG"
  }
  // Unknown feeds (including legacy channel names) fall back to the derived default.
  if (next.updateFeed !== undefined && next.updateFeed !== "stable" && next.updateFeed !== "preview") {
    delete next.updateFeed
  }
  if (next.opencodeBinary === "opencode") {
    next.opencodeBinary = "opencode2"
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
  private readonly serverFlags: ServerFlagReader
  private favoritesSnapshot?: { stamp: string; owner: SettingsDoc }

  constructor(
    private readonly location: ConfigLocation,
    private readonly eventBus: EventBus | undefined,
    private readonly logger: Logger,
  ) {
    migrateSettingsLayout(location, logger)
    this.configStore = new YamlDocStore(
      location.configYamlPath,
      logger.child({ component: "settings-config" }),
      { throwOnPersistError: true },
    )
    this.stateStore = new YamlDocStore(
      location.stateYamlPath,
      logger.child({ component: "settings-state" }),
      { throwOnPersistError: true, normalize: compactRemoteProjectHistory },
    )
    this.serverFlags = new ServerFlagReader(location.configYamlPath)
  }

  /** Identity failures disable native backend admission while startup continues. */
  getServerId(): string | undefined {
    try { return this.initializeServerId() }
    catch (error) {
      this.logger.warn({ err: error }, "Stable server identity unavailable; backend compatibility falls back")
      return undefined
    }
  }

  private initializeServerId(): string {
    const server = this.configStore.getAuthoritativeOwner("server")
    if (server.serverId !== undefined) {
      return z.string().uuid().parse(server.serverId)
    }
    const serverId = claimServerIdentity(this.location.configYamlPath)
    // Refresh after exclusive publication: every process uses the winning claim.
    const current = this.configStore.getAuthoritativeOwner("server")
    if (current.serverId !== undefined) {
      const persisted = z.string().uuid().parse(current.serverId)
      if (persisted !== serverId) throw new Error("Conflicting persisted server identity")
      return persisted
    }
    try {
      fs.accessSync(this.location.configYamlPath, fs.constants.W_OK)
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
    }
    try { this.configStore.mergePatchOwner("server", { serverId }) }
    catch (error) {
      // A concurrent initializer may have committed while Windows refused our rename.
      if (this.configStore.getAuthoritativeOwner("server").serverId !== serverId) throw error
    }
    return z.string().uuid().parse(this.configStore.getAuthoritativeOwner("server").serverId)
  }

  /** Selected desktop profile; same identity used at Mission Play. */
  getProfileScope() {
    const channel = process.env.CODENOMAD_UPDATE_CHANNEL?.trim().toLowerCase()
      || (process.env.CODENOMAD_DEV === "1" ? "dev" : "stable")
    const scope = canonicalScope(channel, this.location.configYamlPath, process.cwd(), process.cwd())
    const expected = process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY
    if (expected !== undefined && scope.configIdentity !== expected) {
      // Tauri's established Windows identity folds ASCII only. Preserve its
      // signed/profile key; do not relocate existing Unicode desktop state.
      const ascii = process.platform === "win32" ? path.resolve(this.location.configYamlPath)
        .replaceAll("/", "\\").replace(/[A-Z]/g, letter => letter.toLowerCase()) : scope.configIdentity
      if (expected !== ascii) throw new Error("CodeNomad profile configuration differs from its desktop identity")
      return { channel, configIdentity: expected,
        key: createHash("sha256").update(`${channel}\0${expected}`).digest("hex") }
    }
    return scope
  }

  getDoc(kind: DocKind): SettingsDoc {
    if (kind !== "config") {
      return this.stateStore.get()
    }

    const current = this.configStore.get()
    const normalized = normalizeConfigDoc(current)
    if (!isDeepEqual(current, normalized)) {
      // Normalize what is on disk now; an unreadable document is displayed, never rewritten.
      let fresh: SettingsDoc
      try {
        fresh = this.configStore.reloadAuthoritative()
      } catch (error) {
        if (error instanceof SettingsReadError) return normalized
        throw error
      }
      const repaired = normalizeConfigDoc(fresh)
      if (!isDeepEqual(fresh, repaired)) this.configStore.replace(repaired)
      return repaired
    }
    return normalized
  }

  /** Authoritative boolean server setting for access decisions; see `ServerFlagReader`. */
  serverFlag(key: string): boolean {
    return this.serverFlags.enabled(key)
  }

  multiBackendEnabled(): boolean {
    return this.serverFlags.enabled("multiBackend", ["ui", "settings"], true)
  }

  readEnvironmentForAdmission(signal?: AbortSignal): Promise<Record<string, string>> {
    return readAdmissionEnvironment(this.location, signal)
  }

  /** Private authority input; never expose the selected profile path in browser requests. */
  configYamlPathForAuthority(): string {
    return this.location.configYamlPath
  }

  desktopVoiceConversationEngineStore(): YamlDocStore | undefined {
    if (!process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY) return undefined
    const { key } = this.getProfileScope()
    return new YamlDocStore(path.join(this.location.baseDir, "voice", key, "engine.yaml"), this.logger,
      { throwOnPersistError: true })
  }

  desktopLiveVoiceConsentStore(engine: "gemini-live" | "openai-realtime"): YamlDocStore | undefined {
    if (!process.env.CODENOMAD_PROFILE_CONFIG_IDENTITY) return undefined
    const { key } = this.getProfileScope()
    return new YamlDocStore(path.join(this.location.baseDir, "voice", key, `consent-${engine}.yaml`), this.logger,
      { throwOnPersistError: true })
  }

  /**
   * Config writes start from the document as it is on disk now (`reloadAuthoritative`), so a
   * stale cache is never written back; an unreadable or invalid document refuses the write
   * with `SettingsReadError`. `check` sees that base and the result before anything persists.
   */
  mergePatchDoc(kind: DocKind, patch: unknown, check?: ConfigWriteCheck): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    let updated: SettingsDoc
    if (kind === "config") {
      assertVoiceConversationPatch(patch.server)
      const before = this.configStore.reloadAuthoritative()
      const changes = Object.hasOwn(patch, "ui") ? { ...patch, ui: preserveLegacyTranscriptDefaults(before.ui, patch.ui) } : patch
      const after = normalizeConfigDoc(applyMergePatch(before, changes) as SettingsDoc)
      check?.(before, after)
      updated = this.configStore.replace(after)
    } else {
      updated = this.stateStore.mergePatch(patch)
    }
    this.publish(kind, "*", kind === "config" ? {} : undefined)
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

  /** Fresh read-only authority, without unrelated normalization or error fallbacks. */
  getRawConfigOwner(owner: string, options?: { refreshCache?: boolean }): SettingsDoc {
    const value = this.configStore.getAuthoritativeOwner(owner, options)
    if (owner === "ui" && value.settings !== undefined && !isPlainObject(value.settings)) throw new SettingsReadError()
    return value
  }

  getPrivateSessionPermissionState(): SettingsDoc {
    return this.stateStore.getAuthoritativeOwner(SESSION_PERMISSION_BLOCKS_OWNER)
  }

  setPrivateSessionPermissionBlock(key: string, active: PermissionRule[] | null,
    target?: { id: string; created: number; directory: string; distro: string | null }, pending?: PermissionRule[], child = false,
    fork?: { copy?: PermissionRule[] | null }): void {
    this.getPrivateSessionPermissionState()
    this.stateStore.mergePatchOwner(SESSION_PERMISSION_BLOCKS_OWNER, {
      [key]: target ? { active, pending: pending ?? null, target, child,
        fork: fork ? { copy: fork.copy ?? null } : null, previous: null, revisions: null } : active,
    })
  }

  /** A cleanup decision requires readable persisted favorites, not the display fallback. */
  getSessionFavoritesState(): SettingsDoc {
    const stamp = () => {
      const file = this.location.stateYamlPath
      let info
      try { info = lstatSync(file, { bigint: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error }
      if (info.isSymbolicLink()) info = statSync(file, { bigint: true })
      return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
    }
    const before = stamp()
    if (this.favoritesSnapshot?.stamp === before) return this.favoritesSnapshot.owner
    const owner = this.stateStore.getAuthoritativeOwner(SESSION_FAVORITES_OWNER)
    if (stamp() !== before) throw new SettingsReadError()
    this.favoritesSnapshot = { stamp: before, owner }
    return owner
  }

  /** See `mergePatchDoc` for the config write base and `check`. */
  mergePatchOwner(kind: DocKind, owner: string, patch: unknown, check?: ConfigWriteCheck): SettingsDoc {
    if (!isPlainObject(patch)) {
      throw new Error("Patch must be a JSON object")
    }
    let updated: SettingsDoc
    if (kind === "config") {
      if (owner === "server") assertVoiceConversationPatch(patch)
      const before = this.configStore.reloadAuthoritative()
      const changes = owner === "ui" ? preserveLegacyTranscriptDefaults(before.ui, patch) : patch
      const merged = applyMergePatch(this.configStore.getOwner(owner), changes) as SettingsDoc
      const next = owner === "server" ? normalizeServerConfigOwner(merged) : merged
      check?.(before, { ...before, [owner]: next })
      updated = this.configStore.replaceOwner(owner, next)
    } else {
      updated = this.stateStore.mergePatchOwner(owner, patch)
      if (owner === SESSION_FAVORITES_OWNER) this.favoritesSnapshot = undefined
    }
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
      value: kind === "config" ? sanitizeConfigOwner(owner, nextValue)
        : owner === SESSION_FAVORITES_OWNER || owner === SESSION_PERMISSION_BLOCKS_OWNER ? {} : nextValue,
    } as any
    try {
      this.eventBus.publish(payload)
    } catch (error) {
      this.logger.warn({ err: error, kind, owner }, "Failed to publish settings change")
    }
  }
}
