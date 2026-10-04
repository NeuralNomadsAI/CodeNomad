import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { build } from "esbuild"
import { ASSIGNED_CLI, privateRoot, launch } from "./runtime.mjs"
import { providerServer } from "./provider.mjs"
import { RPC } from "./schema.mjs"
const experiment = "D:/CodeNomad/.codenomad/worktrees/missions-native-subsessions-20261003"
const primary = "D:/CodeNomad/.codenomad/worktrees/tauri-integrated-20261002-1841-b62f"
export const call = (tool, input, id) => ({ tool, input, id })
export const childCall = (id, extra = {}) => call("subagent", { agent: "recursive", description: id, prompt: "Private native qualification", ...extra }, id)
export async function hashes() {
  const manifest = JSON.parse(await readFile("C:/Users/Admin/AppData/Local/Temp/opencode/missions-native-rollback-V0FPSs/source-before.json", "utf8"))
  const result = {}
  for (const [label, base] of [["primary", primary], ["experimentCommon", experiment]]) {
    const digest = createHash("sha256"), differences = []
    for (const record of manifest) {
      const hash = createHash("sha256").update(await readFile(`${base}/${record.path}`)).digest("hex")
      digest.update(record.path + "\0" + hash + "\n")
      if (hash !== record.sha256) differences.push(record.path)
    }
    result[label] = { files: manifest.length, digest: digest.digest("hex"), baselineDifferences: differences }
  }
  result.primaryIndexSHA256 = createHash("sha256").update(await readFile("D:/CodeNomad/.git/worktrees/tauri-integrated-20261002-1841-b62f/index")).digest("hex")
  return result
}
export async function run(phase, scenario) {
  assert.equal(process.cwd().replaceAll("\\", "/").toLowerCase(), experiment.toLowerCase(), "Explicit experimental working directory only")
  const saved = { ...process.env }, token = randomUUID(), deadline = Date.now() + 230_000
  const h = { cli: ASSIGNED_CLI, token, deadline, events: [], roots: [], matrix: [], result: { phase, started: new Date().toISOString(), status: "running" } }
  let subscription
  const options = () => ({ signal: AbortSignal.timeout(20_000) }); h.options = options
  h.until = async (predicate, label, ms = 20_000) => {
    const end = Math.min(deadline, Date.now() + ms)
    while (Date.now() < end) { if (h.provider?.failure) throw h.provider.failure; if (await predicate()) return; await delay(40) }
    throw new Error("Bounded timeout: " + label)
  }
  h.rpc = (method, input = {}) => h.running.client.rpc(RPC)[method]({ token, ...input }, { location: { directory: h.project }, ...options() })
  h.control = (rootID, state = "running", extra = {}) => h.rpc("control", { rootID, state, ...extra })
  h.wait = sessionID => h.running.client.session.wait({ sessionID }, options())
  h.messages = async sessionID => (await h.running.client.message.list({ sessionID, limit: { order: "asc", limit: 100 } }, options())).data
  h.tools = records => records.flatMap(record => record.content ?? []).filter(part => part.type === "tool")
  h.requests = sessionID => h.provider.requests.filter(record => record.kind === "primary" && (!sessionID || record.sessionID === sessionID))
  h.family = async sessionID => {
    const result = [], seen = new Set()
    while (sessionID) {
      assert(!seen.has(sessionID) && result.length <= 8); seen.add(sessionID)
      const session = await h.running.client.session.get({ sessionID }, options()); result.push(session); sessionID = session.parentID
    }
    assert(result.every(session => session.projectID === result[0].projectID && JSON.stringify(session.location) === JSON.stringify(result[0].location)))
    return result
  }
  h.parent = async (title, permissions) => {
    const session = await h.running.client.session.create({ location: { directory: h.project }, title, agent: "recursive", ...(permissions ? { permissions } : {}) }, options())
    assert(!session.parentID); h.roots.push(session.id); await h.control(session.id); return session.id
  }
  h.submit = async (sessionID, answers, text = "Private native qualification") => {
    h.provider.plans.set(sessionID, answers)
    return h.running.client.session.prompt({ sessionID, text }, options())
  }
  h.binding = async callID => {
    let binding
    await h.until(async () => { binding = (await h.rpc("inspect")).bindings.find(record => record.value.callID === callID)?.value; return binding }, "binding " + callID)
    return binding
  }
  h.observe = (test, status, data) => { h.matrix.push({ test, status, ...data }); console.log(`${status} ${test}`) }
  h.subscribe = () => {
    subscription = new AbortController()
    void (async () => { try { for await (const event of h.running.client.event.subscribe({ signal: subscription.signal })) { h.events.push(event); assert(h.events.length < 8000) } } catch (error) { if (!subscription.signal.aborted) h.result.subscriptionError = String(error) } })()
  }
  h.restart = async graceful => {
    subscription?.abort()
    if (graceful) {
      // Quiesce the owned Location before replacement; Windows TerminateProcess
      // is NOT a graceful daemon signal, and the matrix labels that separately.
      await h.running.client.location.reload({ headers: { "x-opencode-directory": h.project }, ...options() }); await h.running.stop()
    } else await h.running.stop()
    h.logs.push(h.running.logs)
    h.running = await launch(h.cli, h.root, process.env, deadline); h.subscribe()
  }
  try {
    h.result.before = await hashes()
    // Drop credential-bearing variable names without inspecting their values.
    for (const key of Object.keys(process.env)) if (/api[_-]?key|token|secret|password|credential|authorization/i.test(key)) delete process.env[key]
    Object.assign(h, await privateRoot(h.cli)); h.result.artifacts = h.root
    process.env.TSX_DISABLE_CACHE = "1"; process.env.TEMP = h.root; process.env.TMP = h.root
    console.log(`PRIVATE ${phase} ${h.root}`)
    h.provider = await providerServer(); h.logs = []
    const pluginDir = `${h.root}/plugin`; await mkdir(pluginDir)
    const pluginPath = new URL("./plugin.mjs", import.meta.url).href
    const entry = `${h.root}/entry.mjs`
    await writeFile(entry, `import {qualificationPlugin} from ${JSON.stringify(new URL(pluginPath).pathname.replace(/^\/(\w:)/, "$1"))};export default qualificationPlugin(${JSON.stringify(token)},${JSON.stringify(h.root.replaceAll("\\", "/"))});`)
    await build({ entryPoints: [entry], outfile: `${pluginDir}/index.mjs`, bundle: true, platform: "node", format: "esm", target: "node22" })
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: "fixture/fixture", default_agent: "recursive", update: "disable", snapshots: false, experimental: { subagent_depth: 3 },
      permissions: [...(phase === "builtin-general-uncontaminated-policy" ? [] : [{ action: "*", resource: "*", effect: "allow" }]), { action: "execute", resource: "*", effect: "deny" }],
      agents: { recursive: { mode: "all", description: "Legal recursive private probe", system: "Bounded private probe", model: "fixture/fixture", permissions: [{ action: "subagent", resource: "*", effect: "allow" }] }, primary_only: { mode: "primary", description: "Negative control" } },
      providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: h.provider.url, apiKey: "private-synthetic" }, models: { fixture: {} } } }, plugins: [pluginDir] })
    h.running = await launch(h.cli, h.root, process.env, deadline); h.result.version = h.running.info.version
    const openapi = await (await fetch(`${h.running.url}/openapi.json`, { headers: h.running.headers, signal: AbortSignal.timeout(10_000) })).json()
    await writeFile(`${h.root}/openapi.json`, JSON.stringify(openapi, null, 2)); h.openapi = openapi
    h.result.sessionCreateProperties = Object.keys(openapi.paths["/api/session"].post.requestBody.content["application/json"].schema.properties)
    h.result.parentIDCreationAdvertised = h.result.sessionCreateProperties.includes("parentID")
    h.subscribe(); await scenario(h)
    h.result.status = "completed-experiments"
  } catch (error) { h.result.status = "failed-fixture"; h.result.error = String(error); h.result.stack = error.stack; process.exitCode = 1; console.error(error) }
  finally {
    subscription?.abort()
    try {
      if (h.running?.child.exitCode === null) {
        h.result.storage = await h.rpc("inspect")
        const ids = new Set([...h.roots, ...h.events.filter(event => event.type === "session.created").map(event => event.data.sessionID), ...(h.result.storage?.bindings ?? []).map(record => record.value.childID)])
        h.result.counts = { providerRequests: h.provider.requests.length, primaryRequests: h.requests().length, sessions: ids.size, events: h.events.length }
        const transcripts = {}, sessions = {}, inboxes = {}
        for (const id of ids) { transcripts[id] = await h.messages(id); sessions[id] = await h.running.client.session.get({ sessionID: id }); inboxes[id] = await h.running.client.session.inbox.list({ sessionID: id }) }
        await writeFile(`${h.root}/transcripts.json`, JSON.stringify(transcripts, null, 2)); await writeFile(`${h.root}/sessions.json`, JSON.stringify(sessions, null, 2)); await writeFile(`${h.root}/inboxes.json`, JSON.stringify(inboxes, null, 2))
      }
    } catch (error) { h.result.captureFailure = String(error) }
    await h.backend?.close(); await h.running?.stop(); await h.provider?.close()
    h.result.after = await hashes(); h.result.hashesUnchanged = JSON.stringify(h.result.before) === JSON.stringify(h.result.after)
    if (h.root) {
      h.result.matrix = h.matrix
      await writeFile(`${h.root}/results.json`, JSON.stringify(h.result, null, 2)); await writeFile(`${h.root}/requests.json`, JSON.stringify(h.provider?.requests ?? [], null, 2)); await writeFile(`${h.root}/events.json`, JSON.stringify(h.events, null, 2)); await writeFile(`${h.root}/serve.log`, [...(h.logs ?? []), h.running?.logs ?? ""].join("\n")); await writeFile(`${h.root}/backend-trace.json`, JSON.stringify(h.backend?.trace ?? [], null, 2))
    }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
    console.log(JSON.stringify({ status: h.result.status, artifacts: h.root, counts: h.result.counts, hashesUnchanged: h.result.hashesUnchanged }))
  }
}
