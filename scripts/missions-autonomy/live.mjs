import assert from "node:assert/strict"
import { writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { protect, privateRuntime, launch } from "../native-subsession-spike/integration/runtime.mjs"
import { tsImport } from "tsx/esm/api"

const { CODENOMAD_MISSIONS_RPC } = await tsImport("../../packages/server/src/missions/rpc.ts", import.meta.url)
const before = await protect()
const { root, project } = await privateRuntime()
const deadline = Date.now() + 360000
const model = { providerID: "openai", id: "gpt-6.1-sol" }
const events = [], viewerAbort = new AbortController()
const results = { transport: "live-native-real-model", model, root, codeNomadBackendStarted: false,
  sharedProductEntry: "setupMissionsPlugin", protectedBefore: before }
let runtime, client, coordinator, stage = "launch", eventFailure
const signal = () => AbortSignal.timeout(Math.min(30000, Math.max(1, deadline - Date.now())))
const snapshot = () => client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location: { directory: project }, signal: signal() })
async function until(predicate) {
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) throw new Error("Owned private OpenCode server exited")
    if (eventFailure) throw eventFailure
    const failed = events.find(event => event.type === "session.execution.failed" && event.data.sessionID === coordinator?.id)
    if (failed) {
      results.nativeFailure = failed.data.error
      throw new Error(failed.data.error.message)
    }
    const value = await predicate()
    if (value) return value
    await delay(250)
  }
  throw new Error("Timeout at " + stage)
}
try {
  delete process.env.OPENCODE_DISABLE_MODELS_FETCH
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: `${model.providerID}/${model.id}`, default_agent: "mission_trial",
    update: "disable", snapshots: false, experimental: { subagent_depth: 3 },
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "allow" }, { action: "mission_*", resource: "*", effect: "allow" }],
    agents: { mission_trial: { mode: "all", description: "Bounded recursive mission trial", steps: 18,
      system: "You are testing an actual Missions plugin on a small reasoning task. Use mission_inspect to start and mission_report to finish. Use real native subagent tools when requested. Do not use shell, files, network tools or any external side effects. Keep answers short. The native subagent tool can call this same all-mode agent recursively." } },
    plugins: [path.dirname(fileURLToPath(import.meta.url))] })
  // Leave time to capture the failed trial before the native-process watchdog.
  runtime = await launch(root, deadline + 10000)
  client = runtime.client
  results.server = runtime.info
  stage = "native plugin/model discovery"
  await client.agent.list({ location: { directory: project } }, { signal: signal() })
  assert.equal((await snapshot()).missions.length, 0)
  results.plugins = await client.plugin.list({ location: { directory: project } }, { signal: signal() })
  const { data: models } = await client.model.list({ location: { directory: project } }, { signal: signal() })
  results.availableTrialModels = models.filter(value => value.providerID === model.providerID)
    .map(value => ({ providerID: value.providerID, id: value.id, enabled: value.enabled }))
  assert(models.some(value => value.providerID === model.providerID && value.id === model.id && value.enabled !== false), "Requested GPT-6.1 Sol model is available in this authorized runtime")
  const viewer = OpenCode.make({ baseUrl: runtime.url, headers: runtime.headers })
  void (async () => { try { for await (const event of viewer.event.subscribe({ signal: viewerAbort.signal })) events.push(event) }
    catch (error) { if (!viewerAbort.signal.aborted) eventFailure = error } })()
  coordinator = await client.session.create({ location: { directory: project }, title: "Missions live autonomy: recursive arithmetic", agent: "mission_trial", model }, { signal: signal() })
  results.coordinatorID = coordinator.id
  stage = "real recursive Mission execution"
  await client.session.prompt({ sessionID: coordinator.id, text: `Run one small actual Mission.
1. Call mission_inspect with start objective "Check a weighted score through two recursive native helpers", template "custom".
2. Use the native subagent tool with agent "mission_trial". Ask it to call another native subagent with the same agent to compute 17*23. The first child must receive that leaf result, add 41, and return its reasoning and result. Both descendants must just return native results, not start a Mission or call Mission reports.
3. Independently check the expected total 432. Once you receive the native result, finish the Mission with mission_report final=true outcome=completed, summary containing the total and evidence mentioning the two-level delegation.
Do not declare formal task rows in this first trial: this trial tests native execution and the existing final business report only. Do not create root specialists, do not modify files, and do not claim a helper ran without an actual subagent call.` }, { signal: signal() })
  await until(() => events.find(event => event.type === "session.created" && event.data.parentID === coordinator.id))
  stage = "viewer detachment while native work is running"
  viewerAbort.abort()
  results.viewerDetachedAt = Date.now()
  results.eventsBeforeViewerDetach = events.length
  // Nothing closes the private native server. There is no desktop lease or
  // CodeNomad backend to keep this plugin loaded; the observer is now detached.
  stage = "autonomous completion without viewer"
  const finished = await until(async () => (await snapshot()).missions.find(mission => mission.coordinatorSessionId === coordinator.id && mission.status !== "active"))
  assert.equal(finished.status, "completed")
  assert.match(finished.summary, /432/)
  results.finished = finished
  await until(async () => !(await client.session.active({ signal: signal() }))[coordinator.id])
  stage = "fresh client reattachment and persisted readback"
  client = OpenCode.make({ baseUrl: runtime.url, headers: runtime.headers })
  const restored = await snapshot()
  assert.deepEqual(restored.missions, (await snapshot()).missions)
  assert.deepEqual(restored.missions.find(mission => mission.id === finished.id), finished)
  const first = await client.session.list({ parentID: coordinator.id, limit: { limit: 20 } }, { signal: signal() })
  assert(first.data.length >= 1, "Native child really exists")
  const second = await Promise.all(first.data.map(child => client.session.list({ parentID: child.id, limit: { limit: 20 } }, { signal: signal() })))
  assert(second.some(page => page.data.length >= 1), "Native grandchild really exists")
  const ids = [coordinator.id, ...first.data.map(child => child.id), ...second.flatMap(page => page.data.map(child => child.id))]
  results.sessions = await Promise.all(ids.map(sessionID => client.session.get({ sessionID }, { signal: signal() })))
  const transcripts = Object.fromEntries(await Promise.all(ids.map(async sessionID => [sessionID,
    (await client.message.list({ sessionID, limit: { order: "asc", limit: 100 } }, { signal: signal() })).data])))
  assert(transcripts[coordinator.id].some(message => (message.content ?? []).some(part => part.type === "tool" && part.name === "mission_report" && part.state.status === "success")), "Product final report succeeded natively")
  await writeFile(path.join(root, "transcripts.json"), JSON.stringify(transcripts, null, 2))
  results.reconnected = { serverPID: (await client.server.info({ signal: signal() })).pid, missionID: finished.id, nativeDepth: 2 }
  assert.equal(results.reconnected.serverPID, results.server.pid)
  results.status = "passed"
} catch (error) {
  results.status = "failed"
  results.failure = { stage, message: String(error), detail: error, stack: error.stack }
  process.exitCode = 1
  if (client && coordinator && runtime.child.exitCode === null) {
    try {
      results.lastSnapshot = await snapshot()
      await writeFile(path.join(root, "root-transcript.json"), JSON.stringify(await client.message.list({ sessionID: coordinator.id, limit: { order: "asc", limit: 100 } }, { signal: signal() }), null, 2))
    } catch (captureError) { results.captureError = String(captureError) }
  }
} finally {
  viewerAbort.abort()
  await runtime?.stop()
  results.protectedAfter = await protect()
  assert.deepEqual(results.protectedAfter, before)
  results.sources = Object.fromEntries(await Promise.all(["index.ts", "live.mjs"].map(async name => [name, await readFile(new URL(name, import.meta.url), "utf8") ])))
  await writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2))
  await writeFile(path.join(root, "events-before-detach.json"), JSON.stringify(events, null, 2))
  await writeFile(path.join(root, "serve.log"), runtime?.logs() ?? "")
  console.log(`${results.status.toUpperCase()} live shared Missions autonomy: ${root}`)
  if (results.failure) console.error(results.failure)
}
