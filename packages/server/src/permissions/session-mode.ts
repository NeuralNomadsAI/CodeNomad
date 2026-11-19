import { createHash } from "node:crypto"
import type { LocationPublicRef, OpenCodeClient, PermissionRule, SessionInfo } from "@opencode/client"
import { z } from "zod"
import type { ConversationPermissionMode, ConversationPermissionModeResponse } from "../api-types"
import type { SettingsService } from "../settings/service"
import { appendSessionProjection, blockPositions, sameRules, sessionPermissionRules, supervisedRules } from "./session-mode-rules"

export const NEW_CONVERSATION_PERMISSIONS = "newConversationPermissions"

export class SessionModeConflict extends Error {}

type Settings = Pick<SettingsService, "getPrivateSessionPermissionState" | "setPrivateSessionPermissionBlock" | "getRawConfigOwner">
type NativeTarget = {
  client: OpenCodeClient
  read(): Promise<SessionInfo>
  readAncestor(sessionID: string): Promise<SessionInfo | undefined>
  current(): void
  signal: AbortSignal
  distro: string | undefined
}
type NativeCreation = { client: OpenCodeClient; location: LocationPublicRef; distro: string | undefined; signal: AbortSignal }

const blockStart = supervisedRules([], false)
const savedBlock = sessionPermissionRules.refine(block => sameRules(block.slice(0, 2), blockStart))
const savedBlocks = z.object({ active: savedBlock.nullish(), previous: z.array(savedBlock) })
const sourceSessionID = (session: SessionInfo) => session.fork?.sessionID ?? session.parentID

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

  private owned(key: string, state = this.settings.getPrivateSessionPermissionState()) {
    const saved = state[key]
    return Array.isArray(saved) ? { active: savedBlock.parse(saved), previous: [] }
      : savedBlocks.optional().parse(saved) ?? { previous: [] }
  }

  private remember(key: string, active: PermissionRule[] | null, previous: PermissionRule[][] = []) {
    this.settings.setPrivateSessionPermissionBlock(key, active, previous)
  }

  private async inheritedBlock(target: NativeTarget, session: SessionInfo, rules: PermissionRule[]) {
    let source = sourceSessionID(session)
    if (!source || !blockPositions(rules, blockStart).length) return
    const state = this.settings.getPrivateSessionPermissionState()
    const visited = new Set([session.id])
    let match: PermissionRule[] | undefined
    while (source) {
      if (visited.has(source) || visited.size > 64) throw new SessionModeConflict("Invalid permission ancestry")
      visited.add(source)
      const ancestor = await target.readAncestor(source)
      if (!ancestor) break
      const { active, previous } = this.owned(this.key(target.distro, ancestor), state)
      for (const block of active ? [active, ...previous] : previous) {
        if (!blockPositions(rules, block).length) continue
        if (match && !sameRules(match, block)) return "ambiguous" as const
        match = block
      }
      source = sourceSessionID(ancestor)
    }
    return match
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
      const { active } = this.owned(key)
      const rules = this.rules(session)
      const block = active && blockPositions(rules, active).length ? active : await this.inheritedBlock(target, session, rules)
      return { mode: block ? "supervised" : "autonomous" }
    })
  }

  write(target: NativeTarget, mode: ConversationPermissionMode): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, initial) => {
      const { active, previous } = this.owned(key)
      const currentRules = (session: SessionInfo) => {
        target.current()
        if (this.key(target.distro, session) !== key || session.location.directory !== initial.location.directory
          || session.projectID !== initial.projectID || sourceSessionID(session) !== sourceSessionID(initial)) {
          throw new SessionModeConflict("Session placement changed")
        }
        return this.rules(session)
      }
      const original = currentRules(initial)
      const local = active && blockPositions(original, active).length ? active : undefined
      const owned = local ?? await this.inheritedBlock(target, initial, original)
      if (owned === "ambiguous") {
        if (mode === "supervised") return { mode }
        throw new SessionModeConflict("Ambiguous permission block")
      }
      const config = mode === "supervised" && !owned ? await this.configBlock({ ...target, location: initial.location }) : undefined
      const history = active && !previous.some(block => sameRules(block, active)) ? [...previous, active] : previous
      const forget = () => {
        // A descendant can still carry this block after the source changes mode.
        if (active) this.remember(key, null, history)
      }
      let retained: { block: PermissionRule[]; previous: PermissionRule[][] } | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        // Read again after config/lock/persistence. The native update replaces
        // the whole array and has no compare-and-swap precondition.
        const rules = currentRules(await target.read())
        const knownBlock = owned ?? retained?.block
        const positions = knownBlock ? blockPositions(rules, knownBlock) : []
        if (mode === "supervised" && owned && positions.length) return { mode }
        if (sourceSessionID(initial) && !local && !sameRules(rules, original)) {
          const fresh = await this.inheritedBlock(target, initial, rules)
          if (fresh && (fresh === "ambiguous" || !knownBlock || !sameRules(fresh, knownBlock))) {
            throw new SessionModeConflict("Permission rules changed")
          }
          // Keep the rule read immediately before dispatch if ancestry required I/O.
          if (!sameRules(currentRules(await target.read()), rules)) continue
        }
        if (mode === "autonomous" && !positions.length) {
          forget()
          return { mode }
        }
        if (positions.length > 1) throw new SessionModeConflict("Ambiguous permission block")
        if (mode === "supervised" && positions.length) return { mode }
        let block = owned
        if (mode === "supervised") {
          if (!config) throw new SessionModeConflict("Permission rules changed")
          block = appendSessionProjection(config, rules, target.distro)
          // Identical unowned rules do not grant a right to remove them later.
          if (blockPositions(rules, config).length || blockPositions(rules, block).length) {
            throw new SessionModeConflict("Permission block already exists without ownership")
          }
          const prior = retained?.block
          const past = retained?.previous ?? history
          const retired = prior && !sameRules(prior, block) && !past.some(entry => sameRules(entry, prior))
            ? [...past, prior] : past
          this.remember(key, block, retired)
          const fresh = currentRules(await target.read())
          if (!sameRules(fresh, rules)) {
            this.remember(key, prior ?? active ?? null, retained?.previous ?? previous)
            if (blockPositions(fresh, block).length) throw new SessionModeConflict("Permission rules changed")
            continue
          }
          retained = { block, previous: retired }
        }
        if (!block) throw new SessionModeConflict("Permission rules changed")
        const index = positions[0]
        const updated = mode === "supervised" ? [...rules, ...block]
          : [...rules.slice(0, index), ...rules.slice(index + block.length)]
        target.current()
        let writeFailure: { error: unknown } | undefined
        try { await target.client.session.update({ sessionID: initial.id, permissions: updated }, { signal: AbortSignal.timeout(10_000) }) }
        catch (error) { writeFailure = { error } }
        const confirmed = currentRules(await target.read())
        if (sameRules(confirmed, updated)) {
          if (mode === "autonomous") forget()
          return { mode }
        }
        // A failed transport is never replayed. A successful write followed by
        // divergence can rebase against a fresh read in the next iteration.
        if (writeFailure) throw writeFailure.error
        if (retained && attempt === 2 && !blockPositions(confirmed, block).length) this.remember(key, active ?? null, previous)
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
