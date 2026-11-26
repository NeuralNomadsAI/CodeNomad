import type { Plugin } from "@opencode/plugin/effect"
import { Agent } from "@opencode/schema/agent"
import { Automation } from "@opencode/schema/automation"
import { Goal } from "@opencode/schema/goal"
import { Session } from "@opencode/schema/session"
import { Tool } from "@opencode/schema/tool"
import { Cause, Context, Effect, Fiber, Option, Predicate, Schema, Scope, Stream } from "effect"
import {
  COORDINATOR_GOAL_STORAGE_PREFIX,
  coordinatorGoalRecordKey,
  coordinatorGoalRecordPrefix,
  liveCoordinatorGoalSchema,
  parseCoordinatorGoalRecord,
  reconcileCoordinatorGoal,
  type CoordinatorGoalReconcileResult,
  type LiveCoordinatorGoal,
} from "../../missions/coordinator-goal"
import { MissionJournal, stableToken, type MissionStorage } from "../../missions/journal"
import type { MissionJsonValue, MissionMap } from "../../missions/model"
import { missionAutomationService, readMissionAutomation } from "./native-mission-automation"
import { nativeInvocation } from "./native-invocation"

export const COORDINATOR_GOAL_TOOL = Object.freeze({
  namespace: "codenomad",
  name: "mission_goal_reconcile",
  permission: "codenomad_mission_goal_reconcile",
})
export const COORDINATOR_GOAL_WATCHDOG_CODE = `await tools.${COORDINATOR_GOAL_TOOL.namespace}.${COORDINATOR_GOAL_TOOL.name}({}); return null`
export const COORDINATOR_GOAL_WATCHDOG_PERMISSIONS = Object.freeze([
  Object.freeze({ action: "execute", resource: "*", effect: "allow" as const }),
  Object.freeze({ action: COORDINATOR_GOAL_TOOL.permission, resource: "*", effect: "allow" as const }),
])
export const COORDINATOR_GOAL_WATCHDOG_NAME = "codenomad-mission-goal-watchdog"
export const COORDINATOR_GOAL_WATCHDOG_INTERVAL = "1 minute"
export const COORDINATOR_GOAL_CARRIER_MARKER = "codenomad.coordinator-goal-watchdog"
export const COORDINATOR_GOAL_CARRIER_TITLE = "Mission goal watchdog"

const unattended = Context.Reference<unknown>("@opencode/Permission/Unattended", { defaultValue: () => undefined })
const WATCHDOG_SCAN_LIMIT = 100

type NativeEffect = Effect.Effect<unknown, unknown>
const method = Schema.declare<(...args: any[]) => NativeEffect>((value): value is (...args: any[]) => NativeEffect => Predicate.isFunction(value))
const automationApiSchema = Schema.Struct({ create: method, list: method, remove: method, enabled: method })
const missingTag = (error: unknown, name: string) => !!error && typeof error === "object" && "_tag" in error && error._tag === name

export function coordinatorGoalWatchdogSessionID(projectID: string, projectCanonical: string): string {
  return `ses_cn_goal_${stableToken(`${projectID}\0${projectCanonical}`, 24)}`
}

export interface NativeCoordinatorGoalRuntime {
  readonly carrierSessionID: string
  /** One pass for a Mission map the caller already read. */
  reconcile(mission: MissionMap): Promise<CoordinatorGoalReconcileResult | undefined>
  reconcileProject(includeUnrecorded?: boolean): Promise<number>
  cleanupMission(missionID: string): Promise<void>
}

/** Registers the persistent coordinator `/goal` runtime for one OpenCode Location:
 * - Code Mode tool `codenomad.mission_goal_reconcile` for unattended post-restart recovery
 * - Carrier hooks blocking LLM spend on the technical watchdog session
 * - Live `rpc.opencode.goal.changed` subscription for fast queued-arm adoption
 * - Automatic lifecycle management of the project-level Code Mode watchdog automation. */
export const registerNativeCoordinatorGoalRuntime = Effect.fn("missions.registerCoordinatorGoalRuntime")(function* (
  ctx: Plugin.Context,
  invocation = nativeInvocation(),
) {
  const projectID = ctx.location.project.id
  const projectCanonical = ctx.location.project.canonical
  const projectToken = stableToken(`${projectID}\0${projectCanonical}`, 24)
  const carrierSessionID = coordinatorGoalWatchdogSessionID(projectID, projectCanonical)
  const goalRpc = ctx.rpc(Goal.Definition)
  const setupGraph = yield* Effect.context<Scope.Scope>()
  const setupRun = Effect.runPromiseWith(setupGraph)

  let active = true
  yield* Effect.addFinalizer(() => Effect.sync(() => { active = false }))

  // Prevent the technical watchdog carrier from ever making LLM provider calls or title requests.
  const isCarrier = (sessionID: string) => sessionID === carrierSessionID
  yield* ctx.session.hook("title", event => Effect.sync(() => {
    if (isCarrier(event.sessionID)) event.result = COORDINATOR_GOAL_CARRIER_TITLE
  }))
  yield* ctx.session.hook("compaction", event => Effect.sync(() => {
    if (isCarrier(event.sessionID)) event.result = { summary: COORDINATOR_GOAL_CARRIER_TITLE }
  }))
  yield* ctx.session.hook("http.request", event => Effect.sync(() => {
    if (isCarrier(event.sessionID)) throw new Error("coordinator-goal-carrier-provider-http")
  }))

  const runEffect = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
    if (invocation.active()) return invocation.check((run: <B>(e: Effect.Effect<B, unknown>) => Promise<B>) => run(effect))
    return setupRun(effect)
  }

  // Use public `ctx.storage` directly: Code Mode tool invocations run in a sandboxed
  // fiber that may omit `@opencode/storage/Database`, while `ctx.storage` works everywhere.
  const missionStorage = (): MissionStorage => ({
    get: key => runEffect(ctx.storage.get(key)) as Promise<MissionJsonValue | undefined>,
    set: (key, value) => runEffect(ctx.storage.set(key, value)).then(() => undefined),
    remove: key => runEffect(ctx.storage.remove(key)).then(() => undefined),
    scan: options => runEffect(ctx.storage.scan(options)) as ReturnType<MissionStorage["scan"]>,
  })

  const makeJournal = () => new MissionJournal(missionStorage(), projectID, projectCanonical)

  // OpenCode's goal plugin may register after this one: wait for it at activation only, so a
  // Mission change never stalls on a service without `/goal`.
  const goalRpcExpectedBy = Date.now() + 3_000
  const readGoal = async (sessionID: string): Promise<LiveCoordinatorGoal | null | "unavailable"> => {
    const deadline = goalRpcExpectedBy
    while (true) {
      try {
        const raw = await runEffect(goalRpc.get({ sessionID }))
        if (raw === null || raw === undefined) return null
        const parsed = liveCoordinatorGoalSchema.safeParse(raw)
        return parsed.success ? parsed.data : "unavailable"
      } catch (error) {
        const unavailable = !!error && typeof error === "object" && "_tag" in error && error._tag === "RpcError"
          && "type" in error && error.type === "rpc.unavailable"
        if (unavailable && active && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 150))
          continue
        }
        return "unavailable"
      }
    }
  }

  const runGoalCommand = async (sessionID: string, text: string, delivery: "queue" | "steer"): Promise<void> => {
    await runEffect(ctx.session.command({ sessionID: Session.ID.make(sessionID), name: "goal", text, delivery }))
  }

  const needsWatchdog = (mission: Pick<MissionMap, "coordinatorGoal" | "status" | "runState"> | undefined): boolean =>
    Boolean(mission?.coordinatorGoal && mission.status === "active" && mission.runState !== "stopped" && mission.runState !== "prepared")

  const syncWatchdog = (shouldExist: boolean) => Effect.gen(function* () {
    const graph = yield* Effect.context<never>()
    const found = Context.getOption(graph, missionAutomationService)
    if (Option.isNone(found)) return
    const decoded = Schema.decodeUnknownOption(automationApiSchema)(found.value)
    if (Option.isNone(decoded)) return
    const automations = decoded.value
    const enabledEffect = automations.enabled(ctx.location.directory)
    if (!Effect.isEffect(enabledEffect) || (yield* enabledEffect) !== true) return

    const existingList = yield* Effect.suspend(() => automations.list({ sessionID: carrierSessionID })).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.toType(Automation.Info)).check(Schema.isMaxLength(16)))),
      Effect.catch(() => Effect.succeed([] as const)),
    )
    const owned = existingList.filter(item =>
      item.sessionID === carrierSessionID
      && item.name === COORDINATOR_GOAL_WATCHDOG_NAME
      && item.action.type === "code"
      && item.action.code === COORDINATOR_GOAL_WATCHDOG_CODE)

    if (!shouldExist) {
      for (const item of owned) {
        yield* Effect.suspend(() => automations.remove(item.id)).pipe(Effect.catch(() => Effect.void))
      }
      return
    }

    if (owned.some(item => item.status === "active")) return
    // Remove any stale done/paused watchdog rows before creating a fresh active one.
    for (const item of owned) {
      yield* Effect.suspend(() => automations.remove(item.id)).pipe(Effect.catch(() => Effect.void))
    }

    const existingCarrier = yield* ctx.session.get({ sessionID: Session.ID.make(carrierSessionID) }).pipe(
      Effect.catch(error => missingTag(error, "Session.NotFoundError") ? Effect.succeed(undefined) : Effect.fail(error)),
    )
    const rules = COORDINATOR_GOAL_WATCHDOG_PERMISSIONS.map(rule => ({ ...rule }))
    if (!existingCarrier) {
      const listed = yield* ctx.agent.list().pipe(Effect.catch(() => Effect.succeed({ data: [] as readonly { id: string; mode?: string }[] })))
      const agents = Array.isArray(listed) ? listed : listed.data
      const agentID = agents.find((agent: { id: string; mode?: string }) => agent.mode !== "subagent")?.id ?? agents[0]?.id ?? "build"
      yield* ctx.session.create({
        id: Session.ID.make(carrierSessionID),
        title: COORDINATOR_GOAL_CARRIER_TITLE,
        location: { directory: ctx.location.directory },
        agent: Agent.ID.make(agentID),
        metadata: { [COORDINATOR_GOAL_CARRIER_MARKER]: { version: 1, projectID } },
        permissions: rules,
      })
    } else if (!existingCarrier.permissions?.length) {
      yield* ctx.session.update({ sessionID: Session.ID.make(carrierSessionID), permissions: rules })
    }

    const input = Schema.decodeUnknownSync(Schema.toType(Automation.CreateInput))({
      sessionID: carrierSessionID,
      name: COORDINATOR_GOAL_WATCHDOG_NAME,
      trigger: { type: "every", every: COORDINATOR_GOAL_WATCHDOG_INTERVAL },
      action: { type: "code", code: COORDINATOR_GOAL_WATCHDOG_CODE },
    })
    yield* Effect.suspend(() => automations.create(input)).pipe(Effect.flatMap(readMissionAutomation))
  }).pipe(Effect.catch(() => Effect.void))

  const hasAnyActiveGoalMission = async (): Promise<boolean> => {
    const storage = missionStorage()
    const prefix = coordinatorGoalRecordPrefix(projectToken)
    const journal = makeJournal()
    let after: string | undefined
    const seen = new Set<string>()
    do {
      const page = await storage.scan({ prefix, after, limit: WATCHDOG_SCAN_LIMIT })
      for (const entry of page.entries) {
        const record = parseCoordinatorGoalRecord(entry.value)
        if (!record || seen.has(record.missionID)) continue
        seen.add(record.missionID)
        try {
          const view = await journal.missionProjection(record.missionID)
          if (needsWatchdog(view.mission)) return true
        } catch {
          return true
        }
      }
      after = page.next
    } while (after)
    return false
  }

  const reconcileMissionMap = async (mission: MissionMap): Promise<CoordinatorGoalReconcileResult | undefined> => {
    if (!active || !mission.coordinatorGoal) return undefined
    const storage = missionStorage()
    const result = await reconcileCoordinatorGoal(mission, {
      projectToken,
      readRecord: key => storage.get(key),
      writeRecord: (key, value) => storage.set(key, value),
      removeRecord: async key => { await storage.remove?.(key) },
      readGoal,
      runGoalCommand,
    })
    if (needsWatchdog(mission)) {
      await runEffect(syncWatchdog(true))
    } else if (mission.status !== "active" || mission.runState === "stopped") {
      if (!(await hasAnyActiveGoalMission())) await runEffect(syncWatchdog(false))
    }
    return result
  }

  const reconcileMission = async (missionID: string): Promise<CoordinatorGoalReconcileResult | undefined> => {
    if (!active) return undefined
    const view = await makeJournal().missionProjection(missionID).catch(() => undefined)
    if (!view?.mission?.coordinatorGoal) return undefined
    return reconcileMissionMap(view.mission)
  }

  const reconcileProject = async (includeUnrecorded = false): Promise<number> => {
    if (!active) return 0
    const storage = missionStorage()
    const prefix = coordinatorGoalRecordPrefix(projectToken)
    const journal = makeJournal()
    const missionIDs = new Set<string>()
    let after: string | undefined
    do {
      const page = await storage.scan({ prefix, after, limit: WATCHDOG_SCAN_LIMIT })
      for (const entry of page.entries) {
        const record = parseCoordinatorGoalRecord(entry.value)
        if (record) missionIDs.add(record.missionID)
      }
      after = page.next
    } while (after)

    if (includeUnrecorded || missionIDs.size === 0) {
      const snapshot = await journal.snapshot().catch(() => undefined)
      for (const mission of snapshot?.missions ?? []) {
        if (mission.coordinatorGoal) missionIDs.add(mission.id)
      }
    }

    let activeCount = 0
    let reconciled = 0
    for (const missionID of missionIDs) {
      if (!active) break
      let view: Awaited<ReturnType<MissionJournal["missionProjection"]>> | undefined
      try {
        view = await journal.missionProjection(missionID)
      } catch {
        // Never remove a durable record on a transient read error; keep the watchdog alive.
        activeCount++
        continue
      }
      if (!view.mission) {
        await storage.remove?.(coordinatorGoalRecordKey(projectToken, missionID)).catch(() => undefined)
        continue
      }
      if (!view.mission.coordinatorGoal) continue
      if (needsWatchdog(view.mission)) activeCount++
      const result = await reconcileMissionMap(view.mission).catch(() => undefined)
      if (result && result.decision.kind !== "noop") reconciled++
    }
    await runEffect(syncWatchdog(activeCount > 0))
    return reconciled
  }

  const cleanupMission = async (missionID: string): Promise<void> => {
    if (!active) return
    const storage = missionStorage()
    await storage.remove?.(coordinatorGoalRecordKey(projectToken, missionID)).catch(() => undefined)
    if (!(await hasAnyActiveGoalMission())) await runEffect(syncWatchdog(false))
  }

  // Register the unattended Code Mode watchdog tool.
  yield* ctx.tool.transform(editor => editor.add({
    name: COORDINATOR_GOAL_TOOL.name,
    description: "Internal CodeNomad Mission coordinator /goal watchdog. Only the project watchdog automation can call it.",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { namespace: COORDINATOR_GOAL_TOOL.namespace, codemode: true, permission: COORDINATOR_GOAL_TOOL.permission },
    execute: (_input, tool) => {
      return invocation.capture(Effect.gen(function* () {
        if ((yield* unattended) === undefined || tool.sessionID !== carrierSessionID) {
          throw new Error("coordinator-goal-reconcile-caller")
        }
        const count = yield* Effect.promise(() => reconcileProject())
        return { content: JSON.stringify({ reconciled: count }) }
      })).pipe(Effect.catchCause(cause => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        const error = Cause.squash(cause)
        const message = error instanceof Error && /^coordinator-goal-[a-z-]+$/.test(error.message)
          ? error.message : "coordinator-goal-reconcile-failed"
        return Effect.fail(new Tool.Error({ message }))
      }))
    },
  }))

  // Observe live `rpc.opencode.goal.changed` events to adopt queued arming IDs and clear
  // stale mission-pause markers without polling.
  const eventFiber = yield* Effect.forkScoped(
    goalRpc.events.subscribe("changed").pipe(
      Stream.runForEach(event => Effect.promise(async () => {
        if (!active) return
        const sessionID = event?.data?.sessionID
        if (typeof sessionID !== "string" || !sessionID) return
        const storage = missionStorage()
        const prefix = coordinatorGoalRecordPrefix(projectToken)
        let after: string | undefined
        do {
          const page = await storage.scan({ prefix, after, limit: WATCHDOG_SCAN_LIMIT })
          for (const entry of page.entries) {
            const record = parseCoordinatorGoalRecord(entry.value)
            if (record && record.sessionID === sessionID) {
              await reconcileMission(record.missionID).catch(() => undefined)
              return
            }
          }
          after = page.next
        } while (after)
      })),
      Effect.catch(() => Effect.void),
    ),
  )
  yield* Effect.addFinalizer(() => Fiber.interrupt(eventFiber).pipe(Effect.ignore))

  return {
    carrierSessionID,
    reconcile: reconcileMissionMap,
    reconcileProject,
    cleanupMission,
  } satisfies NativeCoordinatorGoalRuntime
})

export { COORDINATOR_GOAL_STORAGE_PREFIX }
