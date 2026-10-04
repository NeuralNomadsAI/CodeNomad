import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { protect, privateRuntime, launch, deterministicProvider, sha } from "./runtime.mjs"

const before = await protect(), { root, project } = await privateRuntime(), deadline = Date.now() + 240000
const provider = deterministicProvider(deadline), events = [], frames = [], sessions = new Set(), abort = new AbortController()
const results = { protectedBefore: before, transport: "captured-native-fixture", gates: [] }
let runtime, client, rootID, failure, stage = "launch", eventCursor = 0
const call = (name, input, id) => ({ name, input, id })
const sub = (prompt, id, extra = {}) => call("subagent", { agent: "integration_all", description: prompt, prompt, ...extra }, id)
const report = (taskKey, summary, id, evidence = []) => call("integration_report", { taskKey, outcome: "completed", summary, evidence }, id)
const primary = id => provider.requests.filter(request => request.kind === "primary" && request.sessionID === id)
const consumed = (id, marker) => primary(id).find(request => JSON.stringify(request.body.messages).includes(marker))
const messages = async id => (await client.message.list({ sessionID: id, limit: { order: "asc", limit: 100 } }, { signal: AbortSignal.timeout(10000) })).data
const parts = transcript => transcript.flatMap(message => message.content ?? []).filter(part => part.type === "tool")
const wait = id => client.session.wait({ sessionID: id }, { signal: AbortSignal.timeout(Math.min(25000, Math.max(1, deadline - Date.now()))) })
const inspect = () => client.rpc({ id: "native.integration.fixture", methods: { inspect: { input: { type: "object" }, output: { type: "object" } } }, events: {} }).inspect({}, { location: { directory: project }, signal: AbortSignal.timeout(10000) })
async function until(predicate) {
  const end = Math.min(deadline, Date.now() + 25000)
  while (Date.now() < end) {
    if (failure || provider.failure()) throw failure ?? provider.failure()
    if (runtime?.child.exitCode !== null && runtime?.child.exitCode !== undefined) throw new Error("Owned private server exited")
    if (await predicate()) return
    await delay(25)
  }
  throw new Error("Timeout at " + stage)
}
const nativeIDs = () => [...new Set([...sessions, ...events.filter(event => event.type === "session.created").map(event => event.data.sessionID)])]
const childForCall = id => events.find(event => event.type === "session.tool.progress" && event.data.id === id)?.data.metadata?.sessionID
async function frame(label) {
  const data = await inspect(), native = await Promise.all(nativeIDs().map(id => client.session.get({ sessionID: id })))
  frames.push({ label, snapshot: data.snapshot, sessions: native, events: events.slice(eventCursor) })
  eventCursor = events.length
  return data.snapshot.missions.find(mission => mission.coordinatorSessionId === rootID)
}
async function held(name, label) { await until(() => provider.holds.has(name)); return frame(label) }
const statuses = mission => Object.fromEntries(mission.tasks.map(task => [task.key, task.status]))
const stableWindow = async () => { const count = provider.requests.length; await delay(300); assert.equal(provider.requests.length, count, "No automatic dispatcher/provider request"); return count }
try {
  await new Promise(resolve => provider.server.listen(0, "127.0.0.1", resolve))
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", default_agent: "integration_all", update: "disable", snapshots: false,
    experimental: { subagent_depth: 3 }, permissions: [{ action: "execute", resource: "*", effect: "deny" }],
    agents: { integration_all: { mode: "all", system: "Synthetic native Mission integration", description: "Private recursive all-mode", steps: 16, permissions: [{ action: "subagent", resource: "*", effect: "allow" }] },
      integration_sub: { mode: "subagent", system: "Synthetic native Mission integration", description: "Private recursive child-mode", steps: 12, permissions: [{ action: "subagent", resource: "*", effect: "allow" }] } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.server.address().port}/v1`, apiKey: "synthetic" }, models: { fixture: {} } } },
    plugins: [path.dirname(fileURLToPath(import.meta.url))] })
  runtime = await launch(root, deadline); client = runtime.client; results.server = runtime.info
  const openapi = await (await fetch(runtime.url + "/openapi.json", { headers: runtime.headers, signal: AbortSignal.timeout(10000) })).json()
  await writeFile(path.join(root, "openapi.json"), JSON.stringify(openapi, null, 2))
  void (async () => { try { for await (const event of client.event.subscribe({ signal: abort.signal })) events.push(event) } catch (error) { if (!abort.signal.aborted) failure = error } })()
  await client.agent.list({ location: { directory: project } })
  const pluginSource = await readFile(new URL("index.ts", import.meta.url), "utf8")
  assert(!/editor\.(update|remove)|\.execute\s*=|permissionOptions/.test(pluginSource), "Unmodified native tools")
  results.initialCatalog = (await inspect()).tools
  assert(results.initialCatalog.some(tool => tool.id === "subagent"))
  const coordinator = await client.session.create({ location: { directory: project }, title: "Native integration coordinator" }); rootID = coordinator.id; sessions.add(rootID)
  provider.markerPlans.set("PHASE_UNREPORTED", [{ answer: "UNREPORTED_NATIVE_SUCCESS" }])
  provider.markerPlans.set("PHASE_NEGATIVE", [
    { answer: report("unknown-task", "DENY_WRONG_TASK", "negative_wrong") },
    { answer: report("verify", "DENY_BLOCKED_DEPENDENCY", "negative_blocked") },
    { answer: call("integration_report", { taskKey: "investigate", outcome: "succeeded", summary: "DENY_WRONG_OUTCOME" }, "negative_outcome") },
    { answer: "NEGATIVE_NATIVE_RESULT" },
  ])
  provider.markerPlans.set("PHASE_INVESTIGATE", [
    { answer: sub("PHASE_INVESTIGATE_LEAF", "investigate_recursive", { agent: "integration_sub" }) },
    { answer: "INVESTIGATE_NATIVE_RESULT" },
    { hold: "implement-model", answer: entry => report("implement", "IMPLEMENTATION_EVIDENCE\nSame native child continued; no root actor was created.", "implement_report", ["Actual continued session: " + entry.sessionID, "Bounded implementation fixture result"]) },
    { answer: "IMPLEMENT_NATIVE_RESULT" },
  ])
  provider.markerPlans.set("PHASE_INVESTIGATE_LEAF", [{ answer: entry => report("investigate", "INVESTIGATION_EVIDENCE\nRecursive native leaf supplied this full bounded report.\nThis is synthetic test evidence, not user project content.", "investigate_report",
    ["Actual native leaf: " + entry.sessionID, "Native ancestor correlation comes from session.parentID and progress events.", "Investigate dependency explicitly satisfied."]) }, { answer: "INVESTIGATE_LEAF_RESULT" }])
  // Longest marker first prevents fixture-only routing from confusing the leaf with its ancestor marker.
  const investigateLeafPlan = provider.markerPlans.get("PHASE_INVESTIGATE_LEAF"); provider.markerPlans.delete("PHASE_INVESTIGATE_LEAF")
  const investigatePlan = provider.markerPlans.get("PHASE_INVESTIGATE"); provider.markerPlans.delete("PHASE_INVESTIGATE")
  provider.markerPlans.set("PHASE_INVESTIGATE_LEAF", investigateLeafPlan); provider.markerPlans.set("PHASE_INVESTIGATE", investigatePlan)
  provider.markerPlans.set("PHASE_REVIEW", [{ hold: "review-model", answer: "REVIEW_NATIVE_RESULT" }])
  provider.markerPlans.set("PHASE_VERIFY_LEAF", [{ answer: entry => report("verify", "VERIFICATION_EVIDENCE\nIndependent recursive verifier leaf completed the custom task contract.", "verify_report", ["Actual fresh verifier leaf: " + entry.sessionID, "Independent native branch, not a Pocock fresh-root qualification."]) }, { answer: "VERIFY_LEAF_RESULT" }])
  provider.markerPlans.set("PHASE_VERIFY_GRANDCHILD", [{ answer: sub("PHASE_VERIFY_LEAF", "verify_to_leaf", { agent: "integration_sub" }) }, { require: ["VERIFY_LEAF_RESULT"], answer: "VERIFY_GRANDCHILD_RESULT" }])
  provider.markerPlans.set("PHASE_VERIFY", [{ answer: sub("PHASE_VERIFY_GRANDCHILD", "verify_recursive", { agent: "integration_sub" }) }, { require: ["VERIFY_GRANDCHILD_RESULT"], answer: "VERIFY_PARENT_RESULT" }])
  provider.plans.set(rootID, [
    { answer: call("integration_start", { objective: "Investigate → implement → verify through real recursive native sessions" }, "mission_start") },
    { hold: "initial", answer: sub("PHASE_UNREPORTED", "unreported_call") },
    { require: ["UNREPORTED_NATIVE_SUCCESS"], hold: "after-unreported", answer: sub("PHASE_NEGATIVE", "negative_call") },
    { require: ["NEGATIVE_NATIVE_RESULT"], hold: "after-negative", answer: sub("PHASE_INVESTIGATE", "investigate_call") },
    { require: ["INVESTIGATION_EVIDENCE", "INVESTIGATE_NATIVE_RESULT"], hold: "after-investigation", answer: entry => {
      const childID = childForCall("investigate_call")
      assert(JSON.stringify(entry.body.messages).includes(childID), "Coordinator actually consumed child identity before native continuation decision")
      return [sub("PHASE_IMPLEMENT_CONTINUATION", "implement_continue", { sessionID: childID }), sub("PHASE_REVIEW", "review_parallel", { agent: "integration_sub", background: true })]
    } },
    { require: ["IMPLEMENTATION_EVIDENCE", "IMPLEMENT_NATIVE_RESULT", "REVIEW_NATIVE_RESULT"], hold: "after-implemented", answer: sub("PHASE_VERIFY", "verify_call") },
    { require: ["VERIFICATION_EVIDENCE", "VERIFY_PARENT_RESULT"], hold: "after-verified", answer: call("integration_report", { final: true, outcome: "completed", summary: "EXPLICIT_COORDINATOR_COMPLETION" }, "mission_final") },
    { require: ["EXPLICIT_COORDINATOR_COMPLETION"], answer: "COORDINATOR_NATIVE_DONE" },
  ])
  // Final report result carries business outcome, not the final summary; the last native model request consumes that outcome.
  provider.plans.get(rootID).at(-1).require = ['"outcome":"completed"']
  await client.session.prompt({ sessionID: rootID, text: "Run the synthetic custom Mission integration contract and decide every native launch explicitly." })
  stage = "initial dependency snapshot"; assert.deepEqual(statuses(await held("initial", "initial")), { investigate: "ready", implement: "blocked", verify: "blocked" }); provider.release("initial")
  stage = "native success without business report"; assert.deepEqual(statuses(await held("after-unreported", "native-success-unreported")), { investigate: "ready", implement: "blocked", verify: "blocked" }); await stableWindow(); provider.release("after-unreported")
  stage = "invalid task, blocked dependency, invalid outcome"; assert.deepEqual(statuses(await held("after-negative", "negative-reports-denied")), { investigate: "ready", implement: "blocked", verify: "blocked" })
  const negativeID = childForCall("negative_call"), negatives = parts(await messages(negativeID)); assert.equal(negatives.length, 3); assert(negatives.every(part => part.state.status === "error")); results.negativeReports = negatives
  provider.release("after-negative")
  stage = "recursive investigation report and coordinator decision"; assert.deepEqual(statuses(await held("after-investigation", "investigate-reported")), { investigate: "completed", implement: "ready", verify: "blocked" })
  assert(consumed(rootID, "INVESTIGATION_EVIDENCE")); assert(consumed(childForCall("investigate_call"), "INVESTIGATE_LEAF_RESULT")); await stableWindow(); provider.release("after-investigation")
  stage = "same-child implementation plus parallel review"; await until(() => provider.holds.has("implement-model") && provider.holds.has("review-model"))
  assert.equal(childForCall("implement_continue"), childForCall("investigate_call"))
  const active = await client.session.active(); assert(active[childForCall("implement_continue")] && active[childForCall("review_parallel")]); results.parallelActivity = active; await frame("parallel-review-active")
  provider.release("review-model"); await wait(childForCall("review_parallel")); provider.release("implement-model")
  stage = "implementation report dependency transition"; assert.deepEqual(statuses(await held("after-implemented", "implemented")), { investigate: "completed", implement: "completed", verify: "ready" }); assert(consumed(rootID, "REVIEW_NATIVE_RESULT")); provider.release("after-implemented")
  stage = "independent recursive verification"; assert.deepEqual(statuses(await held("after-verified", "verified")), { investigate: "completed", implement: "completed", verify: "completed" }); provider.release("after-verified")
  stage = "explicit active coordinator final business report"; await wait(rootID); const finished = await frame("finished"); assert.equal(finished.status, "completed")
  const requestCountAfterDone = await stableWindow(); results.noDispatcherAfterCompletion = { providerRequests: requestCountAfterDone, stableMs: 300 }
  stage = "foreign-parent continuation deny"
  const foreign = await client.session.create({ location: { directory: project }, title: "Foreign continuation negative control" }); sessions.add(foreign.id)
  await until(() => events.some(event => event.type === "session.created" && event.data.sessionID === foreign.id))
  const oldChild = childForCall("investigate_call"), beforeRequests = primary(oldChild).length, births = events.filter(event => event.type === "session.created").length
  provider.plans.set(foreign.id, [{ answer: sub("FOREIGN_DENIED", "foreign_continue", { sessionID: oldChild }) }]); await client.session.prompt({ sessionID: foreign.id, text: "Attempt forbidden foreign-parent continuation" }); await wait(foreign.id)
  assert.equal(parts(await messages(foreign.id))[0].state.status, "error"); assert.equal(primary(oldChild).length, beforeRequests); assert.equal(events.filter(event => event.type === "session.created").length, births)
  results.foreignNegative = { sessionID: foreign.id, nativeTool: parts(await messages(foreign.id))[0], childRequestDelta: 0, birthDelta: 0 }
  results.final = await inspect(); assert.equal(results.final.snapshot.discardedEvents, 0); assert(!results.final.snapshot.notificationUnavailable)
  const reports = results.final.snapshot.missions.find(mission => mission.coordinatorSessionId === rootID).tasks.map(task => task.report)
  assert(reports.every(value => value.notificationStatus === "admitted")); assert.equal(new Set(reports.map(value => value.id)).size, 3)
  results.nativeIDs = { rootID, investigator: oldChild, investigationLeaf: childForCall("investigate_recursive"), reviewer: childForCall("review_parallel"), verifier: childForCall("verify_call"), verifierGrandchild: childForCall("verify_recursive"), verifierLeaf: childForCall("verify_to_leaf") }
  assert.equal((await client.session.get({ sessionID: results.nativeIDs.verifierLeaf })).parentID, results.nativeIDs.verifierGrandchild)
  assert.notEqual(results.nativeIDs.verifierLeaf, results.nativeIDs.investigationLeaf)
  results.consumption = Object.fromEntries(["INVESTIGATION_EVIDENCE", "IMPLEMENTATION_EVIDENCE", "REVIEW_NATIVE_RESULT", "VERIFICATION_EVIDENCE"].map(marker => [marker, consumed(rootID, marker).index]))
  const rootTranscript = await messages(rootID), syntheticReports = rootTranscript.filter(message => message.type === "synthetic" && message.metadata?.["integration.report"])
  assert.equal(syntheticReports.length, 3); assert(syntheticReports.every(message => reports.some(value => value.id === message.metadata["integration.report"].id)))
  assert(rootTranscript.some(message => message.type === "synthetic" && message.metadata?.source === "subagent" && message.metadata.childID === results.nativeIDs.reviewer))
  results.channels = { explicitBusinessReports: syntheticReports.map(message => ({ id: message.id, metadata: message.metadata })), nativeBackgroundReview: rootTranscript.filter(message => message.type === "synthetic" && message.metadata?.source === "subagent") }
  const finalCalled = events.findIndex(event => event.type === "session.tool.called" && event.data.id === "mission_final"), finalSuccess = events.findIndex(event => event.type === "session.tool.success" && event.data.id === "mission_final")
  const stopped = events.findIndex((event, index) => index > finalSuccess && event.type === "session.execution.succeeded" && event.data.sessionID === rootID)
  assert(finalCalled >= 0 && finalSuccess > finalCalled && stopped > finalSuccess); results.activeCoordinatorFinish = { calledEventIndex: finalCalled, successfulEventIndex: finalSuccess, laterExecutionStoppedEventIndex: stopped }
  const nativeSchema = request => request.body.tools.find(tool => tool.function.name === "subagent")
  assert.deepEqual(nativeSchema(primary(rootID)[0]), nativeSchema(primary(rootID).at(-1)), "Native provider schema unchanged across business integration")
  results.nativeSchema = nativeSchema(primary(rootID)[0]); results.finalCatalog = results.final.tools; assert.deepEqual(results.initialCatalog.find(tool => tool.id === "subagent"), results.finalCatalog.find(tool => tool.id === "subagent"))
  results.sourceTypecheck = execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "--noEmit", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "Bundler", "--strict", "--skipLibCheck", "--esModuleInterop", "--types", "node", "packages/server/src/missions/native-subsession-experiment/integration.ts"], { encoding: "utf8", timeout: 30000 }) || "passed scoped integration module"
  results.gates = ["native-success-is-not-report", "wrong-task-denied", "blocked-report-denied", "invalid-outcome-denied", "recursive-investigation", "same-child-implementation", "parallel-native-review", "independent-recursive-verifier", "provider-consumption-before-next-decision", "explicit-active-coordinator-completion", "no-automatic-dispatch", "foreign-parent-continuation-denied", "compatible-report-receipts", "immutable-native-tool", "primary-and-lane1-unchanged"]
  results.status = "passed"
} catch (error) { results.status = "failed"; results.failure = { stage, error: String(error), detail: error, stack: error.stack }; process.exitCode = 1 }
finally {
  try {
    if (client && runtime.child.exitCode === null) {
      results.nativeSessions = await Promise.all(nativeIDs().map(id => client.session.get({ sessionID: id })))
      await writeFile(path.join(root, "transcripts.json"), JSON.stringify(Object.fromEntries(await Promise.all(nativeIDs().map(async id => [id, await messages(id)]))), null, 2))
      results.lastInspection = await inspect()
    }
  } finally {
    abort.abort(); await runtime?.stop(); await provider.stop()
    results.protectedAfter = await protect(); assert.deepEqual(results.protectedAfter, before)
    results.rootID = rootID; results.counts = { providerRequests: provider.requests.length, primaryRequests: provider.requests.filter(request => request.kind === "primary").length, nativeSessions: results.nativeSessions?.length, nativeEvents: events.length }
    const files = ["scripts/native-subsession-spike/integration/run.mjs", "scripts/native-subsession-spike/integration/runtime.mjs", "scripts/native-subsession-spike/integration/index.ts", "packages/server/src/missions/native-subsession-experiment/integration.ts"]
    results.ownHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(file))])))
    await Promise.all([writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2)), writeFile(path.join(root, "requests.json"), JSON.stringify(provider.requests, null, 2)), writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2)),
      writeFile(path.join(root, "capture.json"), JSON.stringify({ version: 1, transport: "captured-native-fixture", rootID, frames }, null, 2)), writeFile(path.join(root, "serve.log"), runtime?.logs() ?? "")])
    console.log(`${results.status.toUpperCase()} native Mission integration: ${root}`); if (results.failure) console.error(results.failure)
  }
}
