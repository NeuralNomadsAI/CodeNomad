import { realpathSync } from "node:fs"
import { realpath } from "node:fs/promises"
import type { Plugin } from "@opencode/plugin/effect"
import { Location } from "@opencode/schema/location"
import { Session } from "@opencode/schema/session"
import { Context, Effect, Schema } from "effect"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"
import { assertRecurrenceProofFresh, assertSchedulePrincipalAction, recurrenceControlProofSchema, recurrenceControlRequestDigest,
  recurrenceSchedulePrincipal } from "../../missions/recurrence-control-proof"
import { verifyRecurrenceBridge } from "../automation-plugin"
import { missionScheduleID, missionScheduleRequestSchema, type MissionScheduleRequest } from "../../missions/mission-schedule-contract"
import type { MissionDocument } from "../../missions/mission-document"
import { stableToken } from "../../missions/receipt-identity"
import { nativeScheduleOwnerControlReceipt } from "./native-schedule-owner"
import { validateMissionProfileCatalog } from "../../missions/playbook-profiles"
import { physical } from "../../missions/physical-path"
import { createFamilyAuthorityIdentityFence, readFamilyAuthorityPlacement } from "../../workspaces/family-authority-claim"
import { acquireNativeMissionDocumentStore, type NativeMissionDocumentRunner } from "./native-mission-document-storage"
import { automaticMissionStartID } from "../../missions/preparation-result"
import { acquireNativeSourceFence } from "./native-source-fence"
import { missionPreparationBindingSchema, readMissionPreparationBinding } from "../../missions/creation-intent"

/** Transport authentication only. It does not mint a grant or authorize a model tool. */
export async function assertRecurrenceBridgeProof(input: unknown, options: { allowAgent?: boolean } = {}) {
  if (!input || typeof input !== "object") throw new Error("Recurrence transport authentication failed")
  const { proof, retry: _retry, ...raw } = input as Record<string, unknown>
  const body = recurrenceControlProofSchema.parse(raw), principal = recurrenceSchedulePrincipal(body)
  assertSchedulePrincipalAction(principal, body.action)
  if (principal.kind === "agent" && !options.allowAgent) throw new Error("Recurrence agent control refused")
  assertRecurrenceProofFresh(body.issuedAt)
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof)
    || principal.kind === "human" && principal.sessionID === "auth-disabled"
    || body.digest !== recurrenceControlRequestDigest((({ digest: _digest, ...identity }) => identity)(body))
    || !await verifyRecurrenceBridge(body, proof)) throw new Error("Recurrence transport authentication failed")
  assertRecurrenceProofFresh(body.issuedAt)
}

const locationTag = Context.Service<never, unknown>("@opencode/Location")
export const NATIVE_MISSION_SCHEDULE_CONTROL_TIMEOUT_MS = 95_000
/** Read the exact immutable native preparation intent and return its synchronous
 * transaction fence. Missing/unreadable/foreign intent must refuse. */
export type NativeMissionScheduleAgentCreationVerifier = (request: MissionScheduleRequest) => Effect.Effect<() => true, unknown>

export function nativeMissionScheduleAgentCreationVerifier(ctx: Pick<Plugin.Context, "storage" | "location">,
  run: NativeMissionDocumentRunner): NativeMissionScheduleAgentCreationVerifier {
  return request => Effect.gen(function* () {
    const principal = recurrenceSchedulePrincipal(request.transport)
    if (principal.kind !== "agent" || !principal.creationRequestID || request.action !== "create") throw new Error("Mission schedule agent creation differs")
    const creationRequestID = principal.creationRequestID
    const fence = (yield* acquireNativeSourceFence(() => true))()
    const binding = yield* Effect.tryPromise(() => readMissionPreparationBinding({
      get: key => { fence.document(key); return run(ctx.storage.get(key)) },
    }, ctx.location.project, creationRequestID))
    const { kind: _kind, ...expected } = principal
    if (canonicalAuthority(missionPreparationBindingSchema.parse(binding)) !== canonicalAuthority(expected))
      throw new Error("Mission schedule agent creation binding differs")
    fence.current()
    return () => { fence.current(); return true }
  })
}

/** Preparation continuations retain their creation scope; project controls use owned-session authority. */
export function assertMissionScheduleAgentRequest(request: MissionScheduleRequest, document?: MissionDocument | null): void {
  const principal = recurrenceSchedulePrincipal(request.transport)
  assertSchedulePrincipalAction(principal, request.action)
  if (principal.kind !== "agent") return
  if (!principal.creationRequestID) return
  const creation = request.action === "create" ? request.creation : document?.creation
  if (request.retry || request.action === "create" && request.requestID !== principal.creationRequestID
    || !creation || creation.requestID !== principal.creationRequestID
    || creation.digest !== principal.creationDigest
    || canonicalAuthority(creation.author ?? null) !== canonicalAuthority(principal.author))
    throw new Error("Mission schedule agent creation differs")
  if (request.action === "play" && (!document || document.firstPlayedAt !== null
    || document.revision !== request.expectedRevision || document.state !== "paused" || document.pending
    || creation.input?.startOnCreation !== true || creation.automaticStart?.attempted !== false
    || creation.automaticStart.requestID !== request.requestID
    || request.requestID !== automaticMissionStartID(creation.requestID)))
    throw new Error("Mission schedule agent first Play refused")
}

/** Fresh transport admits the exact durable control. Its bounded execution keeps
 * ownership checks after the proof's admission window has elapsed. */
export function nativeMissionScheduleControlExecution(request: MissionScheduleRequest, ownership: () => true) {
  const { missionID, requestID, expectedRevision, action } = request, issuedAt = request.transport.issuedAt
  const fingerprint = stableToken(canonicalAuthority({ action, configuration: request.configuration ?? null,
    deleteManagedSessions: request.deleteManagedSessions ?? false }), 64)
  const signal = AbortSignal.timeout(NATIVE_MISSION_SCHEDULE_CONTROL_TIMEOUT_MS)
  let admitted = false
  const current = (): true => {
    signal.throwIfAborted()
    if (!admitted) assertRecurrenceProofFresh(issuedAt)
    return ownership()
  }
  return { signal, current, admitControl: (document: MissionDocument): true => {
    signal.throwIfAborted(); ownership()
    const receipt = nativeScheduleOwnerControlReceipt(document, requestID)
    const manual = action === "run-now" && [document.pending, ...document.history]
      .find(item => item?.origin.kind === "manual" && item.origin.requestID === requestID)
    const exact = action === "run-now" ? manual && manual.manualExpectedRevision === expectedRevision && document.revision > expectedRevision
      : receipt && receipt.requestID === requestID && receipt.expectedRevision === expectedRevision
        && receipt.action === action && receipt.fingerprint === fingerprint
    if (document.id !== missionID || !exact) throw new Error("Mission control admission proof differs")
    admitted = true
    return current()
  } }
}

/** Signed controls acquire a fresh RPC graph and the authenticated bridge proof.
 * Autonomous wakes use their persisted consent and separate guard. */
export const acquireNativeMissionScheduleAuthority = Effect.fn("missions.acquireScheduleAuthority")(function* (
  ctx: Plugin.Context, raw: unknown, run: NativeMissionDocumentRunner,
  verifyAgentCreation: NativeMissionScheduleAgentCreationVerifier = nativeMissionScheduleAgentCreationVerifier(ctx, run),
) {
  const request = missionScheduleRequestSchema.parse(raw), proof = request.transport
  const principal = recurrenceSchedulePrincipal(proof)
  assertSchedulePrincipalAction(principal, request.action)
  yield* Effect.tryPromise(() => assertRecurrenceBridgeProof(proof, { allowAgent: true }))
  const origin = yield* locationTag
  const location = yield* Schema.decodeUnknownEffect(Schema.toType(Schema.Struct(Location.Info.fields)))(origin)
  const sameLocation = () => location.directory === ctx.location.directory && location.workspaceID === ctx.location.workspaceID
    && location.project.id === ctx.location.project.id && location.project.canonical === ctx.location.project.canonical
  if (!sameLocation()
    || proof.location.directory !== location.directory || proof.location.workspaceID !== location.workspaceID)
    throw new Error("Mission schedule Location changed")
  const store = yield* acquireNativeMissionDocumentStore(ctx, run)
  const before = yield* Effect.promise(() => store.read(request.missionID))
  if (request.action === "create" && request.missionID !== missionScheduleID(location.project.id, location.project.canonical, request.requestID))
    throw new Error("Mission schedule creation identity differs")
  if (request.action !== "create" && (!before || "deletedAt" in before && request.action !== "delete" && request.action !== "check"))
    throw new Error("Mission schedule unavailable")
  assertMissionScheduleAgentRequest(request, before && !("deletedAt" in before) ? before : undefined)
  let agentCurrent = (): void => {}
  if (principal.kind === "agent") {
    const author = yield* ctx.session.get({ sessionID: Session.ID.make(principal.author.coordinatorSessionID) })
    if (author.id !== principal.author.coordinatorSessionID || author.projectID !== location.project.id
      || principal.creationRequestID && (author.location.directory !== location.directory || author.location.workspaceID !== location.workspaceID))
      throw new Error("Mission schedule agent owner differs")
    const fence = (yield* acquireNativeSourceFence(() => {
      if (!sameLocation()) throw new Error("Mission schedule Location changed")
      return true
    }))()
    fence.selectedSession(author)
    let creationCurrent = (): true => true
    if (request.action === "create") {
      creationCurrent = yield* verifyAgentCreation(request)
    }
    agentCurrent = () => { fence.current(); assertSynchronousAuthorityGuard(creationCurrent, "policy-unqualified") }
  }
  const configuration = request.configuration ?? (before && !("deletedAt" in before) ? before.configuration : undefined)
  if (!configuration) {
    if (request.action !== "delete" && request.action !== "check" || !before || !("deletedAt" in before)) throw new Error("Mission schedule configuration unavailable")
    const execution = nativeMissionScheduleControlExecution(request, () => {
      agentCurrent()
      if (!sameLocation()) throw new Error("Mission schedule Location changed")
      return true
    })
    execution.current()
    return { request, store, before, location, ...execution, profileSource: proof.profileSource }
  }
  const host = process.platform === "linux" && process.env.WSL_DISTRO_NAME ? `wsl:${process.env.WSL_DISTRO_NAME}` : "local"
  if (configuration.profileID !== proof.profileSource.profileID || configuration.executionHost !== proof.profileSource.executionHost
    || configuration.executionHost !== host || !configuration.roots.some(root => root.directory === location.directory))
    throw new Error("Mission schedule profile or execution host differs")
  // A configure request cannot move an armed object's service/profile namespace.
  if (before && !("deletedAt" in before) && before.firstPlayedAt !== null
    && (configuration.profileID !== before.configuration.profileID || configuration.executionHost !== before.configuration.executionHost
      || canonicalAuthority(configuration.roots) !== canonicalAuthority(before.configuration.roots)))
    throw new Error("Mission schedule armed namespace differs")
  const rootGuards: Array<() => true> = []
  for (const root of configuration.roots) {
    if (root.mode === "git") {
      const family = yield* Effect.tryPromise(() => createFamilyAuthorityIdentityFence(root.directory))
      const actual = yield* Effect.tryPromise(() => readFamilyAuthorityPlacement(root.directory))
      if (actual.checkout !== root.checkout || actual.family !== root.family) throw new Error("Mission schedule root changed")
      rootGuards.push(() => {
        if (family() !== root.family || physical(realpathSync(root.family)) !== root.family) throw new Error("Mission schedule root changed")
        return true
      })
    } else {
      const expected = physical(yield* Effect.tryPromise(() => realpath(root.directory)))
      rootGuards.push(() => {
        if (physical(realpathSync(root.directory)) !== expected) throw new Error("Mission schedule root changed")
        return true
      })
    }
  }
  if (["create", "configure", "play", "resume", "run-now"].includes(request.action)) {
    const [agents, models] = yield* Effect.all([ctx.agent.list(), ctx.model.list()])
    validateMissionProfileCatalog(configuration.profiles, {
      agents: agents.data.filter(agent => !agent.hidden).map(({ id, mode, description }) => ({ id, mode, description })),
      models: models.data.filter(model => model.enabled && model.capabilities.tools)
        .map(({ providerID, id, variants }) => ({ providerID, id, variants: variants.map(variant => variant.id) })),
    }, configuration.taskMode)
  }
  const execution = nativeMissionScheduleControlExecution(request, () => {
    agentCurrent()
    if (!sameLocation()) throw new Error("Mission schedule Location changed")
    for (const guard of rootGuards) guard()
    return true
  })
  execution.current()
  return { request, store, before, location, ...execution, profileSource: proof.profileSource }
})
