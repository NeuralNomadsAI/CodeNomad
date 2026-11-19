import { createHash } from "node:crypto"
import type { LocationPublicRef, OpenCodeClient, PermissionRule, SessionInfo } from "@opencode/client"
import type { ConversationPermissionMode, ConversationPermissionModeResponse } from "../api-types"
import type { SettingsService } from "../settings/service"
import { blockPositions, sameRules, sessionPermissionRules, supervisedRules } from "./session-mode-rules"

export const NEW_CONVERSATION_PERMISSIONS = "newConversationPermissions"

export class SessionModeConflict extends Error {}

type Settings = Pick<SettingsService, "getPrivateSessionPermissionState" | "setPrivateSessionPermissionBlock" | "getRawConfigOwner">
type NativeTarget = {
  client: OpenCodeClient
  read(): Promise<SessionInfo>
  current(): void
  signal: AbortSignal
  distro: string | undefined
}
type NativeCreation = { client: OpenCodeClient; location: LocationPublicRef; distro: string | undefined; signal: AbortSignal }

export function newConversationMode(value: unknown): ConversationPermissionMode {
  if (value === undefined || value === "autonomous") return "autonomous"
  if (value === "supervised") return value
  throw new Error("Invalid new conversation permissions")
}

export class SessionPermissionModes {
  private readonly pending = new Map<string, Promise<unknown>>()

  constructor(private readonly settings: Settings) {}

  private key(distro: string | undefined, session: Pick<SessionInfo, "id" | "time">): string {
    if (!session.id || !Number.isFinite(session.time.created)) throw new Error("Invalid session identity")
    const host = distro ? `wsl:${distro.toLowerCase()}` : `host:${process.platform}`
    return createHash("sha256").update(JSON.stringify([host, session.id, session.time.created])).digest("hex")
  }

  private rules(session: SessionInfo) {
    return sessionPermissionRules.parse(session.permissions ?? [])
  }

  private owned(key: string) {
    const block = sessionPermissionRules.min(2).optional().parse(this.settings.getPrivateSessionPermissionState()[key])
    if (block && !sameRules(block.slice(0, 2), supervisedRules([], false))) throw new Error("Invalid stored permission block")
    return block
  }

  private remember(key: string, block: PermissionRule[] | null) {
    // Start the synchronous merge from a readable, authoritative state document.
    this.settings.setPrivateSessionPermissionBlock(key, block)
  }

  private async configBlock({ client, location, distro, signal }: NativeCreation) {
    const config = await client.config.get({ location: { directory: location.directory } }, { signal })
    return supervisedRules(config, process.platform === "win32" && !distro)
  }

  async newRootRules(target: NativeCreation): Promise<PermissionRule[] | undefined> {
    const settings = this.settings.getRawConfigOwner("ui")?.settings as Record<string, unknown> | undefined
    if (newConversationMode(settings?.[NEW_CONVERSATION_PERMISSIONS]) === "supervised") return this.configBlock(target)
  }

  confirmNewRoot(session: SessionInfo, distro: string | undefined, block: PermissionRule[], original: PermissionRule[]) {
    const rules = this.rules(session)
    if (session.parentID || blockPositions(rules, block).length !== 1
      || !sameRules(rules, [...original, ...block])) throw new Error("Native session permission creation was not confirmed")
    this.remember(this.key(distro, session), block)
  }

  read(target: NativeTarget): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, session) => {
      const block = this.owned(key)
      return { mode: block && blockPositions(this.rules(session), block).length ? "supervised" : "autonomous" }
    })
  }

  write(target: NativeTarget, mode: ConversationPermissionMode): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, initial) => {
      const stored = this.owned(key)
      const currentRules = (session: SessionInfo) => {
        target.current()
        if (this.key(target.distro, session) !== key || session.location.directory !== initial.location.directory
          || session.projectID !== initial.projectID) throw new SessionModeConflict("Session placement changed")
        return this.rules(session)
      }
      let block = stored
      if (mode === "supervised" && !(stored && blockPositions(currentRules(initial), stored).length)) {
        block = await this.configBlock({ ...target, location: initial.location })
      }
      let retained = false
      for (let attempt = 0; attempt < 3; attempt++) {
        // Read again after config/lock/persistence. The native update replaces
        // the whole array and has no compare-and-swap precondition.
        let rules = currentRules(await target.read())
        let positions = block ? blockPositions(rules, block) : []
        if (mode === "supervised" && stored && blockPositions(rules, stored).length) return { mode }
        if (mode === "autonomous" && !positions.length) {
          if (stored) this.remember(key, null)
          return { mode }
        }
        if (!block || positions.length > 1) throw new SessionModeConflict("Ambiguous permission block")
        if (mode === "supervised" && !retained) {
          // Identical unowned rules do not grant a right to remove them later.
          if (positions.length) throw new SessionModeConflict("Permission block already exists without ownership")
          this.remember(key, block)
          retained = true
          rules = currentRules(await target.read())
          positions = blockPositions(rules, block)
          if (positions.length) {
            this.remember(key, stored ?? null)
            throw new SessionModeConflict("Permission rules changed")
          }
        }
        if (mode === "supervised" && positions.length) return { mode }
        const index = positions[0]
        const updated = mode === "supervised" ? [...rules, ...block]
          : [...rules.slice(0, index), ...rules.slice(index + block.length)]
        target.current()
        let writeFailure: { error: unknown } | undefined
        try { await target.client.session.update({ sessionID: initial.id, permissions: updated }, { signal: AbortSignal.timeout(10_000) }) }
        catch (error) { writeFailure = { error } }
        const confirmed = currentRules(await target.read())
        if (sameRules(confirmed, updated)) {
          if (mode === "autonomous") this.remember(key, null)
          return { mode }
        }
        // A failed transport is never replayed. A successful write followed by
        // divergence can rebase against a fresh read in the next iteration.
        if (writeFailure) throw writeFailure.error
        if (retained && attempt === 2 && !blockPositions(confirmed, block).length) this.remember(key, stored ?? null)
      }
      throw new SessionModeConflict("Permission rules changed")
    })
  }

  private async exclusive<T>(target: NativeTarget, run: (key: string, session: SessionInfo) => Promise<T>): Promise<T> {
    const first = await target.read()
    const key = this.key(target.distro, first)
    const previous = this.pending.get(key)
    const task = Promise.resolve(previous).catch(() => {}).then(async () => {
      target.current()
      const fresh = previous ? await target.read() : first
      target.current()
      if (this.key(target.distro, fresh) !== key) throw new SessionModeConflict("Session identity changed")
      return run(key, fresh)
    })
    this.pending.set(key, task)
    try { return await task }
    finally { if (this.pending.get(key) === task) this.pending.delete(key) }
  }
}
