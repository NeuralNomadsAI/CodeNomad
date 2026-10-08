import type { Plugin } from "@opencode/plugin"
import { setupMissionsPlugin, parseDelegateInput, type MissionsPluginContext, type MissionsPluginPolicy } from "../missions-plugin"
import type { MissionControl } from "../../missions/control"
import type { MissionInputTransport, NativeMissionSession } from "../../missions/control-types"
import { MissionJournal, stableToken } from "../../missions/journal"
import type { MissionEvent, MissionLocation } from "../../missions/model"
import { sameLocation } from "../compatibility/location"
import { NativeMissionAuthority, type AuthorityEffectIntent } from "../../missions/authority-core"
import { NativeMissionAuthorityStore, type AuthorityGrant } from "../../missions/authority-store"
import { CODENOMAD_MISSIONS_AUTHORITY_RPC, missionAuthorityHandlers, rejectUnsignedMissionMutators } from "../../missions/authority-rpc"
import { authenticateAuthorityIntent, authoritySignerDigest, canonicalAuthority, selectProvisionedSigner, snapshotAuthoritySigner,
  MissionAuthorityError, rejectAuthority, type AuthorityBinding, type AuthorityIntent, type AuthorityRoot,
  type AuthoritySignerSnapshot, type ProvisionedAuthoritySigner, type SignedAuthorityIntent } from "../../missions/authority-protocol"
import { missionRecoveryInput } from "../../missions/recovery-input"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { parseMissionLifecycleReply } from "../../missions/lifecycle-schema"

type NativeContext = Parameters<Plugin.Plugin["setup"]>[0]
export type DurableMissionsContext = Omit<MissionsPluginContext, "rpc"> & Pick<NativeContext, "rpc">
type Input<K extends keyof MissionInputTransport> = Parameters<NonNullable<MissionInputTransport[K]>>[1]
export type DurableMissionAdmission = {
  [K in keyof Required<MissionInputTransport>]: {
    kind: K; coordinatorID: string; input: Input<K>; grant: AuthorityGrant | null; intent: AuthorityEffectIntent | null
  }
}[keyof MissionInputTransport]
export type DurableMissionTransportReceipt = { admitted: true }
  | { nativeAcknowledgement: import("../../missions/lifecycle-model").MissionNativeAcknowledgement }
  | { outcome: "removed" | "retained" }

/** Trusted construction dependency, NEVER ctx.options or RPC input. The host
 * adapter owns human auth, managed-writer proof, protected grants and physical
 * root resolution. Its authenticated transport must reconstruct native input,
 * hold shared ownership/connection/send/worktree gates, freshly apply environment,
 * and call assertCurrent immediately before effects. No plugin-side HTTP fallback. */
export interface DurableMissionsHost {
  /** Optional restrictive request correlation only. Canonical host always supplies
   * it. Capture BEFORE awaits so old effects cannot borrow another request. */
  captureHumanIntent?(signed: SignedAuthorityIntent): () => true
  assertManagedIncarnation(): true
  readSigners(): Promise<readonly ProvisionedAuthoritySigner[]>
  /** Compare full scope/roots, fingerprint, generation and qualification against
   * the CURRENT trusted map, synchronously. Snapshots are detached identities. */
  assertSignerCurrent(signer: AuthoritySignerSnapshot): true
  resolveRoot(location: MissionLocation): Promise<AuthorityRoot>
  transport: {
    execute(request: DurableMissionAdmission, options: { signal: AbortSignal; assertCurrent(): Promise<void>; assertHumanCurrent?: () => true }): Promise<DurableMissionTransportReceipt>
  }
}

/** Private construction factory only. Nothing imports this from packaging or the
 * desktop entry. With no provisioned host, native reads/context/reports survive,
 * but every privileged mutation and send fails closed. No presence following. */
export function durablePlugin(host?: DurableMissionsHost): Plugin.Plugin {
  return { id: "codenomad.missions", setup: context => setupDurableMissionsPlugin(context, host) }
}

export async function setupDurableMissionsPlugin(context: DurableMissionsContext, host?: DurableMissionsHost): Promise<() => Promise<void>> {
  let active = true
  let authorityReady = false
  const lifetime = new AbortController()
  const assertActive = () => { if (!active) rejectAuthority("authorization-blocked") }
  const requireHost = () => {
    assertActive()
    if (!host || !authorityReady) rejectAuthority("authorization-blocked")
    assertSynchronousAuthorityGuard(() => host.assertManagedIncarnation(), "policy-unqualified")
    return host
  }
  const assertCurrentSigner = (signer: AuthoritySignerSnapshot): true => {
    return assertSynchronousAuthorityGuard(() => requireHost().assertSignerCurrent(signer), "untrusted-signer")
  }
  const readSigners = async () => {
    if (!host) return []
    try { return await requireHost().readSigners() }
    catch (error) { if (error instanceof MissionAuthorityError) throw error; rejectAuthority("trust-unavailable") }
  }
  const journal = new MissionJournal(context.storage, context.location.project.id, context.location.project.canonical)
  const store = new NativeMissionAuthorityStore(context.storage, context.location.project.id, context.location.project.canonical)
  const effects = new Map<string, { intent: AuthorityEffectIntent; signal: AbortSignal; signer: AuthoritySignerSnapshot; current(): true }>()
  let control!: MissionControl
  const mission = async (id: string) => (await journal.snapshot()).missions.find(item => item.id === id)
  const root = async (location: MissionLocation) => {
    let resolved: AuthorityRoot
    try { resolved = await requireHost().resolveRoot(location) }
    catch (error) { if (error instanceof MissionAuthorityError) throw error; rejectAuthority("observation-unavailable") }
    assertActive()
    if (resolved.directory !== location.directory) rejectAuthority("binding-mismatch")
    return resolved
  }
  const nativeActor = async (id: string, location?: MissionLocation): Promise<NativeMissionSession> => {
    let session: NativeMissionSession
    try { session = await context.session.get({ sessionID: id }) }
    catch { rejectAuthority("observation-unavailable") }
    assertActive()
    if (session.id !== id || session.parentID || session.projectID !== context.location.project.id
      || (location && !sameLocation(session.location, location))) rejectAuthority("binding-mismatch")
    return session
  }
  const observe = async (id: string) => {
    const saved = await mission(id)
    if (!saved) return undefined
    const roots: AuthorityRoot[] = []
    for (const actor of saved.actors) {
      const session = await nativeActor(actor.sessionId, actor.location)
      const identity = await root(session.location)
      if (!roots.some(item => canonicalAuthority(item) === canonicalAuthority(identity))) roots.push(identity)
    }
    roots.sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0)
    if (!saved.actors.some(actor => actor.sessionId === saved.coordinatorSessionId && actor.kind === "coordinator")) rejectAuthority("binding-mismatch")
    return { missionID: saved.id, coordinatorSessionID: saved.coordinatorSessionId, revision: saved.revision,
      status: saved.status, runState: saved.runState ?? "running", controlPending: Boolean(saved.control?.pending.length),
      control: saved.control, controlUnavailable: saved.controlUnavailable, roots }
  }
  const creationIDs = (body: AuthorityIntent) => {
    const missionID = `msn_${stableToken(`${body.projectID}\0${body.requestID}`, 24)}`
    return { missionID, coordinatorID: `ses_${stableToken(`${missionID}\0coordinator`, 26)}` }
  }
  const authority = new NativeMissionAuthority(store, {
    assertActive: () => { assertActive(); if (!authorityReady) rejectAuthority("authorization-blocked") },
    readSigners,
    assertSignerCurrent: assertCurrentSigner,
    observeMission: observe,
    assertJournalCapacity: async body => {
      if (body.method === "create") {
        if (body.missionID !== creationIDs(body).missionID) rejectAuthority("binding-mismatch")
        const owned = await root(context.location)
        if (!body.roots.some(item => canonicalAuthority(item) === canonicalAuthority(owned))) rejectAuthority("binding-mismatch")
      }
      const saved = await mission(body.missionID)
      const count = body.method === "lifecycle" ? 1 + (saved?.actors.length ?? 0)
        : ["create", "update", "delete"].includes(body.method) ? 1 : 0
      if (count) await journal.assertCanAppend(count)
    },
  })
  const admission = async (missionID: string, sessionID: string) => {
    const current = await authority.state(missionID)
    if (!current.grant) rejectAuthority("authorization-blocked")
    const saved = await mission(missionID)
    const actor = saved?.actors.find(item => item.sessionId === sessionID)
    if (!actor) rejectAuthority("binding-mismatch")
    const identity = await root((await nativeActor(sessionID, actor.location)).location)
    return authority.assertAdmission({ ...current.grant, root: identity })
  }
  const effectFor = (missionID: string, purpose: string, id?: string) => [...effects.values()].find(({ intent }) =>
    intent.missionID === missionID && (purpose === "lifecycle" ? intent.method === "lifecycle" && id === eventID(intent, "control")
      : purpose === "cleanup" ? intent.method === "delete" && id === eventID(intent, "deleted") : intent.method === "recover"))
  const send = async <K extends keyof MissionInputTransport>(kind: K, coordinatorID: string, input: Input<K>): Promise<unknown> => {
    const value = input as Input<"prompt"> & Input<"lifecycle"> & Input<"cleanup">
    const metadata = value.metadata?.["codenomad.mission"] as { missionID?: string; kind?: string } | undefined
    const missionID = value.missionID ?? metadata?.missionID
    if (!missionID) rejectAuthority("binding-mismatch")
    const effect = kind === "lifecycle" || kind === "cleanup" ? effectFor(missionID, kind, value.operationID ?? value.deletionID)
      : metadata?.kind === "recovery" ? effectFor(missionID, "recovery") : undefined
    if ((kind === "lifecycle" || kind === "cleanup" || metadata?.kind === "recovery") && !effect) rejectAuthority("authorization-blocked")
    const signal = effect?.signal ?? lifetime.signal
    let grant: AuthorityGrant | null = null
    const checkpoint = async () => {
      effect?.current()
      requireHost(); signal.throwIfAborted()
      if (effect) assertCurrentSigner(effect.signer)
      const saved = await mission(missionID)
      if (!saved || saved.coordinatorSessionId !== coordinatorID) rejectAuthority("binding-mismatch")
      const actor = saved.actors.find(item => item.sessionId === value.sessionID)
      if (!actor) rejectAuthority("binding-mismatch")
      await nativeActor(value.sessionID, actor.location)
      if (effect) {
        if (metadata?.kind === "recovery") {
          if (effect.intent.method !== "recover"
            || canonicalAuthority(input) !== canonicalAuthority(missionRecoveryInput(saved, { missionID,
              expectedRevision: effect.intent.expectedRevision, ...effect.intent.payload }))) rejectAuthority("binding-mismatch")
        }
        grant = (await authority.state(missionID)).grant
        await authority.assertEffectReservation(effect.intent, effect.current)
      } else {
        grant = await admission(missionID, value.sessionID)
      }
      requireHost(); signal.throwIfAborted()
      if (effect) assertCurrentSigner(effect.signer)
      effect?.current()
    }
    await checkpoint()
    const request = { kind, coordinatorID, input, grant, intent: effect?.intent ?? null } as DurableMissionAdmission
    try {
      const receipt = await requireHost().transport.execute(request, { signal, assertCurrent: checkpoint, assertHumanCurrent: effect?.current })
      if (kind === "lifecycle") {
        if (!effect || effect.intent.method !== "lifecycle" || !parseMissionLifecycleReply(receipt, {
          missionID, operationID: value.operationID, sessionID: value.sessionID, action: effect.intent.payload.action,
        })) rejectAuthority("effect-unavailable")
      } else if (!("admitted" in receipt && receipt.admitted === true)) rejectAuthority("effect-unavailable")
      return receipt
    } catch (error) { if (error instanceof MissionAuthorityError) throw error; rejectAuthority("effect-unavailable") }
  }
  // ALL send/control paths have a transport, even with an unavailable host. Never
  // pass undefined to MissionControl and never expose native prompt/synthetic.
  const transport: MissionInputTransport = {
    prompt: (id, input) => send("prompt", id, input), synthetic: (id, input) => send("synthetic", id, input),
    lifecycle: (id, input) => send("lifecycle", id, input),
    cleanup: async () => rejectAuthority("policy-unqualified"),
  }
  const publicationFence = async (binding: AuthorityBinding | AuthorityGrant, pinned?: AuthoritySignerSnapshot) => {
    const signer = pinned ?? snapshotAuthoritySigner(selectProvisionedSigner(binding, await readSigners()))
    if ("signerDigest" in binding && binding.signerDigest !== authoritySignerDigest(signer.publicKey)) rejectAuthority("untrusted-signer")
    return () => { assertCurrentSigner(signer) }
  }
  const beforeJournalWrite = async (event: MissionEvent) => {
    assertActive()
    // Evidence/ACKs remain writable independently of new-send authority. Control
    // ACKs still require the matching in-flight signed operation below.
    if (event.type === "task.reported" || event.type === "report.notified" || event.type === "task.dispatched") return
    const effect = [...effects.values()].find(item => item.intent.missionID === event.missionID && (
      event.type === "mission.created" ? item.intent.method === "create" && item.intent.requestID === event.requestID
      : event.type === "mission.updated" ? item.intent.method === "update" && item.intent.requestID === event.requestID
      : event.type === "mission.deleted" ? item.intent.method === "delete" && event.id === eventID(item.intent, "deleted")
      : event.type === "mission.control-requested" || event.type === "mission.control-applied" ? item.intent.method === "lifecycle"
        && (event.type === "mission.control-requested" ? event.id : event.operationID) === eventID(item.intent, "control") : false))
    if (effect) {
      effect.current()
      effect.signal.throwIfAborted()
      if (event.type !== "mission.control-applied") await authority.assertEffectReservation(effect.intent, effect.current)
      if (event.type === "mission.created") {
        if (event.coordinator.sessionID !== effect.intent.coordinatorSessionID || event.prepared !== true) rejectAuthority("binding-mismatch")
        const identity = await root((await nativeActor(event.coordinator.sessionID, event.coordinator.location)).location)
        if (!effect.intent.roots.some(item => canonicalAuthority(item) === canonicalAuthority(identity))) rejectAuthority("binding-mismatch")
      }
      const signerFence = await publicationFence(effect.intent, effect.signer)
      // Both journal reservation AND ACK publication retain the original lease,
      // including late awaits after the native effect acknowledgement.
      return () => { effect.current(); signerFence() }
    }
    if (["mission.created", "mission.updated", "mission.deleted", "mission.control-requested", "mission.control-applied", "mission.session-cleaned"].includes(event.type)) rejectAuthority("authorization-blocked")
    const saved = await mission(event.missionID)
    if (!saved) rejectAuthority("authorization-blocked")
    const grant = await admission(saved.id, saved.coordinatorSessionId)
    if (event.type === "task.dispatching") {
      const identity = await root((await nativeActor(event.actor.sessionID, event.actor.location)).location)
      if (!grant.roots.some(item => canonicalAuthority(item) === canonicalAuthority(identity))) rejectAuthority("binding-mismatch")
      await admission(saved.id, saved.coordinatorSessionId)
    }
    return publicationFence(grant)
  }
  const policy: MissionsPluginPolicy = {
    configure: async instance => {
      control = instance
    },
    beforeJournalWrite,
    beforeTool: async (name, input, sessionID) => {
      assertActive()
      const value = input as { missionID?: string; start?: unknown; final?: boolean }
      if (name === "inspect") { if (value.start !== undefined) rejectAuthority("unsigned-privileged-method"); return }
      if (name === "report" && value.final !== true) return
      // Native declarations are business writes, not root creation. Only the
      // explicit independent exception may use an existing root; new roots stay
      // gated and must not be recreated by a generic get-error fallback.
      const delegated = name === "delegate" ? parseDelegateInput(input) : undefined
      const independent = delegated?.executionMode?.kind === "independent"
      if (independent && !delegated?.targetSessionID) rejectAuthority("policy-unqualified")
      const selected = (await control.inspect(sessionID, { missionID: value.missionID }, "authority-read")).mission
      if (!selected) rejectAuthority("authorization-blocked")
      const grant = await admission(selected.id, sessionID)
      if (independent && delegated?.targetSessionID) {
        const identity = await root((await nativeActor(delegated.targetSessionID)).location)
        if (!grant.roots.some(item => canonicalAuthority(item) === canonicalAuthority(identity))) rejectAuthority("binding-mismatch")
      }
    },
  }
  const proxy: MissionsPluginContext = { ...context,
    rpc: { register: (definition, handlers) => context.rpc.register(definition, rejectUnsignedMissionMutators(handlers)) },
    session: { ...context.session,
      prompt: async () => rejectAuthority("authorization-blocked"), synthetic: async () => rejectAuthority("authorization-blocked"),
      hook: (name, callback) => context.session.hook(name, async event => {
        const before = event.system.length
        await callback(event)
        if (active && event.system.length > before) event.system.push({ type: "text", text:
          "A saved mission map is not execution authorization. New delegation, plan changes, finalization and sends require a current qualified continuity grant. Agent-created missions are unavailable here. Already-admitted evidence may still be reported without waking the coordinator; never replace or replay work to bypass missing authority." })
      }),
      create: async input => {
        const metadata = input.metadata["codenomad.mission"] as { missionID?: string } | undefined
        const effect = [...effects.values()].find(item => item.intent.method === "create" && item.intent.missionID === metadata?.missionID)
        if (!effect || input.id !== effect.intent.coordinatorSessionID || input.id !== creationIDs(effect.intent).coordinatorID) rejectAuthority("authorization-blocked")
        await authority.assertEffectReservation(effect.intent, effect.current)
        const identity = await root(input.location)
        if (!effect.intent.roots.some(item => canonicalAuthority(item) === canonicalAuthority(identity))) rejectAuthority("binding-mismatch")
        assertCurrentSigner(effect.signer); effect.signal.throwIfAborted()
        effect.current()
        return context.session.create(input)
      },
    },
  }
  let disposeMap: (() => Promise<void>) | undefined
  let registration: { dispose(): Promise<void> } | undefined
  let disposal: Promise<void> | undefined
  const dispose = () => {
    active = false; lifetime.abort()
    return disposal ??= (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => disposeMap?.()), Promise.resolve().then(() => registration?.dispose()),
      ])
      effects.clear()
      const failed = results.find(result => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })()
  }
  try {
    // Damaged authority is unavailable, never repaired/fallback-authorized.
    // Keep the independent journal/context/report surface when it is readable.
    try { await store.initialize(); authorityReady = true } catch { authorityReady = false }
    disposeMap = await setupMissionsPlugin(proxy, transport, policy)
    const applyEffects = async (body: AuthorityEffectIntent, signal: AbortSignal, signer: AuthoritySignerSnapshot, current: () => true) => {
         current()
        requireHost(); signal.throwIfAborted()
         await authority.assertEffectReservation(body, current)
        const saved = await mission(body.missionID)
        if (body.method !== "create" && (!saved || saved.revision !== body.expectedRevision
          || saved.coordinatorSessionId !== body.coordinatorSessionID)) rejectAuthority("revision-conflict")
         current()
         const effect = { intent: body, signal: AbortSignal.any([signal, lifetime.signal]), signer, current }
        effects.set(body.requestID, effect)
        try {
          const common = { missionID: body.missionID, requestID: body.requestID, expectedRevision: body.expectedRevision }
          if (body.method === "create") {
            if (body.missionID !== creationIDs(body).missionID) rejectAuthority("binding-mismatch")
            if (body.coordinatorSessionID !== creationIDs(body).coordinatorID) {
              const identity = await root((await nativeActor(body.coordinatorSessionID)).location)
              if (!body.roots.some(item => canonicalAuthority(item) === canonicalAuthority(identity))) rejectAuthority("binding-mismatch")
            }
            // Only the known generated coordinator takes native creation. An
            // explicit existing coordinator keeps the native root/membership checks.
            const result = await control.create({ ...body.payload, requestID: body.requestID,
              ...(body.coordinatorSessionID === creationIDs(body).coordinatorID ? {} : { coordinatorSessionID: body.coordinatorSessionID }) })
            if (result.mission.id !== body.missionID || result.mission.coordinatorSessionId !== body.coordinatorSessionID
              || result.mission.runState !== "prepared") rejectAuthority("binding-mismatch")
            return { missionID: body.missionID, revision: result.mission.revision, prepared: true as const }
          }
          if (body.method === "delete") { await control.delete({ ...common, ...body.payload }); return { missionID: body.missionID, deleted: true as const } }
          if (body.method === "update") { const result = await control.update({ ...common, ...body.payload }); return { missionID: body.missionID, revision: result.mission.revision } }
          if (body.method === "lifecycle") {
            const result = await control.lifecycle({ ...common, ...body.payload })
            return { missionID: body.missionID, revision: result.mission.revision, operationID: result.mission.control!.id }
          }
          const notification = missionRecoveryInput(saved!, { ...common, ...body.payload })
          const result = await control.recover({ ...common, ...body.payload })
          return { missionID: body.missionID, revision: result.mission.revision, admissionID: notification.id }
        } finally { if (effects.get(body.requestID) === effect) effects.delete(body.requestID) }
    }
    const handlers = missionAuthorityHandlers(authority, { apply: async () => rejectAuthority("authorization-blocked") }, assertActive)
    registration = await context.rpc.register(CODENOMAD_MISSIONS_AUTHORITY_RPC, {
      ...handlers, intent: async (input, invocation) => {
        try {
          const currentHost = requireHost()
          const humanFence = currentHost.captureHumanIntent?.(input)
          if (currentHost.captureHumanIntent && typeof humanFence !== "function") rejectAuthority("policy-unqualified")
          const current = (): true => {
            invocation.signal.throwIfAborted(); lifetime.signal.throwIfAborted()
            if (humanFence) assertSynchronousAuthorityGuard(humanFence, "policy-unqualified")
            return true
          }
          current()
          // This integration cannot validate cleanup after the journal mission
          // disappears. Verify then reject BEFORE reserving/deleting; denial
          // intents intentionally skip the core's business-capacity callback.
          const signers = await readSigners()
          const verified = authenticateAuthorityIntent(input, signers)
          if (verified.body.method === "delete" && verified.body.payload.deleteManagedSessions) rejectAuthority("policy-unqualified")
          const signer = verified.signer
          const scoped = missionAuthorityHandlers(authority, { expectedSigner: signer, assertCurrent: current,
            apply: (body, signal) => applyEffects(body, signal, signer, current) }, assertActive)
          return await scoped.intent(input, { signal: AbortSignal.any([invocation.signal, lifetime.signal]) })
        }
        catch (error) {
          if (error instanceof MissionAuthorityError) return invocation.error("mission.authority-rejected", error.message, { code: error.code })
          return invocation.error("mission.authority-rejected", "Mission authority unavailable", { code: "trust-unavailable" })
        }
      },
    })
    return dispose
  } catch (error) { await dispose(); throw error }
}

function eventID(intent: AuthorityEffectIntent, kind: "control" | "deleted"): string {
  return `evt_${stableToken(`${intent.missionID}\0${kind}-${intent.requestID}`, 28)}`
}
