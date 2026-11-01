import path from "node:path"
import { realpath } from "node:fs/promises"
import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { missionConfigurationSchema, requiresMissionCalendar } from "../../missions/launch-policy"
import { missionScheduleActions, missionScheduleID, missionSchedulePayloadDigest, missionScheduleRefusalSchema } from "../../missions/mission-schedule-contract"
import { canonicalAuthority } from "../../missions/authority-protocol"
import { CODENOMAD_MISSIONS_RPC } from "../../missions/rpc"
import { physical } from "../../missions/physical-path"
import { recurrenceControlRequestDigest, signNativeRecurrenceControl } from "../../missions/recurrence-control-proof"
import { resolveStandingProfileSource } from "../../missions/host-authority/profile-source"
import { locationRequestOptions, sameLocation } from "../../opencode/compatibility/location"
import { requestAdmission } from "../request-admission"
import { prepareMissionMapMutation, MissionMapMutationError } from "./mission-map-mutation"
import { recurrenceHumanSession } from "./mission-recurrence-proof"
import { readRecurrenceHoldOwner } from "./mission-recurrence-holds"
import { missionCreationDigest } from "./mission-creation-holds"
import { holdScheduledMission, scheduledMissionHold, scheduledMissionCreationHold, exactScheduledRefusal, ScheduledHoldError,
  type ScheduledHoldBinding } from "./mission-scheduled-holds"
import type { registerMissionRecurrenceCreate } from "./mission-recurrence-create"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { ServiceSupervisionSettings } from "../../host-lifetime/service-supervision-service"

type Deps = Parameters<typeof registerMissionRecurrenceCreate>[1] & {
  supervision?: Pick<ServiceSupervisionSettings, "missionPlay">
  workspaceManager: Parameters<typeof registerMissionRecurrenceCreate>[1]["workspaceManager"] & Partial<Pick<WorkspaceManager, "getServicePathStyle">>
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
const userConfiguration = missionConfigurationSchema.innerType().omit({ roots: true, profileID: true, executionHost: true })
const body = z.object({ requestID: id, expectedRevision: z.number().int().nonnegative().safe(), action: z.enum(missionScheduleActions),
  configuration: userConfiguration.optional(), deleteManagedSessions: z.boolean().optional(), retry: z.boolean().optional(), directory: directory.optional(),
}).strict().refine(value => ["create", "configure"].includes(value.action) === !!value.configuration
  && (value.deleteManagedSessions === undefined || value.action === "delete") && (value.action !== "create" || value.expectedRevision === 0)
  && !(value.action === "create" && value.configuration && !requiresMissionCalendar(value.configuration.launch)))
const resultSchema = z.object({ pending: z.boolean(), deleted: z.boolean().optional(), refusal: missionScheduleRefusalSchema.optional(), document: z.object({ id,
  control: z.object({ requestID: id, expectedRevision: z.number().int().nonnegative().safe(), action: z.enum(missionScheduleActions), pending: z.boolean() }).strict().nullable(),
}).passthrough().nullable() }).passthrough()

/** Physical permits survive unknown native outcomes. Exact completed receipts or
 * proven initial pre-write refusals settle them; reads never retry or arm work. */
export function registerMissionScheduled(app: FastifyInstance, deps: Deps) {
  for (const method of ["GET", "POST"] as const) for (const creating of [false, true]) {
    app.route({ method, url: creating ? method === "POST" ? "/api/workspaces/:id/missions/scheduled"
      : "/api/workspaces/:id/missions/scheduled/requests/:requestID" : "/api/workspaces/:id/missions/:missionID/schedule",
      handler: async (request, reply) => {
        const selected = params.safeParse(request.params), input = method === "POST" ? body.safeParse(request.body) : undefined
        const query = z.object({ directory: directory.optional(), requestID: id.optional() }).strict().safeParse(request.query)
        if (!selected.success || !query.success || method === "POST" && (!input?.success || creating !== (input.data.action === "create")))
          return reply.code(400).send({ error: "Invalid Mission schedule request", code: "schedule-input-invalid" })
        const lifetime = requestAdmission(request, reply), value = input?.success ? input.data : undefined
        const auth = deps.auth, human = auth && recurrenceHumanSession(request, { auth, remoteDevices: deps.remoteDevices })
        let missionID = selected.data.missionID, held: Hold | undefined, ownsHold = false
        const pending = (result: object = {}) => reply.code(503).send({ ...result, missionID, pending: true,
          error: "Mission schedule action remains unconfirmed", code: "schedule-pending" })
        try {
          if (method === "POST" && (!human || !auth || !deps.bridgeToken || !deps.settings?.configYamlPathForAuthority))
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
            if (human && recurrenceHumanSession(request, { auth: auth!, remoteDevices: deps.remoteDevices })?.sessionId !== human.sessionId
              || canonicalAuthority(settings?.getProfileScope() ?? null) !== profile
              || settings?.configYamlPathForAuthority?.() !== yaml || manager.getServiceWslDistro(selected.data.id) !== distro)
              throw new Error("Mission schedule principal changed")
          }
          const configurationFor = (location: { directory: string }) => value?.configuration && missionConfigurationSchema.parse({ ...value.configuration,
            profileID: scope!.key, executionHost, roots: [{ mode: "directory-only", directory: location.directory }] })
          const digestFor = (configuration: ReturnType<typeof configurationFor>) => missionCreationDigest([
            value!.requestID, value!.expectedRevision, value!.action, missionSchedulePayloadDigest({ configuration, deleteManagedSessions: value!.deleteManagedSessions }),
          ])
          const effect = async (owned: Scope, rpc: Rpc, options: Options, retain?: Owned["retain"]) => {
            check(owned)
            if (!value || !human || !auth || !deps.bridgeToken || !settings?.configYamlPathForAuthority || !scope || !yaml || !deps.worktreeDeletionFence)
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
            if (!manager.getServicePathStyle) throw new Error("Mission schedule host paths unavailable")
            const profileSource = await resolveStandingProfileSource({ settings: {
              getProfileScope: () => settings.getProfileScope(), configYamlPathForAuthority: () => settings.configYamlPathForAuthority!(),
            }, descriptor: { scope, physicalProfile: physical(await realpath(path.dirname(yaml))), executionHost },
            binding: { profileID: scope.key, executionHost, projectID: owner.projectID, projectCanonical: owner.projectCanonical,
              roots: [{ mode: "directory-only", directory: owned.location.directory }] },
            manager: manager as WorkspaceManager, workspaceID: selected.data.id,
            roots: { assertRoots: async () => { await owned.refresh(); check(owned) } }, assertCurrent: () => { check(owned); return true } })
            if (!held) retain!(release => { held = holdScheduledMission(deps.worktreeDeletionFence!, binding, release); ownsHold = true })
            await owned.refresh(); check(owned)
            if (value.action === "play" && deps.supervision) {
              await deps.supervision.missionPlay(owned.connection, value.requestID, () => check(owned))
              await owned.refresh(); check(owned)
            }
            const identity = { sessionID: human.sessionId, workspaceID: selected.data.id, requestID: value.requestID,
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
            const { signal: _observerSignal, ...nativeOptions } = options
            const raw = await rpc.scheduleControl({ missionID, requestID: value.requestID, expectedRevision: value.expectedRevision,
              action: value.action, ...(configuration ? { configuration } : {}),
              ...(value.deleteManagedSessions === undefined ? {} : { deleteManagedSessions: value.deleteManagedSessions }),
              ...(value.retry ? { retry: true } : {}), transport: { ...proof, proof: signNativeRecurrenceControl(proof, deps.bridgeToken) } }, nativeOptions)
            await owned.refresh(); check(owned)
            let result = resultSchema.parse(raw)
            if (result.refusal) {
              if (exactScheduledRefusal(requested, result) && (checking || !value.retry && held!.refuse(binding, result)))
                return reply.code(409).send({ ...result, missionID, error: "Mission schedule action refused", code: "schedule-refused" })
              return pending(result)
            }
            if (checking) {
              // Check adopts/reconciles the saved intent. Its own ACK cannot
              // settle the original permit: reread that exact original receipt.
              result = resultSchema.parse(await lifetime.wait(rpc.scheduleRead({ missionID, requestID: binding.requestID }, options)))
              await owned.refresh(); check(owned)
            }
            return held!.settle(binding, result) ? result : pending(result)
          }
          let retryReceipt: unknown
          if (existing) {
            held = existing; missionID = existing.binding.missionID
            if (!human || !auth || !settings || !scope || !yaml || existing.preparing)
              return pending()
            if (query.data.requestID && query.data.requestID !== existing.binding.requestID)
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
                if (!await manager.ownsLocation(selected.data.id, location, client, lifetime.signal)) throw new Error("Mission schedule Location changed")
                const owner = await readRecurrenceHoldOwner(manager, selected.data.id, workspace, location.directory, client, lifetime.signal)
                check(owned)
                if (!owner) throw new Error("Mission schedule physical owner unavailable")
                existing.assertBound({ ...existing.binding, owner, connection, base, profile, configYamlPath: yaml, executionHost })
              } }
            await owned.refresh(); check(owned)
            if (value && value.action !== "check" && (value.requestID !== existing.binding.requestID || value.action !== existing.binding.action
              || value.expectedRevision !== existing.binding.expectedRevision || digestFor(configurationFor(location)) !== existing.binding.digest))
              throw new ScheduledHoldError(409, "Held Mission request differs")
            const options = { location, ...locationRequestOptions(location), signal: lifetime.signal }, rpc = rpcFor(client)
            retryReceipt = resultSchema.parse(await lifetime.wait(rpc.scheduleRead({ missionID, requestID: existing.binding.requestID }, options)))
            await owned.refresh(); check(owned)
            const binding = { ...existing.binding, connection }
            if (existing.settle(binding, retryReceipt)) return retryReceipt
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
            return result.pending ? pending(result) : result
          })
        } catch (error) {
          const status = error instanceof MissionMapMutationError || error instanceof ScheduledHoldError ? error.status : 503
          return reply.code(status).send({ missionID, pending: true, error: "Mission schedule action remains unconfirmed", code: "schedule-unconfirmed" })
        } finally { if (ownsHold) held?.dispose(); lifetime.dispose() }
      },
    })
  }
}
