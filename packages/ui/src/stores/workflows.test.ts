import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { WorkflowRun } from "../../../server/src/api-types.ts"
import { ApiRequestError, serverApi } from "../lib/api-client.ts"
import { serverEvents } from "../lib/server-events.ts"
import { sseManager } from "../lib/sse-manager.ts"
import type { Instance } from "../types/instance.ts"
import {
  WORKFLOW_CLIENT_HISTORY_LIMIT,
  createWorkflowResponseFence,
  reconcileWorkflowDefinitions,
  reconcileWorkflowRunList,
  reconcileWorkflowRuns,
} from "./workflow-reconciliation.ts"
import { createWorkflowRefreshCoordinator } from "./workflow-refresh.ts"
import {
  getWorkflowRuns,
  isWorkflowRunHydrating,
  mountWorkflowInstance,
  refreshWorkflowRun,
  upsertWorkflowRun,
} from "./workflows.ts"
import {
  WORKFLOW_INPUT_BYTES_LIMIT,
  WORKFLOW_INPUT_DEPTH_LIMIT,
  buildWorkflowExecutionTree,
  formatWorkflowError,
  formatWorkflowRunTime,
  parseWorkflowObject,
  resolveWorkflowRunWorkspaceId,
} from "../components/instance/shell/right-panel/tabs/workflow-helpers.ts"

const run = (id: string, updatedAt: string, status: WorkflowRun["status"]): WorkflowRun => ({
  id,
  workspaceId: "workspace",
  workspaceLineageId: "lineage",
  workspacePath: "/workspace",
  objective: id,
  status,
  steps: [],
  createdAt: updatedAt,
  updatedAt,
})

test("workflow reconciliation keeps the newest run update and sorts newest first", () => {
  const current = [run("same", "2026-07-20T12:00:00.000Z", "completed")]
  const incoming = [
    run("older-list-entry", "2026-07-20T10:00:00.000Z", "completed"),
    run("same", "2026-07-20T11:00:00.000Z", "running"),
  ]

  const reconciled = reconcileWorkflowRuns(current, incoming)
  assert.deepEqual(reconciled.map(({ id }) => id), ["same", "older-list-entry"])
  assert.equal(reconciled[0].status, "completed")
})

test("workflow reconciliation caps history and removes absent terminal runs without losing concurrent updates", () => {
  const many = Array.from({ length: WORKFLOW_CLIENT_HISTORY_LIMIT + 5 }, (_, index) =>
    run(`run-${index}`, new Date(1_700_000_000_000 + index).toISOString(), "completed"))
  assert.equal(reconcileWorkflowRuns([], many).length, WORKFLOW_CLIENT_HISTORY_LIMIT)

  const staleTerminal = run("stale", "2026-07-20T11:00:00.000Z", "completed")
  const concurrent = run("concurrent", "2026-07-20T10:00:00.000Z", "completed")
  const active = run("active", "2026-07-20T11:00:00.000Z", "waiting_for_review")
  const reconciled = reconcileWorkflowRunList(
    [staleTerminal, concurrent, active],
    [run("concurrent", concurrent.updatedAt, "running")],
    new Set(["concurrent"]),
  )
  assert.deepEqual(reconciled.map(({ id }) => id), ["active", "concurrent"])
})

test("workflow reconciliation prefers run revisions over timestamps when both are available", () => {
  const current = { ...run("same", "2026-07-20T12:00:00.000Z", "running"), revision: 4 }
  const olderRevision = { ...run("same", "2026-07-20T13:00:00.000Z", "completed"), revision: 3 }
  const newerRevision = { ...run("same", "2026-07-20T11:00:00.000Z", "paused"), revision: 5 }
  assert.equal(reconcileWorkflowRuns([current], [olderRevision])[0].status, "running")
  assert.equal(reconcileWorkflowRuns([current], [newerRevision])[0].status, "paused")
})

test("authoritative lists replace equal-revision compact run details", () => {
  const compact = { ...run("same", "2026-07-20T12:00:00.000Z", "running"), revision: 4, pendingGate: undefined }
  const full = { ...compact, executionNodes: [{
    id: "00000000-0000-4000-8000-000000000000", instanceKey: "work", definitionNodeId: "work",
    type: "agent" as const, status: "completed" as const, attempt: 1, output: "complete",
  }] }
  assert.equal(reconcileWorkflowRunList([compact], [full], new Set([compact.id]))[0], full)
})

test("declarative workflow helpers preserve execution order and require object inputs", () => {
  const node = (instanceKey: string, parentInstanceKey?: string) => ({
    id: `${instanceKey}00000000-0000-4000-8000-000000000000`.slice(-36),
    instanceKey,
    definitionNodeId: instanceKey,
    type: "agent" as const,
    status: "pending" as const,
    attempt: 0,
    parentInstanceKey,
  })
  const tree = buildWorkflowExecutionTree([node("root"), node("second", "root"), node("first", "root")])
  assert.deepEqual(tree[0].children.map(({ node: child }) => child.instanceKey), ["second", "first"])
  assert.deepEqual(parseWorkflowObject('{"name":"Ada"}'), { name: "Ada" })
  assert.throws(() => parseWorkflowObject("[]"), /object_required/)
})

test("workflow input parsing rejects excessive bytes and depth", () => {
  assert.throws(() => parseWorkflowObject(JSON.stringify({ value: "x".repeat(WORKFLOW_INPUT_BYTES_LIMIT) })), /input_too_large/)
  let nested: Record<string, unknown> = {}
  for (let index = 0; index <= WORKFLOW_INPUT_DEPTH_LIMIT; index++) nested = { child: nested }
  assert.throws(() => parseWorkflowObject(JSON.stringify(nested)), /input_too_deep/)
})

test("definition reconciliation fences stale responses, revisions, and tombstones", () => {
  const fence = createWorkflowResponseFence()
  const stale = fence.next()
  const current = fence.next()
  assert.equal(fence.isCurrent(stale), false)
  assert.equal(fence.isCurrent(current), true)
  const record = (revision: number) => ({
    id: "saved", revision, canonical: "{}", createdAt: "now", updatedAt: "now",
    definition: { version: 1 as const, id: "saved", name: "Saved", root: { type: "agent" as const, id: "work", instructions: "Work" } },
  })
  assert.equal(reconcileWorkflowDefinitions([record(2)], [record(1)], new Set(), new Set())[0].revision, 2)
  assert.deepEqual(reconcileWorkflowDefinitions([record(2)], [record(2)], new Set(), new Set(["saved"])), [])
})

test("workflow controls refresh revisions before start and wait for definition deletion", () => {
  const source = readFileSync(new URL("./workflows.ts", import.meta.url), "utf8")
  const reconnect = source.slice(source.indexOf("serverEvents.onOpen"), source.indexOf("export {"))
  assert.match(reconnect, /loadWorkflowDefinitions\(\)/)
  const start = source.slice(source.indexOf("async function startWorkflowDefinition"), source.indexOf("async function approveWorkflowRun"))
  assert.ok(start.indexOf("await serverApi.getWorkflowDefinition(id)") < start.indexOf("serverApi.startWorkflowDefinition(id"))
  assert.match(start, /latest\.revision !== revision/)
  assert.match(start, /current\?\.revision !== revision/)
  const getDefinition = start.indexOf("await serverApi.getWorkflowDefinition(id)")
  const tombstoneCheck = start.indexOf("workflowDefinitionTombstones().has(id)", getDefinition)
  assert.ok(getDefinition < tombstoneCheck)
  assert.ok(tombstoneCheck < start.indexOf("upsertWorkflowDefinition(latest)"))
  const upsert = source.slice(source.indexOf("function upsertWorkflowDefinition"), source.indexOf("function invalidateWorkflowDefinitionLists"))
  assert.match(upsert, /existing\.revision > record\.revision/)
  assert.match(upsert, /workflowDefinitionTombstones\(\)\.has\(record\.id\)/)
  const remove = source.slice(source.indexOf("async function deleteWorkflowDefinition"), source.indexOf("async function startWorkflowDefinition"))
  assert.ok(remove.indexOf("await serverApi.deleteWorkflowDefinition") < remove.indexOf("setWorkflowDefinitionTombstones"))
  assert.ok(remove.indexOf("await serverApi.deleteWorkflowDefinition") < remove.indexOf("setWorkflowDefinitions"))
  assert.match(remove, /setWorkflowDefinitionTombstones/)
  assert.match(remove, /setWorkflowDeclarativeDrafts/)
})

test("mounted declarative builders clear tombstoned selections and cannot recreate their deleted source", () => {
  const source = readFileSync(new URL("../components/instance/shell/right-panel/tabs/DeclarativeWorkflowBuilder.tsx", import.meta.url), "utf8")
  assert.match(source, /workflowDefinitionTombstones\(\)\.has\(id\)/)
  assert.match(source, /setSelectedId\(""\)/)
  assert.match(source, /setBaselineRevision\(undefined\)/)
  assert.match(source, /setSource\(""\)/)
  assert.match(source, /disabled=\{Boolean\(busy\(\)\) \|\| !source\(\)\.trim\(\)\}/)
})

test("simple workflow creation uses the host route with workspace identity", async () => {
  const originalFetch = globalThis.fetch
  let request: { input?: string; init?: RequestInit } = {}
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init }
    return new Response(JSON.stringify({ id: "run" }), { status: 202, headers: { "Content-Type": "application/json" } })
  }
  try {
    await serverApi.createWorkflowRun("workspace", {
      objective: "Ship",
      stages: [{
        id: "build", title: "Build", instructions: "Build it",
        model: { providerId: "provider", modelId: "model" },
      }],
    })
    assert.equal(request.input, "/api/workflow-runs")
    assert.equal(request.init?.method, "POST")
    assert.deepEqual(JSON.parse(String(request.init?.body)), {
      workspaceId: "workspace",
      objective: "Ship",
      stages: [{
        id: "build", title: "Build", instructions: "Build it",
        model: { providerID: "provider", modelID: "model" },
      }],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("retained workflow sessions resolve only to their execution workspace lineage", () => {
  const retained = { ...run("retained", "2026-07-20T12:00:00.000Z", "completed"), workspaceId: "old-workspace" }
  const instance = (id: string, lineageId: string): Instance => ({
    id, lineageId, folder: `/${id}`, port: 0, pid: 0, proxyPath: "", status: "ready", client: null,
  })
  assert.equal(resolveWorkflowRunWorkspaceId(retained, new Map([["old-workspace", instance("old-workspace", "other")]])), "old-workspace")
  assert.equal(resolveWorkflowRunWorkspaceId(retained, new Map([["restored", instance("restored", "lineage")]])), "restored")
  assert.equal(resolveWorkflowRunWorkspaceId(retained, new Map([["panel", instance("panel", "other")]])), undefined)
})

test("workflow errors and dates use localized UI formatting", () => {
  const t = (key: string) => key
  assert.equal(formatWorkflowError(new ApiRequestError("raw English", 404), t), "instanceShell.workflows.errors.notFound")
  assert.equal(formatWorkflowError(new ApiRequestError("raw English", 503), t), "instanceShell.workflows.errors.unavailable")
  assert.equal(formatWorkflowError(new Error("raw English"), t), "instanceShell.workflows.errors.action")
  const value = "2026-07-20T12:00:00.000Z"
  assert.equal(formatWorkflowRunTime(value, "de"), new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)))
  assert.equal(formatWorkflowRunTime("invalid", "de"), "invalid")
})

test("workflow run and node details default closed and mount bodies only while expanded", () => {
  const runList = readFileSync(new URL("../components/instance/shell/right-panel/tabs/WorkflowRunList.tsx", import.meta.url), "utf8")
  assert.match(runList, /createSignal\(""\)/)
  assert.doesNotMatch(runList, /setExpandedId\(props\.runs\[0\]/)
  assert.match(runList, /aria-controls=\{detailsId\(\)\}/)
  assert.match(runList, /hidden=\{!props\.expanded\}/)
  const tree = readFileSync(new URL("../components/instance/shell/right-panel/tabs/WorkflowExecutionTree.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(tree, /<details open>/)
  assert.match(tree, /<Show when=\{open\(\)\}>/)
})

test("legacy approval sends the pending review step as its expectation", async () => {
  const originalFetch = globalThis.fetch
  let request: { input?: string; init?: RequestInit } = {}
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init }
    return new Response(JSON.stringify({ id: "run" }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    await serverApi.approveWorkflowRun("workspace", "run", "review-step")
    assert.equal(request.input, "/api/workflow-runs/run/approve")
    assert.equal(request.init?.method, "POST")
    assert.deepEqual(JSON.parse(String(request.init?.body)), { expectedStepId: "review-step" })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("workflow confirmations retain the displayed gate and recovery revision", async () => {
  const source = readFileSync(new URL("../components/instance/shell/right-panel/tabs/WorkflowRunList.tsx", import.meta.url), "utf8")
  const approve = source.slice(source.indexOf("const approve = async"), source.indexOf("const cancel = async"))
  assert.ok(approve.indexOf("const gate = props.run.pendingGate") < approve.indexOf("showConfirmDialog"))
  assert.match(approve, /answerWorkflowGate\(props\.instanceId, props\.run\.id, gate\.executionNodeId, true\)/)
  const recover = source.slice(source.indexOf("const recover = async"), source.indexOf("const answerInput = async"))
  assert.ok(recover.indexOf("const expectedRevision = props.run.revision") < recover.indexOf("showConfirmDialog"))
  assert.match(recover, /resumeWorkflowRun\(props\.instanceId, props\.run\.id, true, expectedRevision\)/)

  const originalFetch = globalThis.fetch
  let body: unknown
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ id: "run" }), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  try {
    await serverApi.resumeWorkflowRun("run", { confirmRecovery: true, expectedRevision: 7 })
    assert.deepEqual(body, { confirmRecovery: true, expectedRevision: 7 })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("workflow checkpoint events stay compact and refresh full boundary state", () => {
  const manager = readFileSync(new URL("../../../server/src/workflows/manager.ts", import.meta.url), "utf8")
  const publish = manager.slice(manager.indexOf('type: "workflow.run.updated"'), manager.indexOf("if ([\"completed\"", manager.indexOf('type: "workflow.run.updated"')))
  assert.match(publish, /runId: snapshot\.id/)
  assert.doesNotMatch(publish, /run: snapshot/)

  const store = readFileSync(new URL("./workflows.ts", import.meta.url), "utf8")
  const update = store.slice(store.indexOf("sseManager.onWorkflowRunUpdated"), store.indexOf("serverEvents.onOpen"))
  assert.match(update, /status !== "running" && status !== "pausing"/)
  assert.match(update, /refreshWorkflowRun\(instanceId, runId, event\.properties\?\.revision\)/)
})

test("workflow refreshes coalesce duplicate boundaries and fetch once more for a newer in-flight revision", async () => {
  let resolve!: () => void
  let calls = 0
  const revisions: Array<number | undefined> = []
  const refresh = createWorkflowRefreshCoordinator(async (_instanceId, _runId, revision) => {
    calls += 1
    revisions.push(revision)
    await new Promise<void>((done) => { resolve = done })
  })

  const settled = refresh("workspace", "run", 4)
  refresh("workspace", "run", 4)
  refresh("workspace", "run", 5)
  refresh("workspace", "run", 6)
  assert.equal(calls, 1)
  resolve()
  await new Promise((done) => setImmediate(done))
  assert.equal(calls, 2)
  assert.deepEqual(revisions, [4, 6])
  resolve()
  await settled
})

test("workflow refresh runs the newest queued revision after an earlier refresh fails", async () => {
  let reject!: (error: unknown) => void
  const revisions: Array<number | undefined> = []
  const refresh = createWorkflowRefreshCoordinator(async (_instanceId, _runId, revision) => {
    revisions.push(revision)
    if (revisions.length === 1) await new Promise<void>((_resolve, fail) => { reject = fail })
  })
  const settled = refresh("workspace", "run", 7)
  refresh("workspace", "run", 8)
  reject(new Error("stale request failed"))
  await settled
  assert.deepEqual(revisions, [7, 8])
})

test("compact workflow revisions disable stale gate and recovery confirmations until hydration", () => {
  const store = readFileSync(new URL("./workflows.ts", import.meta.url), "utf8")
  const refresh = store.slice(store.indexOf("const requestWorkflowRunRefresh"), store.indexOf("function refreshWorkflowRun"))
  assert.doesNotMatch(refresh, /clearWorkflowRunHydrating/)
  assert.match(refresh, /scheduleWorkflowRunRefresh\(instanceId, runId, revision\)/)

  const update = store.slice(store.indexOf("sseManager.onWorkflowRunUpdated"), store.indexOf("serverEvents.onOpen"))
  assert.match(update, /markWorkflowRunHydrating\(instanceId, runId, event\.properties\.revision\)/)
  assert.match(update, /upsertWorkflowRun\(instanceId, updated, Boolean\(run\)\)/)
  assert.match(update, /pendingGate: undefined/)
  assert.match(update, /pendingReviewStepId: undefined/)

  const load = store.slice(store.indexOf("async function loadWorkflowRuns"), store.indexOf("async function createWorkflowRun"))
  assert.match(load, /markWorkflowRunHydrated\(instanceId, run\)/)

  const list = readFileSync(new URL("../components/instance/shell/right-panel/tabs/WorkflowRunList.tsx", import.meta.url), "utf8")
  assert.equal(list.match(/disabled=\{busy\(\) \|\| detailsHydrating\(\)\}/g)?.length, 4)
  assert.match(list, /!confirmed \|\| detailsHydrating\(\) \|\| props\.run\.revision !== expectedRevision/)
  assert.match(list, /confirmed && !detailsHydrating\(\) && props\.run\.revision === expectedRevision/)
})

test("compact workflow hydration stays closed across stale responses and retries while mounted", async () => {
  const instanceId = "stale-hydration-workspace"
  const compact = {
    ...run("stale-hydration-run", "2026-07-20T12:00:00.000Z", "running"),
    revision: 1,
    pendingReviewStepId: "old-review",
  }
  const hydrated = {
    ...compact,
    status: "waiting_for_review" as const,
    revision: 2,
    updatedAt: "2026-07-20T12:01:00.000Z",
    pendingReviewStepId: "new-review",
  }
  const originalGetWorkflowRun = serverApi.getWorkflowRun
  let calls = 0
  serverApi.getWorkflowRun = async () => {
    calls += 1
    return calls === 1 ? compact : hydrated
  }
  const unmount = mountWorkflowInstance(instanceId)
  try {
    upsertWorkflowRun(instanceId, compact)
    sseManager.onWorkflowRunUpdated?.(instanceId, {
      type: "workflow.run.updated",
      properties: {
        runId: compact.id,
        revision: 2,
        status: "waiting_for_review",
        updatedAt: "2026-07-20T12:01:00.000Z",
      },
    })
    assert.equal(isWorkflowRunHydrating(instanceId, compact.id), true)

    await new Promise((done) => setImmediate(done))
    assert.equal(calls, 1)
    assert.equal(isWorkflowRunHydrating(instanceId, compact.id), true)
    assert.equal(getWorkflowRuns(instanceId).find(({ id }) => id === compact.id)?.pendingReviewStepId, undefined)

    await new Promise((done) => setTimeout(done, 350))
    assert.equal(calls, 2)
    assert.equal(isWorkflowRunHydrating(instanceId, compact.id), false)
    assert.equal(getWorkflowRuns(instanceId).find(({ id }) => id === compact.id)?.revision, 2)
    assert.equal(getWorkflowRuns(instanceId).find(({ id }) => id === compact.id)?.pendingReviewStepId, "new-review")
  } finally {
    unmount()
    serverApi.getWorkflowRun = originalGetWorkflowRun
    const events = serverEvents as unknown as {
      connectGeneration: number
      retryTimer: ReturnType<typeof setTimeout> | null
      connection: { disconnect(): void } | null
    }
    events.connectGeneration += 1
    if (events.retryTimer) clearTimeout(events.retryTimer)
    events.connection?.disconnect()
  }
})

test("replay reset participants propagate authoritative status, interruption, Yolo, and workflow failures", () => {
  const sessions = readFileSync(new URL("./session-api.ts", import.meta.url), "utf8")
  const fetch = sessions.slice(sessions.indexOf("async function fetchSessions"), sessions.indexOf("async function loadMoreSessions"))
  assert.match(fetch, /requestData<Record<string, any>>\(rootClient\.session\.status\(\), "session\.status"\)/)
  assert.match(fetch, /if \(options\?\.propagateErrors\) throw error/)

  const instances = readFileSync(new URL("./instances.ts", import.meta.url), "utf8")
  const permissions = instances.slice(instances.indexOf("async function syncPendingPermissions"), instances.indexOf("async function syncPendingQuestions"))
  const questions = instances.slice(instances.indexOf("async function syncPendingQuestions"), instances.indexOf("function startInstanceSessionHydration"))
  assert.match(permissions, /if \(propagateErrors\) throw error/)
  assert.match(questions, /if \(propagateErrors\) throw error/)
  const replay = instances.slice(instances.indexOf("async function rehydrateInstance"), instances.indexOf("async function disposeInstance"))
  assert.match(replay, /refreshYoloState\(instanceId, sessionId\)/)
  assert.match(replay, /propagateErrors: options\?\.replayReset/)

  const workflows = readFileSync(new URL("./workflows.ts", import.meta.url), "utf8")
  const reset = workflows.slice(workflows.indexOf("serverEvents.onReplayReset"), workflows.indexOf("export {"))
  assert.match(reset, /loadWorkflowDefinitions\(\{ propagateErrors: true \}\)/)
  assert.match(reset, /loadWorkflowRuns\(instanceId, \{ propagateErrors: true \}\)/)
})

test("opening workflow sessions selects their app tab and run cards survive object replacement", () => {
  const tab = readFileSync(new URL("../components/instance/shell/right-panel/tabs/WorkflowsTab.tsx", import.meta.url), "utf8")
  assert.match(tab, /selectInstanceTab\(workspaceId\)/)
  assert.doesNotMatch(tab, /setActiveInstanceId\(workspaceId\)/)
  const list = readFileSync(new URL("../components/instance/shell/right-panel/tabs/WorkflowRunList.tsx", import.meta.url), "utf8")
  assert.match(list, /visibleRuns\(\)\.map\(\(\{ id \}\) => id\)/)
  assert.match(list, /props\.runs\.find\(\(\{ id \}\) => id === runId\)/)
})
