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
const retiredBlock = z.union([savedBlock, z.array(savedBlock).min(1)])
type RetiredBlock = z.infer<typeof retiredBlock>
const savedBlocks = z.object({
  active: savedBlock.nullish(), previous: z.array(retiredBlock),
  revisions: z.array(savedBlock).default([]), pending: savedBlock.nullish(),
})
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
    return Array.isArray(saved) ? { active: savedBlock.parse(saved), previous: [], revisions: [], pending: undefined }
      : savedBlocks.parse(saved ?? { previous: [] })
  }

  private remember(key: string, active: PermissionRule[] | null, previous: RetiredBlock[] = [],
    revisions: PermissionRule[][] = [], pending?: PermissionRule[] | null) {
    this.settings.setPrivateSessionPermissionBlock(key, active, previous, revisions, pending ?? undefined)
  }

  private track(key: string, distro: string | undefined, session: SessionInfo) {
    this.known.set(key, { id: session.id, created: session.time.created, directory: session.location.directory, distro: distro?.toLowerCase() })
  }

  knownAt(distro: string | undefined, directory?: string) {
    return [...this.known.values()].filter(session => session.distro === distro?.toLowerCase() && (!directory || session.directory === directory))
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
    let match: PermissionRule[] | undefined
    while (source) {
      if (visited.has(source) || visited.size > 64) throw new SessionModeConflict("Invalid permission ancestry")
      visited.add(source)
      const ancestor = await target.readAncestor(source)
      if (!ancestor) break
      const { active, previous, revisions, pending } = this.owned(this.key(target.distro, ancestor), state)
      const current = revisions.length || pending ? revisionMatch(rules, [active, pending, ...revisions]) : active
      if (current === ambiguous) return ambiguous
      for (const entry of current ? [current, ...previous] : previous) {
        const block = revisionMatch(rules, Array.isArray(entry[0]) ? entry as PermissionRule[][] : [entry as PermissionRule[]])
        if (block === ambiguous) return ambiguous
        if (!block) continue
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
    const key = this.key(distro, session)
    this.remember(key, block)
    this.track(key, distro, session)
  }

  read(target: NativeTarget): Promise<ConversationPermissionModeResponse> {
    return this.exclusive(target, async (key, session) => {
      const { active, pending } = this.owned(key)
      const rules = this.rules(session)
      const block = revisionMatch(rules, [active, pending]) ?? await this.inheritedBlock(target, session, rules)
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
        const local = revisionMatch(rules, [saved.active, saved.pending])
        const owned = local ?? await this.inheritedBlock(target, initial, rules)
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
          if (!local || saved.pending) this.remember(key, owned, saved.previous, revisions)
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
          this.remember(key, saved.active ?? null, saved.previous, saved.revisions, saved.pending)
          rules = beforeWrite
          continue
        }
        const { confirmed, failure } = await this.replace(target, initial.id, updated, currentRules)
        if (sameRules(confirmed, updated)) {
          this.remember(key, replacement, saved.previous, revisions)
          return { mode: "supervised" }
        }
        if (sameRules(confirmed, rules)) this.remember(key, saved.active ?? null, saved.previous, saved.revisions, saved.pending)
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
      const { active, previous, revisions, pending } = this.owned(key)
      const currentRules = this.currentRules(target, key, initial)
      const original = currentRules(initial)
      const local = revisionMatch(original, [active, pending])
      const owned = local ?? await this.inheritedBlock(target, initial, original)
      if (owned) this.track(key, target.distro, initial)
      if (owned === "ambiguous") {
        if (mode === "supervised") return { mode }
        throw new SessionModeConflict("Ambiguous permission block")
      }
      const config = mode === "supervised" && !owned ? await this.configBlock({ ...target, location: initial.location }) : undefined
      const history = [...previous]
      if (active || pending) {
        if (revisions.length || pending) history.push([...revisions, ...(active ? [active] : []), ...(pending ? [pending] : [])])
        else if (active && !history.some(entry => !Array.isArray(entry[0]) && sameRules(entry as PermissionRule[], active))) history.push(active)
      }
      const forget = () => {
        // A descendant can still carry this block after the source changes mode.
        if (active || pending) this.remember(key, null, history)
        this.known.delete(key)
      }
      let retained: { block: PermissionRule[]; previous: RetiredBlock[] } | undefined
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
          const retired = prior && !sameRules(prior, block) && !past.some(entry => !Array.isArray(entry[0]) && sameRules(entry as PermissionRule[], prior))
            ? [...past, prior] : past
          this.remember(key, block, retired)
          const fresh = currentRules(await target.read())
          if (!sameRules(fresh, rules)) {
            this.remember(key, prior ?? active ?? null, retained?.previous ?? previous, revisions, pending)
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
        if (retained && attempt === 2 && !blockPositions(confirmed, block).length) this.remember(key, active ?? null, previous, revisions, pending)
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
