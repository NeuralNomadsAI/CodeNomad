import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import { clearFixtureGitEnvironment } from "../native-fixture-guards.mjs"

// Use the existing authenticated native service and its configured GPT provider.
// Never copy credentials to a private server, alter global config, or start/stop
// the service. All mutations below belong to this newly created trial Location.
const root = await mkdtemp("C:/Users/Admin/AppData/Local/Temp/opencode/missions-gpt-trial-")
const project = path.join(root, "project")
clearFixtureGitEnvironment()
await mkdir(project)
const deadline = Date.now() + 240000
const lifetime = new AbortController()
const model = { providerID: "openai", id: "gpt-6.1-sol" }
const result = { root, project, model, composition: "compiled-shared-product-core", desktopCloseTest: false }
const events = []
let client, coordinator, stage = "native service discovery", eventError
const signal = () => AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now())))
const { OpenCodeCliService } = await tsImport("../../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
const { createRuntimeFetch } = await tsImport("../../packages/server/src/opencode/compatibility/transport.ts", import.meta.url)
const { CODENOMAD_MISSIONS_RPC } = await tsImport("../../packages/server/src/missions/rpc.ts", import.meta.url)
const cli = "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
const snapshot = () => client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location: { directory: project }, signal: signal() })
async function until(check) {
  while (Date.now() < deadline) {
    if (eventError) throw eventError
    const failed = events.find(event => event.type === "session.execution.failed")
    if (failed) { result.nativeFailure = failed.data.error; throw new Error(failed.data.error.message) }
    const found = await check()
    if (found) return found
    await delay(300)
  }
  throw new Error(`Trial deadline reached: ${stage}`)
}
try {
  const service = new OpenCodeCliService({ label: "Missions GPT trial", timeoutMs: 20000,
    command: (args, start) => {
      assert.equal(start, false, "This trial cannot start a shared service")
      assert(!args.includes("stop"))
      return { command: cli, args, options: {}, cwd: process.cwd(), env: process.env }
    } })
  const endpoint = await service.discover()
  assert(endpoint, "An existing authenticated OpenCode service is required")
  client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint) })
  result.server = await client.server.info({ signal: signal() })
  const plugin = path.join(root, "mission-core.mjs")
  await build({ entryPoints: [fileURLToPath(new URL("index.ts", import.meta.url))], outfile: plugin,
    bundle: true, platform: "node", format: "esm", target: "node22" })
  result.pluginBytes = (await readFile(plugin)).length
  const entry = path.join(project, ".opencode", "plugins", "missions-empirical", "index.ts")
  await mkdir(path.dirname(entry), { recursive: true })
  // Global CodeNomad already owns codenomad.missions in this service. Use a
  // trial-only plugin identity in this new Location; its business journal/RPC
  // remain the actual shared product. Never replace the global discovery entry.
  await writeFile(entry, `import core from ${JSON.stringify(plugin.replaceAll("\\", "/"))}\nexport default { ...core, id: "codenomad.missions.empirical" }\n`)
  execFileSync("git", ["init", "--quiet", project], { windowsHide: true })
  await writeFile(path.join(project, "opencode.json"), JSON.stringify({
    model: `${model.providerID}/${model.id}`, default_agent: "mission_trial", snapshots: false,
    experimental: { subagent_depth: 3 },
    permissions: [{ action: "*", resource: "*", effect: "deny" },
      { action: "subagent", resource: "*", effect: "allow" }, { action: "mission_*", resource: "*", effect: "allow" }],
    agents: { mission_trial: { mode: "all", model: `${model.providerID}/${model.id}`,
      description: "Short empirical recursive Missions check", steps: 12,
      system: "Use actual native recursive subagent calls, all on GPT-6.1 Sol. The root starts one custom Mission and finishes its global summary. Descendants return only native conversation answers, without starting Missions or business reports. No shell, files, network or external side effects. Keep work under two minutes. You may delegate to mission_trial recursively." } },
  }, null, 2))
  stage = "project plugin activation"
  await client.agent.list({ location: { directory: project } }, { signal: signal() })
  result.plugins = await client.plugin.list({ location: { directory: project } }, { signal: signal() })
  assert.equal((await snapshot()).missions.length, 0)
  const { data: models } = await client.model.list({ location: { directory: project } }, { signal: signal() })
  assert(models.some(value => value.providerID === model.providerID && value.id === model.id && value.enabled !== false), "GPT-6.1 Sol available through the native provider")
  void (async () => {
    try { for await (const event of client.event.subscribe({ signal: lifetime.signal })) {
      if (event.location?.directory === project || event.data?.sessionID === coordinator?.id) events.push(event)
    } } catch (error) { if (!lifetime.signal.aborted) eventError = error }
  })()
  coordinator = await client.session.create({ location: { directory: project }, title: "Missions empirical trial: close behavior", agent: "mission_trial", model }, { signal: signal() })
  result.coordinatorID = coordinator.id
  const code = await readFile(new URL("../../packages/server/src/opencode/desktop-plugin-presence.ts", import.meta.url), "utf8")
  stage = "short native recursive Mission"
  await client.session.prompt({ sessionID: coordinator.id, text: `Start a custom Mission through mission_inspect: objective "Find the close-while-busy defect and propose three short regressions".
Declare one native plan task through mission_delegate with taskKey "check-lifetime", title "Check close behavior", brief "Inspect this bounded implementation and derive three regressions", role "specialist", blockedBy []. This declaration must not create a root actor.
Use one native subagent with agent mission_trial to inspect the function below. Require that child to delegate to a second native subagent (same agent) to derive three concrete regression scenarios from the requirement. Receive their real native results. Do not invent their execution or create independent root workers.
Requirement: CodeNomad presence lost + idle Missions => dispose; presence lost + unfinished work => preserve registration; reopening while already active => no duplicate registration. Native service itself must never be stopped.
After the native results, record the coordinator business readout with mission_report taskKey="check-lifetime", outcome=completed, evidence including the defect and the three scenarios; omit contract. Then finish the global Mission with mission_report final=true outcome=completed. No child mission_report required. This is a bounded behavioral analysis of 47 lines, NOT a full architecture review.
Current implementation:\n${code}` }, { signal: signal() })
  const completed = await until(async () => (await snapshot()).missions.find(mission => mission.coordinatorSessionId === coordinator.id && mission.status === "completed"))
  result.mission = completed
  assert.equal(completed.tasks.length, 1)
  assert.equal(completed.tasks[0].status, "completed")
  assert.equal(completed.tasks[0].report?.delivery, "coordinator-readout")
  assert.equal(completed.tasks[0].report?.notificationStatus, undefined, "Coordinator readout is not an undelivered child notification")
  assert.equal(completed.actors.length, 1, "No independent root workers were created")
  stage = "native ancestry and persisted transcript verification"
  const children = (await client.session.list({ parentID: coordinator.id, limit: { limit: 12 } }, { signal: signal() })).data
  assert(children.length > 0, "Real native child exists")
  const grandchildren = (await Promise.all(children.map(child => client.session.list({ parentID: child.id, limit: { limit: 12 } }, { signal: signal() })))).flatMap(page => page.data)
  assert(grandchildren.length > 0, "Real native grandchild exists")
  const ids = [coordinator.id, ...children.map(item => item.id), ...grandchildren.map(item => item.id)]
  const sessions = await Promise.all(ids.map(sessionID => client.session.get({ sessionID }, { signal: signal() })))
  result.sessions = sessions
  for (const session of sessions) {
    assert.equal(session.model?.providerID, model.providerID)
    assert.equal(session.model?.id, model.id)
  }
  const transcripts = Object.fromEntries(await Promise.all(ids.map(async sessionID => [sessionID, (await client.message.list({ sessionID, limit: { order: "asc", limit: 80 } }, { signal: signal() })).data])))
  for (const id of ids.slice(1)) assert(!transcripts[id].some(message => message.content?.some(part => part.type === "tool" && part.name === "mission_report")), "Native descendants need no business-report copies")
  await writeFile(path.join(root, "transcripts.json"), JSON.stringify(transcripts, null, 2))
  assert.deepEqual((await snapshot()).missions.find(item => item.id === completed.id), completed)
  result.status = "passed"
} catch (error) {
  result.status = "failed"
  result.failure = { stage, message: error.message ?? String(error), detail: error }
  process.exitCode = 1
} finally {
  lifetime.abort()
  if (client && coordinator) {
    try {
      await writeFile(path.join(root, "root-transcript.json"), JSON.stringify(await client.message.list({ sessionID: coordinator.id, limit: { order: "asc", limit: 80 } }, { signal: AbortSignal.timeout(10000) }), null, 2))
      result.lastMissionMap = await snapshot()
    } catch { result.captureUnavailable = true }
  }
  await writeFile(path.join(root, "events.json"), JSON.stringify(events, null, 2))
  await writeFile(path.join(root, "results.json"), JSON.stringify(result, null, 2))
  console.log(`${result.status.toUpperCase()} GPT Missions native-service trial: ${root}`)
  if (result.failure) console.error({ stage, message: result.failure.message })
}
