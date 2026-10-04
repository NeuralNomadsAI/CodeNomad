import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import { protect, privateRuntime, launch, deterministicProvider } from "../native-subsession-spike/integration/runtime.mjs"

const { CODENOMAD_MISSIONS_RPC } = await tsImport("../../packages/server/src/missions/rpc.ts", import.meta.url)
const before = await protect(), { root, project } = await privateRuntime(), deadline = Date.now() + 180000
const provider = deterministicProvider(deadline), events = [], observerAbort = new AbortController()
const results = { transport: "real-native-scripted-model", root, codeNomadBackendStarted: false, protectedBefore: before }
let runtime, client, stage = "launch", eventFailure
const call = (name, input, id) => ({ name, input, id })
const report = (taskKey, summary, id, extra = {}) => call("mission_report", { taskKey, outcome: "completed", summary, evidence: [], next: [], ...extra }, id)
const read = () => client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location: { directory: project }, signal: AbortSignal.timeout(10000) })
const wait = id => client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(25000) })
const primary = id => provider.requests.filter(request => request.kind === "primary" && request.sessionID === id)
const transcript = async id => (await client.message.list({ sessionID: id, limit: { order: "asc", limit: 100 } })).data
const tools = messages => messages.flatMap(message => message.content ?? []).filter(part => part.type === "tool")
async function until(predicate) {
  const end = Math.min(deadline, Date.now() + 30000)
  while (Date.now() < end) {
    if (eventFailure || provider.failure()) throw eventFailure ?? provider.failure()
    if (runtime.child.exitCode !== null) throw new Error("Owned private native server exited")
    const value = await predicate()
    if (value) return value
    await delay(25)
  }
  throw new Error("Timeout at " + stage)
}
try {
  await new Promise(resolve => provider.server.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", default_agent: "autonomy_trial", update: "disable", snapshots: false,
    experimental: { subagent_depth: 3 }, permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "allow" }, { action: "mission_*", resource: "*", effect: "allow" }],
    agents: { autonomy_trial: { mode: "all", description: "Private autonomous Mission trial", steps: 14, system: "Bounded scripted trial" },
      fallback_trial: { mode: "primary", description: "Provider without native delegation in this fixture", steps: 14, system: "Bounded fallback trial" } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.server.address().port}/v1`, apiKey: "synthetic" }, models: { fixture: {} } } },
    plugins: [path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture")] })
  runtime = await launch(root, deadline); client = runtime.client; results.server = runtime.info
  void (async () => { try { for await (const event of client.event.subscribe({ signal: observerAbort.signal })) events.push(event) }
    catch (error) { if (!observerAbort.signal.aborted) eventFailure = error } })()
  await client.agent.list({ location: { directory: project } })
  const rootSession = await client.session.create({ location: { directory: project }, title: "Shared Mission native coordinator readout", agent: "autonomy_trial" })
  const task = { taskKey: "check-score", title: "Check the score", brief: "Compute 17*23+41", role: "specialist" }
  provider.markerPlans.set("NATIVE_REPORT_BASELINE", [
    { answer: "NATIVE_CHILD_RESULT:432" },
  ])
  provider.plans.set(rootSession.id, [
    { answer: call("mission_inspect", { start: { objective: "Report a declared native task", template: "custom" } }, "start_native") },
    { answer: call("mission_delegate", task, "declare_native") },
    { hold: "declared", answer: call("subagent", { agent: "autonomy_trial", description: "Native business report baseline", prompt: "NATIVE_REPORT_BASELINE" }, "native_child") },
    { require: ["NATIVE_CHILD_RESULT:432"], answer: report(task.taskKey, "432 received through the native child return", "coordinator_readout") },
    { answer: report(undefined, "Native task completed", "finish_native", { final: true }) },
    { answer: "NATIVE_BASELINE_END" },
  ])
  await client.session.prompt({ sessionID: rootSession.id, text: "Exercise the shared native declaration/report path" })
  stage = "native declaration without a root actor"
  await until(() => provider.holds.has("declared"))
  const declared = (await read()).missions.find(mission => mission.coordinatorSessionId === rootSession.id)
  assert.deepEqual(declared.tasks[0].executionMode, { kind: "native", parentTaskKey: null })
  assert.equal(declared.actors.length, 1)
  provider.release("declared")
  await wait(rootSession.id)
  stage = "coordinator readout without a native child report copy"
  const childID = events.find(event => event.type === "session.tool.progress" && event.data.id === "native_child")?.data.metadata?.sessionID
  assert(childID)
  assert(!tools(await transcript(childID)).some(tool => tool.name === "mission_report"))
  const finalAttempt = tools(await transcript(rootSession.id)).find(tool => tool.id === "finish_native")
  assert.equal(finalAttempt.state.status, "completed")
  const native = (await read()).missions.find(mission => mission.id === declared.id)
  assert.equal(native.status, "completed")
  assert.equal(native.tasks[0].report.delivery, "coordinator-readout")
  assert.equal(native.tasks[0].report.notificationStatus, undefined)
  assert.equal(native.tasks[0].actorSessionId, undefined)
  results.native = { rootID: rootSession.id, childID, finalAttempt,
    snapshot: (await read()).missions.find(mission => mission.id === declared.id) }

  stage = "explicit existing fallback with native capability absent"
  const fallback = await client.session.create({ location: { directory: project }, title: "Shared Mission fallback without UI", agent: "fallback_trial" })
  provider.markerPlans.set("FALLBACK_SCORE", [
    { hold: "fallback-working", answer: report("fallback-score", "Fallback checked total 432", "fallback_report") },
    { answer: "FALLBACK_NATIVE_DONE" },
  ])
  provider.plans.set(fallback.id, [
    { answer: call("mission_inspect", { start: { objective: "Check 432 when native delegation is unavailable", template: "custom" } }, "start_fallback") },
    { answer: call("mission_delegate", { taskKey: "fallback-score", title: "Check score", brief: "FALLBACK_SCORE: compute 17*23+41", role: "specialist",
      execution: { agent: "autonomy_trial", model: { providerID: "fixture", id: "fixture" } },
      executionMode: { kind: "independent", reason: "playbook", explanation: "This provider has no native delegation tool; use the existing managed-root assignment path for this new task." } }, "delegate_fallback") },
    { require: ["Fallback checked total 432"], answer: report(undefined, "Autonomous fallback total 432", "finish_fallback", { final: true }) },
    { answer: "FALLBACK_MISSION_DONE" },
  ])
  await client.session.prompt({ sessionID: fallback.id, text: "Use the existing fallback without a CodeNomad backend" })
  await until(() => {
    const failed = events.find(event => event.type === "session.tool.failed" && event.data.id === "delegate_fallback")
    if (failed) throw new Error(failed.data.error.message)
    return provider.holds.has("fallback-working")
  })
  assert(primary(fallback.id).every(request => !request.body.tools.some(tool => tool.function.name === "subagent")), "Native delegation really unavailable in this controlled case")
  const pending = (await read()).missions.find(mission => mission.coordinatorSessionId === fallback.id)
  const actorID = pending.tasks[0].actorSessionId
  assert(actorID && actorID !== fallback.id)
  assert.equal((await client.session.get({ sessionID: actorID })).parentID, undefined)
  observerAbort.abort()
  results.viewerDetachedAt = Date.now()
  provider.release("fallback-working")
  const finished = await until(async () => (await read()).missions.find(mission => mission.id === pending.id && mission.status === "completed"))
  await wait(fallback.id)
  await wait(actorID)
  assert.equal(finished.tasks[0].status, "completed")
  assert.equal(finished.tasks[0].report.notificationStatus, "admitted")
  assert.equal(primary(actorID).filter(request => JSON.stringify(request.body.messages).includes("FALLBACK_SCORE")).length, 2)
  results.fallback = { mission: finished, coordinatorID: fallback.id, actorID }
  const saved = (await read()).missions
  const transcripts = Object.fromEntries(await Promise.all([rootSession.id, childID, fallback.id, actorID].map(async id => [id, await transcript(id)])))
  await writeFile(path.join(root, "transcripts.json"), JSON.stringify(transcripts, null, 2))

  stage = "native server restart and reattachment to plugin storage"
  await runtime.stop()
  runtime = await launch(root, deadline); client = runtime.client
  await client.agent.list({ location: { directory: project } })
  assert.deepEqual((await read()).missions, saved)
  client = OpenCode.make({ baseUrl: runtime.url, headers: runtime.headers })
  assert.deepEqual((await read()).missions, saved)
  results.recovered = { oldPID: results.server.pid, newPID: runtime.info.pid, missionIDs: saved.map(mission => mission.id) }
  results.status = "passed"
} catch (error) {
  results.status = "failed"; results.failure = { stage, message: String(error), detail: error, stack: error.stack }; process.exitCode = 1
  if (client && runtime.child.exitCode === null) {
    try {
      results.lastSnapshot = await read()
      const ids = [...new Set(events.filter(event => event.type === "session.created").map(event => event.data.sessionID))]
      results.lastSessions = await Promise.all(ids.map(sessionID => client.session.get({ sessionID })))
      await writeFile(path.join(root, "transcripts.json"), JSON.stringify(Object.fromEntries(await Promise.all(ids.map(async id => [id, await transcript(id)]))), null, 2))
    } catch (captureError) { results.captureError = String(captureError) }
  }
} finally {
  observerAbort.abort()
  await runtime?.stop(); await provider.stop()
  results.protectedAfter = await protect(); assert.deepEqual(results.protectedAfter, before)
  await Promise.all([writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2)),
    writeFile(path.join(root, "requests.json"), JSON.stringify(provider.requests, null, 2)),
    writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2)), writeFile(path.join(root, "serve.log"), runtime?.logs() ?? "")])
  console.log(`${results.status.toUpperCase()} shared Mission autonomous fallback/baseline: ${root}`)
  if (results.failure) console.error(results.failure)
}
