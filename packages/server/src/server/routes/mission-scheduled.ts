import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { missionConfigurationSchema, requiresMissionCalendar } from "../../missions/launch-policy"
import { missionScheduleActions, missionScheduleID, missionSchedulePayloadDigest, missionScheduleRefusalSchema } from "../../missions/mission-schedule-contract"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl, type SchedulePrincipal } from "../../missions/recurrence-control-proof"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { requestAdmission } from "../request-admission"
import { prepareMissionMapMutation, MissionMapMutationError } from "./mission-map-mutation"
import { recurrenceHumanSession } from "./mission-recurrence-proof"
import { readRecurrenceHoldOwner } from "./mission-recurrence-holds"
import { missionCreationDigest } from "./mission-creation-holds"
import { holdScheduledMission, scheduledMissionHold, scheduledMissionCreationHold, exactScheduledRefusal, ScheduledHoldError,
  recordUndispatchedCheck, readUndispatchedCheck, type ScheduledHoldBinding } from "./mission-scheduled-holds"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import type { SettingsService } from "../../settings/service"
import type { AuthManager } from "../../auth/manager"
import type { RemoteControlManager } from "../../remote-control/manager"
import { scheduledMissionProfileSource } from "./mission-scheduled-admission"

export type ScheduledMissionDeps = {
  workspaceManager: Pick<WorkspaceManager, "get" | "getServiceLocation" | "getSharedServiceConnection" | "ownsLocation"
    | "getServiceDirectoryForPath" | "getWorktreeIdentityForPath" | "getHostPathForServicePath" | "getServiceWslDistro">
    & Partial<Pick<WorkspaceManager, "getServicePathStyle">>
  settings?: Pick<SettingsService, "getProfileScope"> & Partial<Pick<SettingsService, "configYamlPathForAuthority">>
  auth?: Pick<AuthManager, "isAuthEnabled" | "getSessionFromRequest">; bridgeToken?: string
  remoteDevices?: Pick<RemoteControlManager, "isDeviceAuthorized">; worktreeDeletionFence?: WorktreeDeletionFence
}
type Owned = Awaited<ReturnType<typeof prepareMissionMapMutation>>
type Scope = Pick<Owned, "client" | "connection" | "workspace" | "base" | "location" | "current" | "refresh">
type Hold = ReturnType<typeof holdScheduledMission>
const rpcFor = (client: Owned["client"]) => client.rpc(CODENOMAD_MISSIONS_RPC)
type Rpc = ReturnType<typeof rpcFor>
type Options = { location: { directory: string }; signal?: AbortSignal; headers?: Record<string, string> }
const id = z.string().regex(/^[A-Za-z0-9_-]{3,100}$/)
const directory = z.string().min(1).max(4096).refine(value => !value.includes("\0"))
const params = z.object({ id: z.string().min(1).max(200), missionID: id.optional(), requestID: id.optional() }).strict()
const scheduleUserConfiguration = z.object(missionConfigurationSchema.shape).strict().omit({
  roots: true, profileID: true, executionHost: true, coordinatorSelectionAuthor: true,
})
const body = z.object({ requestID: id, expectedRevision: z.number().int().nonnegative().safe(), action: z.enum(missionScheduleActions),
  configuration: scheduleUserConfiguration.optional(), deleteManagedSessions: z.boolean().optional(), retry: z.boolean().optional(), directory: directory.optional(),
}).strict().refine(value => ["create", "configure"].includes(value.action) === !!value.configuration
  && (value.deleteManagedSessions === undefined || value.action === "delete") && (value.action !== "create" || value.expectedRevision === 0)
  && !(value.action === "create" && value.configuration && !requiresMissionCalendar(value.configuration.launch)))
const deletionReceiptSchema = z.object({ id, requestID: id, expectedRevision: z.number().int().nonnegative().safe(),
  deleteManagedSessions: z.boolean() }).strict()
const checkReceiptSchema = z.object({ id, requestID: id, expectedRevision: z.number().int().nonnegative().safe(),
  action: z.literal("check") }).strict()
const resultSchema = z.object({ pending: z.boolean(), deleted: z.boolean().optional(), refusal: missionScheduleRefusalSchema.optional(),
  deletionReceipt: deletionReceiptSchema.optional(), checkReceipt: checkReceiptSchema.optional(), document: z.object({ id,
  control: z.object({ requestID: id, expectedRevision: z.number().int().nonnegative().safe(), action: z.enum([...missionScheduleActions, "reconcile"]), pending: z.boolean() }).strict().nullable(),
}).passthrough().nullable() }).passthrough()

/** Physical permits survive unknown native outcomes. Exact completed receipts or
 * proven initial pre-write refusals settle them; reads never retry or arm work. */
export function registerMissionScheduled(app: FastifyInstance, deps: ScheduledMissionDeps) {
  for (const method of ["GET", "POST"] as const) for (const creating of [false, true]) {
    app.route({ method, url: creating ? method === "POST" ? "/api/workspaces/:id/missions/scheduled"
      : "/api/workspaces/:id/missions/scheduled/requests/:requestID" : "/api/workspaces/:id/missions/:missionID/schedule",
      handler: async (request, reply) => {
        const selected = params.safeParse(request.params), input = method === "POST" ? body.safeParse(request.body) : undefined
        const query = z.object({ directory: directory.optional(), requestID: id.optional() }).strict().safeParse(request.query)
        if (!selected.success || !query.success || method === "POST" && (!input?.success || creating !== (input.data.action === "create")))
          return reply.code(400).send({ error: "Invalid Mission schedule request", code: "schedule-input-invalid" })
        const lifetime = requestAdmission(request, reply)
        const auth = deps.auth, human = auth && recurrenceHumanSession(request, { auth, remoteDevices: deps.remoteDevices })
        try {
          const result = await executeScheduledMission(deps, { selected: selected.data, query: query.data,
            value: input?.success ? input.data : undefined, method, creating, lifetime,
            principal: human && { kind: "human", sessionID: human.sessionId },
            currentPrincipal: () => {
              if (human && recurrenceHumanSession(request, { auth: auth!, remoteDevices: deps.remoteDevices })?.sessionId !== human.sessionId)
                throw new Error("Mission schedule principal changed")
            } })
          return reply.code(result.status).send(result.body)
        } finally { lifetime.dispose() }
      },
    })
  }
}

/** Shared human/agent business admission. Only the private bridge supplies an agent principal. */
export async function executeScheduledMission(deps: ScheduledMissionDeps, args: {
  selected: z.infer<typeof params>; query: { directory?: string; requestID?: string }
  value?: z.infer<typeof body>; method: "GET" | "POST"; creating: boolean
  lifetime: Pick<ReturnType<typeof requestAdmission>, "signal" | "wait">
  principal?: SchedulePrincipal; currentPrincipal(): void; checkPrincipal?(): Promise<void>
}): Promise<{ status: number; body: unknown }> {
        const { method, creating, lifetime, principal, value } = args
        const selected = { data: args.selected }, query = { data: args.query }
        let status = 200
        const reply = { code(value: number) { status = value; return this }, send(body: unknown) { return { status, body } } }
        let missionID = selected.data.missionID, held: Hold | undefined, ownsHold = false
        const pending = (result: object = {}) => reply.code(503).send({ ...result, missionID, pending: true,
          error: "Mission schedule action remains unconfirmed", code: "schedule-pending" })
        const busyNoDispatch = (attempt: { requestID: string; expectedRevision: number; action: string }) => reply.code(409).send({
          missionID, pending: true, dispatched: false, requestID: attempt.requestID, expectedRevision: attempt.expectedRevision,
          action: attempt.action, error: "Mission schedule request remains held", code: "schedule-busy",
        })
        try {
          args.currentPrincipal(); await args.checkPrincipal?.()
          if (method === "POST" && (!principal || !deps.bridgeToken || !deps.settings?.configYamlPathForAuthority))
            return reply.code(401).send({ error: "Human authentication required", code: "schedule-human-required" })
          const settings = deps.settings, manager = deps.workspaceManager, scope = settings?.getProfileScope()
          const distro = manager.getServiceWslDistro(selected.data.id), executionHost = distro ? `wsl:${distro}` : "local"
          const profile = canonicalAuthority(scope ?? null), yaml = settings?.configYamlPathForAuthority?.()
          if (value?.configuration && scope) {
            const base = manager.getServiceLocation(selected.data.id)
            if (base && !missionConfigurationSchema.safeParse({ ...value.configuration, profileID: scope.key, executionHost,
              roots: [{ mode: "directory-only", directory: base.directory }] }).success)
              return reply.code(400).send({ error: "Invalid Mission schedule configuration", code: "schedule-input-invalid" })
          }
          const creationRequestID = creating ? value?.requestID ?? selected.data.requestID! : undefined
          if (creating && query.data.requestID && query.data.requestID !== creationRequestID)
            throw new ScheduledHoldError(409, "Exact creation request required")
          const existing = creating ? scheduledMissionCreationHold(deps.worktreeDeletionFence, selected.data.id, creationRequestID!)
            : scheduledMissionHold(deps.worktreeDeletionFence, missionID!)
          const check = (owned: Scope) => {
            owned.current(); lifetime.signal.throwIfAborted()
            args.currentPrincipal()
            if (canonicalAuthority(settings?.getProfileScope() ?? null) !== profile
              || settings?.configYamlPathForAuthority?.() !== yaml || manager.getServiceWslDistro(selected.data.id) !== distro)
              throw new Error("Mission schedule principal changed")
          }
          const configurationFor = (location: { directory: string }) => value?.configuration && missionConfigurationSchema.parse({ ...value.configuration,
            ...(principal?.kind === "agent" ? { coordinatorSelectionAuthor: { coordinatorSessionID: principal.author.coordinatorSessionID } } : {}),
            profileID: scope!.key, executionHost, roots: [{ mode: "directory-only", directory: location.directory }] })
          const digestFor = (configuration: ReturnType<typeof configurationFor>) => missionCreationDigest([
            value!.requestID, value!.expectedRevision, value!.action, missionSchedulePayloadDigest({ configuration, deleteManagedSessions: value!.deleteManagedSessions }),
          ])
          const effect = async (owned: Scope, rpc: Rpc, options: Options, retain?: Owned["retain"]) => {
            check(owned)
            await args.checkPrincipal?.()
            if (!value || !principal || !deps.bridgeToken || !settings?.configYamlPathForAuthority || !scope || !yaml || !deps.worktreeDeletionFence)
              throw new Error("Mission schedule admission unavailable")
            const owner = await readRecurrenceHoldOwner(manager, selected.data.id, owned.workspace, owned.location.directory, owned.client, lifetime.signal)
            check(owned)
            if (!owner) throw new Error("Mission schedule physical owner unavailable")
            missionID ??= missionScheduleID(owner.projectID, owner.projectCanonical, value.requestID)
            const configuration = configurationFor(owned.location)
            const checking = !!held && value.action === "check" && value.requestID !== held.binding.requestID
            const requested: ScheduledHoldBinding = { missionID, workspaceID: selected.data.id, requestID: value.requestID,
              action: value.action, expectedRevision: value.expectedRevision, digest: digestFor(configuration), owner,
              deleteManagedSessions: value.deleteManagedSessions ?? false,
              connection: owned.connection, location: owned.location, base: owned.base, profile, configYamlPath: yaml, executionHost }
            const binding = checking ? { ...held!.binding, owner, connection: owned.connection, location: owned.location,
              base: owned.base, profile, configYamlPath: yaml, executionHost } : requested
            const profileSource = await scheduledMissionProfileSource({ manager, settings, workspaceID: selected.data.id,
              owned, owner, scope, yaml, executionHost, check: () => check(owned) })
            if (!held) try {
              retain!(release => { held = holdScheduledMission(deps.worktreeDeletionFence!, binding, release); ownsHold = true })
            } catch (error) {
              if (error instanceof ScheduledHoldError && error.busyConflict) return busyNoDispatch(value)
              throw error
            }
            await owned.refresh(); check(owned); await args.checkPrincipal?.()
            const identity = { ...(principal.kind === "human" ? { sessionID: principal.sessionID } : { principal }),
              workspaceID: selected.data.id, requestID: value.requestID,
              location: options.location, scheduleID: missionID, action: value.action, expectedRevision: value.expectedRevision,
              profileSource, issuedAt: Date.now(), ...(["create", "configure", "delete"].includes(value.action)
                ? { configDigest: missionSchedulePayloadDigest({ configuration, deleteManagedSessions: value.deleteManagedSessions }) } : {}) }
            const proof = { ...identity, digest: recurrenceControlRequestDigest(identity) }
            if (held!.preparing) held!.dispatch()
            else {
              if (held!.connection !== owned.connection) retain!(release => { held!.retry(binding, retryReceipt, release) })
              else held!.retry(binding, retryReceipt)
              ownsHold = true
            }
            if (checking) held!.trackCheck(value.requestID)
            const { signal: _observerSignal, ...nativeOptions } = options
            const raw = await rpc.scheduleControl({ missionID, requestID: value.requestID, expectedRevision: value.expectedRevision,
              action: value.action, ...(configuration ? { configuration } : {}),
              ...(value.deleteManagedSessions === undefined ? {} : { deleteManagedSessions: value.deleteManagedSessions }),
              ...(value.retry ? { retry: true } : {}), transport: { ...proof, proof: signNativeRecurrenceControl(proof, deps.bridgeToken) } }, nativeOptions)
            await owned.refresh(); check(owned)
            const checkResult = resultSchema.parse(raw)
            if (checkResult.refusal) {
              if (exactScheduledRefusal(requested, checkResult) && (checking || !value.retry && held!.refuse(binding, checkResult)))
                return reply.code(409).send({ ...checkResult, missionID, error: "Mission schedule action refused", code: "schedule-refused" })
              return pending(checkResult)
            }
            let result = checkResult
            if (checking) {
              // Check adopts/reconciles the saved intent. Its own ACK cannot
              // settle the original permit: reread that exact original receipt.
              result = resultSchema.parse(await lifetime.wait(rpc.scheduleRead({ missionID, requestID: binding.requestID }, options)))
              await owned.refresh(); check(owned)
            }
            const ownCheckProof = checking && checkResult.pending === false ? (
              checkResult.deleted === true && checkResult.document === null
                && checkResult.deletionReceipt?.id === missionID
                && checkResult.checkReceipt && checkResult.checkReceipt.id === missionID
                && checkResult.checkReceipt.requestID === value.requestID
                && checkResult.checkReceipt.expectedRevision === value.expectedRevision
                && checkResult.checkReceipt.action === "check"
                ? checkResult.checkReceipt
              : checkResult.document?.id === missionID
                && checkResult.document.control?.requestID === value.requestID
                && checkResult.document.control.expectedRevision === value.expectedRevision
                && checkResult.document.control.action === "check"
                && checkResult.document.control.pending === false
                ? { id: missionID, requestID: value.requestID, expectedRevision: value.expectedRevision, action: "check" as const }
              : undefined
            ) : undefined
            return held!.settle(binding, result)
              ? reply.send(ownCheckProof ? { ...result, checkReceipt: ownCheckProof } : result)
              : pending(result)
          }
          let retryReceipt: unknown
          if (existing) {
            held = existing; missionID = existing.binding.missionID
            if (existing.preparing && value && value.requestID !== existing.binding.requestID)
              return busyNoDispatch(value)
            if (!principal || !settings || !scope || !yaml || existing.preparing)
              return pending()
            const borrowedCheckRead = method === "GET" && !!query.data.requestID && existing.hasCheck(query.data.requestID)
            const borrowedCheckPost = method === "POST" && value?.action === "check" && value.requestID !== existing.binding.requestID
            if (query.data.requestID && query.data.requestID !== existing.binding.requestID && !borrowedCheckRead
              && !(method === "POST" && value && query.data.requestID === value.requestID))
              throw new ScheduledHoldError(409, "Exact held Mission request required")
            const workspace = manager.get(selected.data.id), base = manager.getServiceLocation(selected.data.id)
            const connection = await lifetime.wait(manager.getSharedServiceConnection(selected.data.id))
            if (!workspace || !base || !connection) throw new Error("Mission schedule owner unavailable")
            const location = existing.binding.location, client = connection.client
            if ((value?.directory ?? query.data.directory) !== undefined
              && await manager.getServiceDirectoryForPath(selected.data.id, value?.directory ?? query.data.directory!) !== location.directory)
              throw new ScheduledHoldError(409, "Held Mission directory differs")
            const owned: Scope = { workspace, base, connection, client, location,
              current: () => {
                lifetime.signal.throwIfAborted(); connection.assertCurrent()
                if (manager.get(selected.data.id) !== workspace || !sameLocation(manager.getServiceLocation(selected.data.id) ?? { directory: "" }, base))
                  throw new Error("Mission schedule read changed")
              },
              refresh: async () => {
                check(owned)
                if (!await manager.ownsLocation(selected.data.id, location, client, { signal: lifetime.signal })) throw new Error("Mission schedule Location changed")
                const owner = await readRecurrenceHoldOwner(manager, selected.data.id, workspace, location.directory, client, lifetime.signal)
                check(owned)
                if (!owner) throw new Error("Mission schedule physical owner unavailable")
                existing.assertBound({ ...existing.binding, owner, connection, base, profile, configYamlPath: yaml, executionHost })
              } }
            await owned.refresh(); check(owned)
            const options = { location, ...locationRequestOptions(location), signal: lifetime.signal }, rpc = rpcFor(client)
            if (borrowedCheckRead) {
              const checkRead = resultSchema.parse(await lifetime.wait(rpc.scheduleRead({ missionID, requestID: query.data.requestID! }, options)))
              await owned.refresh(); check(owned)
              return checkRead.pending ? pending(checkRead) : reply.send(checkRead)
            }
            if (value && value.action !== "check" && (value.requestID !== existing.binding.requestID || value.action !== existing.binding.action
              || value.expectedRevision !== existing.binding.expectedRevision || digestFor(configurationFor(location)) !== existing.binding.digest))
              return busyNoDispatch(value)
            retryReceipt = resultSchema.parse(await lifetime.wait(rpc.scheduleRead({ missionID, requestID: existing.binding.requestID }, options)))
            await owned.refresh(); check(owned)
            const binding = { ...existing.binding, connection }
            if (existing.settle(binding, retryReceipt)) {
              if (borrowedCheckPost) {
                const entry = { missionID: missionID!, requestID: value!.requestID, expectedRevision: value!.expectedRevision, action: "check" as const }
                recordUndispatchedCheck(deps.worktreeDeletionFence, entry)
                return reply.send({ ...(retryReceipt as object), notDispatched: entry })
              }
              return reply.send(retryReceipt)
            }
            if (value?.action === "check" && value.requestID !== existing.binding.requestID || value?.retry && value.action !== "check") {
              if (existing.connection === connection) return await effect(owned, rpc, options)
              // A retired connection's permit remains held until a fresh physical
              // admission and the exact partial receipt authorize original-intent retry.
              const fresh = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence, workspaceID: selected.data.id,
                directory: location.directory, signal: lifetime.signal, wait: lifetime.wait })
              return await fresh.run((rpc, options) => {
                if (fresh.connection !== connection) throw new ScheduledHoldError(503, "Mission schedule connection changed after partial read")
                return effect(fresh, rpc, options, fresh.retain)
              })
            }
            return pending(retryReceipt as object)
          }
          const owned = await prepareMissionMapMutation({ manager, fence: deps.worktreeDeletionFence, workspaceID: selected.data.id,
            directory: value?.directory ?? query.data.directory, signal: lifetime.signal, wait: lifetime.wait })
          return await owned.run(async (rpc, options) => {
            if (method === "POST") return effect(owned, rpc, options, owned.retain)
            if (creating) {
              // A lost HTTP response may hide even the document ID. Derive it
              // from the acquired native owner, never a browser-local path.
              const owner = await readRecurrenceHoldOwner(manager, selected.data.id, owned.workspace, owned.location.directory, owned.client, lifetime.signal)
              check(owned)
              if (!owner) throw new Error("Mission schedule owner unavailable")
              missionID = missionScheduleID(owner.projectID, owner.projectCanonical, creationRequestID!)
            }
            const result = resultSchema.parse(await lifetime.wait(rpc.scheduleRead({ missionID: missionID!,
              ...((creationRequestID ?? query.data.requestID) ? { requestID: creationRequestID ?? query.data.requestID } : {}) }, { ...options, signal: lifetime.signal })))
            await owned.refresh(); check(owned)
            if (result.pending && !creating && query.data.requestID) {
              const skipped = readUndispatchedCheck(deps.worktreeDeletionFence, missionID!, query.data.requestID)
              if (skipped) return busyNoDispatch(skipped)
            }
            return result.pending ? pending(result) : reply.send(result)
          })
        } catch (error) {
          const status = error instanceof MissionMapMutationError || error instanceof ScheduledHoldError ? error.status : 503
          return reply.code(status).send({ missionID, pending: true, error: "Mission schedule action remains unconfirmed", code: "schedule-unconfirmed" })
        } finally { if (ownsHold) held?.dispose() }
}
