// Explicit opt-in integration test. Never uses service discovery or a user DB.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"

const cli = process.argv[2]
if (!cli || !path.isAbsolute(cli)) throw new Error("Pass an absolute path to the CLI executable to test in isolation")
const runtimeVersion = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim().replace(/^opencode2? v/, "")
const ui = process.argv.includes("--ui")
const legacyPruning = process.argv.includes("--legacy-pruning")
const pluginArgument = process.argv[3]?.startsWith("--") ? undefined : process.argv[3]
const pluginDirectory = pluginArgument ?? fileURLToPath(new URL("../packages/server/src/opencode/session-pruning/", import.meta.url))
if (!path.isAbsolute(pluginDirectory)) throw new Error("Plugin directory must be absolute")
const temporaryRoot = path.join(os.tmpdir(), "opencode")
await mkdir(temporaryRoot, { recursive: true })
// macOS FSEvents reports physical paths (/private/var, not /var). OpenCode's
// plugin-source filter compares those to its configured roots lexically.
// Give the isolated daemon one canonical namespace before it starts watching.
const root = await realpath(await mkdtemp(path.join(temporaryRoot, "codenomad-pruning-native-")))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE_") && !key.startsWith("XDG_")))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
Object.assign(env, {
  USERPROFILE: root, HOME: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "test.db"),
  OPENCODE_SERVER_PASSWORD: "isolated-pruning-fixture", OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
})
await mkdir(env.OPENCODE_CONFIG_DIR)
const bundled = !pluginArgument
let closePresence
let openPresence
if (bundled) {
  const { installPruningPresence } = await tsImport("../packages/server/src/opencode/pruning-installation.ts", import.meta.url)
  const { readFile } = await import("node:fs/promises")
  const bundle = await readFile(new URL("../packages/server/dist/plugins/session-pruning/plugin.mjs", import.meta.url))
  openPresence = () => installPruningPresence(bundle, { config: env.OPENCODE_CONFIG_DIR, data: path.join(root, "codenomad") })
} else {
  await mkdir(path.join(env.OPENCODE_CONFIG_DIR, "plugins"))
  await writeFile(path.join(env.OPENCODE_CONFIG_DIR, "plugins", "codenomad-session-pruning.ts"),
    `export { default } from ${JSON.stringify(pathToFileURL(path.join(pluginDirectory, "index.ts")).href)}\n`)
}
await mkdir(path.join(root, "plugin"))
await writeFile(path.join(root, "permission-fixture.txt"), "Permission contract fixture")
const requests = []
let primaryCount = 0
let toolSteps = 1
let probeName = "prune_probe"
let held
let releaseProvider
let providerError
const provider = createServer(async (request, response) => {
  try {
  let raw = ""
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw)
  const kind = request.headers["x-pruning-test-kind"]
  const text = kind === "compaction"
    ? ["## Objective", "## Requirements", "## Decisions", "## Work State", "### Completed", "### Active", "### Blocked", "## Next Move", "## Relevant Files", "## Important Context"].map(heading => `${heading}\n- Fixture`).join("\n\n")
    : "Retain this conclusion"
  requests.push({ kind, body })
  if (kind === "primary" && held) await held
  if (!body.stream) {
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify({ id: "aux", choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  const tool = kind === "primary" && primaryCount++ < toolSteps
  response.setHeader("Content-Type", "text/event-stream")
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", model: "fixture",
    choices: [{ index: 0, delta, finish_reason }],
    ...(finish_reason ? { usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } } : {}),
  })}\n\n`)
  chunk({ role: "assistant" })
  if (tool) {
    chunk({ reasoning_content: "REASONING_PRUNING_CANARY" })
    let name = probeName, args = {}
    if (probeName === "permission_probe") {
      const read = body.tools.find(tool => tool.function?.name === "read")?.function
      assert(read, "Native read tool must be available for permission integration")
      name = read.name
      const keys = Object.keys(read.parameters.properties)
      const pathKey = keys.find(key => /^(path|file_?path)$/i.test(key))
      assert(pathKey, `Unknown native read input: ${JSON.stringify(read.parameters)}`)
      args = { [pathKey]: path.join(root, "permission-fixture.txt") }
    }
    chunk({ tool_calls: Array.from({ length: probeName === "bash" ? 2 : 1 }, (_, index) => ({ index, id: `fixture-call-${primaryCount}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) })
  } else chunk({ content: text })
  chunk({}, tool ? "tool_calls" : "stop")
  response.end("data: [DONE]\n\n")
  } catch (error) { providerError = error; response.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
await writeFile(path.join(root, "plugin", "index.ts"), `
export default { id:'pruning-test-fixture', async setup(ctx) {
  await ctx.session.hook('http.request', event => event.request.headers.set('x-pruning-test-kind', event.kind))
  await ctx.tool.transform(editor => editor.add({ name:'prune_probe', description:'Fixture', input:{type:'object',properties:{}}, options:{codemode:false}, execute:async()=>({content:'TOOL_PRUNING_CANARY'}) }))
  await ctx.permission.hook('evaluate', event => { if(event.action === 'read') event.effect = 'ask' })
  ${ui ? "await ctx.tool.transform(editor => editor.add({ name:'bash', description:'Isolated inert fixture', input:{type:'object',properties:{}}, options:{codemode:false}, execute:async()=>({content:'TOOL_PRUNING_CANARY'}) }))" : ""}
} }
`)
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
  model: "fixture/fixture",
  permissions: [{ action: "read", resource: "*", effect: "ask" }],
  commands: { fixture: { description: "Isolated contract fixture", template: "Conclude briefly." } },
  providers: { fixture: { package: `${runtimeVersion === "0.0.0-beta-19271" ? "@opencode-ai" : "@opencode"}/ai/providers/openai-compatible`, settings: {
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only",
  }, models: { fixture: {} } } },
  plugins: [path.join(root, "plugin")],
})
let output = ""
function start() {
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "debug", "--print-logs"], { cwd: root, env, windowsHide: true })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  return { child, stopped }
}
let { child, stopped } = start()
let db
let observerError
const streams = new AbortController()
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value
const revision = content => createHash("sha256").update(JSON.stringify(canonical(content))).digest("hex")
async function until(predicate) {
  for (let attempt = 0; attempt < 3000; attempt++) {
    if (providerError) throw providerError
    if (observerError) throw observerError
    if (await predicate()) return
    if (child.exitCode !== null) throw new Error("Isolated server exited early")
    await delay(20)
  }
  throw new Error("Isolated test condition timed out")
}
try {
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const { OpenCodeCliService } = await tsImport("../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
  const { OpenCodeSharedService } = await tsImport("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
  const lifecycle = new OpenCodeCliService({ label: "Isolated native", timeoutMs: 5000,
    command: args => ({ command: cli, args, options: {} }),
  }, { execFile: async (_file, args) => ({ stdout: args.join(" ") === "service get password" ? "isolated-pruning-fixture" : baseUrl, stderr: "" }) })
  const sharedService = new OpenCodeSharedService()
  const client = await sharedService.client({ kind: "lifecycle", identity: "isolated-native", lifecycle })
  const connection = await sharedService.acquire()
  const runtimeFetch = connection.fetch
  // Recognition follows the actual authenticated schema, not an exact version
  // allowlist. Exercise this route against every real runtime in the matrix.
  const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  const { createRuntimeFetch } = await tsImport("../packages/server/src/opencode/compatibility/transport.ts", import.meta.url)
  const futureEndpoint = { ...connection.endpoint }
  rememberRuntime(futureEndpoint, { version: "contract-probe", pid: 1, discovery: "status" })
  const negotiatedClient = OpenCode.make({ baseUrl, fetch: createRuntimeFetch(futureEndpoint) })
  assert.equal((await negotiatedClient.location.get({ location: { directory: root } })).directory, (await client.location.get({ location: { directory: root } })).directory)
  const makeClient = () => OpenCode.make({ baseUrl, headers: {
    Authorization: `Basic ${Buffer.from("opencode:isolated-pruning-fixture").toString("base64")}`,
  }, fetch: runtimeFetch })
  assert.equal((await client.server.info()).version, runtimeVersion)
  console.log(`Testing official runtime ${runtimeVersion}`)
  const { testNativeLocationIdentity } = await import("./test-opencode-location-native.mjs")
  await testNativeLocationIdentity({ client, connection, root })
  const { testNativeProxy } = await import("./test-opencode-proxy-native.mjs")
  await testNativeProxy({ client, baseUrl, root, runtimeFetch, connection, authorization: `Basic ${Buffer.from("opencode:isolated-pruning-fixture").toString("base64")}`,
    exercise: async (proxy, sessionID) => {
      const wait = () => proxy.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })
      // Real UI pre-send sequence, both voice-off removal and voice-on put.
      await proxy.session.instructions.entry.remove({ sessionID, key: "voice-mode" })
      await proxy.session.prompt({ sessionID, text: "Conclude briefly." })
      await wait()
      await proxy.session.instructions.entry.put({ sessionID, key: "voice-mode", value: "Be brief." })
      await proxy.session.command({ sessionID, name: "fixture", text: "" })
      await wait()
      await proxy.session.shell({ sessionID, command: "echo contract-fixture" })
      await wait()
      held = new Promise(resolve => { releaseProvider = resolve })
      try {
        const before = requests.length
        await proxy.session.prompt({ sessionID, text: "Hold for inbox checks." })
        await until(() => requests.slice(before).some(item => item.kind === "primary"))
        const pending = await proxy.session.prompt({ sessionID, text: "Queued fixture", delivery: "queue" })
        assert.equal(typeof pending.time.created, "number")
        assert((await proxy.session.inbox.list({ sessionID })).some(item => item.id === pending.id && item.time.created === pending.time.created))
        await proxy.session.inbox.update({ sessionID, inboxID: pending.id, delivery: "steer" })
        await proxy.session.inbox.update({ sessionID, inboxID: pending.id, delivery: "queue" })
        await proxy.session.inbox.cancel({ sessionID, inboxID: pending.id })
        await proxy.session.interrupt({ sessionID, resume: false })
      } finally { releaseProvider?.(); held = undefined }
      await wait()
      const messages = (await proxy.message.list({ sessionID, limit: 100 })).data
      assert(messages.some(message => message.type === "assistant"))
      await proxy.session.revert.stage({ sessionID, messageID: messages.find(message => message.type === "user").id, files: false })
      await proxy.session.revert.clear({ sessionID })
      const shell = await proxy.shell.create({ location: { directory: root }, cwd: root, command: "echo background-contract-fixture", timeout: 10_000 })
      try {
        await until(async () => (await proxy.shell.get({ id: shell.data.id, location: { directory: root } })).data.status !== "running")
        const output = await proxy.shell.output({ id: shell.data.id, location: { directory: root }, limit: 8 })
        const next = await proxy.shell.output({ id: shell.data.id, location: { directory: root }, cursor: output.data.cursor })
        assert((output.data.output + next.data.output).includes("background-contract-fixture"))
      } finally { await proxy.shell.remove({ id: shell.data.id, location: { directory: root } }) }
      const { createOpencodePermissionReplier } = await tsImport("../packages/server/src/permissions/opencode-replier.ts", import.meta.url)
      const yolo = createOpencodePermissionReplier({ workspaceManager: {
        get: () => ({ path: root }), getSharedServiceClient: async () => client,
        ownsLocation: async (_id, location) => path.resolve(location.directory) === path.resolve(root) && location.workspaceID === undefined,
      } })
      for (const mode of ["ui", "yolo", "reject"]) {
        primaryCount = 0
        probeName = "permission_probe"
        try {
          await proxy.session.prompt({ sessionID, text: "Use permission_probe." })
          let pending
          try {
            await until(async () => {
              pending = (await proxy.permission.request.list({ location: { directory: root } })).data.find(item => item.sessionID === sessionID)
              return Boolean(pending)
            })
          } catch (error) {
            console.error("Permission fixture", mode, primaryCount, JSON.stringify((await proxy.message.list({ sessionID, limit: 8 })).data))
            throw error
          }
          if (mode === "yolo") await yolo({ instanceId: "native", sessionId: sessionID, permissionId: pending.id })
          else await proxy.permission.reply({ sessionID, requestID: pending.id, decision: mode === "reject" ? "reject" : "once" })
          await wait()
          assert(!(await proxy.permission.request.list({ location: { directory: root } })).data.some(item => item.id === pending.id))
        } finally { probeName = "prune_probe" }
      }
      console.log("PASS: real proxy voice-off/on prompt, command, session Shell, pending inbox delivery/cancel, interrupt/wait")
      console.log("PASS: real native permissions through UI and server Yolo, including rejection")
    },
  })
  primaryCount = 0
  const location = { directory: root, ...(legacyPruning ? { workspaceID: "wrk_pruning_fixture" } : {}) }
  const { locationRequestOptions } = await tsImport("../packages/server/src/opencode/compatibility/location.ts", import.meta.url)
  const locationOptions = locationRequestOptions(location)
  const session = await client.session.create({ location }, locationOptions)
  assert.equal(session.location.workspaceID, location.workspaceID)
  // Install after the daemon and location exist: desktop startup must not need a restart.
  if (bundled) {
    const beforeInstallation = (await client.plugin.list({ location }, locationOptions)).data
    assert(!beforeInstallation.some(item => item.id === "codenomad-session-pruning"), "Bundled plugin must be absent before late installation")
    closePresence = await openPresence()
  }
  let plugins
  try {
    await until(async () => {
      plugins = (await client.plugin.list({ location }, locationOptions)).data
      const failed = plugins.filter(item => item.source.type !== "builtin" && item.state.status === "failed")
      if (failed.length) throw new Error(JSON.stringify(failed))
      return plugins.some(item => item.id === "codenomad-session-pruning" && item.state.status === "active")
    })
  } catch (error) {
    const snapshot = { runtimeVersion, bundled, location, config: env.OPENCODE_CONFIG_DIR, plugins }
    await writeFile(path.join(root, "discovery.json"), JSON.stringify(snapshot, null, 2))
    throw new Error(`Native pruning discovery failed: ${JSON.stringify(snapshot)}`, { cause: error })
  }
  const first = [], second = []
  const observe = (subscriber, events) => (async () => {
    for await (const event of subscriber.event.subscribe({ signal: streams.signal })) events.push(event)
  })().catch(error => { if (!streams.signal.aborted) observerError = error })
  const normalizedStream = await sharedService.subscribe({ signal: streams.signal })
  const observers = [observe({ event: { subscribe: () => normalizedStream } }, first), observe(makeClient(), second)]
  await until(() => first.length && second.length)
  const wait = () => client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) })
  await client.session.prompt({ sessionID: session.id, text: "Use prune_probe, then conclude" })
  await wait()
  const messages = (await client.message.list({ sessionID: session.id, limit: 100, order: "asc" })).data
  const target = messages.find(message => message.type === "assistant" && message.content.some(part => part.type === "tool"))
  assert(target)
  const { testSessionHistoryNative } = await import("./test-session-history-native.mjs")
  await testSessionHistoryNative({ client, location, locationOptions, template: target })
  const { testSessionNavigationNative } = await import("./test-session-navigation-native.mjs")
  await testSessionNavigationNative({ client, location, locationOptions, template: target })
  if (ui) {
    const { testPruningUI } = await import("./test-session-pruning-ui.mjs")
    await testPruningUI({ client, connection, baseUrl, root, location, busy: async (sessionID) => {
      held = new Promise(resolve => { releaseProvider = resolve })
      const before = requests.length
      await client.session.prompt({ sessionID, text: "Keep this request in flight" })
      await until(() => requests.slice(before).some(item => item.kind === "primary"))
      return async () => {
        releaseProvider(); held = undefined
        await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })
      }
    }, generate: async (sessionID) => {
      primaryCount = 0
      toolSteps = 2
      probeName = "bash"
      try {
        await client.session.prompt({ sessionID, text: "Use the inert fixture tools, then conclude" })
        await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(20_000) })
      } finally { toolSteps = 1; probeName = "prune_probe" }
    } })
  }
  const fork = await client.session.fork({ sessionID: session.id, before: messages.at(-1).id })
  const forkTarget = (await client.message.list({ sessionID: fork.id, limit: 100, order: "asc" })).data.find(message => message.type === "assistant")
  assert.deepEqual(forkTarget.content, target.content)
  const preview = (await client.rpc.call({ rpcID: "codenomad.session-pruning", method: "preview", location, input: { sessionID: session.id, messageID: target.id } }, locationOptions)).output
  assert.equal(preview.status, "preview")
  assert.equal(preview.liveMutation, true)
  assert.equal(preview.revision, revision(target.content))
  assert.deepEqual(preview.parts.map(part => part.type), ["reasoning", "tool"])
  const input = { sessionID: session.id, messageID: target.id, revision: preview.revision, indexes: [0] }
  const prune = () => client.rpc.call({ rpcID: "codenomad.session-pruning", method: "prune", location, input }, locationOptions)
  db = new DatabaseSync(env.OPENCODE_DB)
  const claim = () => db.prepare("SELECT time_suspended FROM session_v2 WHERE id=?").get(session.id).time_suspended
  held = new Promise(resolve => { releaseProvider = resolve })
  const beforeBusy = requests.length
  await client.session.prompt({ sessionID: session.id, text: "In-flight proof" })
  await until(() => requests.slice(beforeBusy).some(item => item.kind === "primary"))
  assert.notEqual(claim(), null)
  assert.deepEqual((await prune()).output, { status: "blocked", reason: "maintenance_required" })
  const busyBatch = (await client.rpc.call({ rpcID: "codenomad.session-pruning", method: "pruneBatch", location,
    input: { sessionID: session.id, candidates: [{ messageID: target.id, revision: preview.revision, toolCount: 1, reasoningCount: 1 }] } }, locationOptions)).output
  assert.deepEqual(busyBatch.results[0].result, { status: "blocked", reason: "maintenance_required" })
  releaseProvider(); held = undefined
  await wait()
  assert.equal(claim(), null)
  const result = (await prune()).output
  assert.equal(result.status, "pruned")
  assert.deepEqual((await prune()).output, result)
  await until(() => [first, second].every(events => events.some(event => event.type === "rpc.codenomad.session-pruning.pruned" && event.data.messageID === target.id)))
  assert.deepEqual((await client.session.message.get({ sessionID: session.id, messageID: target.id })).content, target.content.slice(1))
  // The second ordering: native admission begins while our write lock is held.
  db.exec("BEGIN IMMEDIATE")
  assert.equal(claim(), null)
  const before = requests.length
  const competing = client.session.prompt({ sessionID: session.id, text: "Reply after cleanup" })
  await delay(150)
  assert.equal(requests.length, before)
  db.prepare("UPDATE session_message SET data=json_set(data,'$.content',json('[]')) WHERE session_id=? AND id=?").run(session.id, target.id)
  db.exec("COMMIT")
  await competing; await wait()
  const next = requests.slice(before).filter(item => item.kind === "primary")
  assert(next.length > 0)
  assert(!JSON.stringify(next).includes("TOOL_PRUNING_CANARY"))
  assert(!JSON.stringify(next).includes("REASONING_PRUNING_CANARY"))
  assert(JSON.stringify(next).includes("Retain this conclusion"))
  assert.deepEqual((await client.session.message.get({ sessionID: session.id, messageID: target.id })).content, [])
  assert.deepEqual((await client.session.message.get({ sessionID: fork.id, messageID: forkTarget.id })).content, target.content, "parent cleanup does not alter a fork's independent copy")
  assert.equal(typeof (await client.session.compact({ sessionID: fork.id })).time.created, "number")
  await client.session.wait({ sessionID: fork.id }, { signal: AbortSignal.timeout(20_000) })
  const contextBefore = await client.session.context({ sessionID: fork.id })
  assert(contextBefore.some(message => message.type === "compaction" && message.status === "completed"))
  assert(!contextBefore.some(message => message.id === forkTarget.id))
  const historicalPage = (await client.rpc.call({ rpcID: "codenomad.session-pruning", method: "history", location,
    input: { sessionID: fork.id, purpose: "prune", query: "", includeTechnical: true } }, locationOptions)).output
  assert(historicalPage.candidates.some(candidate => candidate.messageID === forkTarget.id), "whole-session plan includes pre-compaction content")
  const historical = { sessionID: fork.id, messageID: forkTarget.id, revision: revision(forkTarget.content), indexes: [0, 1] }
  assert.equal((await client.rpc.call({ rpcID: "codenomad.session-pruning", method: "prune", location, input: historical }, locationOptions)).output.status, "pruned")
  assert.deepEqual((await client.session.message.get({ sessionID: fork.id, messageID: forkTarget.id })).content, [])
  assert.deepEqual(await client.session.context({ sessionID: fork.id }), contextBefore, "deleting pre-compaction content does not rewrite or re-expand a summary")
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok")
  const enqueued = first.filter(event => event.type === "session.inbox.enqueued")
  assert(enqueued.length > 0)
  for (const event of enqueued) assert.equal(typeof event.created, "number", "SSE timestamps are event metadata, not HTTP inbox fields")
  streams.abort(); await Promise.all(observers)
  db.close(); db = undefined
  child.kill(); await stopped
  await writeFile(path.join(root, "before-restart.log"), output)
  output = ""
  ;({ child, stopped } = start())
  await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const restartedEndpoint = { ...connection.endpoint, url: output.match(/http:\/\/127\.0\.0\.1:\d+/)[0] }
  rememberRuntime(restartedEndpoint, { version: runtimeVersion, pid: child.pid, discovery: "status" })
  const restarted = OpenCode.make({ baseUrl: restartedEndpoint.url, fetch: createRuntimeFetch(restartedEndpoint) })
  assert.deepEqual((await restarted.session.message.get({ sessionID: session.id, messageID: target.id })).content, [])
  assert.deepEqual((await restarted.session.message.get({ sessionID: fork.id, messageID: forkTarget.id })).content, [])
  assert.deepEqual(await restarted.session.context({ sessionID: fork.id }), contextBefore)
  if (bundled) {
    const preview = () => restarted.rpc.call({ rpcID: "codenomad.session-pruning", method: "preview", location, input: { sessionID: session.id, messageID: target.id } }, locationOptions)
    await preview()
    const closeSecond = await openPresence()
    await closePresence()
    await delay(2_200)
    await preview() // Another CodeNomad backend keeps RPC registered.
    await closeSecond()
    await until(async () => {
      try { await preview(); return false } catch (error) {
        assert.match(JSON.stringify(error), /rpc|not.found/i)
        return true
      }
    })
    closePresence = await openPresence()
    await until(async () => { try { await preview(); return true } catch { return false } })
    await closePresence()
    const { writeFile, rm } = await import("node:fs/promises")
    const crashLease = path.join(root, "codenomad", "session-pruning", "presence", "dead.lease")
    await writeFile(crashLease, "") // A crashed backend leaves a lease with no heartbeat.
    await preview()
    await until(async () => { try { await preview(); return false } catch { return true } })
    await rm(crashLease)
    assert.deepEqual((await restarted.session.message.get({ sessionID: session.id, messageID: target.id })).content, [])
    console.log("PASS: shipped bundle, automatic discovery, multiple backends, final close disposes RPC, reopening restores RPC")
    console.log("PASS: installation on an already-running daemon and crash expiry without stopping OpenCode")
  }
  console.log("PASS: native plugin preview/prune RPC, active-claim refusal, idempotent retry, two subscribers, competing prompt, next model payload, fork isolation, pre-compaction history and restart")
  if (legacyPruning) console.log("PASS: complete native pruning suite with non-null legacy workspace identity")
} finally {
  await closePresence?.()
  streams.abort(); releaseProvider?.()
  if (db?.isTransaction) db.exec("ROLLBACK")
  db?.close()
  child.kill(); await stopped
  provider.closeAllConnections(); provider.close()
  await writeFile(path.join(root, "server.log"), output)
  console.log(`Isolated fixture retained at ${root}`)
}
