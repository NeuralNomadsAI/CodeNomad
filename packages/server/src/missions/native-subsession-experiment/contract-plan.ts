import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import { parseExecution } from "../execution"
import { stableToken } from "../journal"
import { MISSION_MAX_EVENTS, MISSION_MAX_MISSIONS, MISSION_MAX_TASKS, type MissionEvent, type MissionLocation, type MissionMap, type MissionSnapshot } from "../model"

export const Ref = z.object({ missionID: z.string().regex(/^[A-Za-z0-9_-]{3,100}$/), revision: z.number().int().positive().safe(), taskKey: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/) }).strict()
export type Reference = z.infer<typeof Ref>
export const Task = z.object({ key: Ref.shape.taskKey, parentTaskKey: Ref.shape.taskKey.nullable(), title: z.string().min(1).max(240), brief: z.string().min(1).max(20000), role: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/), blockedBy: z.array(Ref.shape.taskKey).max(24),
  execution: z.unknown().transform(parseExecution).optional(), reuseFromTaskKey: Ref.shape.taskKey.optional(),
}).strict()
export type ContractTask = z.infer<typeof Task>
export const Binding = Ref.extend({ parentID: z.string().startsWith("ses"), childID: z.string().startsWith("ses"), callID: z.string().min(1), messageID: z.string().min(1), depth: z.number().int().min(1).max(3) }).strict()
export type Binding = z.infer<typeof Binding>
export type ContractBinding = Binding
export type EventPayload = MissionEvent extends infer E ? E extends MissionEvent ? Omit<E, "version" | "missionID" | "projectID" | "id" | "createdAt"> : never : never

const Seed = z.object({ missionID: Ref.shape.missionID, coordinatorID: z.string().startsWith("ses"), expectedRevision: z.literal(0), objective: z.string().min(1).max(20000), tasks: z.array(Task).min(1).max(MISSION_MAX_TASKS) }).strict()
const Retire = z.object({ taskKey: Ref.shape.taskKey, replacementTaskKey: Ref.shape.taskKey.optional() }).strict()
const Dependency = z.object({ taskKey: Ref.shape.taskKey, blockedBy: Task.shape.blockedBy }).strict()
const Revise = z.object({ missionID: Ref.shape.missionID, coordinatorID: Seed.shape.coordinatorID, requestID: z.string().min(1).max(128), expectedRevision: Ref.shape.revision, reason: z.string().min(1).max(2000),
  retireTasks: z.array(Retire).max(24).default([]), addTasks: z.array(Task.extend({ replacesTaskKey: Ref.shape.taskKey }).strict()).max(24).default([]), dependencyUpdates: z.array(Dependency).max(96).default([]),
}).strict()
const PlanSchema = Seed.extend({ revision: Ref.shape.revision, generations: z.record(Ref.shape.revision), retired: z.array(Retire).max(MISSION_MAX_TASKS), coordinatorLocation: z.object({ directory: z.string().min(1), workspaceID: z.string().optional() }).strict() }).strict()
export type ContractPlan = z.infer<typeof PlanSchema>
const Marker = z.object({ state: z.enum(["pending", "complete"]), revision: Ref.shape.revision, identity: z.string().min(1) }).strict()
const Receipt = z.object({ fingerprint: z.string(), result: z.object({ missionID: Ref.shape.missionID, revision: Ref.shape.revision }).strict() }).strict()
const Archive = z.object({ contract: Ref, task: Task, objective: Seed.shape.objective, coordinatorID: Seed.shape.coordinatorID, coordinatorLocation: PlanSchema.shape.coordinatorLocation }).strict()
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const equal = (a: unknown, b: unknown) => isDeepStrictEqual(a === undefined ? a : clone(a), b === undefined ? b : clone(b))
const historyKey = (ref: Reference) => `history/${ref.missionID}/${ref.taskKey}/${ref.revision}`
const sameLocation = (a: MissionLocation, b: MissionLocation) => a.directory === b.directory && a.workspaceID === b.workspaceID

export interface ContractPlanDependencies {
  get<T>(suffix: string): Promise<T | undefined>
  set(suffix: string, value: unknown): Promise<void>
  event(missionID: string, identity: string, payload: EventPayload): Promise<void>
  snapshot(): Promise<MissionSnapshot>
  /** Must be the trusted, Location-fenced adapter, not a caller-provided resolver. */
  session: { get(input: { sessionID: string }): Promise<{ id: string; parentID?: string; projectID: string; title?: string; location: MissionLocation }> }
  assertActive(): void
  /** Optional trusted host metadata preserves canonical repository identity in worktrees. */
  location?: { directory: string; project: { id: string; canonical: string } }
}

function validateGraph(tasks: ContractTask[]) {
  const graph = new Map(tasks.map(task => [task.key, task]))
  if (graph.size !== tasks.length) throw new Error("Duplicate task key")
  for (const task of tasks) {
    if (new Set(task.blockedBy).size !== task.blockedBy.length || task.blockedBy.some(key => key === task.key || !graph.has(key))) throw new Error("Unknown, retired, self or duplicate dependency")
    let current = task
    const parents = new Set([task.key])
    let depth = 1
    while (current.parentTaskKey !== null) {
      const parent = graph.get(current.parentTaskKey)
      if (!parent || parents.has(parent.key)) throw new Error("Unknown, retired or cyclic parent task")
      parents.add(parent.key); current = parent
      if (++depth > 3) throw new Error("Private qualification depth cap is 3 native edges")
    }
  }
  const checked = new Set<string>(), visiting = new Set<string>()
  const visit = (key: string) => {
    if (visiting.has(key)) throw new Error("Cyclic contract dependency")
    if (checked.has(key)) return
    visiting.add(key)
    for (const dependency of graph.get(key)!.blockedBy) visit(dependency)
    visiting.delete(key); checked.add(key)
  }
  for (const key of graph.keys()) visit(key)
  // A parent awaiting its own child's report cannot admit that child.
  const executionVisiting = new Set<string>(), executionChecked = new Set<string>()
  const executionVisit = (key: string) => {
    if (executionVisiting.has(key)) throw new Error("Cyclic parent/dependency admission graph")
    if (executionChecked.has(key)) return
    executionVisiting.add(key)
    const task = graph.get(key)!
    for (const edge of [...task.blockedBy, ...(task.parentTaskKey === null ? [] : [task.parentTaskKey])]) executionVisit(edge)
    executionVisiting.delete(key); executionChecked.add(key)
  }
  for (const key of graph.keys()) executionVisit(key)
}

/** Private fixture business seam only. Caller serializes seed/revise with its
 * project lock; no executor is awaited here. This is NOT crash-atomic: pending
 * markers fail closed forever, with no repair, replay or dispatch scheduler.
 * Historical lookup supplies report evidence ONLY; never delegation privilege.
 * Task dependency edits follow MissionControl's ready/blocked-only rule. Even
 * completed or assigned work can be retired, but cannot be edited in place.
 */
export function createNativeContractPlans(deps: ContractPlanDependencies) {
  const readSnapshot = async () => {
    deps.assertActive()
    const snapshot = await deps.snapshot()
    deps.assertActive()
    if (snapshot.discardedEvents || snapshot.controlUnavailable || snapshot.notificationUnavailable || snapshot.cleanupUnavailable) throw new Error("Damaged mission journal; contract authority unavailable")
    return snapshot
  }
  const requireMission = (snapshot: MissionSnapshot, missionID: string) => {
    const mission = snapshot.missions.find(item => item.id === missionID)
    if (!mission) throw new Error("Contract mission journal missing or partial")
    return mission
  }
  const rootFor = async (coordinatorID: string, snapshot: MissionSnapshot, location?: MissionLocation) => {
    const root = await deps.session.get({ sessionID: coordinatorID })
    deps.assertActive()
    if (root.id !== coordinatorID || root.parentID || root.projectID !== snapshot.projectID || !root.location.directory
      || (deps.location && (root.projectID !== deps.location.project.id || root.location.directory !== deps.location.directory))
      || (location && !sameLocation(root.location, location))) throw new Error("Only the owned coordinator root at its admitted Location may change the plan")
    return root
  }
  const validateProjection = (plan: ContractPlan, mission: MissionMap) => {
    if (mission.coordinatorSessionId !== plan.coordinatorID || mission.objective !== plan.objective || mission.tasks.length !== plan.tasks.length) throw new Error("Partial contract/journal projection")
    const retired = new Set(plan.retired.map(item => item.taskKey))
    for (const task of plan.tasks) {
      const projected = mission.tasks.find(item => item.key === task.key)
      if (!projected || !equal(clone({ title: projected.title, brief: projected.brief, role: projected.role, execution: projected.execution, blockedBy: projected.blockedBy }), clone({ title: task.title, brief: task.brief, role: task.role, execution: task.execution, blockedBy: task.blockedBy }))
        || (retired.has(task.key) && projected.status !== "withdrawn")) throw new Error("Partial contract task projection")
    }
  }
  const load = async (missionID: string) => {
    const raw = await deps.get<unknown>("plan/" + missionID)
    const markerRaw = await deps.get<unknown>("mutation/" + missionID)
    deps.assertActive()
    if (!raw || !markerRaw) throw new Error("Unknown contract or partial plan persistence")
    const plan = PlanSchema.parse(raw), marker = Marker.parse(markerRaw)
    if (plan.missionID !== missionID || marker.state !== "complete" || marker.revision !== plan.revision) throw new Error("Partial plan persistence; no automatic repair")
    const receipt = Receipt.parse(await deps.get(`request/${missionID}/${marker.identity}`))
    if (receipt.result.missionID !== missionID || receipt.result.revision !== plan.revision) throw new Error("Partial or damaged latest plan request receipt")
    const request = marker.identity === "seed" ? Seed.parse(JSON.parse(receipt.fingerprint)) : Revise.parse(JSON.parse(receipt.fingerprint))
    if (request.missionID !== missionID || request.coordinatorID !== plan.coordinatorID || request.expectedRevision + 1 !== plan.revision
      || (marker.identity !== "seed" && marker.identity !== "revise-" + stableToken((request as z.infer<typeof Revise>).requestID, 32))) throw new Error("Damaged latest plan request identity")
    const keys = plan.tasks.map(task => task.key), retired = new Set(plan.retired.map(item => item.taskKey))
    if (new Set(keys).size !== keys.length || retired.size !== plan.retired.length || Object.keys(plan.generations).length !== keys.length
      || keys.some(key => !Object.prototype.hasOwnProperty.call(plan.generations, key)) || [...retired].some(key => !keys.includes(key))) throw new Error("Damaged plan metadata")
    validateGraph(plan.tasks.filter(task => !retired.has(task.key)))
    for (const task of plan.tasks) {
      const ref = { missionID, taskKey: task.key, revision: plan.generations[task.key] }
      const archived = Archive.parse(await deps.get(historyKey(ref)))
      if (!equal(archived.contract, ref) || !equal(archived.task, task) || archived.objective !== plan.objective || archived.coordinatorID !== plan.coordinatorID || !sameLocation(archived.coordinatorLocation, plan.coordinatorLocation)) throw new Error("Damaged immutable task history")
    }
    const snapshot = await readSnapshot(), mission = requireMission(snapshot, missionID)
    validateProjection(plan, mission)
    deps.assertActive()
    return { plan, mission, snapshot }
  }
  const planFor = async (raw: Reference, options: { historical?: boolean } = {}) => {
    // Internal callers pass full Bindings; the model-facing Ref remains strict.
    const ref = Ref.parse({ missionID: raw.missionID, revision: raw.revision, taskKey: raw.taskKey }), { plan, mission } = await load(ref.missionID)
    const task = plan.tasks.find(item => item.key === ref.taskKey)
    if (!task) throw new Error("Unknown contract task")
    const validGeneration = plan.generations[ref.taskKey] === ref.revision && !plan.retired.some(item => item.taskKey === ref.taskKey)
      && mission.tasks.find(item => item.key === ref.taskKey)?.status !== "withdrawn"
    if (!validGeneration && !options.historical) throw new Error("Retired contract or stale task generation")
    const running = mission.status === "active" && (mission.runState === undefined || mission.runState === "running") && !mission.control?.pending.length
    if (!options.historical && !running) throw new Error("Mission is not running or control is pending")
    const current = validGeneration && running
    if (current) return { plan, task, current }
    const archive = Archive.parse(await deps.get(historyKey(ref)))
    deps.assertActive()
    if (!equal(archive.contract, ref) || archive.task.key !== ref.taskKey || archive.coordinatorID !== plan.coordinatorID || !sameLocation(archive.coordinatorLocation, plan.coordinatorLocation)) throw new Error("Unknown historical contract generation")
    return { plan: { ...plan, objective: archive.objective }, task: archive.task, current }
  }
  const archiveTasks = async (plan: ContractPlan, tasks: ContractTask[]) => {
    for (const task of tasks) {
      const contract = { missionID: plan.missionID, taskKey: task.key, revision: plan.generations[task.key] }
      const value = clone({ contract, task, objective: plan.objective, coordinatorID: plan.coordinatorID, coordinatorLocation: plan.coordinatorLocation })
      const previous = await deps.get(historyKey(contract))
      if (previous !== undefined && !equal(previous, value)) throw new Error("Immutable task history conflict")
      deps.assertActive(); await deps.set(historyKey(contract), value)
    }
  }
  const capacity = (snapshot: MissionSnapshot, count: number) => {
    if (snapshot.missions.reduce((total, mission) => total + mission.revision, 0) + count > MISSION_MAX_EVENTS) throw new Error("Mission event safety limit reached")
  }
  const finish = async (plan: ContractPlan, identity: string, fingerprint: string) => {
    deps.assertActive(); await deps.set("plan/" + plan.missionID, clone(plan))
    const result = { missionID: plan.missionID, revision: plan.revision }
    await deps.set(`request/${plan.missionID}/${identity}`, { fingerprint, result })
    deps.assertActive(); await deps.set("mutation/" + plan.missionID, { state: "complete", revision: plan.revision, identity })
    // Verify shared business events were accepted, not merely written.
    await load(plan.missionID)
    return result
  }
  const retry = async (missionID: string, identity: string, fingerprint: string) => {
    const raw = await deps.get(`request/${missionID}/${identity}`)
    if (raw === undefined) return undefined
    const receipt = Receipt.parse(raw)
    if (receipt.fingerprint !== fingerprint) throw new Error("Contract request identity conflict")
    const { plan } = await load(missionID)
    if (receipt.result.missionID !== missionID || receipt.result.revision > plan.revision) throw new Error("Damaged request receipt")
    return receipt.result
  }
  const seed = async (raw: unknown) => {
    const input = Seed.parse(raw), fingerprint = JSON.stringify(clone(input)), snapshot = await readSnapshot()
    const root = await rootFor(input.coordinatorID, snapshot)
    const repeated = await retry(input.missionID, "seed", fingerprint)
    if (repeated) {
      await rootFor(input.coordinatorID, snapshot, (await load(input.missionID)).plan.coordinatorLocation)
      return repeated
    }
    if (await deps.get("plan/" + input.missionID) || await deps.get("mutation/" + input.missionID) || snapshot.missions.some(m => m.id === input.missionID)) throw new Error("Plan already exists or partial seed; coordinator revision required")
    if (snapshot.missions.length >= MISSION_MAX_MISSIONS) throw new Error("Project mission limit reached")
    if (input.tasks.some(task => task.reuseFromTaskKey !== undefined)) throw new Error("Actor reuse requires explicit coordinator replacement")
    validateGraph(input.tasks); capacity(snapshot, input.tasks.length + 1)
    const plan: ContractPlan = { ...input, revision: 1, generations: Object.fromEntries(input.tasks.map(task => [task.key, 1])), retired: [], coordinatorLocation: root.location }
    deps.assertActive(); await deps.set("mutation/" + input.missionID, { state: "pending", revision: 1, identity: "seed" })
    await deps.event(input.missionID, "created", { type: "mission.created", projectCanonical: deps.location?.project.canonical ?? root.location.directory, objective: input.objective, template: "custom", coordinator: { sessionID: root.id, title: root.title ?? root.id, location: root.location } })
    for (const task of plan.tasks) {
      deps.assertActive()
      await deps.event(input.missionID, "task-" + task.key, { type: "task.created", task: { id: "task_" + stableToken(input.missionID + task.key, 24), key: task.key, title: task.title, brief: task.brief, role: task.role, blockedBy: task.blockedBy, ...(task.execution === undefined ? {} : { execution: task.execution }) } })
    }
    await archiveTasks(plan, plan.tasks)
    return finish(plan, "seed", fingerprint)
  }
  const revise = async (raw: unknown) => {
    const input = Revise.parse(raw), fingerprint = JSON.stringify(clone(input)), identity = "revise-" + stableToken(input.requestID, 32)
    const { plan, mission, snapshot } = await load(input.missionID)
    if (input.coordinatorID !== plan.coordinatorID) throw new Error("Only the coordinator may revise task topology")
    await rootFor(input.coordinatorID, snapshot, plan.coordinatorLocation)
    const repeated = await retry(input.missionID, identity, fingerprint)
    if (repeated) return repeated
    if (plan.revision !== input.expectedRevision) throw new Error("Plan document revision conflict")
    if (mission.status !== "active" || (mission.runState !== undefined && mission.runState !== "running") || mission.control?.pending.length) throw new Error("Mission is not running or control is pending")
    if (!input.retireTasks.length && !input.addTasks.length && !input.dependencyUpdates.length) throw new Error("Empty contract revision")
    if (plan.tasks.length + input.addTasks.length > MISSION_MAX_TASKS || plan.revision >= MISSION_MAX_EVENTS) throw new Error("Contract task/revision safety limit reached")
    capacity(snapshot, 1)
    const tasks = new Map(plan.tasks.map(task => [task.key, clone(task)])), retired = new Map(plan.retired.map(item => [item.taskKey, item]))
    const retiring = new Map(input.retireTasks.map(item => [item.taskKey, item]))
    if (retiring.size !== input.retireTasks.length) throw new Error("Duplicate retired task")
    for (const key of retiring.keys()) if (!tasks.has(key) || retired.has(key) || mission.tasks.find(task => task.key === key)?.status === "withdrawn") throw new Error("Cannot retire unknown or already retired task")
    const added = new Set<string>()
    for (const item of input.addTasks) {
      if (tasks.has(item.key) || added.has(item.key)) throw new Error("Task key already exists")
      if (retiring.get(item.replacesTaskKey)?.replacementTaskKey !== item.key) throw new Error("Replacement must match exactly one retired task")
      if (item.reuseFromTaskKey !== undefined) {
        // Actor source and replaced work are independent coordinator choices.
        // Authorize identity here, even while that predecessor is running;
        // completion, returned receipt and authoritative idle are execution gates.
        const old = plan.tasks.find(task => task.key === item.reuseFromTaskKey)
        if (!old) throw new Error("Reuse predecessor is unknown in this Mission")
        const ownerRaw = await deps.get(`owner/${plan.missionID}/${old.key}`)
        if (ownerRaw === undefined) throw new Error("Reuse predecessor has no owned native actor")
        const owner = Binding.parse(ownerRaw)
        if (owner.missionID !== plan.missionID || owner.taskKey !== old.key || owner.revision !== plan.generations[old.key] || old.parentTaskKey !== item.parentTaskKey) throw new Error("Reuse requires exact historical actor and unchanged native parent")
        const current = Binding.parse(await deps.get("current/" + owner.childID))
        const actor = await deps.session.get({ sessionID: owner.childID })
        const projected = mission.tasks.find(task => task.key === old.key)
        if (current.missionID !== owner.missionID || current.taskKey !== owner.taskKey || current.revision !== owner.revision || current.childID !== owner.childID || current.parentID !== owner.parentID
          || actor.id !== owner.childID || actor.parentID !== owner.parentID || actor.projectID !== snapshot.projectID || !sameLocation(actor.location, plan.coordinatorLocation)
          || projected?.actorSessionId !== owner.childID || projected.nativeBinding?.generation !== owner.revision || projected.nativeBinding.parentSessionID !== owner.parentID || projected.nativeBinding.toolCallID !== owner.callID || projected.nativeBinding.parentMessageID !== owner.messageID) throw new Error("Reuse actor binding/native identity mismatch")
      }
      const { replacesTaskKey: _, ...task } = item
      tasks.set(item.key, task); added.add(item.key)
    }
    const replacements = [...retiring.values()].flatMap(item => item.replacementTaskKey === undefined ? [] : [item.replacementTaskKey])
    if (new Set(replacements).size !== replacements.length || replacements.length !== added.size) throw new Error("Every replacement must replace exactly one retired task")
    for (const item of retiring.values()) if (item.replacementTaskKey !== undefined && !added.has(item.replacementTaskKey)) throw new Error("Retired task replacement is missing")
    const updates = new Set<string>(), changed: ContractTask[] = []
    for (const update of input.dependencyUpdates) {
      const task = tasks.get(update.taskKey), projected = mission.tasks.find(item => item.key === update.taskKey)
      if (!task || !projected || retired.has(update.taskKey) || retiring.has(update.taskKey) || updates.has(update.taskKey)) throw new Error("Invalid or duplicate dependency update")
      if (projected.status !== "ready" && projected.status !== "blocked") throw new Error("Cannot change dependencies after dispatch or completion")
      if (await deps.get(`owner/${plan.missionID}/${task.key}`)) throw new Error("Cannot edit admitted task dependencies")
      updates.add(task.key)
      if (!equal(task.blockedBy, update.blockedBy)) { task.blockedBy = update.blockedBy; changed.push(task) }
    }
    for (const [key, item] of retiring) retired.set(key, item)
    validateGraph([...tasks.values()].filter(task => !retired.has(task.key)))
    if (!retiring.size && !added.size && !changed.length) throw new Error("Empty effective contract revision")
    const next: ContractPlan = { ...plan, revision: plan.revision + 1, tasks: [...tasks.values()], retired: [...retired.values()], generations: { ...plan.generations } }
    for (const task of changed) next.generations[task.key]++
    for (const key of added) next.generations[key] = 1
    deps.assertActive(); await deps.set("mutation/" + plan.missionID, { state: "pending", revision: next.revision, identity })
    await deps.event(plan.missionID, identity, { type: "mission.revised", requestID: input.requestID, expectedRevision: mission.revision, actorSessionID: plan.coordinatorID, reason: input.reason, notesSpecified: false, retiredTasks: input.retireTasks,
      addedTasks: input.addTasks.map(task => ({ id: "task_" + stableToken(plan.missionID + task.key, 24), key: task.key, title: task.title, brief: task.brief, role: task.role, blockedBy: task.blockedBy, replacesTaskKey: task.replacesTaskKey, ...(task.execution === undefined ? {} : { execution: task.execution }) })), dependencyUpdates: changed.map(task => ({ taskKey: task.key, blockedBy: task.blockedBy })) })
    await archiveTasks(next, [...changed, ...next.tasks.filter(task => added.has(task.key))])
    return finish(next, identity, fingerprint)
  }
  const admitted = async (raw: Reference, parentID: string) => {
    const ref = Ref.parse(raw), { plan, task } = await planFor(ref)
    let depth = 1
    if (task.parentTaskKey === null) {
      if (plan.coordinatorID !== parentID) throw new Error("Contract parent is not the coordinator")
      await rootFor(parentID, await readSnapshot(), plan.coordinatorLocation)
    } else {
      const parent = Binding.parse(await deps.get("current/" + parentID))
      if (parent.childID !== parentID || parent.missionID !== ref.missionID || parent.taskKey !== task.parentTaskKey) throw new Error("Contract parent is not the declared native subwork owner")
      // Compare the parent's OWN generation, never the child's generation.
      await planFor(parent)
      const owner = Binding.parse(await deps.get(`owner/${ref.missionID}/${parent.taskKey}`))
      const call = Binding.parse(await deps.get(`binding/${parent.parentID}/${parent.callID}`))
      const projected = requireMission(await readSnapshot(), ref.missionID).tasks.find(task => task.key === parent.taskKey)
      if (!equal(call, parent) || owner.missionID !== parent.missionID || owner.taskKey !== parent.taskKey || owner.revision !== parent.revision || owner.childID !== parent.childID || owner.parentID !== parent.parentID || owner.depth !== parent.depth
        || projected?.actorSessionId !== parent.childID || projected.nativeBinding?.generation !== owner.revision || projected.nativeBinding.parentSessionID !== owner.parentID || projected.nativeBinding.toolCallID !== owner.callID || projected.nativeBinding.parentMessageID !== owner.messageID) throw new Error("Parent native admission evidence is partial or mismatched")
      const nativeParent = await deps.session.get({ sessionID: parentID })
      if (nativeParent.id !== parent.childID || nativeParent.parentID !== parent.parentID || nativeParent.projectID !== (await readSnapshot()).projectID || !sameLocation(nativeParent.location, plan.coordinatorLocation)) throw new Error("Native parent binding/Location mismatch")
      depth = parent.depth + 1
    }
    if (depth > 3) throw new Error("Private qualification depth cap is 3 native edges")
    for (const taskKey of task.blockedBy) {
      const expected = { missionID: ref.missionID, taskKey, revision: plan.generations[taskKey] }
      const report = await deps.get<{ id?: string; sessionId?: string; contract?: Reference; outcome?: string }>(`report/${ref.missionID}/${taskKey}`)
      if (report?.outcome !== "completed" || !equal(report.contract, expected)) throw new Error("Contract dependency has no explicit completed report for current generation")
      const projected = requireMission(await readSnapshot(), ref.missionID).tasks.find(task => task.key === taskKey)
      if (projected?.status !== "completed" || projected.report?.outcome !== "completed" || projected.report.id !== report.id || projected.report.sessionId !== report.sessionId
        || projected.actorSessionId !== report.sessionId || projected.nativeBinding?.generation !== expected.revision) throw new Error("Contract dependency completed report journal evidence is missing or mismatched")
    }
    // Wrapper also calls this before its task-lock wait and inside the lock.
    await planFor(ref); deps.assertActive()
    return { plan, task, depth }
  }
  const isCurrent = async (raw: Reference) => {
    const ref = Ref.parse({ missionID: raw.missionID, revision: raw.revision, taskKey: raw.taskKey }), { plan, mission } = await load(ref.missionID)
    return mission.status === "active" && (mission.runState === undefined || mission.runState === "running") && !mission.control?.pending.length
      && mission.tasks.some(task => task.key === ref.taskKey && task.status !== "withdrawn") && plan.generations[ref.taskKey] === ref.revision && !plan.retired.some(item => item.taskKey === ref.taskKey)
  }
  return { seed, revise, planFor, admitted, isCurrent }
}
