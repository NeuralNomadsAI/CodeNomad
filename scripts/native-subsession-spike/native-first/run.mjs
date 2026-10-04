import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { ASSIGNED_CLI, privateRoot } from "../../missions-child-environment/runtime.mjs"

const experiment = "D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003"
assert.equal(path.resolve(process.cwd()).toLowerCase(), path.resolve(experiment).toLowerCase(), "Run only from the experiment worktree")
const primary = "D:/CodeNomad/.codenomad/worktrees/tauri-integrated-20261002-1841-b62f"
const rollback = "C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-rollback-V0FPSs"
const manifest = JSON.parse(await readFile(path.join(rollback, "source-before.json"), "utf8"))
const sha = value => createHash("sha256").update(value).digest("hex")
async function protectedHashes() {
  const files = await Promise.all(manifest.map(async entry => ({ path: entry.path, sha256: sha(await readFile(path.join(primary, entry.path))) })))
  assert.deepEqual(files, manifest, "Frozen primary source bytes must match rollback manifest")
  const gitDir = path.resolve(primary, (await readFile(path.join(primary, ".git"), "utf8")).trim().slice(8))
  return { files: files.length, digest: sha(JSON.stringify(files)), index: sha(await readFile(path.join(gitDir, "index"))) }
}
const before = await protectedHashes()
for (const key of Object.keys(process.env)) if (/(TOKEN|SECRET|API_KEY|PASSWORD|WSL|CONTEXT)/i.test(key)) delete process.env[key]
const { root, project } = await privateRoot(ASSIGNED_CLI)
const deadline = Date.now() + 240_000
const requests = [], events = [], plans = new Map(), markerPlans = new Map(), holds = new Map(), sessions = new Map()
const results = { protectedBefore: before, stages: [] }
const abort = new AbortController()
let child, closed, watchdog, client, output = "", failure, stage = "launch"
const primaryRequests = id => requests.filter(r => r.sessionID === id && r.kind === "primary")
const contains = (id, text) => primaryRequests(id).some(r => JSON.stringify(r.body.messages).includes(text))
const tool = (name, input, id) => ({ name, input, id })
const sub = (marker, id, extra = {}) => tool("subagent", { agent: "recursive_all", description: marker, prompt: marker, ...extra }, id)
const reporting = (taskKey, summary, id) => tool("first_report", { taskKey, outcome: "completed", summary }, id)
function emit(response, answer) {
  response.setHeader("content-type", "text/event-stream")
  const calls = Array.isArray(answer) ? answer : typeof answer === "string" ? undefined : [answer]
  const delta = calls ? { role: "assistant", tool_calls: calls.map((t, index) => ({ index, id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } })) } : { role: "assistant", content: answer }
  for (const [d, finish_reason] of [[delta, null], [{}, calls ? "tool_calls" : "stop"]]) response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: d, finish_reason }] })}\n\n`)
  response.end("data: [DONE]\n\n")
}
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), sessionID = request.headers["x-first-session"], kind = request.headers["x-first-kind"]
    requests.push({ index: requests.length, sessionID, kind, time: Date.now(), body })
    assert(requests.length <= 200, "Provider budget")
    if (kind !== "primary") { emit(response, "Private title"); return }
    if (!plans.has(sessionID)) {
      for (const [marker, steps] of markerPlans) if (JSON.stringify(body.messages).includes(marker)) { plans.set(sessionID, steps); markerPlans.delete(marker); break }
    }
    const step = plans.get(sessionID)?.shift() ?? {}
    if (step.hold) await new Promise(resolve => { holds.set(step.hold, resolve); response.once("close", resolve) })
    if (response.destroyed) return
    if (step.fail) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "PRIVATE_CHILD_PROVIDER_FAILURE", type: "invalid_request_error" } })); return }
    emit(response, step.answer ?? `DONE:${sessionID}`)
  } catch (error) { failure = error; response.destroy() }
})
async function until(predicate, label = stage) {
  const end = Math.min(deadline, Date.now() + 25000)
  while (Date.now() < end) {
    if (failure) throw failure
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error("Private server exited")
    await delay(30)
  }
  throw new Error("Timeout: " + label)
}
const release = name => { assert(holds.has(name), "Missing provider hold " + name); holds.get(name)(); holds.delete(name) }
const messages = async id => (await client.message.list({ sessionID: id, limit: { order: "asc", limit: 100 } }, { signal: AbortSignal.timeout(10000) })).data
const parts = m => m.flatMap(x => x.content ?? []).filter(p => p.type === "tool")
const wait = id => client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(Math.min(25000, Math.max(1, deadline - Date.now()))) })
const inspect = () => client.rpc({ id: "native.first.fixture", methods: { inspect: { input: { type: "object" }, output: { type: "object" } } }, events: {} }).inspect({}, { location: { directory: project }, signal: AbortSignal.timeout(10000) })
async function create(name, tasks = [], options = {}) {
  const session = await client.session.create({ location: { directory: project }, title: name, ...options })
  sessions.set(name, session.id)
  if (tasks.length) plans.set(session.id, [{ answer: tool("first_start", { objective: name, tasks }, name + "_start") }])
  return session.id
}
async function launchRoot(name, tasks, steps, options) {
  const id = await create(name, tasks, options)
  plans.set(id, [...(plans.get(id) ?? []), ...steps])
  await client.session.prompt({ sessionID: id, text: name })
  return id
}
async function childOf(parentID, callID) {
  await until(async () => parts(await messages(parentID)).some(p => p.id === callID && p.state.metadata?.sessionID))
  return parts(await messages(parentID)).find(p => p.id === callID).state.metadata.sessionID
}
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", default_agent: "recursive_all", update: "disable", snapshots: false, experimental: { subagent_depth: 3 },
    permissions: [{ action: "execute", resource: "*", effect: "deny" }],
    agents: { recursive_all: { mode: "all", description: "Private recursive all-mode experiment", system: "Synthetic private experiment", steps: 12,
      permissions: [{ action: "subagent", resource: "*", effect: "allow" }] },
      recursive_sub: { mode: "subagent", description: "Private recursive subagent-mode experiment", system: "Synthetic private experiment", steps: 12,
        permissions: [{ action: "subagent", resource: "*", effect: "allow" }] } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic" }, models: { fixture: {} } } },
    plugins: [path.dirname(fileURLToPath(import.meta.url))] })
  // Immutable isolation helper reused; its launch assertion is 2.0.21-specific, so launch this assigned 2.0.22 child explicitly.
  child = spawn(ASSIGNED_CLI, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: process.env, windowsHide: true })
  closed = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data })
  watchdog = setTimeout(() => { failure = new Error("Global deadline"); child.kill(); provider.closeAllConnections() }, Math.max(1, deadline - Date.now()))
  watchdog.unref()
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`
  client = OpenCode.make({ baseUrl: url, headers: { authorization } })
  results.server = await client.server.info()
  assert.equal(results.server.version, "2.0.22", "Actual assigned child HTTP version")
  const openapi = await (await fetch(url + "/openapi.json", { headers: { authorization }, signal: AbortSignal.timeout(10000) })).json()
  await writeFile(path.join(root, "openapi.json"), JSON.stringify(openapi, null, 2))
  void (async () => { try { for await (const event of client.event.subscribe({ signal: abort.signal })) events.push(event) } catch (error) { if (!abort.signal.aborted) failure = error } })()
  results.agents = await client.agent.list({ location: { directory: project } })
  results.initialCatalog = await inspect()
  const pluginSource = await readFile(new URL("index.ts", import.meta.url), "utf8")
  assert(!/editor\.(update|remove)|\.execute\s*=|permissionOptions/.test(pluginSource), "Plugin cannot replace native executor, options or schema")
  assert(results.initialCatalog.tools.some(t => t.id === "subagent"))
  results.nativeIsolation = { sourceHash: sha(pluginSource), method: "No editor.update/remove or execute assignment; real provider native schema captured", executorReferenceEquality: "unknown: client/editor adapt tool definitions" }

  stage = "depth three, custom all and subagent mode"
  markerPlans.set("DEPTH_CHILD", [{ answer: sub("DEPTH_GRANDCHILD", "depth_cg", { agent: "recursive_sub" }) }, { answer: "CHILD_CONSUMED_GRANDCHILD" }])
  markerPlans.set("DEPTH_GRANDCHILD", [{ answer: sub("DEPTH_GREATGRANDCHILD", "depth_gg") }, { answer: "GRANDCHILD_CONSUMED_GREATGRANDCHILD" }])
  markerPlans.set("DEPTH_GREATGRANDCHILD", [{ answer: reporting("deep", "GREATGRANDCHILD_BUSINESS_REPORT", "depth_report") }, { answer: "GREATGRANDCHILD_RESULT" }])
  const depthRoot = await launchRoot("depthRoot", ["deep"], [{ answer: sub("DEPTH_CHILD", "depth_rc") }])
  await wait(depthRoot)
  const depthChild = await childOf(depthRoot, "depth_rc"), grandchild = await childOf(depthChild, "depth_cg"), greatgrandchild = await childOf(grandchild, "depth_gg")
  await until(() => contains(depthRoot, "GREATGRANDCHILD_BUSINESS_REPORT"))
  await wait(depthRoot)
  const chain = [depthRoot, depthChild, grandchild, greatgrandchild]
  for (let i = 1; i < chain.length; i++) {
    assert.equal((await client.session.get({ sessionID: chain[i] })).parentID, chain[i - 1])
    const first = primaryRequests(chain[i])[0]
    assert(JSON.stringify(first.body.messages).includes("NATIVE_FIRST_CONTRACT:"), "Inherited contract in first model request")
    assert(first.body.tools.some(t => t.function.name === "subagent"), "Explicit recursive custom agent exposes native subagent")
  }
  assert(contains(grandchild, "GREATGRANDCHILD_RESULT"))
  assert(contains(depthChild, "GRANDCHILD_CONSUMED_GREATGRANDCHILD"))
  assert(contains(depthRoot, "CHILD_CONSUMED_GRANDCHILD"))
  const depthSnapshot = await inspect()
  for (const id of chain.slice(1)) {
    const firstContext = depthSnapshot.traces.find(trace => trace.sessionID === id)
    assert(firstContext.binding.lineage.every(edge => edge.callIDs.length > 0), "Native callIDs observed by the first child context in this run")
  }
  assert.equal(depthSnapshot.snapshot.missions.find(m => m.coordinatorSessionId === depthRoot)?.tasks[0]?.status,
    "completed", "Existing business reducer receives explicit report")
  results.depth = { chain, firstRequests: chain.map(id => primaryRequests(id)[0].index), consumption: {
    greatgrandchildToGrandchild: primaryRequests(grandchild).find(r => JSON.stringify(r.body.messages).includes("GREATGRANDCHILD_RESULT"))?.index,
    grandchildToChild: primaryRequests(depthChild).find(r => JSON.stringify(r.body.messages).includes("GRANDCHILD_CONSUMED_GREATGRANDCHILD"))?.index,
    childToRoot: primaryRequests(depthRoot).find(r => JSON.stringify(r.body.messages).includes("CHILD_CONSUMED_GRANDCHILD"))?.index,
    reportToCoordinator: primaryRequests(depthRoot).find(r => JSON.stringify(r.body.messages).includes("GREATGRANDCHILD_BUSINESS_REPORT"))?.index } }
  results.stages.push(stage)

  stage = "same-child continuation and foreign-parent negative"
  plans.set(depthRoot, [{ answer: sub("CONTINUE_DEPTH_CHILD", "continue_rc", { sessionID: depthChild }) }])
  await client.session.prompt({ sessionID: depthRoot, text: "Continue the existing native child" })
  await wait(depthRoot)
  assert.equal(await childOf(depthRoot, "continue_rc"), depthChild)
  assert.equal(events.filter(e => e.type === "session.created" && e.data.parentID === depthRoot).length, 1)
  assert(contains(depthChild, "CONTINUE_DEPTH_CHILD"))
  const requestCount = primaryRequests(depthChild).length
  const foreign = await launchRoot("foreignParent", [], [{ answer: sub("FOREIGN_CONTINUE", "foreign_rc", { sessionID: depthChild }) }])
  await wait(foreign)
  assert.equal(parts(await messages(foreign))[0].state.status, "error")
  assert.equal(primaryRequests(depthChild).length, requestCount)
  results.continuation = { childID: depthChild, foreignParent: foreign, continuation: parts(await messages(depthRoot)).find(p => p.id === "continue_rc"), foreign: parts(await messages(foreign)) }
  results.stages.push(stage)

  stage = "General builtin recursive-deny control"
  markerPlans.set("GENERAL_CONTROL", [{ answer: sub("MUST_NOT_GENERAL_RECURSE", "general_nested") }])
  const generalRoot = await launchRoot("generalRoot", [], [{ answer: sub("GENERAL_CONTROL", "general_rc", { agent: "general" }) }])
  await wait(generalRoot)
  const generalChild = await childOf(generalRoot, "general_rc")
  assert(!primaryRequests(generalChild)[0].body.tools.some(t => t.function.name === "subagent"))
  assert.equal(events.filter(e => e.type === "session.created" && e.data.parentID === generalChild).length, 0)
  assert.equal(parts(await messages(generalChild))[0].state.status, "error")
  results.generalNegative = { rootID: generalRoot, childID: generalChild, childParts: parts(await messages(generalChild)) }
  results.stages.push(stage)

  stage = "explicit permission deny no child birth"
  const denied = await launchRoot("deniedRoot", [], [{ answer: sub("DENIED_BIRTH", "denied_rc") }], { permissions: [{ action: "subagent", resource: "*", effect: "deny" }] })
  await wait(denied)
  assert.equal(parts(await messages(denied))[0].state.status, "error")
  assert(!events.some(e => e.type === "session.created" && e.data.parentID === denied))
  results.permissionNegative = { rootID: denied, tools: parts(await messages(denied)) }
  results.stages.push(stage)

  stage = "concurrent background branches and native result consumption"
  for (const branch of ["A", "B"]) markerPlans.set("BRANCH_" + branch, [{ hold: "branch" + branch, answer: reporting("branch-" + branch.toLowerCase(), "BRANCH_REPORT_" + branch, "report_" + branch) }, { answer: "BRANCH_RESULT_" + branch }])
  const branchesRoot = await launchRoot("branchesRoot", ["branch-a", "branch-b"], [{ answer: [sub("BRANCH_A", "branch_a", { background: true }), sub("BRANCH_B", "branch_b", { background: true })] }])
  await until(() => holds.has("branchA") && holds.has("branchB"))
  const branchA = await childOf(branchesRoot, "branch_a"), branchB = await childOf(branchesRoot, "branch_b")
  await wait(branchesRoot)
  const active = await client.session.active()
  assert(active[branchA] && active[branchB] && !active[branchesRoot])
  const preReport = await inspect()
  assert(preReport.snapshot.missions.find(m => m.coordinatorSessionId === branchesRoot).tasks.every(t => t.status !== "completed"))
  release("branchA"); release("branchB")
  await Promise.all([wait(branchA), wait(branchB)])
  await until(() => contains(branchesRoot, "BRANCH_RESULT_A") && contains(branchesRoot, "BRANCH_RESULT_B") && contains(branchesRoot, "BRANCH_REPORT_A") && contains(branchesRoot, "BRANCH_REPORT_B"))
  await wait(branchesRoot)
  const branchMessages = await messages(branchesRoot)
  for (const id of [branchA, branchB]) assert(branchMessages.some(m => m.type === "synthetic" && m.metadata?.source === "subagent" && m.metadata.childID === id && m.metadata.state === "completed"))
  for (const id of [branchA, branchB]) assert((await inspect()).traces.find(trace => trace.sessionID === id).binding.lineage[0].callIDs.length === 1,
    "Concurrent children correlate to distinct native calls before first context")
  results.branches = { rootID: branchesRoot, childIDs: [branchA, branchB], activeBeforeRelease: active,
    reports: (await inspect()).snapshot.missions.find(m => m.coordinatorSessionId === branchesRoot).tasks,
    consumedRequests: primaryRequests(branchesRoot).map(r => r.index) }
  results.stages.push(stage)

  stage = "foreground provider error consumed by actual parent"
  markerPlans.set("FAIL_FOREGROUND", [{ fail: true }])
  const errorRoot = await launchRoot("errorRoot", ["failed-task"], [{ answer: sub("FAIL_FOREGROUND", "error_rc") }])
  await wait(errorRoot)
  const errorChild = await childOf(errorRoot, "error_rc")
  assert.equal((await client.session.get({ sessionID: errorChild })).outcome, "failed")
  assert.equal(parts(await messages(errorRoot)).find(p => p.id === "error_rc").state.status, "error")
  assert(contains(errorRoot, "PRIVATE_CHILD_PROVIDER_FAILURE"))
  assert.notEqual((await inspect()).snapshot.missions.find(m => m.coordinatorSessionId === errorRoot).tasks[0].status, "completed")
  results.error = { rootID: errorRoot, childID: errorChild, tools: parts(await messages(errorRoot)), consumedRequests: primaryRequests(errorRoot).map(r => r.index) }
  results.stages.push(stage)

  stage = "successful native result is not business task completion"
  markerPlans.set("UNREPORTED_CHILD", [{ answer: "NATIVE_SUCCESS_NO_BUSINESS_REPORT" }])
  const unreported = await launchRoot("unreportedRoot", ["unreported"], [{ answer: sub("UNREPORTED_CHILD", "unreported_rc") }])
  await wait(unreported)
  assert(contains(unreported, "NATIVE_SUCCESS_NO_BUSINESS_REPORT"))
  const unreportedTask = (await inspect()).snapshot.missions.find(m => m.coordinatorSessionId === unreported).tasks[0]
  assert.notEqual(unreportedTask.status, "completed")
  results.unreported = { rootID: unreported, task: unreportedTask }
  results.stages.push(stage)
  results.final = await inspect()
  assert.equal(results.final.snapshot.discardedEvents, 0, "No incompatible Mission journal event discarded")
  assert(!results.final.snapshot.notificationUnavailable, "Reused report receipt identities remain valid")
  for (const mission of results.final.snapshot.missions) for (const task of mission.tasks) if (task.report) assert.equal(task.report.notificationStatus, "admitted", "Admission is recorded separately from provider consumption")
  results.finalAgents = await client.agent.list({ location: { directory: project } })
  assert(results.final.tools.some(t => t.id === "subagent"))
  results.status = "passed"
} catch (error) {
  results.status = "failed"
  results.failure = { stage, error: String(error), detail: error, stack: error.stack }
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  for (const resolve of holds.values()) resolve()
  try {
    if (client) {
      const ids = [...new Set([...sessions.values(), ...events.filter(e => e.type === "session.created").map(e => e.data.sessionID)])]
      results.nativeSessions = await Promise.all(ids.map(id => client.session.get({ sessionID: id }).catch(error => ({ id, error: String(error) }))))
      const transcripts = Object.fromEntries(await Promise.all(ids.map(async id => [id, await messages(id).catch(error => ({ error: String(error) }))])))
      await writeFile(path.join(root, "transcripts.json"), JSON.stringify(transcripts, null, 2))
      results.lastInspection = await inspect().catch(error => ({ error: String(error) }))
    }
  } finally {
    abort.abort()
    child?.kill()
    if (closed) await closed
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    results.protectedAfter = await protectedHashes()
    assert.deepEqual(results.protectedAfter, before, "Frozen primary including index unchanged")
    results.counts = { provider: requests.length, primary: requests.filter(r => r.kind === "primary").length, sessions: results.nativeSessions?.length, events: events.length }
    results.ownModuleHashes = Object.fromEntries(await Promise.all(["run.mjs", "index.ts", "mission.ts"].map(async file => [file, sha(await readFile(new URL(file, import.meta.url)))])))
    await Promise.all([writeFile(path.join(root, "requests.json"), JSON.stringify(requests, null, 2)), writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2)),
      writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2)), writeFile(path.join(root, "serve.log"), output.replaceAll(process.env.OPENCODE_SERVER_PASSWORD, "[REDACTED]"))])
    console.log(`${results.status.toUpperCase()} native-first: ${root}`)
    if (results.failure) console.error(results.failure)
  }
}
