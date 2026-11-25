import { z } from "zod"
import { canonicalAuthority } from "../../missions/authority-protocol"
import type { MissionPrepareRequest } from "../../missions/control-types"
import { missionPreparationSource } from "../../missions/coordinator-actions"
import { parseMissionCreationDefaults } from "../../missions/creation-defaults"
import { missionConfigurationSchema, requiresMissionCalendar, type MissionCriteriaLaunchPolicy } from "../../missions/launch-policy"
import type { MissionSnapshot } from "../../missions/model"
import { missionPreparationCreation, missionPreparationCreationSchema } from "../../missions/preparation-input"
import { automaticMissionStartID, type PreparationResult } from "../../missions/preparation-result"
import { missionScheduleID, missionSchedulePayloadDigest, missionScheduleRefusalSchema } from "../../missions/mission-schedule-contract"
import type { MissionScheduleRead } from "../../missions/mission-schedule-view"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { truncateMissionText } from "../../missions/truncate-text"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import type { NativeScheduleSettingsActivation } from "../../opencode/native-schedule-settings-activation"
import { PluginControlsError } from "../../opencode/plugin-controls"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { missionCreationDigest } from "./mission-creation-holds"
import { prepareMissionMapMutation } from "./mission-map-mutation"
import { readRecurrenceHoldOwner } from "./mission-recurrence-holds"
import { missionScheduleActivationJournal } from "./mission-schedule-activation-journal"
import { missionScheduleActivationRefusal } from "./mission-schedule-activation-refusal"
import { scheduledMissionProfileSource, type ScheduledMissionManager, type ScheduledMissionSettings } from "./mission-scheduled-admission"
import { holdScheduledMission, scheduledMissionCreationHold, scheduledMissionHold, type ScheduledHoldBinding } from "./mission-scheduled-holds"

type Input = MissionPrepareRequest & { missionID?: string; observeOnly?: true; launch?: MissionCriteriaLaunchPolicy;
  watchedConversationIDs?: string[]; coordinatorSessionID?: string }
export type ScheduledPreparationDeps = {
  settings?: ScheduledMissionSettings; bridgeToken?: string
  scheduleSettingsActivation?: Pick<NativeScheduleSettingsActivation, "prepare" | "apply" | "verify">
}
type Hold = ReturnType<typeof holdScheduledMission>
const receipt = z.object({ pending: z.boolean(), acknowledgement: z.enum(["fresh", "recovered"]).optional(),
  refusal: missionScheduleRefusalSchema.optional(), document: z.object({
    id: z.string(), revision: z.number().int().nonnegative(), state: z.string(),
    creation: missionPreparationCreationSchema.optional(),
    control: z.object({ requestID: z.string(), expectedRevision: z.number(), action: z.string(), pending: z.boolean() }).nullable(),
  }).passthrough().nullable(),
}).passthrough()

/** The agent principal authorizes only paused creation and its exact fresh first
 * Play. Recovery observes original receipts; it never dispatches a control. */
export async function prepareScheduledCoordinatorMission(args: {
  manager: ScheduledMissionManager; fence: WorktreeDeletionFence; workspaceID: string
  authorSessionID: string; input: Input; signal: AbortSignal
} & ScheduledPreparationDeps): Promise<PreparationResult> {
  const { manager, fence, workspaceID, authorSessionID, input, signal, settings, bridgeToken } = args
  const previousHold = scheduledMissionCreationHold(fence, workspaceID, input.requestID)
  let missionID = previousHold?.binding.missionID ?? "", requestID = input.requestID, phase: "creation" | "activation" | "start" = "creation"
  let target: Extract<NonNullable<PreparationResult["target"]>, { kind: "schedule" }> | undefined
  let held: Hold | undefined, ownsHold = false, dispatched = false
  const uncertain = (): PreparationResult => ({ outcome: "uncertain", phase, requestID, missionID, ...(target ? { target } : {}) })
  const refused = (code: string): PreparationResult => previousHold && scheduledMissionHold(fence, previousHold.binding.missionID) === previousHold
    ? uncertain() : ({ outcome: "refused", phase, code, ...(target ? { target } : {}) })
  try {
    signal.throwIfAborted()
    if (!settings?.configYamlPathForAuthority || !bridgeToken || !input.launch || !requiresMissionCalendar(input.launch)
      || input.taskMode === undefined) return refused("prepare-refused")
    const scope = settings.getProfileScope(), yaml = settings.configYamlPathForAuthority()
    const distro = manager.getServiceWslDistro(workspaceID), executionHost = distro ? `wsl:${distro}` : "local"
    const profile = canonicalAuthority(scope ?? null)
    if (!scope || !yaml) return refused("prepare-refused")
    const connection = await manager.getSharedServiceConnection(workspaceID)
    if (!connection) return refused("prepare-refused")
    const client = connection.client
    const author = await client.session.get({ sessionID: authorSessionID }, { signal })
    if (author.id !== authorSessionID || !await manager.ownsLocation(workspaceID, author.location, client, { signal }))
      return refused("prepare-refused")
    const location = { directory: author.location.directory }, options = { location, ...locationRequestOptions(location), signal }
    const rpc = client.rpc(CODENOMAD_MISSIONS_RPC)
    const check = () => {
      signal.throwIfAborted(); connection.assertCurrent()
      if (canonicalAuthority(settings.getProfileScope() ?? null) !== profile
        || settings.configYamlPathForAuthority!() !== yaml || manager.getServiceWslDistro(workspaceID) !== distro)
        throw new Error("Mission schedule profile changed")
    }
    const assertAuthor = async () => {
      check()
      const fresh = await client.session.get({ sessionID: authorSessionID }, { signal })
      const snapshot = await rpc.snapshot({}, options) as MissionSnapshot
      const source = await missionPreparationSource(snapshot, fresh, id => client.session.get({ sessionID: id }, { signal }))
      check()
      if (fresh.id !== authorSessionID || fresh.projectID !== author.projectID || !sameLocation(fresh.location, location)
        || !input.observeOnly && source?.id !== input.missionID
        || !await manager.ownsLocation(workspaceID, fresh.location, client, { signal }))
        throw new Error("Mission schedule author changed")
      check()
    }
    await assertAuthor()
    const configuration = missionConfigurationSchema.parse({
      title: input.title ?? truncateMissionText(input.objective.trim().replace(/\s+/g, " "), 60), objective: input.objective,
      ...(input.notes === undefined ? {} : { notes: input.notes }), template: input.template,
      profiles: input.profiles, taskMode: input.taskMode, launch: input.launch,
      watchedConversationIDs: [...input.watchedConversationIDs ?? []].sort(),
      ...(input.coordinatorSessionID ? { coordinatorSessionID: input.coordinatorSessionID } : {}),
      profileID: scope.key, executionHost, roots: [{ mode: "directory-only", directory: location.directory }],
    })
    const creationDefaults = input.creationDefaults === undefined ? undefined : parseMissionCreationDefaults(input.template, input.creationDefaults)
    const authorIdentity = { coordinatorSessionID: authorSessionID, ...(input.missionID ? { missionID: input.missionID } : {}) }
    const creation = missionPreparationCreation({ ...input, creationDefaults }, authorIdentity, input.requestID)
    const creationPayload = { configuration, creation }
    const payloadDigest = missionSchedulePayloadDigest(creationPayload)
    const digest = missionCreationDigest([input.requestID, 0, "create", payloadDigest])
    const recovered = async (raw: unknown): Promise<PreparationResult> => {
      const result = receipt.parse(raw), doc = result.document
      if (!doc || doc.id !== missionID || !doc.creation) return uncertain()
      if (doc.creation.requestID !== input.requestID || doc.creation.digest !== creation.digest
        || canonicalAuthority(doc.creation.author) !== canonicalAuthority(authorIdentity)) return refused("prepare-conflict")
      target = { kind: "schedule", document: result as unknown as MissionScheduleRead }
      if (doc.creation.automaticStart?.attempted) {
        requestID = doc.creation.automaticStart.requestID; phase = "start"
        const play = doc.control?.requestID === requestID ? result
          : receipt.parse(await rpc.scheduleRead({ missionID, requestID }, options))
        await assertAuthor()
        target = { kind: "schedule", document: play as unknown as MissionScheduleRead }
        if (play.document?.id === missionID && play.document.control?.requestID === requestID
          && play.document.control.action === "play" && play.document.control.pending === false && !play.pending)
          return { outcome: "activated", acknowledgement: "recovered", target }
        return uncertain()
      }
      return { outcome: "prepared", acknowledgement: "recovered", target }
    }
    const owner = await readRecurrenceHoldOwner(manager, workspaceID, manager.get(workspaceID)!, location.directory, client, signal)
    check()
    if (!owner || owner.projectID !== author.projectID) return refused("prepare-refused")
    missionID = missionScheduleID(owner.projectID, owner.projectCanonical, input.requestID)
    held = scheduledMissionHold(fence, missionID)
    if (held) {
      const play = held.binding.action === "play" && input.startOnCreation === true
        && held.binding.requestID === automaticMissionStartID(input.requestID)
      if (play) { requestID = held.binding.requestID; phase = "start" }
      if (held.busy || !play && (held.binding.action !== "create" || held.binding.requestID !== input.requestID || held.binding.digest !== digest))
        return uncertain()
      const base = manager.getServiceLocation(workspaceID)
      if (!base) return uncertain()
      const binding = { ...held.binding, owner, connection, location, base, profile, configYamlPath: yaml, executionHost }
      held.assertBound(binding)
      const observed = receipt.parse(await rpc.scheduleRead({ missionID, requestID }, options))
      await assertAuthor()
      if (!held.settle(binding, observed)) return uncertain()
      return recovered(observed)
    }
    const owned = await prepareMissionMapMutation({ manager, fence, workspaceID, directory: location.directory, signal })
    return await owned.run(async (native, nativeOptions) => {
      if (owned.connection !== connection) return refused("prepare-refused")
      if (input.observeOnly) {
        const observed = await native.scheduleRead({ missionID, requestID: input.requestID }, { ...nativeOptions, signal })
        await owned.refresh(); await assertAuthor()
        return recovered(observed)
      }
      const capabilities = await native.documentCapabilities({}, { ...nativeOptions, signal }) as {
        version?: number; automaticStart?: boolean; agentSchedulePreparation?: boolean }
      await owned.refresh(); await assertAuthor()
      if (capabilities.version !== 1 || capabilities.automaticStart !== true || capabilities.agentSchedulePreparation !== true)
        return refused("prepare-refused")
      // Before first dispatch, absence is a document read; an absent exact receipt
      // stays uncertain only on the held/observation-only recovery paths above.
      const previous = receipt.parse(await native.scheduleRead({ missionID }, { ...nativeOptions, signal }))
      await owned.refresh(); await assertAuthor()
      if (previous.document) return recovered(previous)
      if (previous.pending) return uncertain()
      const send = async () => {
        const action = "create" as const, expectedRevision = 0
        await owned.refresh(); await assertAuthor()
        const freshOwner = await readRecurrenceHoldOwner(manager, workspaceID, owned.workspace, location.directory, client, signal)
        check()
        if (!freshOwner || freshOwner.workspace !== owner.workspace || freshOwner.projectID !== owner.projectID
          || freshOwner.projectCanonical !== owner.projectCanonical || freshOwner.checkout !== owner.checkout)
          throw new Error("Mission schedule physical owner changed")
        const profileSource = await scheduledMissionProfileSource({ manager, settings, workspaceID, owned, owner: freshOwner,
          scope, yaml, executionHost, check })
        const payload = creationPayload
        const binding: ScheduledHoldBinding = { missionID, workspaceID, requestID, action, expectedRevision,
          digest: missionCreationDigest([requestID, expectedRevision, action, missionSchedulePayloadDigest(payload)]),
          owner: freshOwner, connection, location, base: owned.base, profile, configYamlPath: yaml, executionHost }
        owned.retain(release => { held = holdScheduledMission(fence, binding, release); ownsHold = true })
        await owned.refresh(); await assertAuthor()
        const principal = { kind: "agent" as const, author: authorIdentity,
          creationRequestID: input.requestID, creationDigest: creation.digest }
        const identity = { principal, workspaceID, requestID, location: nativeOptions.location,
          scheduleID: missionID, action, expectedRevision, profileSource, issuedAt: Date.now(),
          ...(action === "create" ? { configDigest: payloadDigest } : {}) }
        const proof = { ...identity, digest: recurrenceControlRequestDigest(identity) }
        held!.dispatch(); dispatched = true
        const result = receipt.parse(await native.scheduleControl({ missionID, requestID, expectedRevision, action, ...payload,
          transport: { ...proof, proof: signNativeRecurrenceControl(proof, bridgeToken) } }, nativeOptions))
        await owned.refresh(); check()
        if (result.refusal && held!.refuse(binding, result)) return { result, complete: false, refused: result.refusal.reason }
        const complete = held!.settle(binding, result)
        return { result, complete }
      }
      const created = await send()
      if (created.refused) return refused(created.refused)
      if (!created.complete) return uncertain()
      target = { kind: "schedule", document: created.result as unknown as MissionScheduleRead }
      if (created.result.acknowledgement !== "fresh") return recovered(created.result)
      const document = created.result.document
      if (!document || document.creation?.requestID !== input.requestID || document.creation.digest !== creation.digest
        || canonicalAuthority(document.creation.author) !== canonicalAuthority(authorIdentity)) return uncertain()
      if (!input.startOnCreation) return { outcome: "prepared", acknowledgement: "fresh", target }
      // The Create permit is released by its exact ACK. Activation and Play own
      // a new ordinary admission; a captured fresh ACK alone reaches this branch.
      phase = "activation"; requestID = automaticMissionStartID(input.requestID)
      return activateAndPlay()
    })

    async function activateAndPlay(): Promise<PreparationResult> {
      const activation = args.scheduleSettingsActivation
      if (!activation || !target?.document.document) return refused("schedule-activation-unavailable")
      const mutation = await prepareMissionMapMutation({ manager, fence, workspaceID, directory: location.directory, signal })
      return mutation.run(async (native, nativeOptions) => {
        if (mutation.connection !== connection) return refused("schedule-activation-unavailable")
        const guarded = { documentActivation: async (...params: Parameters<typeof native.documentActivation>) => {
          await mutation.refresh(); await assertAuthor()
          return native.documentActivation(...params)
        } }
        const revision = target!.document.document!.revision
        const adapter = missionScheduleActivationJournal(guarded, nativeOptions, { missionID, requestID, expectedRevision: revision }, check)
        const before = await adapter.read()
        if (before.revision !== revision || before.state !== "paused") return refused("schedule-activation-conflict")
        try {
          if (before.scheduleActivation) return refused("schedule-activation-conflict")
          const plan = await activation.prepare(workspaceID, location)
          await mutation.refresh(); await assertAuthor()
          await activation.apply(workspaceID, location, plan, adapter.journal)
          const after = await adapter.read()
          if (after.scheduleActivation?.state !== "ready" || after.scheduleActivation.requestID !== requestID) return uncertain()
          await activation.verify(workspaceID, location, after.scheduleActivation.authority)
          await mutation.refresh(); await assertAuthor()
          phase = "start"
          const freshOwner = await readRecurrenceHoldOwner(manager, workspaceID, mutation.workspace, location.directory, client, signal)
          check()
          if (!freshOwner) return refused("prepare-refused")
          const profileSource = await scheduledMissionProfileSource({ manager, settings: settings!, workspaceID, owned: mutation, owner: freshOwner,
            scope: scope!, yaml: yaml!, executionHost, check })
          const binding: ScheduledHoldBinding = { missionID, workspaceID, requestID, action: "play", expectedRevision: after.revision,
            digest: missionCreationDigest([requestID, after.revision, "play", missionSchedulePayloadDigest({})]),
            owner: freshOwner, connection, location, base: mutation.base, profile, configYamlPath: yaml!, executionHost }
          mutation.retain(release => { held = holdScheduledMission(fence, binding, release); ownsHold = true })
          await mutation.refresh(); await assertAuthor()
          const identity = { principal: { kind: "agent" as const, author: authorIdentity,
            creationRequestID: input.requestID, creationDigest: creation.digest }, workspaceID, requestID,
            location: nativeOptions.location, scheduleID: missionID, action: "play" as const, expectedRevision: after.revision,
            profileSource, issuedAt: Date.now() }
          const proof = { ...identity, digest: recurrenceControlRequestDigest(identity) }
          held!.dispatch(); dispatched = true
          const result = receipt.parse(await native.scheduleControl({ missionID, requestID, action: "play", expectedRevision: after.revision,
            transport: { ...proof, proof: signNativeRecurrenceControl(proof, bridgeToken!) } }, nativeOptions))
          await mutation.refresh(); check()
          if (result.refusal && held!.refuse(binding, result)) return refused(result.refusal.reason)
          if (!held!.settle(binding, result)) return uncertain()
          target = { kind: "schedule", document: result as unknown as MissionScheduleRead }
          return { outcome: "activated", acknowledgement: "fresh", target }
        } catch (error) {
          if (phase === "activation") {
            const rejection = missionScheduleActivationRefusal(error)
            if (rejection) return refused("schedule-activation-refused")
            await adapter.failed(error instanceof PluginControlsError ? `configuration-${error.kind}` : "configuration-unconfirmed").catch(() => undefined)
          }
          return uncertain()
        }
      })
    }
  } catch {
    return dispatched || held || previousHold ? uncertain() : refused("prepare-refused")
  } finally { if (ownsHold) held?.dispose() }
}
