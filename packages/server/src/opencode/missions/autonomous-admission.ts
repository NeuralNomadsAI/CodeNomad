import { isDeepStrictEqual } from "node:util"
import type { Plugin } from "@opencode/plugin"
import { authorityBindingSchema, assertAuthorityScope, canonicalAuthority, rejectAuthority,
  type AuthorityBinding } from "../../missions/authority-protocol"
import type { MissionJournal } from "../../missions/journal"
import type { NativeMissionAuthority } from "../../missions/authority-core"
import { matchesExecution } from "../../missions/execution"
import { sameLocation } from "../compatibility/location"
import { reconstructAutonomousMissionCommand } from "./autonomous-contract"
import { readAutonomousMissionEnvironment, type AutonomousProfileSource } from "./autonomous-environment"
import type { AuthorityRoot } from "../../missions/authority-protocol"
import type { MissionNativeService } from "./native-service-adapter"
import type { NativeMissionSession } from "../../missions/control-types"
import { assertSynchronousAuthorityGuard } from "../../missions/authority-synchronous"

type NativeContext = Parameters<Plugin.Plugin["setup"]>[0]
export type AutonomousMissionReadContext = Pick<NativeContext, "location"> & {
  session: { get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<NativeMissionSession> }
}

/** Private preparation, not admission evidence. Actual native call-entry fences
 * below have the same boundary as existing backend sends: no invented native
 * commit-closure API. External moves after call entry remain a native API race. */
export async function prepareAutonomousMissionAdmission(input: {
  context: AutonomousMissionReadContext; journal: Pick<MissionJournal, "snapshot">;
  authority: NativeMissionAuthority;
  scope: AuthorityBinding; profile: AutonomousProfileSource; command: unknown; signal: AbortSignal
  executionHost?: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
}) {
  input.signal.throwIfAborted()
  canonicalAuthority(input.scope)
  const scope = authorityBindingSchema.parse(input.scope)
  assertAuthorityScope(scope, scope)
  const location = structuredClone(input.context.location)
  const profile = structuredClone(input.profile)
  // Never turn projectID alone, or a different loaded Location, into ownership.
  if (location.workspaceID !== undefined || location.project.id !== scope.projectID
    || location.project.canonical !== scope.projectCanonical
    || !scope.roots.some(root => root.directory === location.directory)) rejectAuthority("binding-mismatch")
  const raw = JSON.parse(canonicalAuthority(input.command, 512 * 1024)) as unknown
  const first = reconstructAutonomousMissionCommand(await input.journal.snapshot(), scope, raw)
  const sessionIDs = [...new Set([scope.coordinatorSessionID, first.command.input.sessionID])]
  const readActors = async () => {
    input.signal.throwIfAborted()
    if (!isDeepStrictEqual(structuredClone(input.context.location), location)) rejectAuthority("binding-mismatch")
    return Promise.all(sessionIDs.map(async sessionID => {
      const session = await input.context.session.get({ sessionID }, { signal: input.signal })
      input.signal.throwIfAborted()
      const recorded = first.mission.actors.find(actor => actor.sessionId === sessionID)
      if (session.id !== sessionID || session.parentID || session.projectID !== scope.projectID || !recorded
        || !sameLocation(session.location, recorded.location) || "workspaceID" in session.location
        || !scope.roots.some(root => root.directory === session.location.directory)) rejectAuthority("binding-mismatch")
      if (sessionID === first.command.input.sessionID && first.command.kind === "prompt"
        && !matchesExecution(first.execution, session)) rejectAuthority("binding-mismatch")
      return { sessionID, projectID: session.projectID, location: structuredClone(session.location),
        ...(session.agent === undefined ? {} : { agent: session.agent }),
        ...(session.model === undefined ? {} : { model: structuredClone(session.model) }) }
    }))
  }
  const actors = await readActors()
  const state = await input.authority.state(scope.missionID)
  if (!state.grant || state.terminal || state.pendingRequestIDs.length) rejectAuthority("authorization-blocked")
  const epoch = state.grant.epoch
  const checkGrant = async () => {
    for (const directory of new Set(actors.map(actor => actor.location.directory))) {
      const root = scope.roots.find(root => root.directory === directory)
      if (!root) rejectAuthority("binding-mismatch")
      const grant = await input.authority.assertAdmission({ ...scope, epoch, root })
      if (!isDeepStrictEqual(grant, state.grant)) rejectAuthority("observation-unavailable")
    }
    input.signal.throwIfAborted()
  }
  await checkGrant()
  const variables = await readAutonomousMissionEnvironment(scope, profile, input.signal, input.executionHost)
  const fresh = reconstructAutonomousMissionCommand(await input.journal.snapshot(), scope, raw)
  const latestActors = await readActors()
  input.signal.throwIfAborted()
  if (!isDeepStrictEqual(first.mission, fresh.mission) || !isDeepStrictEqual(actors, latestActors)
    || !isDeepStrictEqual(structuredClone(input.context.location), location)) {
    rejectAuthority("observation-unavailable")
  }
  await checkGrant()
  return { kind: "prepared" as const, scope, command: fresh.command, missionRevision: fresh.mission.revision,
    grant: structuredClone(state.grant), actors: latestActors, variables }
}

/** Native daemon-local execution, without CodeNomad HTTP. Construction receives
 * existing protected owner/signer and mutation exclusion; none comes from RPC.
 * Caller reserves its stable journal/passage identity BEFORE invoking this. No
 * retry, no uncertain-effect replay, no configuration or permission mutation. */
export async function admitAutonomousMissionInput(input: Parameters<typeof prepareAutonomousMissionAdmission>[0] & {
  native: MissionNativeService
  assertCurrent(): true
  withGate<T>(operation: () => Promise<T>): Promise<T>
  resolveRoot(location: { directory: string }): Promise<AuthorityRoot>
}) {
  return input.withGate(async () => {
    const current = () => { input.signal.throwIfAborted(); input.native.assertCurrent(); return assertSynchronousAuthorityGuard(input.assertCurrent, "policy-unqualified") }
    current()
    const prepared = await prepareAutonomousMissionAdmission(input)
    // Explicit recovery belongs to the signed human effect reservation path,
    // never an ordinary continuity grant or automatic dispatch retry.
    if (prepared.command.input.metadata["codenomad.mission"].kind === "recovery") rejectAuthority("unsigned-privileged-method")
    const check = async () => {
      current()
      const fresh = reconstructAutonomousMissionCommand(await input.journal.snapshot(), prepared.scope, prepared.command)
      if (fresh.mission.revision !== prepared.missionRevision) rejectAuthority("revision-conflict")
      for (const actor of prepared.actors) {
        const actual = await input.native.get({ sessionID: actor.sessionID }, { signal: input.signal })
        if (actual.id !== actor.sessionID || actual.parentID || actual.projectID !== actor.projectID
          || !sameLocation(actual.location, actor.location)
          || !matchesExecution(actor, actual)) rejectAuthority("binding-mismatch")
        const root = await input.resolveRoot(actual.location)
        if (!prepared.scope.roots.some(item => isDeepStrictEqual(item, root))) rejectAuthority("binding-mismatch")
        const grant = await input.authority.assertAdmission({ ...prepared.scope, epoch: prepared.grant.epoch, root })
        if (!isDeepStrictEqual(grant, prepared.grant)) rejectAuthority("authorization-blocked")
        current()
      }
    }
    await check()
    await input.native.environment({ sessionID: prepared.command.input.sessionID, variables: { ...prepared.variables } },
      { signal: input.signal }, current)
    await check()
    current()
    const receipt = await input.native.admit(prepared.command, { signal: input.signal }, current)
    // ACK is admission only, never model consumption. Never discard an ACK on a
    // late lifecycle change and then replay the potentially admitted input.
    return { admitted: true as const, admissionID: receipt.id, sessionID: receipt.sessionID }
  })
}
