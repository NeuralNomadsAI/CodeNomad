import assert from "node:assert/strict"
import test from "node:test"
import {
  COORDINATOR_GOAL_MAX_RESTART_RESUMES,
  COORDINATOR_GOAL_OBJECTIVE_MAX,
  COORDINATOR_GOAL_RESTART_REASON,
  coordinatorGoalObjective,
  coordinatorGoalRecordKey,
  parseCoordinatorGoalRecord,
  reconcileCoordinatorGoal,
  reconcileCoordinatorGoalDecision,
  type CoordinatorGoalRecord,
  type LiveCoordinatorGoal,
} from "./coordinator-goal"
import { parseMissionEvent } from "./journal"
import { reduceMissionEvents, type MissionEvent, type MissionJsonValue, type MissionMap } from "./model"
import { setupMissionsPlugin } from "../opencode/missions-plugin"

const baseMission = (overrides: Partial<MissionMap> = {}): Pick<MissionMap, "id" | "title" | "objective" | "status" | "runState" | "coordinatorGoal" | "coordinatorSessionId"> => ({
  id: "msn_goal_test_001",
  title: "Ship feature X",
  objective: "Implement feature X with tests and verification",
  status: "active",
  runState: "running",
  coordinatorGoal: true,
  coordinatorSessionId: "ses_coord_001",
  ...overrides,
})

const liveGoal = (overrides: Partial<LiveCoordinatorGoal> = {}): LiveCoordinatorGoal => ({
  id: "goal_1",
  objective: coordinatorGoalObjective(baseMission()),
  status: "active",
  rounds: 0,
  maxRounds: 50,
  boot: "boot-a",
  updatedAt: 1_000,
  ...overrides,
})

test("coordinatorGoalObjective produces bounded, quote-free, control-word-safe text", () => {
  const short = coordinatorGoalObjective({ title: "Fix bug", objective: "Fix the race condition" })
  assert.ok(short.length <= COORDINATOR_GOAL_OBJECTIVE_MAX)
  assert.ok(short.includes("Fix bug"))
  assert.ok(short.includes("mission.report"))

  const huge = coordinatorGoalObjective({ title: "Huge", objective: "A".repeat(20_000) })
  assert.ok(huge.length <= COORDINATOR_GOAL_OBJECTIVE_MAX)
  assert.ok(huge.includes("…"))

  for (const word of ["pause", "resume", "clear", "status", '"pause"', "'resume'"]) {
    const out = coordinatorGoalObjective({ title: undefined, objective: word })
    assert.notEqual(out.toLowerCase(), "pause")
    assert.notEqual(out.toLowerCase(), "resume")
    assert.notEqual(out.toLowerCase(), "clear")
    assert.ok(out.startsWith("Mission: "))
  }
})

test("pure reconciler never acts when disabled, prepared, or while lifecycle control is pending", () => {
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ coordinatorGoal: undefined }), undefined, null), { kind: "noop", reason: "disabled" })
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ coordinatorGoal: false }), undefined, null), { kind: "noop", reason: "disabled" })
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ runState: "prepared" }), undefined, null), { kind: "noop", reason: "prepared" })
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({
    control: { id: "op_1", missionID: "msn_goal_test_001", requestID: "req_1", expectedRevision: 1, action: "start", targets: [{ sessionID: "ses_coord_001", location: { directory: "/repo" } }], pending: ["ses_coord_001"] },
  }), undefined, null), { kind: "noop", reason: "control-pending" })
})

test("reconcileCoordinatorGoal aborts without mutating when opencode.goal RPC is unavailable", async () => {
  const store = new Map<string, MissionJsonValue>()
  let commanded = false
  const result = await reconcileCoordinatorGoal(baseMission({ runState: "running" }), {
    projectToken: "proj_tok",
    readRecord: async key => store.get(key),
    writeRecord: async (key, value) => { store.set(key, value) },
    readGoal: async () => "unavailable",
    runGoalCommand: async () => { commanded = true },
  })
  assert.deepEqual(result.decision, { kind: "noop", reason: "goal-rpc-unavailable" })
  assert.equal(commanded, false)
  assert.equal(store.size, 0)
})

test("pure reconciler arms running mission and never overwrites a pre-existing foreign goal", () => {
  const decision = reconcileCoordinatorGoalDecision(baseMission(), undefined, null)
  assert.equal(decision.kind, "arm")

  // Attached session already had its own user `/goal` before mission armed.
  const foreign = reconcileCoordinatorGoalDecision(baseMission(), undefined, liveGoal({ id: "user_goal_99", objective: "User custom goal" }))
  assert.deepEqual(foreign, { kind: "noop", reason: "foreign-goal" })
})

test("pure reconciler adopts queued arm, handles mission pause/resume, and respects user pauses/clears", () => {
  const objective = coordinatorGoalObjective(baseMission())
  const armingRecord: CoordinatorGoalRecord = {
    version: 1, missionID: "msn_goal_test_001", sessionID: "ses_coord_001",
    armingAt: 1000, armingObjective: objective, restartResumes: 0, lastAction: "arming", updatedAt: 1000,
  }
  // While still queued, second tick does not re-arm.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), armingRecord, null, 2000), { kind: "noop", reason: "arming-in-flight" })
  // Once materialized with matching objective, adopt its ID.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), armingRecord, liveGoal({ id: "goal_new", objective })), { kind: "adopt-armed", goalID: "goal_new" })

  const armedRecord: CoordinatorGoalRecord = {
    version: 1, missionID: "msn_goal_test_001", sessionID: "ses_coord_001",
    goalID: "goal_1", restartResumes: 0, lastAction: "armed", updatedAt: 1000,
  }
  // User manually cleared the goal: never re-arm.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), armedRecord, null), { kind: "noop", reason: "user-cleared" })
  // User replaced with another goal: never touch it.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ runState: "paused" }), armedRecord, liveGoal({ id: "goal_foreign" })), { kind: "noop", reason: "foreign-goal" })
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ status: "completed" }), armedRecord, liveGoal({ id: "goal_foreign" })), { kind: "forget" })

  // Mission Pause pauses owned active goal.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ runState: "paused" }), armedRecord, liveGoal()), { kind: "pause", goalID: "goal_1" })
  // If user already paused the goal before pausing the mission, Mission Pause does NOT mark pausedByMissionAt.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ runState: "paused" }), armedRecord, liveGoal({ status: "paused", reason: "Paused by user" })), { kind: "noop", reason: "mission-paused" })

  // Mission Resume resumes only goals paused by Mission Pause.
  const pausedByMission: CoordinatorGoalRecord = { ...armedRecord, pausedByMissionAt: 2000, lastAction: "paused-mission" }
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ runState: "running" }), pausedByMission, liveGoal({ status: "paused", reason: "Paused" })), { kind: "resume-mission-pause", goalID: "goal_1" })
  // If user already manually resumed the goal while mission was running, clear stale marker.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission({ runState: "running" }), pausedByMission, liveGoal({ status: "active" })), { kind: "clear-mission-pause" })

  // Human / stall / maxRounds pauses are NEVER auto-resumed.
  for (const reason of ["Paused", "No progress across 3 rounds", "Reached maximum rounds (50)", "The goal reviewer gave no usable verdict", undefined]) {
    assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), armedRecord, liveGoal({ status: "paused", reason })), { kind: "noop", reason: "non-resumable-pause" })
  }
})

test("pure reconciler auto-resumes restart pauses once per dead boot up to max limit", () => {
  const armedRecord: CoordinatorGoalRecord = {
    version: 1, missionID: "msn_goal_test_001", sessionID: "ses_coord_001",
    goalID: "goal_1", restartResumes: 0, lastAction: "armed", updatedAt: 1000,
  }
  const restarted = liveGoal({ status: "paused", reason: COORDINATOR_GOAL_RESTART_REASON, boot: "boot-dead-1", updatedAt: 5000 })
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), armedRecord, restarted), {
    kind: "resume-restart", goalID: "goal_1", deadBoot: "boot-dead-1", pausedAt: 5000,
  })

  // Same dead boot is deduped.
  const after1: CoordinatorGoalRecord = { ...armedRecord, restartResumes: 1, lastResumedBoot: "boot-dead-1", lastResumedPausedAt: 5000 }
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), after1, restarted), { kind: "noop", reason: "already-resumed-boot" })

  // Same updatedAt even without boot is deduped.
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), after1, liveGoal({ status: "paused", reason: COORDINATOR_GOAL_RESTART_REASON, boot: undefined, updatedAt: 5000 })), {
    kind: "noop", reason: "already-resumed-pause",
  })

  // New restart with new dead boot is resumed while under cap.
  const restarted2 = liveGoal({ status: "paused", reason: COORDINATOR_GOAL_RESTART_REASON, boot: "boot-dead-2", updatedAt: 9000 })
  assert.equal(reconcileCoordinatorGoalDecision(baseMission(), after1, restarted2).kind, "resume-restart")

  // Cap enforced at COORDINATOR_GOAL_MAX_RESTART_RESUMES.
  const atLimit: CoordinatorGoalRecord = { ...armedRecord, restartResumes: COORDINATOR_GOAL_MAX_RESTART_RESUMES, lastResumedBoot: "boot-dead-3", lastResumedPausedAt: 12_000 }
  assert.deepEqual(reconcileCoordinatorGoalDecision(baseMission(), atLimit, liveGoal({ status: "paused", reason: COORDINATOR_GOAL_RESTART_REASON, boot: "boot-dead-4", updatedAt: 15_000 })), {
    kind: "noop", reason: "restart-limit-reached",
  })
})

test("reconcileCoordinatorGoal full lifecycle: arm -> pause -> resume -> restart recovery -> clear", async () => {
  const store = new Map<string, MissionJsonValue>()
  const commands: Array<{ sessionID: string; text: string; delivery: "queue" | "steer" }> = []
  const state: { goal: LiveCoordinatorGoal | null } = { goal: null }
  let clock = 10_000
  let currentBoot = "boot-1"

  const adapter = {
    projectToken: "proj_tok",
    now: () => ++clock,
    readRecord: async (key: string) => store.get(key),
    writeRecord: async (key: string, value: MissionJsonValue) => { store.set(key, value) },
    readGoal: async () => state.goal,
    runGoalCommand: async (sessionID: string, text: string, delivery: "queue" | "steer") => {
      commands.push({ sessionID, text, delivery })
      if (text === "pause" && state.goal) state.goal = { ...state.goal, status: "paused", reason: "Paused", updatedAt: ++clock }
      else if (text === "resume" && state.goal) state.goal = { ...state.goal, status: "active", reason: undefined, boot: currentBoot, updatedAt: ++clock }
      else if (text === "clear") state.goal = null
      else state.goal = { id: "goal_live_1", objective: text, status: "active", rounds: 0, maxRounds: 50, boot: currentBoot, updatedAt: ++clock }
    },
  }

  // 1. Prepared -> noop
  const r0 = await reconcileCoordinatorGoal(baseMission({ runState: "prepared" }), adapter)
  assert.equal(r0.decision.kind, "noop")
  assert.equal(commands.length, 0)

  // 2. Play (running) -> arms `/goal` with delivery: "queue" and records goalID
  const r1 = await reconcileCoordinatorGoal(baseMission({ runState: "running" }), adapter)
  assert.equal(r1.decision.kind, "arm")
  assert.equal(r1.record?.goalID, "goal_live_1")
  assert.equal(commands.at(-1)?.delivery, "queue")

  // 3. Pause mission -> pauses goal
  const r2 = await reconcileCoordinatorGoal(baseMission({ runState: "paused" }), adapter)
  assert.equal(r2.decision.kind, "pause")
  assert.equal(state.goal?.status, "paused")
  assert.ok(r2.record?.pausedByMissionAt)

  // 4. Resume mission -> resumes goal
  const r3 = await reconcileCoordinatorGoal(baseMission({ runState: "running" }), adapter)
  assert.equal(r3.decision.kind, "resume-mission-pause")
  assert.equal(state.goal?.status, "active")
  assert.equal(r3.record?.pausedByMissionAt, undefined)

  // 5. Simulate OpenCode daemon restart: status=paused, exact reason, OLD dead boot preserved
  currentBoot = "boot-2"
  state.goal = { ...state.goal!, status: "paused", reason: COORDINATOR_GOAL_RESTART_REASON, boot: "boot-1", updatedAt: ++clock }
  const r4 = await reconcileCoordinatorGoal(baseMission({ runState: "running" }), adapter)
  assert.equal(r4.decision.kind, "resume-restart")
  assert.equal(r4.record?.restartResumes, 1)
  assert.equal(r4.record?.lastResumedBoot, "boot-1")
  assert.equal(state.goal?.status, "active")
  assert.equal(state.goal?.boot, "boot-2")

  // 6. Simulate crash right after persisting restart counter (command throws): second tick does NOT loop on same dead boot!
  currentBoot = "boot-3"
  state.goal = { ...state.goal!, status: "paused", reason: COORDINATOR_GOAL_RESTART_REASON, boot: "boot-2", updatedAt: ++clock }
  await assert.rejects(reconcileCoordinatorGoal(baseMission({ runState: "running" }), {
    ...adapter,
    runGoalCommand: async () => { throw new Error("daemon died mid-resume") },
  }), /daemon died mid-resume/)
  const savedAfterCrash = parseCoordinatorGoalRecord(store.get(coordinatorGoalRecordKey("proj_tok", "msn_goal_test_001")))
  assert.equal(savedAfterCrash?.restartResumes, 2)
  assert.equal(savedAfterCrash?.lastResumedBoot, "boot-2")
  const rRetry = await reconcileCoordinatorGoal(baseMission({ runState: "running" }), adapter)
  assert.deepEqual(rRetry.decision, { kind: "noop", reason: "already-resumed-boot" })

  // 7. Terminal mission (completed) -> clears owned goal
  state.goal = { ...state.goal!, status: "active", boot: "boot-3", updatedAt: ++clock }
  const r5 = await reconcileCoordinatorGoal(baseMission({ status: "completed" }), adapter)
  assert.equal(r5.decision.kind, "clear")
  assert.equal(state.goal, null)
})

test("journal parser and reducer preserve optional coordinatorGoal and stay backward-compatible with old events", () => {
  const base: Omit<Extract<MissionEvent, { type: "mission.created" }>, "coordinatorGoal"> = {
    version: 1, id: "evt_created_1", type: "mission.created", missionID: "msn_001", projectID: "proj_1",
    projectCanonical: "/repo", objective: "Do work", template: "custom",
    coordinator: { sessionID: "ses_1", title: "Lead", location: { directory: "/repo" } }, createdAt: 1,
  }
  const oldParsed = parseMissionEvent(base)
  assert.equal(oldParsed?.type, "mission.created")
  assert.equal(oldParsed.coordinatorGoal, undefined)
  const oldSnap = reduceMissionEvents([oldParsed])
  assert.equal(oldSnap.missions[0]?.coordinatorGoal, undefined)

  const enabledParsed = parseMissionEvent({ ...base, coordinatorGoal: true })
  assert.equal(enabledParsed?.type, "mission.created")
  assert.equal(enabledParsed.coordinatorGoal, true)
  const enabledSnap = reduceMissionEvents([enabledParsed])
  assert.equal(enabledSnap.missions[0]?.coordinatorGoal, true)

  // Invalid non-boolean coordinatorGoal is rejected.
  assert.equal(parseMissionEvent({ ...base, coordinatorGoal: "yes" }), undefined)
})

/** In-memory record store and live goal, with OpenCode's `/goal` commands applied to it. */
function goalFixture(goal: LiveCoordinatorGoal | null = null) {
  const store = new Map<string, MissionJsonValue>(), commands: string[] = [], state = { goal, failNext: false }
  let clock = 50_000
  const key = coordinatorGoalRecordKey("proj_tok", "msn_goal_test_001")
  return { store, commands, state, key, record: () => parseCoordinatorGoalRecord(store.get(key)), adapter: {
    projectToken: "proj_tok", now: () => ++clock,
    readRecord: async (name: string) => store.get(name),
    writeRecord: async (name: string, value: MissionJsonValue) => { store.set(name, value) },
    removeRecord: async (name: string) => { store.delete(name) },
    readGoal: async () => state.goal,
    runGoalCommand: async (_sessionID: string, text: string) => {
      if (state.failNext) { state.failNext = false; throw new Error("command refused") }
      commands.push(text)
      if (text === "clear") state.goal = null
      else if (text === "pause" && state.goal) state.goal = { ...state.goal, status: "paused", reason: "Paused" }
      else if (text === "resume" && state.goal) state.goal = { ...state.goal, status: "active", reason: undefined }
      else if (!["pause", "resume"].includes(text)) state.goal = liveGoal({ id: "goal_live", objective: text })
    },
  } }
}

test("a failed Mission whose goal clears immediately drops its record in the same pass so immediate recovery arms again", async () => {
  const f = goalFixture()
  await reconcileCoordinatorGoal(baseMission(), f.adapter)
  const cleared = await reconcileCoordinatorGoal(baseMission({ status: "failed" }), f.adapter)
  assert.equal(cleared.decision.kind, "clear")
  assert.equal(f.store.has(f.key), false)
  assert.equal((await reconcileCoordinatorGoal(baseMission(), f.adapter)).decision.kind, "arm")
})

test("a finished Mission drops its record once nothing is left to clear, and a recovered one arms again", async () => {
  const f = goalFixture()
  await reconcileCoordinatorGoal(baseMission(), f.adapter)
  assert.equal(f.record()?.goalID, "goal_live")
  // Goal already cleared before terminal pass: the record is forgotten on the terminal pass.
  f.state.goal = null
  assert.equal((await reconcileCoordinatorGoal(baseMission({ status: "failed" }), f.adapter)).decision.kind, "forget")
  assert.equal(f.store.has(f.key), false)
  assert.deepEqual((await reconcileCoordinatorGoal(baseMission({ status: "failed" }), f.adapter)).decision, { kind: "noop", reason: "terminal" })
  // Recovered through the coordinator: the option still applies.
  assert.equal((await reconcileCoordinatorGoal(baseMission(), f.adapter)).decision.kind, "arm")
  assert.deepEqual(f.commands.filter(text => text !== "clear").length, 2)
  // A goal the user cleared while the Mission runs stays cleared.
  f.state.goal = null
  assert.deepEqual((await reconcileCoordinatorGoal(baseMission(), f.adapter)).decision, { kind: "noop", reason: "user-cleared" })
  // A finished Mission never touches another goal on its session, and still drops its record.
  f.state.goal = liveGoal({ id: "user_goal" })
  assert.equal((await reconcileCoordinatorGoal(baseMission({ status: "completed" }), f.adapter)).decision.kind, "forget")
  assert.equal(f.state.goal?.id, "user_goal")
})

test("a Mission that ended or paused while its arm was queued acts on the adopted goal in the same pass", async () => {
  const objective = coordinatorGoalObjective(baseMission())
  for (const [mission, command] of [[baseMission({ status: "completed" }), "clear"], [baseMission({ runState: "paused" }), "pause"]] as const) {
    const f = goalFixture(liveGoal({ id: "goal_late", objective }))
    f.store.set(f.key, { version: 1, missionID: "msn_goal_test_001", sessionID: "ses_coord_001", armingAt: 50_000, armingObjective: objective,
      restartResumes: 0, lastAction: "arming", updatedAt: 50_000 })
    const result = await reconcileCoordinatorGoal(mission, f.adapter)
    assert.deepEqual([result.decision.kind, f.commands], [command, [command]])
  }
  // A queued arm that has not materialised keeps its record after the Mission ended.
  const waiting = goalFixture()
  waiting.store.set(waiting.key, { version: 1, missionID: "msn_goal_test_001", sessionID: "ses_coord_001", armingAt: 50_000, armingObjective: objective,
    restartResumes: 0, lastAction: "arming", updatedAt: 50_000 })
  assert.deepEqual((await reconcileCoordinatorGoal(baseMission({ status: "completed" }), waiting.adapter)).decision, { kind: "noop", reason: "terminal" })
  assert.equal(waiting.store.has(waiting.key), true)
})

test("a refused Mission Resume command is sent again on the next pass", async () => {
  const f = goalFixture()
  await reconcileCoordinatorGoal(baseMission(), f.adapter)
  await reconcileCoordinatorGoal(baseMission({ runState: "paused" }), f.adapter)
  f.state.failNext = true
  await assert.rejects(reconcileCoordinatorGoal(baseMission(), f.adapter), /command refused/)
  assert.equal(f.state.goal?.status, "paused")
  assert.equal((await reconcileCoordinatorGoal(baseMission(), f.adapter)).decision.kind, "resume-mission-pause")
  assert.equal(f.state.goal?.status, "active")
})

test("a Mission without the option never reaches the goal runtime; one with it arrives as its map", async () => {
  const values = new Map<string, MissionJsonValue>(), reconciled: Array<{ id: string; coordinatorGoal?: boolean }> = []
  let handlers: Record<string, (input: unknown, context?: unknown) => Promise<unknown>> | undefined
  const registration = () => ({ dispose: async () => {} })
  const dispose = await setupMissionsPlugin({
    location: { directory: "/repo", project: { id: "project-1", canonical: "/repo" } },
    storage: { get: async (key: string) => values.get(key), set: async (key: string, value: MissionJsonValue) => { values.set(key, structuredClone(value)) },
      scan: async ({ prefix }: { prefix: string }) => ({ entries: [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })) }) },
    session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, projectID: "project-1", title: "Coordinator", location: { directory: "/repo" } }),
      hook: async () => registration() },
    agent: { list: async () => ({ data: [] }) }, model: { list: async () => ({ data: [] }) },
    tool: { transform: async (callback: (draft: unknown) => void) => { callback({ namespace: () => {}, add: () => {} }); return registration() } },
    rpc: { register: async (_definition: unknown, registered: typeof handlers) => { handlers = registered; return { ...registration(), events: { emit: async () => {} } } } },
  } as never, undefined, undefined, undefined, undefined, true, undefined, undefined, {
    reconcile: async (mission: MissionMap) => { reconciled.push({ id: mission.id, coordinatorGoal: mission.coordinatorGoal }) },
    // The runtime's own read by ID: a change must not take it.
    reconcileMission: async (id: string) => { reconciled.push({ id }) }, cleanupMission: async () => {},
  } as never)
  try {
    const context = { error: (...args: unknown[]) => { throw new Error(JSON.stringify(args)) } }
    await handlers!.create({ requestID: "plain", objective: "Plain", template: "custom", coordinatorSessionID: "ses_plain" }, context)
    assert.deepEqual(reconciled, [])
    const kept = await handlers!.create({ requestID: "kept", objective: "Kept", template: "custom", coordinatorSessionID: "ses_kept", coordinatorGoal: true }, context) as { mission: { id: string } }
    assert.deepEqual(reconciled, [{ id: kept.mission.id, coordinatorGoal: true }])
  } finally { await dispose() }
})
