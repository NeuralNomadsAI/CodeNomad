// Reuses the immutable continuity spike's private serve/provider protocol, not
// its executor-wrapper or direct ctx.tool.execute test path.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { clearFixtureGitEnvironment } from "../../native-fixture-guards.mjs"

const experiment = "D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003"
assert.equal(path.resolve(process.cwd()).toLowerCase(), path.resolve(experiment).toLowerCase())
const cli = "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
const root = await mkdtemp("C:/Users/Admin/AppData/Local/Temp/opencode/missions-observer-")
const project = path.join(root, "project"), config = path.join(root, "config"), pluginDir = path.join(root, "plugin")
for (const dir of [project, config, pluginDir]) await mkdir(dir)
clearFixtureGitEnvironment()
for (const key of Object.keys(process.env)) if (/^(OPENCODE|CODENOMAD|XDG|WSL)/i.test(key) || /(API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|AUTH)/i.test(key)) delete process.env[key]
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) process.env[key] = path.join(root, key)
Object.assign(process.env, { HOME: root, USERPROFILE: root, LOCALAPPDATA: root, APPDATA: root, XDG_RUNTIME_DIR: root, TMP: root, TEMP: root,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "git-global"), GIT_CONFIG_SYSTEM: path.join(root, "git-system"),
  OPENCODE_TEST_HOME: root, OPENCODE_DB: path.join(root, "private.db"), OPENCODE_CONFIG_DIR: config,
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: "private-observer-only" })
await writeFile(path.join(config, "opencode.json"), "{}\n")
execFileSync("git", ["init", "--quiet", project], { cwd: root, env: process.env })
execFileSync("git", ["-c", "user.name=Private", "-c", "user.email=private@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "Private fixture identity"], { cwd: project, env: process.env })
const { OpenCode } = await import("@opencode/client")
const { build } = await import("esbuild")
const { tsImport } = await import("tsx/esm/api")
const { readNativeMissionFamily } = await tsImport(pathToFileURL(path.join(experiment, "packages/server/src/missions/native-session-family.ts")).href, import.meta.url)
await build({ entryPoints: [fileURLToPath(new URL("./plugin.ts", import.meta.url))], outfile: path.join(pluginDir, "index.js"),
  bundle: true, platform: "node", format: "esm", target: "es2022", logLevel: "silent" })
await writeFile(path.join(pluginDir, "package.json"), '{"type":"module"}\n')
const hashes = {}
for (const name of ["scripts/native-subsession-spike/observer/plugin.ts", "scripts/native-subsession-spike/observer/run.mjs",
  "packages/server/src/missions/native-subsession-experiment/observer.ts", "packages/server/src/missions/journal.ts",
  "packages/server/src/missions/native-session-family.ts"]) hashes[name] = createHash("sha256").update(await readFile(path.join(experiment, name))).digest("hex")
const pluginSource = await readFile(fileURLToPath(new URL("./plugin.ts", import.meta.url)), "utf8")
assert(!pluginSource.includes("editor.update(") && !pluginSource.includes("editor.remove(") && !pluginSource.includes("tool.execute("), "No native executor/schema/options override or direct execution")
const requests = [], events = [], plans = new Map(), childPlans = new Map(), holds = new Map(), sessions = new Map()
const results = { root, hashes, rollback: "missions-native-rollback-V0FPSs/RESULT.json", confirmed: [], unknown: [] }
let child, stopped, output = "", client, failure, stage = "setup", watchdog
const deadline = Date.now() + 240_000, subscription = new AbortController()
function emit(response, answers) {
  response.setHeader("content-type", "text/event-stream")
  const values = Array.isArray(answers) ? answers : [answers]
  const isText = typeof values[0] === "string"
  const delta = isText ? { role: "assistant", content: values[0] } : { role: "assistant", tool_calls: values.map((v, index) => ({
    index, id: v.id, type: "function", function: { name: v.tool, arguments: JSON.stringify(v.input) } })) }
  for (const [data, finish_reason] of [[delta, null], [{}, isText ? "stop" : "tool_calls"]]) response.write(`data: ${JSON.stringify({
    id: "observer", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: data, finish_reason }] })}\n\n`)
  response.end("data: [DONE]\n\n")
}
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), sessionID = request.headers["x-observer-session"], kind = request.headers["x-observer-kind"]
    requests.push({ index: requests.length, sessionID, kind, time: Date.now(), body })
    assert(requests.length <= 200, "request budget")
    if (kind === "primary") {
      if (!plans.has(sessionID)) {
        // This is deterministic provider routing only, never contract correlation.
        for (const [marker, steps] of childPlans) if (JSON.stringify(body.messages).includes(marker)) {
          plans.set(sessionID, steps); childPlans.delete(marker); break
        }
      }
      const step = plans.get(sessionID)?.shift()
      if (step?.hold) await new Promise(resolve => { holds.set(step.hold, resolve); response.once("close", resolve) })
      if (response.destroyed) return
      const answer = step?.answer ?? `NATIVE_DONE:${sessionID}`
      for (const call of typeof answer === "string" ? [] : Array.isArray(answer) ? answer : [answer]) {
        assert(body.tools.some(t => t.function.name === call.tool), `tool missing: ${call.tool}`)
      }
      emit(response, answer)
    } else if (body.stream) emit(response, "Private title")
    else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ id: "observer", choices: [{
      message: { role: "assistant", content: "Private title" }, finish_reason: "stop" }] })) }
  } catch (error) { failure = error; response.destroy() }
})
async function until(predicate, label = stage) {
  const limit = Math.min(Date.now() + 25_000, deadline)
  while (Date.now() < limit) {
    if (failure) throw failure
    if (await predicate()) return
    if (child?.exitCode != null) throw new Error(`private child exited: ${output.slice(-2000)}`)
    await delay(40)
  }
  throw new Error(`Timeout: ${label}`)
}
const primary = id => requests.filter(r => r.kind === "primary" && r.sessionID === id)
const call = (tool, input, id) => ({ tool, input, id })
const subagent = (prompt, extra = {}) => ({ agent: "recursive", description: "Private ordinary native delegation", prompt, ...extra })
const toolParts = list => list.flatMap(m => m.type === "assistant" ? m.content.filter(p => p.type === "tool") : [])
const messages = async id => (await client.message.list({ sessionID: id, order: "asc", limit: 100 })).data
const wait = id => client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(25_000) })
const control = input => client.rpc({ id: "native.observer.spike", methods: { control: { input: { type: "object" }, output: { type: "object" } } }, events: {} })
  .control(input, { location: { directory: project }, signal: AbortSignal.timeout(15_000) })
const ok = async input => { const result = await control(input); assert(!result.error, result.error); return result.value ?? result }
const release = name => { assert(holds.has(name), name); holds.get(name)(); holds.delete(name) }
const create = async name => { const session = await client.session.create({ location: { directory: project }, title: name, agent: "recursive" }); sessions.set(name, session.id); return session.id }
const childOf = async parent => { await until(() => events.some(e => e.type === "session.created" && e.data.parentID === parent));
  return events.find(e => e.type === "session.created" && e.data.parentID === parent).data.sessionID }
const firstContext = id => {
  const marker = primary(id)[0].body.messages.find(m => m.role === "system" && typeof m.content === "string" && m.content.includes("OBSERVER_CONTEXT:"))?.content
  assert(marker, `context absent ${id}`)
  return JSON.parse(marker.slice(marker.indexOf("OBSERVER_CONTEXT:") + "OBSERVER_CONTEXT:".length))
}
try {
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", default_agent: "recursive", update: "disable", snapshots: false,
    experimental: { subagent_depth: 3 },
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "observer_report", resource: "*", effect: "allow" }],
    agents: { recursive: { mode: "all", description: "Private recursive agent", system: "Private deterministic native recursion", steps: 12,
      permissions: [{ action: "subagent", resource: "*", effect: "allow" }] } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: {
      baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "synthetic-private" }, models: { fixture: {} } } }, plugins: [pluginDir] })
  child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: process.env, windowsHide: true })
  stopped = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  await writeFile(path.join(root, "sentinel.json"), JSON.stringify({ pid: child.pid, cli, ownedRoot: root, deadline }))
  watchdog = setTimeout(() => { failure = new Error(`240s budget exceeded ${stage}`); child.kill(); provider.closeAllConnections() }, deadline - Date.now())
  watchdog.unref()
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const authorization = `Basic ${Buffer.from("opencode:private-observer-only").toString("base64")}`
  client = OpenCode.make({ baseUrl: url, headers: { authorization } })
  results.server = await client.server.info(); assert.equal(results.server.version, "2.0.22")
  results.openapi = await (await fetch(`${url}/openapi.json`, { headers: { authorization }, signal: AbortSignal.timeout(10_000) })).json()
  void (async () => { try { for await (const event of client.event.subscribe({ signal: subscription.signal })) events.push(event) }
    catch (error) { if (!subscription.signal.aborted) failure = error } })()
  await client.agent.list({ location: { directory: project } })
  results.agents = await client.agent.list({ location: { directory: project } })
  results.initial = await ok({ action: "capture" })
  results.reader = await ok({ action: "reader", url, pid: results.server.pid, password: "private-observer-only" })
  const a = await create("coordinator-rootA"), b = await create("existing-rootB"), foreign = await create("foreign-unassigned")
  const missionID = "observer_private_mission"
  await ok({ action: "intent", caller: a, missionID, objective: "Observe existing native trees without changing delegation",
    tasks: [{ key: "task-a", blockedBy: [] }, { key: "task-b", blockedBy: [] }, { key: "dependent", blockedBy: ["task-a", "task-b"] }, { key: "ambiguous", blockedBy: [] }] })
  const snapshot = await ok({ action: "snapshot" })
  let revision = snapshot.missions[0].revision
  await ok({ action: "attach", caller: a, missionID, taskKey: "task-a", rootID: a, revision })
  revision = (await ok({ action: "snapshot" })).missions[0].revision
  await ok({ action: "attach", caller: a, missionID, taskKey: "task-b", rootID: b, revision })
  revision = (await ok({ action: "snapshot" })).missions[0].revision
  results.overlap = await control({ action: "attach", caller: a, missionID, taskKey: "ambiguous", rootID: a, revision })
  assert.match(results.overlap.error, /overlapping/)
  results.foreignWriter = await control({ action: "attach", caller: b, missionID, taskKey: "ambiguous", rootID: foreign, revision })
  assert.match(results.foreignWriter.error, /coordinator-only/)

  stage = "native recursive foreground and background concurrent roots"
  // root A -> child -> grandchild -> great-grandchild (three native edges).
  childPlans.set("A_CHILD_ONE", [{ answer: call("subagent", subagent("A_GRANDCHILD"), "a_grand") }, { answer: "A_CHILD_TERMINAL" }])
  childPlans.set("A_GRANDCHILD", [{ answer: call("subagent", subagent("A_GREAT_GRANDCHILD"), "a_great") }, { answer: "A_GRAND_TERMINAL" }])
  childPlans.set("A_GREAT_GRANDCHILD", [{ hold: "deep-leaf", answer: "DEEP_LEAF_EVIDENCE" }])
  childPlans.set("A_SIBLING", [{ hold: "sibling", answer: "SIBLING_EVIDENCE" }])
  childPlans.set("B_CHILD", [{ hold: "background", answer: "BACKGROUND_EVIDENCE" }])
  plans.set(a, [{ answer: [call("subagent", subagent("A_CHILD_ONE"), "a_child"), call("subagent", subagent("A_SIBLING"), "a_sibling")] }, { answer: "COORDINATOR_CONSUMED_FOREGROUND" }])
  plans.set(b, [{ answer: call("subagent", subagent("B_CHILD", { background: true }), "b_child") }, { answer: "B_LAUNCH_ACK_ONLY" }])
  await Promise.all([client.session.prompt({ sessionID: a, text: "Use ordinary native foreground subagents concurrently" }),
    client.session.prompt({ sessionID: b, text: "Use ordinary native background subagent" })])
  await until(() => holds.has("deep-leaf") && holds.has("sibling") && holds.has("background"))
  // Native parentID alone identifies the unique deep branch while foreground
  // Tool parts are absent from both context and raw message-list reads.
  // Invocation identity is asserted only AFTER native parts become readable.
  const created = events.filter(e => e.type === "session.created").map(e => e.data)
  const branch = created.filter(s => s.parentID === a && created.some(c => c.parentID === s.sessionID))
  assert.equal(branch.length, 1, "unambiguous native deep branch")
  const childA = branch[0].sessionID, grand = await childOf(childA), great = await childOf(grand), childB = await childOf(b)
  await wait(b)
  results.whileRunning = { active: await client.session.active(), partsB: toolParts(await messages(b)), contextGreat: await ok({ action: "context", sessionID: great }) }
  assert.equal(results.whileRunning.partsB[0].state.status, "completed")
  assert.equal(results.whileRunning.partsB[0].state.metadata.status, "running")
  assert(results.whileRunning.active[childB] && !results.whileRunning.active[b])
  assert.equal((await ok({ action: "snapshot" })).missions[0].tasks.find(t => t.key === "task-b").report, undefined)
  for (const [id, task, depth] of [[childA, "task-a", 1], [grand, "task-a", 2], [great, "task-a", 3], [childB, "task-b", 1]]) {
    const context = firstContext(id)
    assert.equal(context.status, "assigned"); assert.equal(context.contract.taskKey, task); assert.equal(context.depth, depth)
    assert(context.path.flat().every(e => e.toolID && e.messageID && e.metadata.sessionID === e.childID))
    assert(["pending", "proved"].includes(context.correlation))
  }
  results.firstRequestContexts = Object.fromEntries([childA, grand, great, childB].map(id => [id, firstContext(id)]))
  results.confirmed.push("Unwrapped first-request parent/task-scoped contract inheritance at native depth 3; ToolID correlation separately pending", "Concurrent roots and actual sibling tool calls", "Background launch completion separate from execution/task completion")
  release("deep-leaf"); release("sibling"); release("background")
  await Promise.all([wait(a), wait(childB)])
  await until(() => primary(b).some(r => JSON.stringify(r.body.messages).includes("BACKGROUND_EVIDENCE")))
  await wait(b)
  assert.equal(toolParts(await messages(a)).find(p => p.id === "a_child").state.metadata.sessionID, childA)
  assert.equal(toolParts(await messages(childA)).find(p => p.id === "a_grand").state.metadata.sessionID, grand)
  assert.equal(toolParts(await messages(grand)).find(p => p.id === "a_great").state.metadata.sessionID, great)
  assert(primary(a).some(r => JSON.stringify(r.body.messages).includes("A_CHILD_TERMINAL") && JSON.stringify(r.body.messages).includes("SIBLING_EVIDENCE")))
  const nativeNotification = (await messages(b)).find(m => m.type === "synthetic" && m.metadata?.childID === childB)
  assert.equal(nativeNotification.metadata.state, "completed")
  results.nativeNotification = nativeNotification
  results.confirmed.push("Provider consumed real foreground tool results and native background notification, not only ACK")
  results.unknown.push("Foreground ToolID is absent from BOTH native context and raw message-list reads during the parent turn; ancestry gives inherited task context, not per-invocation binding")

  stage = "native existing-child continuation and foreign-parent deny"
  plans.set(a, [{ answer: call("subagent", subagent("CONTINUED_EXISTING", { sessionID: childA }), "a_continue") }])
  await client.session.prompt({ sessionID: a, text: "Continue the existing native child unchanged" }); await wait(a)
  assert.equal(toolParts(await messages(a)).find(p => p.id === "a_continue").state.metadata.sessionID, childA)
  assert.equal(events.filter(e => e.type === "session.created" && e.data.parentID === a).length, 2)
  const beforeForeign = primary(childA).length
  plans.set(foreign, [{ answer: call("subagent", subagent("FOREIGN_DENIED", { sessionID: childA }), "foreign_continue") }])
  await client.session.prompt({ sessionID: foreign, text: "Attempt foreign-parent continuation" }); await wait(foreign)
  results.foreignContinuation = toolParts(await messages(foreign))
  assert.equal(results.foreignContinuation[0].state.status, "error"); assert.equal(primary(childA).length, beforeForeign)
  results.confirmed.push("Native continuation retains child identity; native foreign-parent continuation denied")

  stage = "unassigned ordinary tree and general negative control"
  childPlans.set("UNASSIGNED_CHILD", [{ answer: "UNASSIGNED_NATIVE_RESULT" }])
  plans.set(foreign, [{ answer: call("subagent", subagent("UNASSIGNED_CHILD"), "unassigned_child") }])
  await client.session.prompt({ sessionID: foreign, text: "Unassigned native execution remains visible" }); await wait(foreign)
  const unassigned = await childOf(foreign)
  results.unassigned = await ok({ action: "context", sessionID: unassigned })
  assert.equal(results.unassigned.status, "unassigned")
  const negative = await create("general-negative")
  childPlans.set("GENERAL_NEGATIVE", [{ answer: "GENERAL_NATIVE_WITHOUT_RECURSION" }])
  plans.set(negative, [{ answer: call("subagent", { agent: "general", description: "Builtin recursion negative control", prompt: "GENERAL_NEGATIVE" }, "general_call") }])
  await client.session.prompt({ sessionID: negative, text: "Inspect built-in general permissions" }); await wait(negative)
  const general = await childOf(negative)
  results.generalTools = primary(general)[0].body.tools.map(t => t.function.name)
  if (results.generalTools.includes("subagent")) results.unknown.push("General negative control advertises subagent under this fixture policy; no platform impossibility inferred")
  else results.confirmed.push("Builtin general negative control excludes subagent; custom all-mode agent recurses")

  stage = "coordinator business reports from persisted native evidence"
  const reportA = { missionID, taskKey: "task-a", rootID: a, sourceID: great, revision, evidenceToolID: "a_great", summary: "Explicit deep native evidence", reportID: "report_a" }
  const reportB = { missionID, taskKey: "task-b", rootID: b, sourceID: childB, revision, evidenceToolID: "b_child", summary: "Explicit background evidence", reportID: "report_b" }
  plans.set(a, [
    { answer: call("observer_report", { ...reportA, taskKey: "task-b" }, "wrong_task_report") },
    { answer: call("observer_report", { ...reportA, revision: revision + 1 }, "wrong_revision_report") },
    { answer: call("observer_report", { ...reportA, sourceID: unassigned }, "wrong_source_report") },
    { answer: call("observer_report", reportB, "good_report_b") }, { answer: "COORDINATOR_REPORT_B_SAVED" },
  ])
  await client.session.prompt({ sessionID: a, text: "Validate explicit evidence and complete only the matching task" }); await wait(a)
  const reports = toolParts(await messages(a)).filter(p => p.name === "observer_report")
  for (const id of ["wrong_task_report", "wrong_revision_report", "wrong_source_report"]) assert.equal(reports.find(p => p.id === id).state.status, "error")
  assert.equal(reports.find(p => p.id === "good_report_b").state.status, "completed")
  assert(primary(a).some(r => JSON.stringify(r.body.messages).includes('Explicit background evidence') && JSON.stringify(r.body.messages).includes('report_b')),
    "Coordinator provider consumed the actual persisted business report tool result")
  // Self-root task A cannot complete while its coordinator is still running;
  // perform its explicit coordinator confirmation after the native turn is idle.
  // The plugin business tool intentionally fails closed during that turn.
  reportA.revision = (await ok({ action: "snapshot" })).missions[0].revision
  plans.set(a, [{ answer: call("observer_report", reportA, "self_root_report") }])
  await client.session.prompt({ sessionID: a, text: "Try explicit self-root confirmation while running" }); await wait(a)
  assert.equal(toolParts(await messages(a)).find(p => p.id === "self_root_report").state.status, "error")
  results.unknown.push("Coordinator-as-task-root cannot self-report completion inside its own running turn; needs idle authorized business confirmation")
  const afterReport = await ok({ action: "snapshot" })
  assert.equal(afterReport.missions[0].tasks.find(t => t.key === "task-b").status, "completed")
  assert.equal(afterReport.missions[0].tasks.find(t => t.key === "task-a").report, undefined)
  assert.equal(afterReport.missions[0].tasks.find(t => t.key === "dependent").status, "blocked")
  results.businessSnapshot = afterReport
  results.confirmed.push("Real runner report tool rejects task/source/revision mismatch; coordinator-only matching report completes task B", "Unassigned child never creates a task report")

  stage = "dispose and persisted rebuild plus actual location reload"
  const rootSession = await client.session.get({ sessionID: a })
  const family = await readNativeMissionFamily(client, rootSession, AbortSignal.timeout(10_000))
  const watchBefore = await ok({ action: "watch", ids: [...family] })
  results.beforeReload = await ok({ action: "capture" })
  await ok({ action: "dispose" }); await ok({ action: "rebuild" })
  results.afterRebuild = await ok({ action: "watch", ids: [...family] })
  assert.deepEqual(results.afterRebuild, watchBefore)
  await client.location.reload()
  await client.agent.list({ location: { directory: project } })
  results.afterReload = await ok({ action: "capture" })
  assert(results.afterReload.generation > results.beforeReload.generation)
  const reloadedSnapshot = await ok({ action: "snapshot" })
  assert.deepEqual(reloadedSnapshot.missions, afterReport.missions)
  assert.deepEqual(await ok({ action: "watch", ids: [...family] }), watchBefore)
  results.confirmed.push("Disposed/rebuilt observer and real Location reload reconstruct identical tree/contracts/Mission reducer state from private native storage")
  results.sourceRevision = await ok({ action: "revise-source", caller: a, missionID, revision: reloadedSnapshot.missions[0].revision })
  results.changedSource = await control({ action: "context", sessionID: great })
  assert.match(results.changedSource.error, /source contract changed/)
  const changedWatch = await ok({ action: "watch", ids: [...family] })
  assert.equal(changedWatch.length, watchBefore.length)
  assert(changedWatch.every(row => row.observation.status === "unknown"))
  results.confirmed.push("Explicit current source dependency revision invalidates the inherited contract; native tree stays visible UNKNOWN without deletion or forged completion")
  plans.set(a, [{ answer: call("subagent", subagent("SOURCE_CHANGED_NATIVE_CONTINUE", { sessionID: childA }), "changed_source_continue") }])
  await client.session.prompt({ sessionID: a, text: "Explicit native continuation remains available despite UNKNOWN observer contract" }); await wait(a)
  const changedContinuation = toolParts(await messages(a)).find(p => p.id === "changed_source_continue")
  assert.equal(changedContinuation.state.status, "completed")
  assert.equal(changedContinuation.state.metadata.sessionID, childA)
  assert.equal((await ok({ action: "snapshot" })).missions[0].tasks.find(t => t.key === "task-a").report, undefined)
  results.confirmed.push("UNKNOWN observer contract does not veto unchanged ordinary native execution or replay/create a replacement child")
  results.agents = await client.agent.list({ location: { directory: project } })
  const initialNative = results.initial.catalog.find(t => t.id === "subagent")
  assert.deepEqual(results.afterReload.catalog.find(t => t.id === "subagent"), initialNative)
  const ids = new Set([...sessions.values(), ...events.filter(e => e.type === "session.created").map(e => e.data.sessionID)])
  results.transcripts = Object.fromEntries(await Promise.all([...ids].map(async id => [id, await messages(id)])))
  results.counts = { nativeSessions: ids.size, events: events.length, providerRequests: requests.length, maxNativeDepth: 3, confirmed: results.confirmed.length, unknown: results.unknown.length }
  results.status = "passed"
  console.log(`PASS native observer ${results.server.version}: ${root}`)
} catch (error) {
  results.status = "failed"; results.failure = { stage, message: String(error), error, stack: error.stack }; process.exitCode = 1
  console.error(`FAIL ${stage}: ${root}\n${error.stack ?? JSON.stringify(error)}`)
} finally {
  clearTimeout(watchdog)
  for (const resolve of holds.values()) resolve()
  subscription.abort()
  try {
    if (client) {
      results.transcripts ??= Object.fromEntries(await Promise.all([...new Set([...sessions.values(), ...events.filter(e => e.type === "session.created").map(e => e.data.sessionID)])]
        .map(async id => [id, await messages(id).catch(error => ({ error: String(error) }))])))
      results.finalCapture = await control({ action: "capture" }).catch(error => ({ error: String(error) }))
    }
    await writeFile(path.join(root, "requests.json"), JSON.stringify(requests, null, 2))
    await writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2))
    await writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2))
    await writeFile(path.join(root, "serve.log"), output)
  } finally {
    child?.kill(); if (stopped) await stopped
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve))
    await writeFile(path.join(root, "cleanup.json"), JSON.stringify({ pid: child?.pid, stopped: child?.exitCode !== null || child?.signalCode !== null, scope: "exact owned ChildProcess only" }))
  }
}
