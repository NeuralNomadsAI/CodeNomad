import { createHash } from "node:crypto"
import type { LocationPublicRef, OpenCodeClient, PermissionRule, SessionInfo } from "@opencode/client"
import { z } from "zod"
import type { ConversationPermissionMode, ConversationPermissionModeResponse } from "../api-types"
import type { SettingsService } from "../settings/service"
import { sameLocation } from "../opencode/compatibility/location"
import { appendSessionProjection, blockPositions, sameRules, sessionPermissionRules, supervisedRules } from "./session-mode-rules"

export const NEW_CONVERSATION_PERMISSIONS = "newConversationPermissions"

export class SessionModeConflict extends Error {}

type Settings = Pick<SettingsService, "getPrivateSessionPermissionState" | "setPrivateSessionPermissionBlock" | "getRawConfigOwner">
export type NativeTarget = {
  sessionID: string
  client: OpenCodeClient
  read(): Promise<SessionInfo>
  readAncestor(sessionID: string): Promise<SessionInfo | undefined>
  current(): void
  signal: AbortSignal
  distro: string | undefined
}
type NativeCreation = { client: OpenCodeClient; location: LocationPublicRef; distro: string | undefined; signal: AbortSignal }
type CopyObservation = { target: NativeTarget; session: SessionInfo; rules: PermissionRule[]; exactNativeCopy: boolean }

const blockStart = supervisedRules([], false)
const savedBlock = sessionPermissionRules.refine(block => sameRules(block.slice(0, 2), blockStart))
const retiredBlock = z.union([savedBlock, z.array(savedBlock).min(1)])
type RetiredBlock = z.infer<typeof retiredBlock>
const savedTarget = z.object({ id: z.string().min(1), created: z.number(), directory: z.string().min(1), distro: z.string().nullish() })
const savedBlocks = z.object({
  active: savedBlock.nullish(), previous: z.array(retiredBlock),
  revisions: z.array(savedBlock).default([]), pending: savedBlock.nullish(), target: savedTarget.nullish().catch(undefined),
})
type SavedBlocks = z.infer<typeof savedBlocks>
type Ownership = SavedBlocks & { recorded: boolean }
const sourceSessionID = (session: SessionInfo) => session.fork?.sessionID ?? session.parentID
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
  private readonly known = new Map<string, { id: string; created: number; directory: string; distro: string | undefined }>()

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
    return Array.isArray(saved) ? { active: savedBlock.parse(saved), previous: [], revisions: [], pending: undefined }
      : savedBlocks.parse(saved ?? { previous: [] })
  }

  private owned(key: string, state = this.settings.getPrivateSessionPermissionState()): Ownership {
    return { ...this.parseSaved(state[key]), recorded: Object.hasOwn(state, key) }
  }

  private remember(key: string, active: PermissionRule[] | null, previous: RetiredBlock[] = [],
    revisions: PermissionRule[][] = [], pending?: PermissionRule[] | null, keepEmpty = false) {
    const target = active || pending ? this.known.get(key) : undefined
    this.settings.setPrivateSessionPermissionBlock(key, active, previous, revisions, pending ?? undefined,
      target && { ...target, distro: target.distro ?? null }, keepEmpty)
  }

  private track(key: string, distro: string | undefined, session: SessionInfo) {
    this.known.set(key, { id: session.id, created: session.time.created, directory: session.location.directory, distro: distro?.toLowerCase() })
  }

  knownAt(distro: string | undefined, directory?: string) {
    return [...this.known.values()].filter(session => session.distro === distro?.toLowerCase() && (!directory || session.directory === directory))
  }

  refreshTargets(distro: string | undefined, directory?: string) {
    const host = distro?.toLowerCase()
    const targets = new Map([...this.known].filter(([, target]) =>
      target.distro === host && (!directory || target.directory === directory)))
    const legacy = new Set<string>()
    for (const [key, entry] of Object.entries(this.settings.getPrivateSessionPermissionState())) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue
      let saved
      try { saved = this.parseSaved(entry) }
      catch { continue }
      if (!saved.active && !saved.pending) continue
      const { target } = saved
      if (!target) {
        if (!this.known.has(key)) legacy.add(key)
        continue
      }
      if ((target.distro ?? undefined) !== host || (directory && target.directory !== directory)
        || key !== this.key(distro, { id: target.id, time: { created: target.created } })) continue
      if (!targets.has(key)) targets.set(key, { ...target, distro: target.distro ?? undefined })
    }
    return { targets: targets.values(), legacy }
  }

  matchLegacyTarget(distro: string | undefined, session: SessionInfo, legacy: Set<string>) {
    return legacy.delete(this.key(distro, session))
  }

  forgetDeleted(distro: string | undefined, sessionID: string) {
    for (const [key, session] of this.known) {
      if (session.id === sessionID && session.distro === distro?.toLowerCase()) this.known.delete(key)
    }
  }

  mayBeSupervised(session: SessionInfo) {
    return blockPositions(session.permissions ?? [], blockStart).length > 0
  }

  private async inheritedBlock(target: NativeTarget, session: SessionInfo, rules: PermissionRule[]) {
    let source = sourceSessionID(session)
    if (!source || !blockPositions(rules, blockStart).length) return
    const state = this.settings.getPrivateSessionPermissionState()
    const visited = new Set([session.id])
    let inherited: PermissionRule[] | undefined
    while (source) {
      if (visited.has(source) || visited.size > 64) throw new SessionModeConflict("Invalid permission ancestry")
      visited.add(source)
      const ancestor = await target.readAncestor(source)
      if (!ancestor) break
      const { active, previous, revisions, pending } = this.owned(this.key(target.distro, ancestor), state)
      const retired = previous.flatMap(entry => Array.isArray(entry[0]) ? entry as PermissionRule[][] : [entry as PermissionRule[]])
      for (const block of [active, pending, ...revisions, ...retired]) {
        if (!block) continue
        const positions = blockPositions(rules, block)
        if (!positions.length) continue
        if (positions.length > 1 || (inherited && !sameRules(inherited, block))) return ambiguous
        inherited = block
      }
      source = sourceSessionID(ancestor)
    }
    return inherited
  }

  private block(target: NativeTarget, session: SessionInfo, rules: PermissionRule[], saved: Ownership) {
    const local = revisionMatch(rules, [saved.active, saved.pending])
    return saved.recorded ? local : this.inheritedBlock(target, session, rules)
  }

  /** Bind an owned creation snapshot to its direct source before refreshing the copy. */
  observeCopy(distro: string | undefined, id: string, sourceID: string, load: () => Promise<CopyObservation | undefined>) {
    if (id === sourceID) return Promise.resolve(false)
    return this.serialize(distro, [sourceID, id], async () => {
      const observation = await load()
      if (!observation) return false
      const { target, session, rules, exactNativeCopy } = observation
      const key = this.key(distro, session)
      if (this.owned(key).recorded) return true

      let block: PermissionRule[] | undefined
      if (blockPositions(rules, blockStart).length) {
        // A later source state cannot disambiguate the creation boundary.
        const ancestor = await target.readAncestor(sourceID)
        if (!ancestor || !(ancestor.time.updated <= session.time.created)) return false
        const sourceRules = this.rules(ancestor)
        // Explicit child rules can replace the native copy.
        if (sameRules(sourceRules, rules)) {
          const saved = this.owned(this.key(distro, ancestor))
          const copied = await this.block(target, ancestor, sourceRules, saved)
          if (copied === ambiguous || saved.pending || (copied && blockPositions(rules, copied).length !== 1)) return false
          block = copied
          const fresh = await target.readAncestor(sourceID)
          if (!fresh || this.key(distro, fresh) !== this.key(distro, ancestor)
            || fresh.time.updated !== ancestor.time.updated || !sameRules(this.rules(fresh), sourceRules)) return false
          const current = this.owned(this.key(distro, fresh))
          if (current.pending || current.recorded !== saved.recorded || !sameRules(current.active ?? [], saved.active ?? [])) return false
        } else if (exactNativeCopy) return false
      }
      target.current()
      if (block) this.track(key, distro, session)
      this.remember(key, block ?? null, [], [], undefined, true)
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
    if (session.parentID || blockPositions(rules, block).length !== 1
      || !sameRules(rules, [...original, ...block])) throw new Error("Native session permission creation was not confirmed")
    const key = this.key(distro, session)
    this.track(key, distro, session)
    this.remember(key, block)
  }

  /** Recover only a unique copy from a proven creation, without replacing newer ownership. */
  recoverNewRoot(target: NativeTarget, block: PermissionRule[]): Promise<void> {
    return this.exclusive(target, async (key, session) => {
      if (sourceSessionID(session) || blockPositions(this.rules(session), block).length !== 1
        || Object.hasOwn(this.settings.getPrivateSessionPermissionState(), key)) return
      this.track(key, target.distro, session)
      this.remember(key, block)
    })
  }

  read(target: NativeTarget): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, session) => {
      const block = await this.block(target, session, this.rules(session), this.owned(key))
      if (block) this.track(key, target.distro, session)
      else this.known.delete(key)
      return { mode: block ? "supervised" : "autonomous" }
    })
  }

  async refresh(target: NativeTarget): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, initial) => {
      const saved = this.owned(key)
      const currentRules = this.currentRules(target, key, initial)
      let rules = currentRules(initial)
      let config: PermissionRule[] | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        const owned = await this.block(target, initial, rules, saved)
        if (!owned) {
          this.known.delete(key)
          if (attempt) throw new SessionModeConflict("Permission block changed")
          return { mode: "autonomous" }
        }
        this.track(key, target.distro, initial)
        if (owned === ambiguous) throw new SessionModeConflict("Ambiguous permission block")
        const positions = blockPositions(rules, owned)
        if (positions.length !== 1) throw new SessionModeConflict("Ambiguous permission block")
        const index = positions[0]
        const prefix = rules.slice(0, index)
        config ??= await this.configBlock({ ...target, location: initial.location })
        const replacement = appendSessionProjection(config, prefix, target.distro)
        const revisions = [...saved.revisions]
        for (const block of [owned, saved.active, saved.pending]) {
          if (block && !sameRules(block, replacement) && !revisions.some(entry => sameRules(entry, block))) revisions.push(block)
        }
        if (sameRules(owned, replacement)) {
          const fresh = currentRules(await target.read())
          if (!sameRules(fresh, rules)) { rules = fresh; continue }
          if (!saved.recorded || saved.pending || saved.target?.directory !== initial.location.directory) this.remember(key, owned, saved.previous, revisions)
          return { mode: "supervised" }
        }
        const updated = [...prefix, ...replacement, ...rules.slice(index + owned.length)]
        if (blockPositions(updated, replacement).length !== 1
          || (replacement.length > owned.length && blockPositions(rules, replacement).includes(index))
          || (replacement.length < owned.length && blockPositions(updated, owned).includes(index))) {
          throw new SessionModeConflict("Ambiguous replacement permission block")
        }
        // Retain both possibilities across an interrupted native write.
        this.remember(key, owned, saved.previous, revisions, replacement)
        const beforeWrite = currentRules(await target.read())
        if (!sameRules(beforeWrite, rules)) {
          this.remember(key, saved.active ?? null, saved.previous, saved.revisions, saved.pending, saved.recorded)
          rules = beforeWrite
          continue
        }
        const { confirmed, failure } = await this.replace(target, initial.id, updated, currentRules)
        if (sameRules(confirmed, updated)) {
          this.remember(key, replacement, saved.previous, revisions)
          return { mode: "supervised" }
        }
        if (sameRules(confirmed, rules)) this.remember(key, saved.active ?? null, saved.previous, saved.revisions, saved.pending, saved.recorded)
        if (failure) throw failure.error
        // Rebase from verified ownership if another client changed other rules.
        saved.active = owned
        saved.pending = replacement
        saved.revisions = revisions
        rules = confirmed
      }
      throw new SessionModeConflict("Permission rules changed")
    })
  }

  write(target: NativeTarget, mode: ConversationPermissionMode): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, initial) => {
      const saved = this.owned(key)
      const { active, previous, revisions, pending, recorded } = saved
      const currentRules = this.currentRules(target, key, initial)
      const original = currentRules(initial)
      const owned = await this.block(target, initial, original, saved)
      if (owned) this.track(key, target.distro, initial)
      if (owned === ambiguous) throw new SessionModeConflict("Ambiguous permission block")
      const config = mode === "supervised" && !owned ? await this.configBlock({ ...target, location: initial.location }) : undefined
      const history = [...previous]
      if (active || pending) {
        if (revisions.length || pending) history.push([...revisions, ...(active ? [active] : []), ...(pending ? [pending] : [])])
        else if (active && !history.some(entry => !Array.isArray(entry[0]) && sameRules(entry as PermissionRule[], active))) history.push(active)
      }
      if (owned && !recorded) history.push(owned)
      const forget = () => {
        // A descendant can still carry this block after the source changes mode.
        if (active || pending || (owned && !recorded)) this.remember(key, null, history)
        this.known.delete(key)
      }
      let retained: { block: PermissionRule[]; previous: RetiredBlock[] } | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        // Read again after config/lock/persistence. The native update replaces
        // the whole array and has no compare-and-swap precondition.
        const rules = currentRules(await target.read())
        const knownBlock = owned ?? retained?.block
        const positions = knownBlock ? blockPositions(rules, knownBlock) : []
        if (!sameRules(rules, original) && (recorded || sourceSessionID(initial))) {
          const fresh = await this.block(target, initial, rules, saved)
          if (fresh && (fresh === ambiguous || !knownBlock || !sameRules(fresh, knownBlock))) {
            throw new SessionModeConflict("Permission rules changed")
          }
          // Keep the rule read immediately before dispatch if ancestry required I/O.
          if (!recorded && !sameRules(currentRules(await target.read()), rules)) continue
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
          const retired = prior && !sameRules(prior, block) && !past.some(entry => !Array.isArray(entry[0]) && sameRules(entry as PermissionRule[], prior))
            ? [...past, prior] : past
          this.track(key, target.distro, initial)
          this.remember(key, block, retired)
          const fresh = currentRules(await target.read())
          if (!sameRules(fresh, rules)) {
            this.remember(key, prior ?? active ?? null, retained?.previous ?? previous, revisions, pending, recorded)
            if (blockPositions(fresh, block).length) throw new SessionModeConflict("Permission rules changed")
            continue
          }
          retained = { block, previous: retired }
        }
        if (!block) throw new SessionModeConflict("Permission rules changed")
        const index = positions[0]
        const updated = mode === "supervised" ? [...rules, ...block]
          : [...rules.slice(0, index), ...rules.slice(index + block.length)]
        const { confirmed, failure } = await this.replace(target, initial.id, updated, currentRules)
        if (sameRules(confirmed, updated)) {
          if (mode === "autonomous") forget()
          else this.track(key, target.distro, initial)
          return { mode }
        }
        // A failed transport is never replayed. A successful write followed by
        // divergence can rebase against a fresh read in the next iteration.
        if (failure) throw failure.error
        if (retained && attempt === 2 && !blockPositions(confirmed, block).length) this.remember(key, active ?? null, previous, revisions, pending, recorded)
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
