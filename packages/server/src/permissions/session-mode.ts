import { createHash } from "node:crypto"
import type { LocationPublicRef, OpenCodeClient, PermissionRule, SessionInfo } from "@opencode/client"
import { z } from "zod"
import type { ConversationPermissionMode, ConversationPermissionModeResponse } from "../api-types"
import type { SettingsService } from "../settings/service"
import { sameLocation } from "../opencode/compatibility/location"
import { appendSessionProjection, blockPositions, sameRules, sessionPermissionRules, supervisedRules } from "./session-mode-rules"

export const NEW_CONVERSATION_PERMISSIONS = "newConversationPermissions"

export class SessionModeConflict extends Error {}
export class UnverifiedPermissionBlock extends SessionModeConflict {
  constructor() {
    super("Cannot switch to Autonomous: CodeNomad could not verify which rules to remove. No rules were changed.")
  }
}

type Settings = Pick<SettingsService, "getPrivateSessionPermissionState" | "setPrivateSessionPermissionBlock" | "getRawConfigOwner">
export type NativeTarget = {
  sessionID: string
  client: OpenCodeClient
  read(): Promise<SessionInfo>
  current(): void
  signal: AbortSignal
  distro: string | undefined
}
type NativeCreation = { client: OpenCodeClient; location: LocationPublicRef; distro: string | undefined; signal: AbortSignal }
type CopyObservation = { session: SessionInfo; source: SessionInfo; rules: PermissionRule[]; current(): void }

const blockStart = supervisedRules([], false)
const savedBlock = sessionPermissionRules.refine(block => sameRules(block.slice(0, 2), blockStart))
const savedTarget = z.object({ id: z.string().min(1), created: z.number(), directory: z.string().min(1), distro: z.string().nullish() })
const savedBlocks = z.object({
  active: savedBlock.nullish(), pending: savedBlock.nullish(), target: savedTarget.nullish().catch(undefined),
  child: z.boolean().optional(),
})
type SavedBlocks = z.infer<typeof savedBlocks>
const sourceSessionID = (session: SessionInfo) => session.fork?.sessionID ?? session.parentID
export const isPermissionRoot = (session: SessionInfo) => !!session.fork || !session.parentID
const ambiguous = "ambiguous" as const

// Refresh revisions replace the same span. If one is a prefix of another at
// that position, take the complete block; unrelated spans are still ambiguous.
function revisionMatch(rules: PermissionRule[], candidates: readonly (PermissionRule[] | null | undefined)[]): PermissionRule[] | typeof ambiguous | undefined {
  let match: PermissionRule[] | undefined
  let offset: number | undefined
  for (const block of candidates) {
    if (!block) continue
    for (const pos of blockPositions(rules, block)) {
      if (offset !== undefined && offset !== pos) return ambiguous
      offset = pos
      if (!match || match.length < block.length) match = block
    }
  }
  return match
}

export function newConversationMode(value: unknown): ConversationPermissionMode {
  if (value === undefined || value === "autonomous") return "autonomous"
  if (value === "supervised") return value
  throw new Error("Invalid new conversation permissions")
}

export class SessionPermissionModes {
  private readonly pending = new Map<string, Promise<unknown>>()
  constructor(private readonly settings: Settings) {}

  private key(distro: string | undefined, session: { id: string; time: Pick<SessionInfo["time"], "created"> }): string {
    if (!session.id || !Number.isFinite(session.time.created)) throw new Error("Invalid session identity")
    const host = distro ? `wsl:${distro.toLowerCase()}` : `host:${process.platform}`
    return createHash("sha256").update(JSON.stringify([host, session.id, session.time.created])).digest("hex")
  }

  private rules(session: SessionInfo) {
    return sessionPermissionRules.parse(session.permissions ?? [])
  }

  private parseSaved(saved: unknown): SavedBlocks {
    return Array.isArray(saved) ? { active: savedBlock.parse(saved) } : savedBlocks.parse(saved ?? {})
  }

  private owned(key: string): SavedBlocks {
    const saved = this.settings.getPrivateSessionPermissionState()[key]
    try { return this.parseSaved(saved) }
    catch { return {} }
  }

  private remember(key: string, active: PermissionRule[] | null, distro: string | undefined, session: SessionInfo,
    pending?: PermissionRule[] | null) {
    const target = active || pending
      ? { id: session.id, created: session.time.created, directory: session.location.directory, distro: distro?.toLowerCase() ?? null }
      : undefined
    this.settings.setPrivateSessionPermissionBlock(key, active, target, pending ?? undefined, !isPermissionRoot(session))
  }

  refreshTargets(distro: string | undefined, directory?: string) {
    const host = distro?.toLowerCase()
    const targets = []
    const legacy = new Set<string>()
    for (const [key, entry] of Object.entries(this.settings.getPrivateSessionPermissionState())) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue
      let saved
      try { saved = this.parseSaved(entry) }
      catch { continue }
      if (!saved.active && !saved.pending) continue
      const { target } = saved
      if (!target) {
        legacy.add(key)
        continue
      }
      if ((target.distro ?? undefined) !== host || (directory && target.directory !== directory)
        || key !== this.key(distro, { id: target.id, time: { created: target.created } })) continue
      targets.push(target)
    }
    return { targets, legacy }
  }

  matchLegacyTarget(distro: string | undefined, session: SessionInfo, legacy: Set<string>) {
    return legacy.delete(this.key(distro, session))
  }

  forgetDeleted(distro: string | undefined, sessionID: string, confirmed: () => Promise<boolean>, created?: number) {
    return this.serialize(distro, [sessionID], async () => {
      const state = this.settings.getPrivateSessionPermissionState()
      if (created !== undefined) {
        const key = this.key(distro, { id: sessionID, time: { created } })
        if (Object.hasOwn(state, key) && await confirmed()) this.settings.setPrivateSessionPermissionBlock(key, null)
        return
      }
      const keys = Object.entries(state).flatMap(([key, entry]) => {
        const target = savedBlocks.safeParse(entry).data?.target
        return target?.id === sessionID && (target.distro ?? undefined) === distro?.toLowerCase()
          && key === this.key(distro, { id: sessionID, time: { created: target.created } }) ? [key] : []
      })
      if (keys.length && await confirmed()) for (const key of keys) this.settings.setPrivateSessionPermissionBlock(key, null)
    })
  }

  mayBeSupervised(session: Pick<SessionInfo, "permissions">) {
    return blockPositions(session.permissions ?? [], blockStart).length > 0
  }

  /** Record only an exact creation match with the direct source, never a historical or ancestor match. */
  observeCopy(distro: string | undefined, id: string, sourceID: string, load: () => Promise<CopyObservation | undefined>) {
    if (id === sourceID) return Promise.resolve(false)
    return this.serialize(distro, [sourceID, id], async () => {
      const observation = await load()
      if (!observation) return false
      const { session, source, rules, current } = observation
      const key = this.key(distro, session)
      const existing = this.owned(key)
      if (existing.active || existing.pending) return true
      if (sourceSessionID(session) !== sourceID || source.id !== sourceID || source.time.updated > session.time.created
        || !sameRules(this.rules(source), rules) || !sameRules(this.rules(session), rules)) return false
      const from = this.owned(this.key(distro, source))
      if (!from.active || from.pending || (!isPermissionRoot(source) && !from.child)
        || blockPositions(rules, from.active).length !== 1) return false
      current()
      this.remember(key, from.active, distro, session)
      return true
    })
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
    if (sourceSessionID(session) || blockPositions(rules, block).length !== 1
      || !sameRules(rules, [...original, ...block])) throw new Error("Native session permission creation was not confirmed")
    const key = this.key(distro, session)
    this.remember(key, block, distro, session)
  }

  /** Recover only a unique copy from a proven creation, without replacing newer ownership. */
  recoverNewRoot(target: NativeTarget, block: PermissionRule[]): Promise<void> {
    return this.exclusive(target, async (key, session) => {
      if (sourceSessionID(session) || blockPositions(this.rules(session), block).length !== 1
        || Object.hasOwn(this.settings.getPrivateSessionPermissionState(), key)) return
      this.remember(key, block, target.distro, session)
    })
  }

  read(target: NativeTarget): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, session) => {
      const { active, pending } = this.owned(key)
      const supervised = revisionMatch(this.rules(session), [active, pending])
        || (session.fork || active || pending) && this.mayBeSupervised(session)
      return { mode: supervised ? "supervised" : "autonomous" }
    })
  }

  async refresh(target: NativeTarget): Promise<void> {
    return this.exclusive(target, async (key, initial) => {
      const saved = this.owned(key)
      const child = !isPermissionRoot(initial)
      if (child && !saved.child) return
      const currentRules = this.currentRules(target, key, initial)
      let rules = currentRules(initial)
      let config: PermissionRule[] | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const owned = revisionMatch(rules, [saved.active, saved.pending])
        if (!owned || owned === ambiguous) return
        const index = blockPositions(rules, owned)[0]
        const prefix = rules.slice(0, index)
        config ??= await this.configBlock({ ...target, location: initial.location })
        // Child creation does not say whether identical rules were explicitly supplied.
        // Even an exact match permits only adding restrictions, never rewriting a child rule.
        const replacement = child ? [...owned, ...config.filter(rule => rule.effect === "deny"
          && !owned.some(entry => sameRules([entry], [rule])))] : appendSessionProjection(config, prefix, target.distro)
        if (sameRules(owned, replacement)) {
          const fresh = currentRules(await target.read())
          if (!sameRules(fresh, rules)) { rules = fresh; continue }
          if (saved.pending || saved.target?.directory !== initial.location.directory) this.remember(key, owned, target.distro, initial)
          return
        }
        const updated = [...prefix, ...replacement, ...rules.slice(index + owned.length)]
        if (blockPositions(updated, replacement).length !== 1
          || (replacement.length > owned.length && blockPositions(rules, replacement).includes(index))
          || (replacement.length < owned.length && blockPositions(updated, owned).includes(index))) {
          return
        }
        // Retain both possibilities across an interrupted native write.
        this.remember(key, owned, target.distro, initial, replacement)
        const beforeWrite = currentRules(await target.read())
        if (!sameRules(beforeWrite, rules)) {
          this.remember(key, saved.active ?? null, target.distro, initial, saved.pending)
          rules = beforeWrite
          continue
        }
        const { confirmed, failure } = await this.replace(target, initial.id, updated, currentRules)
        if (sameRules(confirmed, updated)) {
          this.remember(key, replacement, target.distro, initial)
          return
        }
        if (sameRules(confirmed, rules)) this.remember(key, saved.active ?? null, target.distro, initial, saved.pending)
        if (failure) throw failure.error
        // Rebase from verified ownership if another client changed other rules.
        saved.active = owned
        saved.pending = replacement
        rules = confirmed
      }
      throw new SessionModeConflict("Permission rules changed")
    })
  }

  write(target: NativeTarget, mode: ConversationPermissionMode): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, initial) => {
      const saved = this.owned(key)
      const { active, pending } = saved
      if (!isPermissionRoot(initial)) throw new SessionModeConflict("Conversation family changed")
      const currentRules = this.currentRules(target, key, initial)
      const original = currentRules(initial)
      const owned = revisionMatch(original, [active, pending])
      if (owned === ambiguous) {
        if (mode === "autonomous") throw new UnverifiedPermissionBlock()
        return { mode }
      }
      if (mode === "supervised" && initial.fork && this.mayBeSupervised(initial) && !owned) return { mode }
      const config = mode === "supervised" && !owned ? await this.configBlock({ ...target, location: initial.location }) : undefined
      const forget = () => {
        if (active || pending) this.settings.setPrivateSessionPermissionBlock(key, null)
      }
      let retained: PermissionRule[] | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        // Read again after config/lock/persistence. The native update replaces
        // the whole array and has no compare-and-swap precondition.
        const rules = currentRules(await target.read())
        const knownBlock = owned ?? retained
        const positions = knownBlock ? blockPositions(rules, knownBlock) : []
        if (!sameRules(rules, original)) {
          const fresh = revisionMatch(rules, [active, pending])
          if (fresh && (fresh === ambiguous || !knownBlock || !sameRules(fresh, knownBlock))) {
            throw new SessionModeConflict("Permission rules changed")
          }
        }
        if (mode === "autonomous" && !positions.length) {
          if ((initial.fork || active || pending) && blockPositions(rules, blockStart).length) throw new UnverifiedPermissionBlock()
          forget()
          return { mode }
        }
        if (positions.length > 1) {
          if (mode === "autonomous") throw new UnverifiedPermissionBlock()
          return { mode }
        }
        if (mode === "supervised" && positions.length) return { mode }
        let block = owned
        if (mode === "supervised") {
          if (!config) throw new SessionModeConflict("Permission rules changed")
          block = appendSessionProjection(config, rules, target.distro)
          // Identical unowned rules do not grant a right to remove them later.
          if (initial.fork && blockPositions(rules, blockStart).length) return { mode }
          if (blockPositions(rules, config).length || blockPositions(rules, block).length) {
            throw new SessionModeConflict("Permission block already exists without ownership")
          }
          this.remember(key, block, target.distro, initial)
          const fresh = currentRules(await target.read())
          if (!sameRules(fresh, rules)) {
            this.remember(key, retained ?? active ?? null, target.distro, initial, pending)
            if (blockPositions(fresh, block).length) throw new SessionModeConflict("Permission rules changed")
            continue
          }
          retained = block
        }
        if (!block) throw new SessionModeConflict("Permission rules changed")
        const index = positions[0]
        const updated = mode === "supervised" ? [...rules, ...block]
          : [...rules.slice(0, index), ...rules.slice(index + block.length)]
        const { confirmed, failure } = await this.replace(target, initial.id, updated, currentRules)
        if (sameRules(confirmed, updated)) {
          if (mode === "autonomous") forget()
          return { mode }
        }
        // A failed transport is never replayed. A successful write followed by
        // divergence can rebase against a fresh read in the next iteration.
        if (failure) throw failure.error
        if (retained && attempt === 2 && !blockPositions(confirmed, block).length) this.remember(key, active ?? null, target.distro, initial, pending)
      }
      throw new SessionModeConflict("Permission rules changed")
    })
  }

  private currentRules(target: NativeTarget, key: string, initial: SessionInfo) {
    return (session: SessionInfo) => {
      target.current()
      if (this.key(target.distro, session) !== key || !sameLocation(session.location, initial.location)
        || session.projectID !== initial.projectID || sourceSessionID(session) !== sourceSessionID(initial)) {
        throw new SessionModeConflict("Session placement changed")
      }
      return this.rules(session)
    }
  }

  private async replace(target: NativeTarget, sessionID: string, permissions: PermissionRule[], currentRules: (session: SessionInfo) => PermissionRule[]) {
    target.current()
    let failure: { error: unknown } | undefined
    try { await target.client.session.update({ sessionID, permissions }, { signal: AbortSignal.timeout(10_000) }) }
    catch (error) { failure = { error } }
    return { confirmed: currentRules(await target.read()), failure }
  }

  private async serialize<T>(distro: string | undefined, sessionIDs: string[], run: () => Promise<T>): Promise<T> {
    const keys = sessionIDs.map(id => JSON.stringify([distro?.toLowerCase(), id]))
    const task = Promise.allSettled(keys.map(key => this.pending.get(key))).then(run)
    for (const key of keys) this.pending.set(key, task)
    try { return await task }
    finally { for (const key of keys) if (this.pending.get(key) === task) this.pending.delete(key) }
  }

  withSessionLock<T>(target: NativeTarget, run: (session: SessionInfo) => Promise<T>): Promise<T> {
    return this.serialize(target.distro, [target.sessionID], async () => {
      target.current()
      const fresh = await target.read()
      target.current()
      return run(fresh)
    })
  }

  private exclusive<T>(target: NativeTarget, run: (key: string, session: SessionInfo) => Promise<T>): Promise<T> {
    return this.withSessionLock(target, session => run(this.key(target.distro, session), session))
  }
}
