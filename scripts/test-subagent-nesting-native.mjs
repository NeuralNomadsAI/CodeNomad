// Private runtime with project discovery: real nested General subagents under the depth editor's
// project writes. A deterministic provider makes every conversation launch one General subagent.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
import { parse } from "jsonc-parser"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"
import { PluginControls } from "../packages/server/src/opencode/plugin-controls.ts"
import { SubagentDepthSettings } from "../packages/server/src/opencode/subagent-depth-settings.ts"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const root = await mkdtemp(path.join(await fixtureParent({ projectConfig: true }), "subagent-nesting-"))
const project = path.join(root, "project"), config = path.join(root, "config"), globalFile = path.join(config, "opencode.jsonc")
await mkdir(project); await mkdir(config)
await writeFile(globalFile, '{"experimental":{"subagent_depth":3}}\n')
let calls = 0, providerError
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw), tools = (body.tools ?? []).map(tool => tool.function?.name)
    assert(++calls < 100, "Provider request budget")
    // Launch one General subagent when offered the tool; conclude once its result returns.
    const answer = !body.stream || body.messages?.at(-1)?.role === "tool" || !tools.includes("subagent") ? "DONE"
      : { name: "subagent", arguments: JSON.stringify({ agent: "general", description: "Nest", prompt: "Nest once more" }) }
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      return response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Title" }, finish_reason: "stop" }] }))
    }
    const delta = typeof answer === "string" ? { role: "assistant", content: answer }
      : { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: answer }] }
    response.setHeader("content-type", "text/event-stream")
    for (const [value, finish_reason] of [[delta, null], [{}, typeof answer === "string" ? "stop" : "tool_calls"]])
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`)
    response.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; response.destroy() }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
const password = randomUUID()
const env = await fixtureEnvironment(root, { OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "fixture/fixture", update: "disable", snapshots: false, providers: { fixture: {
    package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" },
    models: { fixture: {} } } } }) })
let output = ""
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: project, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
async function until(predicate, label) {
  const deadline = Date.now() + 30_000
  while (!await predicate()) {
    if (providerError) throw providerError
    assert(child.exitCode === null && Date.now() < deadline, `${label}: ${output.slice(-3000)}`)
    await delay(100)
  }
}
try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), "private serve")
  const endpoint = { url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], auth: { type: "basic", username: "opencode", password } }
  const boundedFetch = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: boundedFetch,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  const location = { directory: project }
  const connection = { endpoint, client, fetch: boundedFetch, assertCurrent() {} }
  const manager = {
    get: () => ({}), getSharedServiceConnection: async () => connection,
    getServiceDirectoryForPath: async (_id, directory) => directory === project ? project : undefined,
    ownsLocation: async (_id, value) => value.directory === project, getWorktreeIdentityForPath: async () => "private-fixture-project",
    getServicePathStyle: () => process.platform === "win32" ? "win32" : "posix",
    getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, value) => value,
  }
  const settings = new SubagentDepthSettings(new PluginControls({ workspaceManager: manager,
    worktreeDeletionFence: { enter: () => () => {} }, logger: {} }), manager)
  const save = async value => settings.update("fixture", location, value, (await settings.read("fixture", location)).project.expectation)
  const generalAllows = async () => (await client.agent.list({ location })).data.find(agent => agent.id === "general")
    ?.permissions.filter(rule => rule.action === "subagent").at(-1)?.effect === "allow"
  /** The deepest subagent level one prompt reaches when every conversation launches a General subagent. */
  async function nestedLevels() {
    const session = await client.session.create({ location })
    await client.session.prompt({ sessionID: session.id, text: "Start nesting" })
    await delay(300)
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) })
    let levels = 0
    for (let frontier = [session.id]; frontier.length; levels++) {
      const next = []
      for (const id of frontier) next.push(...(await client.session.list({ location, parentID: id, limit: 32 })).data.map(item => item.id))
      if (!next.length) return levels
      frontier = next
    }
    return levels
  }

  const initial = await settings.read("fixture", location)
  assert.equal(initial.effectiveDepth, 3)
  assert.deepEqual(initial.nesting, { effect: "deny", configured: false }, "General's built-in rule decides")
  assert.equal(await nestedLevels(), 1, "a Global depth of 3 alone never nests General subagents")

  await save(3)
  const file = initial.project.path
  assert.match(await readFile(file, "utf8"), /Added by CodeNomad with the subagent depth/)
  await until(generalAllows, "native reload of the project rule")
  assert.deepEqual((await settings.read("fixture", location)).nesting, { effect: "allow", configured: true, added: true })
  assert.equal(await nestedLevels(), 3, "the saved depth nests General subagents up to its limit")

  await save(null)
  assert.deepEqual(parse(await readFile(file, "utf8")) ?? {}, {}, "Inherit removes the depth and the rule")
  await until(async () => !await generalAllows(), "native reload of the restored project")
  const inherited = await settings.read("fixture", location)
  assert.deepEqual([inherited.effectiveDepth, inherited.nesting], [3, { effect: "deny", configured: false }])
  console.log("PASS built-in General denial blocks nesting; a project depth of 3 also lifts it and nests three levels; Inherit restores both")
} finally {
  await stopFixtureChild(child, stopped)
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  await writeFile(path.join(root, "daemon.log"), output)
  console.log(`Isolated fixture: ${root}`)
}
