// Private daemon and deterministic loopback provider: parent entry inheritance and
// awaited native prompt-hook writes before a native child's very first model call.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { OpenCode } from "@opencode/client"
import { nativePluginBuild } from "../packages/server/scripts/native-plugin-build.mjs"
import { readMemoryInstructionsCapability } from "../packages/server/src/memory/instructions-capability.ts"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const root = await mkdtemp(path.join(await fixtureParent(), "memory-instructions-"))
const config = path.join(root, "config"), state = path.join(root, "state.json"), plugin = path.join(root, "memory-proof")
await mkdir(config)
await mkdir(plugin)
await writeFile(path.join(plugin, "package.json"), JSON.stringify({ name: "codenomad-memory-proof", type: "module", exports: "./index.mjs" }))
await writeFile(state, JSON.stringify({ enabled: false, revision: 0 }))
await build({ ...nativePluginBuild, entryPoints: [fileURLToPath(new URL("./fixtures/memory-instructions/plugin.mjs", import.meta.url))], outfile: path.join(plugin, "index.mjs") })

const requests = []
let providerError
const provider = createServer(async (request, response) => {
  try {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    assert(requests.length < 60, "Provider request budget")
    requests.push(body)
    const tools = (body.tools ?? []).map(tool => tool.function?.name)
    const last = JSON.stringify(body.messages.at(-1))
    const launch = body.stream && /PARENT_(BASELINE|HOOK)/.test(last) && tools.includes("subagent")
    if (!body.stream) {
      response.setHeader("content-type", "application/json")
      return response.end(JSON.stringify({ id: "fixture", choices: [{ message: { role: "assistant", content: "Memory proof" }, finish_reason: "stop" }] }))
    }
    const delta = launch ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: {
      name: "subagent", arguments: JSON.stringify({ agent: "general", description: "Memory proof", prompt: last.includes("PARENT_BASELINE") ? "CHILD_BASELINE" : "CHILD_HOOK" }),
    } }] } : { role: "assistant", content: "DONE" }
    response.setHeader("content-type", "text/event-stream")
    for (const [value, finish_reason] of [[delta, null], [{}, launch ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`)
    }
    response.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; response.destroy() }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
const password = randomUUID()
const env = await fixtureEnvironment(root, {
  OPENCODE_CONFIG_DIR: config, OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ update: "disable", snapshots: false, model: "fixture/fixture",
    plugins: [{ package: plugin, options: { state } }], providers: { fixture: {
      package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }, models: { fixture: {} },
    } } }),
})
let output = "", spawnError
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.on("error", error => { spawnError = error })
child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
async function until(predicate, label) {
  const deadline = Date.now() + 45_000
  while (!await predicate()) {
    if (spawnError) throw spawnError
    if (providerError) throw providerError
    assert(child.exitCode === null && Date.now() < deadline, `${label}: ${output.slice(-3000)}`)
    await delay(50)
  }
}
try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output), "private serve")
  const endpoint = { url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0], auth: { type: "basic", username: "opencode", password } }
  const fetcher = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: fetcher, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
  const capability = await readMemoryInstructionsCapability({ endpoint, fetch: fetcher, assertCurrent() {} })
  assert.equal(capability, "supported")
  const info = await client.server.info()
  console.log(`Runtime: ${info.version}`)
  const location = { directory: root }
  const entries = sessionID => client.session.instructions.entry.list({ sessionID })
  const ownEntry = async sessionID => (await entries(sessionID)).find(entry => entry.key === "codenomad.memory")
  async function run(label) {
    const session = await client.session.create({ location })
    await client.session.instructions.entry.put({ sessionID: session.id, key: "codenomad.memory", value: "PARENT_MEMORY_CANARY" })
    const start = requests.length
    await client.session.prompt({ sessionID: session.id, text: `PARENT_${label}` })
    await until(async () => (await client.session.list({ location, parentID: session.id, limit: 20 })).data.length === 1, "native child creation")
    const descendant = (await client.session.list({ location, parentID: session.id, limit: 20 })).data[0]
    await until(() => requests.slice(start).some(body => body.stream && JSON.stringify(body.messages.at(-1)).includes(`CHILD_${label}`)), "native child model request")
    await client.session.wait({ sessionID: descendant.id }, { signal: AbortSignal.timeout(30_000) })
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) })
    const firstChildRequest = requests.slice(start).find(body => body.stream && JSON.stringify(body.messages.at(-1)).includes(`CHILD_${label}`))
    return { session, descendant, firstChildRequest }
  }
  const baseline = await run("BASELINE")
  const inherited = await ownEntry(baseline.descendant.id)
  console.log(`Baseline child instruction entry: ${inherited ? "inherited" : "absent"}`)
  assert.equal(inherited, undefined, "The qualified runtime gives native children their own instruction entries")
  assert.doesNotMatch(JSON.stringify(baseline.firstChildRequest.messages.filter(message => message.role === "system")), /PARENT_MEMORY_CANARY/)

  await writeFile(state, JSON.stringify({ enabled: true, revision: 1 }))
  const hooked = await run("HOOK")
  const written = await ownEntry(hooked.descendant.id)
  assert(written, "The admission hook wrote the child's own named entry")
  assert.match(JSON.stringify(written), new RegExp(hooked.descendant.id))
  const system = JSON.stringify(hooked.firstChildRequest.messages.filter(message => message.role === "system"))
  assert.match(system, /NATIVE_MEMORY_CANARY/)
  assert.match(system, new RegExp(hooked.descendant.id))
  assert.doesNotMatch(system, /PARENT_MEMORY_CANARY/)
  console.log("PASS parent entries are session-local; awaited native prompt hook installs the child's own entry before its first provider request, outside the proxy")

  await writeFile(state, JSON.stringify({ enabled: true, revision: 2 }))
  const start = requests.length
  await client.session.prompt({ sessionID: hooked.descendant.id, text: "CHILD_REFRESH" })
  await until(() => requests.length > start, "fresh native child admission")
  await client.session.wait({ sessionID: hooked.descendant.id }, { signal: AbortSignal.timeout(30_000) })
  assert.match(JSON.stringify(await ownEntry(hooked.descendant.id)), /"revision":2/)
  const refreshed = JSON.stringify(requests.slice(start).find(body => body.stream).messages)
  assert.ok(/revision[^\d]*2/.test(refreshed), "A resumed request receives the fresh entry through the native context-update notice")
  console.log("PASS resumed native child refreshes the entry at its next admission through the native context-update notice")

  await client.session.instructions.entry.put({ sessionID: hooked.descendant.id, key: "other-owner", value: "OTHER_OWNER_CANARY" })
  await client.session.instructions.entry.remove({ sessionID: hooked.descendant.id, key: "codenomad.memory" })
  assert.equal(await ownEntry(hooked.descendant.id), undefined)
  assert.ok((await entries(hooked.descendant.id)).some(entry => entry.key === "other-owner"))
  console.log("PASS removing the memory entry preserves other owners' instruction keys")

  await writeFile(state, JSON.stringify({ enabled: true, refuse: true }))
  const failed = await client.session.create({ location })
  const beforeFailure = requests.length
  await assert.rejects(client.session.prompt({ sessionID: failed.id, text: "FAILURE_PROOF" }))
  assert.equal(requests.length, beforeFailure, "An independent mandatory prompt hook admits no provider request")
  assert.equal((await client.session.inbox.list({ sessionID: failed.id })).length, 0)
  console.log("PASS an independent mandatory native admission gate still rejects input before any provider call or inbox entry")
} finally {
  try { await stopFixtureChild(child, stopped) } finally {
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    await writeFile(path.join(root, "daemon.log"), output)
    console.log(`Isolated fixture: ${root}`)
  }
}
