import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { chromium } from "playwright"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"

const root = "C:/Users/Admin/AppData/Local/Temp/opencode/missions-desktop-trial-20261003"
const project = `${root}/product-project`
const deadline = Date.now() + 180000
const { OpenCodeCliService } = await tsImport("../../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
const { createRuntimeFetch } = await tsImport("../../packages/server/src/opencode/compatibility/transport.ts", import.meta.url)
const { CODENOMAD_MISSIONS_RPC } = await tsImport("../../packages/server/src/missions/rpc.ts", import.meta.url)
const service = new OpenCodeCliService({ label: "Read-only desktop trial observation", timeoutMs: 20000,
  command: (args, start) => {
    assert(!start && !args.includes("stop"))
    return { command: "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe", args, options: {} }
  } })
const endpoint = await service.discover()
assert(endpoint)
const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint) })
const options = () => ({ signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))) })
const snapshot = () => client.rpc(CODENOMAD_MISSIONS_RPC).snapshot({}, { location: { directory: project }, ...options() })
const state = JSON.parse(await readFile(`${root}/cdp.json`, "utf8"))
const result = { root, project, transport: "compiled-tauri-ui-start-and-native-close", allDesktopPresenceGone: false,
  limitation: "Original user desktop windows remain open; this proves the trial backend/window closure, not absence of every global CodeNomad lease." }
let browser, mission, stage = "prepared Mission from actual UI"
try {
  result.serverBefore = await client.server.info(options())
  const before = await snapshot()
  mission = before.missions.find(item => item.objective === "Validate recursive native Missions through the compiled desktop")
  assert(mission && mission.runState === "prepared")
  result.before = mission
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`)
  const page = browser.contexts().flatMap(context => context.pages()).find(item => item.url() === state.url)
  assert(page, "Exact owned empirical window")
  stage = "real UI Play"
  await page.getByRole("button", { name: "Démarrer la mission", exact: true }).click()
  stage = "wait for actual recursive native child before close"
  let children
  while (Date.now() < deadline) {
    children = (await client.session.list({ parentID: mission.coordinatorSessionId, limit: { limit: 12 } }, options())).data
    if (children.length) break
    const transcript = (await client.message.list({ sessionID: mission.coordinatorSessionId, limit: { order: "desc", limit: 12 } }, options())).data
    const error = transcript.flatMap(message => message.content ?? []).find(part => part.type === "tool" && part.state?.status === "error")
    if (error) { result.nativeToolFailure = error; throw new Error(`Native tool failed: ${error.name}`) }
    await delay(300)
  }
  assert(children?.length, "An actual child was admitted before close")
  result.childrenAtClose = children
  result.missionAtClose = (await snapshot()).missions.find(item => item.id === mission.id)
  assert.equal(result.missionAtClose.status, "active", "Close occurs before Mission business finish")
  await page.screenshot({ path: `${root}/busy-before-close.png` })
  stage = "native title-bar close while Mission active"
  await page.getByRole("button", { name: "Fermer la fenêtre", exact: true }).click()
  await browser.close().catch(() => {})
  browser = undefined
  result.closedAt = new Date().toISOString()
  stage = "native completion after actual desktop close"
  let completed
  while (Date.now() < deadline) {
    completed = (await snapshot()).missions.find(item => item.id === mission.id && item.status === "completed")
    if (completed) break
    await delay(300)
  }
  assert(completed, "Mission finishes after owned Tauri window/backend closes")
  result.completed = completed
  assert.equal(completed.tasks.length, 1)
  assert.equal(completed.tasks[0].report?.delivery, "coordinator-readout")
  assert.equal(completed.tasks[0].report?.notificationStatus, undefined)
  const grandchildren = (await Promise.all(children.map(child => client.session.list({ parentID: child.id, limit: { limit: 12 } }, options())))).flatMap(page => page.data)
  assert(grandchildren.length, "Actual native grandchild")
  const ids = [mission.coordinatorSessionId, ...children.map(item => item.id), ...grandchildren.map(item => item.id)]
  result.sessions = await Promise.all(ids.map(sessionID => client.session.get({ sessionID }, options())))
  for (const session of result.sessions) {
    assert.equal(session.model.providerID, "openai")
    assert.equal(session.model.id, "gpt-6.1-sol")
  }
  const transcripts = Object.fromEntries(await Promise.all(ids.map(async sessionID => [sessionID, (await client.message.list({ sessionID, limit: { order: "asc", limit: 80 } }, options())).data])))
  for (const id of ids.slice(1)) assert(!transcripts[id].some(message => message.content?.some(part => part.type === "tool" && part.name === "mission_report")))
  assert(JSON.stringify(transcripts).includes("484"), "Concrete verified arithmetic result retained")
  await writeFile(`${root}/product-transcripts.json`, JSON.stringify(transcripts, null, 2))
  result.serverAfter = await client.server.info(options())
  assert.equal(result.serverAfter.pid, result.serverBefore.pid, "Shared daemon never restarted")
  result.status = "passed"
} catch (error) {
  result.status = "failed"
  result.failure = { stage, message: error.message ?? String(error) }
  if (browser) {
    const page = browser.contexts().flatMap(context => context.pages()).find(item => item.url() === state.url)
    await page?.screenshot({ path: `${root}/product-failure.png` }).catch(() => {})
    result.uiText = await page?.locator("body").innerText().catch(() => "")
  }
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  await writeFile(`${root}/product-result.json`, JSON.stringify(result, null, 2))
  console.log(`${result.status.toUpperCase()} compiled desktop recursive Mission: ${root}`)
  if (result.failure) console.error(result.failure)
}
