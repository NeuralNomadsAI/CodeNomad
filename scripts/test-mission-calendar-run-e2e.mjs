// End-to-end isolated OpenCode test of a Mission calendar with the REAL bundled
// `codenomad.missions` plugin and no CodeNomad at all (no presence lease, no bridge):
// 1. Without CodeNomad and without work, Missions stays unregistered.
// 2. A native Automation whose whole program is the calendar tool launches an ordinary
//    one-time Mission: created, started, coordinator `/goal` armed.
// 3. While that Mission is active, later runs launch nothing.
// 4. The coordinator delegates an independent task: the plugin creates the root,
//    prompts it and delivers its report by its own session API; the Mission completes.
// 5. The next run launches again: the new Mission replaces the first one, in the same
//    conversation. OpenCode restarts in the middle of it and Missions registers again
//    by itself, so the coordinator can finish.
// 6. A calendar waiting for commits on a local branch launches nothing until one lands,
//    then coordinates in the conversation it names.
// 7. A programming saved with a prepared Mission launches by starting that Mission.
// Usage: node --import tsx scripts/test-mission-calendar-run-e2e.mjs <absolute-opencode-cli>
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { CODENOMAD_MISSIONS_RPC } from "../packages/server/src/missions/rpc.ts"
import { MISSION_CALENDAR_CODE } from "../packages/server/src/missions/calendar-run.ts"
import { missionCalendars } from "../packages/server/src/opencode/mission-calendars.ts"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass absolute OpenCode CLI path")

const bundlePath = path.resolve("packages/server/dist/plugins/missions/plugin.mjs")
const root = await mkdtemp(path.join(await fixtureParent(), "mission-calendar-run-e2e-"))
// CodeNomad never runs here: the presence directory stays empty.
const presenceDir = path.join(root, "presence")
await mkdir(presenceDir, { recursive: true })
const git = (...args) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, stdio: "pipe" })
git("init", "-q", "-b", "main"); git("commit", "-q", "--allow-empty", "-m", "first")

const password = randomUUID()
const env = await fixtureEnvironment(root, {
  OPENCODE_CONFIG_DIR: path.join(root, "config"),
  OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: password,
})
const pluginDir = path.join(env.OPENCODE_CONFIG_DIR, "plugins", "codenomad-missions")
await mkdir(pluginDir, { recursive: true })
await writeFile(path.join(pluginDir, "package.json"), JSON.stringify({
  name: "codenomad-missions-e2e-shim", type: "module", exports: { ".": "./index.mjs" }, opencode: { server: "./index.mjs" },
}), "utf8")
await writeFile(path.join(pluginDir, "index.mjs"), `
import { desktopPlugin } from ${JSON.stringify(pathToFileURL(bundlePath).href)}
export default desktopPlugin(${JSON.stringify(presenceDir)})
`, "utf8")

// A scripted model. A tool result ends the turn. The coordinator delegates one independent
// task and reports once that task's report reaches it, or (held) reports after `holdMs`;
// the task's root reports after `rootHoldMs`.
const OBJECTIVE = "CALENDAR-OBJECTIVE review what changed", BRIEF = "ROOT-TASK inspect the change", DONE = "ROOT-DONE"
// `service` counts OpenCode starts: a turn held across a restart answers a service that is gone.
const script = { mode: "delegate", holdMs: 0, rootHoldMs: 25_000, service: 1 }
const seen = { delegated: new Set(), rootReports: 0, finals: 0, coordinatorTurns: 0, heldTurns: 0, rootTurns: 0 }
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw), tools = (Array.isArray(body.tools) ? body.tools : []).map(tool => tool?.function?.name)
    const text = JSON.stringify(body.messages ?? body.input ?? "")
    res.setHeader("Content-Type", "text/event-stream")
    const chunk = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    const say = content => { chunk({ role: "assistant", content }, null); chunk({}, "stop"); res.end("data: [DONE]\n\n") }
    const call = (name, input) => {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + randomUUID().slice(0, 8), type: "function", function: { name, arguments: JSON.stringify(input) } }] }, null)
      chunk({}, "tool_calls"); res.end("data: [DONE]\n\n")
    }
    if (!tools.length) return say("Fixture title")
    if (body.messages?.at(-1)?.role === "tool") return say("Noted.")
    const report = tools.find(name => /mission[_.]report$/.test(name ?? "")), delegate = tools.find(name => /mission[_.]delegate$/.test(name ?? ""))
    // Every launch shares one conversation: the latest start names the current Mission.
    const mission = [...text.matchAll(/Start or resume existing mission (msn_[A-Za-z0-9]+)/g)].at(-1)?.[1] ?? "unknown"
    if (text.includes("Start or resume existing mission")) {
      seen.coordinatorTurns++
      if (!report || !delegate) return say("Mission tools missing.")
      if (script.mode === "held") {
        seen.heldTurns++
        const service = script.service
        await delay(script.holdMs)
        if (service === script.service) seen.finals++
        return call(report, { outcome: "completed", summary: "Held Mission finished.", final: true })
      }
      if (text.includes(DONE)) {
        // The next launch arrives in this same conversation as soon as this one completes: script it now.
        seen.finals++; script.mode = "held"; script.holdMs = 25_000
        return call(report, { outcome: "completed", summary: "Delegated work returned.", final: true })
      }
      if (!seen.delegated.has(mission)) {
        seen.delegated.add(mission)
        return call(delegate, { taskKey: "probe", title: "Probe", brief: BRIEF, role: "specialist", delivery: "queue",
          executionMode: { kind: "independent", reason: "lifetime", explanation: "The probe outlives this turn." } })
      }
      await delay(2_000)
      return say("Waiting for the probe.")
    }
    if (text.includes("ROOT-TASK")) {
      seen.rootTurns++
      if (!report) return say("Mission tools missing.")
      await delay(script.rootHoldMs)
      seen.rootReports++
      return call(report, { outcome: "completed", summary: DONE })
    }
    return say("Nothing to do.")
  } catch (error) { res.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))

env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  automations: true, plugins: [pluginDir], model: "fixture/fixture",
  providers: { fixture: { package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} } } },
})

const location = { directory: root }, callOpts = { location, headers: { "x-opencode-directory": root } }
async function startDaemon(label) {
  let output = "", spawnError
  const child = spawn(cli, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.on("error", error => { spawnError = error })
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`${label} failed:\n${output.slice(-2000)}`)
    await delay(25)
  }
  const file = path.join(env.XDG_STATE_HOME, "opencode/service.json")
  let endpoint
  while (!endpoint && Date.now() < deadline) {
    try { if (JSON.parse(await readFile(file, "utf8")).pid === child.pid) endpoint = await Service.discover({ file }) } catch {}
    if (!endpoint) await delay(25)
  }
  assert(endpoint, `${label} did not register isolated service.json`)
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  return { client,
    snapshot: () => client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, callOpts),
    goal: async sessionID => (await client.rpc.call({ rpcID: "opencode.goal", method: "get", input: { sessionID }, location }, { headers: callOpts.headers })).output,
    stop: async () => { await stopFixtureChild(child, stopped); await writeFile(path.join(root, `daemon-${label}.log`), output) } }
}
const until = async (label, read, done, ms = 60_000) => {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await read(); if (done(last)) return last } catch (error) { last = { error: String(error?.message ?? error) } }
    await delay(250)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)?.slice(0, 1500)}`)
}
const missions = async daemon => (await daemon.snapshot()).missions

let daemon
try {
  daemon = await startDaemon("1")
  await delay(3_000)
  await assert.rejects(daemon.snapshot(), "Missions is unregistered without CodeNomad and without work")
  console.log("PASS 1 (no CodeNomad, no work: Missions unregistered)")

  // The server's own adapter creates the carrier conversation and the Automations.
  const projectID = (await daemon.client.location.get({ location })).project.id
  const calendars = () => missionCalendars(daemon.client, location, projectID)
  const rule = (calendar, args) => ({ name: args.title, trigger: { type: "every", every: "15 seconds" }, action: { type: "code", code: MISSION_CALENDAR_CODE, args: { calendar, ...args } } })
  await calendars().save("cal_e2e", [rule("cal_e2e", { objective: OBJECTIVE, title: "Calendar E2E", template: "custom", coordinatorGoal: true })])
  const automation = { id: (await calendars().list())[0].rules[0].automationID }
  const row = () => daemon.client.experimental.automation.get({ automationID: automation.id })

  const first = (await until("first Mission", () => missions(daemon), list => list.length === 1, 60_000).catch(async error => {
    throw new Error(`${error.message}\nautomation: ${JSON.stringify(await row().catch(() => null))?.slice(0, 1500)}`)
  }))[0]
  assert.equal(first.title, "Calendar E2E")
  assert.equal(first.status, "active")
  await until("coordinator /goal", () => daemon.goal(first.coordinatorSessionId), goal => goal?.status === "active", 20_000)
  console.log("PASS 2 (the Automation launched and started a one-time Mission, /goal armed)")

  const launchedAt = (await row()).runCount
  const later = await until("a later run", row, info => info.runCount >= launchedAt + 1, 45_000)
  assert.notEqual(later.lastOutcome, "failed", later.lastOutput)
  const listed = (await calendars().list())[0]
  assert.deepEqual([listed.id, listed.title, listed.paused, listed.last?.outcome, listed.last?.missionID, listed.last?.coordinatorSessionID],
    ["cal_e2e", "Calendar E2E", false, "waiting", first.id, first.coordinatorSessionId], "the list tells what the programmed Mission last did")
  assert.deepEqual((await missions(daemon)).map(mission => [mission.id, mission.status]), [[first.id, "active"]], "a run launches nothing while the previous Mission is active")
  console.log("PASS 3 (later runs wait for the active Mission)")

  // Read while the launch is active: the next one removes its Mission.
  const working = (await until("independent task", () => missions(daemon), list => list.find(mission => mission.id === first.id)?.actors.some(actor => actor.kind !== "coordinator"), 60_000))
    .find(mission => mission.id === first.id)
  assert.equal(working.tasks[0]?.key, "probe")
  const actor = working.actors.find(actor => actor.kind !== "coordinator")
  assert.ok(actor?.managed, "the independent root is a managed actor")
  assert.equal((await daemon.client.session.get({ sessionID: actor.sessionId })).parentID, undefined)
  // The plugin admits the report at once; under `/goal` OpenCode took 20 to 60 seconds to hand it to the coordinator.
  await until("the final report", async () => seen.finals, count => count >= 1, 180_000)
  assert.ok(seen.rootReports >= 1)
  console.log("PASS 4 (independent task: root created, prompted and reported without CodeNomad)")

  const replaced = await until("the next launch", () => missions(daemon), list => list.some(mission => mission.id !== first.id), 90_000)
  const second = replaced.find(mission => mission.id !== first.id)
  assert.deepEqual([replaced.length, second.coordinatorSessionId], [1, first.coordinatorSessionId], "the new launch replaces the first Mission, in the same conversation")
  assert.deepEqual((await calendars().list())[0].last?.history.map(item => item.outcome), ["completed"])
  await until("held coordinator turn", async () => seen.heldTurns, count => count > 0, 120_000)
  await calendars().pause("cal_e2e")
  await daemon.stop()
  script.holdMs = 0; script.service++
  daemon = await startDaemon("2")
  const restored = await until("Missions after restart", () => missions(daemon), list => list.some(mission => mission.id === second.id), 30_000)
  assert.equal(restored.find(mission => mission.id === second.id).status, "active")
  // Once it completes nothing is left to do, and Missions unregisters within two seconds: either reading proves the end.
  const finals = seen.finals
  await until("second Mission ends after restart", () => missions(daemon).then(list => list.find(mission => mission.id === second.id)?.status, () => "unregistered"),
    status => status === "completed" || status === "unregistered", 120_000)
  assert.ok(seen.finals > finals, "the coordinator sent its final report after the restart")
  console.log("PASS 5 (after an OpenCode restart Missions registers again and the Mission finishes)")
  assert.equal((await calendars().list())[0].paused, true)
  await calendars().delete("cal_e2e")

  // Held long enough to be read: once its Mission completes, Missions unregisters again.
  script.holdMs = 10_000
  await calendars().save("cal_commits", [rule("cal_commits", { objective: OBJECTIVE, title: "Commits E2E", template: "custom", coordinatorSessionID: first.coordinatorSessionId,
    when: [{ kind: "branch-commits", directory: root, ref: "refs/heads/main" }] })])
  const watching = { id: (await calendars().list())[0].rules[0].automationID }
  const watch = () => daemon.client.experimental.automation.get({ automationID: watching.id })
  // Beside an Automation that existed at startup, OpenCode can take a minute to run a new one for the first time.
  const quiet = await until("two runs without a commit", watch, info => info.runCount >= 2 || info.lastOutcome === "failed", 150_000)
  assert.notEqual(quiet.lastOutcome, "failed", quiet.lastOutput)
  assert.equal((await missions(daemon).catch(() => [])).filter(mission => mission.title === "Commits E2E").length, 0, "no commit, no Mission")
  git("commit", "-q", "--allow-empty", "-m", "second")
  const reused = (await until("the commit's Mission", () => missions(daemon), list => list.some(mission => mission.title === "Commits E2E"), 60_000).catch(async error => {
    throw new Error(`${error.message}\nautomation: ${JSON.stringify(await watch().catch(() => null))?.slice(0, 1500)}`)
  })).find(mission => mission.title === "Commits E2E")
  assert.equal(reused.coordinatorSessionId, first.coordinatorSessionId, "the calendar's Missions share the conversation it names")
  console.log("PASS 6 (a calendar waiting for commits launches only once one lands, in the conversation it names)")
  await calendars().delete("cal_commits")
  assert.deepEqual(await calendars().list(), [])

  // A person programs a Mission with CodeNomad open: its backend lease registers Missions, and the Mission is prepared at once.
  const lease = path.join(presenceDir, `${randomUUID()}.lease`)
  await writeFile(lease, "")
  const prepared = (await until("the prepared Mission", () => daemon.client.rpc(CODENOMAD_MISSIONS_RPC).create({ requestID: "req_prepared_e2e", objective: OBJECTIVE,
    title: "Prepared E2E", template: "custom", prepared: true }, callOpts), created => !!created?.mission?.id, 30_000)).mission
  await rm(lease)
  await calendars().save("cal_prepared", [rule("cal_prepared", { objective: OBJECTIVE, title: "Prepared E2E", template: "custom", prepared: prepared.id,
    when: [{ kind: "branch-commits", directory: root, ref: "refs/heads/main" }] })])
  const programmed = () => daemon.client.experimental.automation.get({ automationID: watchingPrepared.id })
  const watchingPrepared = { id: (await calendars().list())[0].rules[0].automationID }
  const still = await until("two runs without a commit", programmed, info => info.runCount >= 2 || info.lastOutcome === "failed", 150_000)
  assert.notEqual(still.lastOutcome, "failed", still.lastOutput)
  assert.equal((await calendars().list())[0].missionID, prepared.id, "the programmed Mission is the prepared one")
  assert.equal((await missions(daemon)).find(mission => mission.id === prepared.id).runState, "prepared")
  git("commit", "-q", "--allow-empty", "-m", "third")
  await until("the prepared Mission starts", () => missions(daemon).then(list => list.find(mission => mission.id === prepared.id)?.runState, () => "unregistered"),
    state => state === "running" || state === "unregistered", 60_000)
  assert.deepEqual([(await calendars().list())[0].last?.outcome, (await calendars().list())[0].last?.missionID], ["launched", prepared.id])
  console.log("PASS 7 (a programming saved with a prepared Mission launches by starting that Mission)")
  await calendars().delete("cal_prepared")
} finally {
  console.log("seen:", JSON.stringify({ ...seen, delegated: [...seen.delegated] }))
  if (daemon) await daemon.stop().catch(() => {})
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
}
