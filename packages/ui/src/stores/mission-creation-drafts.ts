import { createSignal } from "solid-js"
import type { MissionMap } from "../../../server/src/api-types"
import type { MissionExecution } from "../../../server/src/missions/execution"
import type { MissionProfiles } from "../../../server/src/missions/playbook-profiles"
import type { MissionTaskMode } from "../lib/mission-defaults"
import { captureBackendOperation } from "../lib/backend-operation"
import { backendOf } from "../lib/backend-client"
import type { MissionCreationReceipt } from "../../../server/src/missions/creation-receipt"

export interface UncertainMissionCreation {
  requestId: string
  title?: string
  objective: string
  notes: string
  template: MissionMap["template"]
  directory?: string
  profiles?: MissionProfiles
  taskMode?: MissionTaskMode
  watchedConversationIDs?: readonly string[]
  /** Display-only draft choice; recovered creation never continues Play. */
  startOnCreation?: boolean
  coordinatorGoal?: boolean
}

export type MissionCreationHoldState = "pending" | "uncertain"
export interface MissionCreationOwner { client: unknown; generation: number }
interface HeldCreation {
  operation: Readonly<UncertainMissionCreation>; state: MissionCreationHoldState
  confirmed?: { owner: MissionCreationOwner; receipt: MissionCreationReceipt; current(): boolean }
}

// Window-memory only, not native settlement authority or restart persistence.
// Retain dispatched/unknown operations by their original scope/request until the
// original response or its exact receipt settles them.
const held = new Map<string, Map<string, HeldCreation>>()
const [version, setVersion] = createSignal(0)
interface ReceiptRead { owner: MissionCreationOwner; controller: AbortController; promise: Promise<MissionCreationReceipt | undefined> }
const reading = new Map<string, ReceiptRead>()
const sameOwner = (left: MissionCreationOwner, right: MissionCreationOwner) => left.client === right.client && left.generation === right.generation
const freeze = (operation: UncertainMissionCreation): Readonly<UncertainMissionCreation> => Object.freeze({
  ...operation, ...(operation.profiles === undefined ? {} : { profiles: copyMissionProfiles(operation.profiles) }),
  ...(operation.watchedConversationIDs === undefined ? {} : { watchedConversationIDs: Object.freeze([...operation.watchedConversationIDs]) }),
})

/** Register the exact intent BEFORE dispatch so a closed/remounted editor in the
 * same scope cannot submit another logical creation while its reply is pending. */
export function holdMissionCreation(scope: string, operation: UncertainMissionCreation): boolean {
  if (held.get(scope)?.size) return false
  held.set(scope, new Map([[operation.requestId, { operation: freeze(operation), state: "pending" }]]))
  setVersion(value => value + 1)
  return true
}

/** Only the original request's definitive outcome (success or reviewed rejection) releases it. */
export function releaseMissionCreation(scope: string, requestId: string): void {
  const operations = held.get(scope)
  if (operations?.get(requestId)?.state !== "pending") return
  operations.delete(requestId)
  if (!operations.size) held.delete(scope)
  setVersion(value => value + 1)
}

/** Reads the original request only. Absence, transport loss and mismatches keep its hold. */
export function reconcileMissionCreation(scope: string, instanceId: string, owner: MissionCreationOwner, current: () => boolean): Promise<MissionCreationReceipt | undefined> {
  const operation = missionCreationHold(scope)
  if (operation?.state !== "uncertain" || !current()) return Promise.resolve(undefined)
  if (operation.confirmed && sameOwner(operation.confirmed.owner, owner)) return Promise.resolve(operation.confirmed.receipt)
  const key = JSON.stringify([scope, operation.operation.requestId])
  const existing = reading.get(key)
  if (existing && sameOwner(existing.owner, owner)) return existing.promise
  existing?.controller.abort()
  const controller = new AbortController()
  let entry: ReceiptRead
  const attachment = captureBackendOperation(instanceId, controller.signal, current)
  const promise = Promise.resolve().then(() => {
    attachment.signal.throwIfAborted()
    return backendOf(instanceId).api.missionCreationReceipt(instanceId, operation.operation.requestId, attachment.signal)
  }).then(receipt => {
    if (!attachment.current() || missionCreationHold(scope) !== operation || receipt.requestId !== operation.operation.requestId
      || receipt.state !== "created" && receipt.state !== "rejected"
      || receipt.state === "created" && (!receipt.mission || typeof receipt.mission.id !== "string")) return
    held.get(scope)!.get(receipt.requestId)!.confirmed = { owner, receipt, current: attachment.current }
    return receipt
  }).catch(() => undefined).finally(() => { if (reading.get(key) === entry) reading.delete(key) })
  entry = { owner, controller, promise }
  reading.set(key, entry)
  return promise
}

/** Only a current owning view consumes its exact confirmed outcome. */
export function consumeMissionCreation(scope: string, receipt: MissionCreationReceipt, owner: MissionCreationOwner): boolean {
  const operation = missionCreationHold(scope)
  if (!operation?.confirmed || !operation.confirmed.current() || !sameOwner(operation.confirmed.owner, owner) || operation.confirmed.receipt !== receipt) return false
  held.get(scope)!.delete(receipt.requestId)
  if (!held.get(scope)!.size) held.delete(scope)
  setVersion(value => value + 1)
  return true
}

export function retainUncertainMissionCreation(scope: string, operation: UncertainMissionCreation): void {
  const operations = held.get(scope) ?? new Map<string, HeldCreation>()
  const current = operations.get(operation.requestId)
  if (current?.state === "uncertain") return
  operations.set(operation.requestId, { operation: current?.operation ?? freeze(operation), state: "uncertain" })
  held.set(scope, operations)
  setVersion(value => value + 1)
}

export function uncertainMissionCreation(scope: string): Readonly<UncertainMissionCreation> | undefined {
  version()
  for (const entry of held.get(scope)?.values() ?? []) if (entry.state === "uncertain") return entry.operation
  return undefined
}

/** Tracked: any pending or unknown creation in this scope fences new submissions. */
export function missionCreationHold(scope: string): Readonly<HeldCreation> | undefined {
  version()
  const operations = held.get(scope)
  return operations && ([...operations.values()].find(entry => entry.state === "uncertain") ?? operations.values().next().value)
}

/** Copy before freezing: the caller's editable signals remain caller-owned. */
export function copyMissionProfiles(profiles?: MissionProfiles): MissionProfiles | undefined {
  if (!profiles) return undefined
  const copy = (execution: MissionExecution): MissionExecution => Object.freeze({
    ...(execution.agent === undefined ? {} : { agent: execution.agent }),
    ...(execution.model === undefined ? {} : { model: Object.freeze({ ...execution.model }) }),
  })
  return Object.freeze({
    ...(profiles.coordinator === undefined ? {} : { coordinator: copy(profiles.coordinator) }),
    ...(profiles.roles === undefined ? {} : { roles: Object.freeze(Object.fromEntries(Object.entries(profiles.roles).map(([role, execution]) => [role, copy(execution)]))) }),
  })
}

/** Stable request identity includes every profile field and optional absence. */
export function missionCreationPayloadIdentity(operation: Omit<UncertainMissionCreation, "requestId">): string {
  const execution = (value?: MissionExecution) => value === undefined ? null : [value.agent ?? null,
    value.model ? [value.model.providerID, value.model.id, value.model.variant ?? null] : null]
  const profiles = operation.profiles
  return JSON.stringify([operation.title ?? null, operation.objective, operation.notes, operation.template, operation.directory ?? null, operation.taskMode ?? null,
    operation.watchedConversationIDs ?? null, Boolean(operation.coordinatorGoal),
    profiles === undefined ? null : [execution(profiles.coordinator), profiles.roles === undefined ? null
      : Object.keys(profiles.roles).sort().map(role => [role, execution(profiles.roles![role])])]])
}
