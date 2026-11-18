// Design agent activation against an explicit isolated CLI: private home, config,
// database and ProgramData, loopback fake chat and image models (no paid call),
// and only processes this script starts. Usage:
//   node scripts/test-design-activation-native.mjs <absolute opencode executable>
// Requires the session-pruning bundle (npm run build:pruning --workspace @neuralnomads/codenomad).
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import readline from "node:readline"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { tsImport } from "tsx/esm/api"
import { OpenCode } from "@opencode/client"
import { stopFixtureChild } from "./native-fixture-guards.mjs"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"

const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "server", "src", "opencode")
const load = file => tsImport(`../packages/server/src/opencode/${file}`, import.meta.url)
const { DesktopPluginLifecycle, prepareDesktopPluginPresence } = await load("desktop-plugin-lifecycle.ts")
const { resolveDesktopPluginPaths } = await load("desktop-plugin-paths.ts")
const { designLeaseContent } = await load("design/activation.ts")
const { designAgentStatus } = await load("design/status.ts")
const { DESIGN_CONTENT_MARK, DESIGN_SKILL_IDS, DESIGN_SOURCE_FILES, parseDesignContent } = await load("design/content.ts")
const { PRESENCE_EXPIRY_MS, PRESENCE_INTERVAL_MS } = await load("desktop-plugin-presence.ts")

const connect = (url, password) => OpenCode.make({ baseUrl: url,
  headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } })
async function provision(client, lifecycle) {
  const paths = await resolveDesktopPluginPaths({ client, assertCurrent() {} }, { kind: "host", platform: process.platform, binary: "fixture" })
  await prepareDesktopPluginPresence(paths, () => {}, { pruning: lifecycle })
  return paths
}

// Child backend: a separate process whose crash leaves its lease to expire.
if (process.argv[2] === "--backend") {
  const lifecycle = new DesktopPluginLifecycle("session-pruning")
  await lifecycle.setLeaseContent(designLeaseContent(process.argv[5] === "design"))
  await provision(connect(process.argv[3], process.argv[4]), lifecycle)
  process.stdout.write("ready\n")
  for await (const line of readline.createInterface({ input: process.stdin })) {
    await lifecycle.setLeaseContent(designLeaseContent(JSON.parse(line).design))
    process.stdout.write("ok\n")
  }
  await lifecycle.stop()
  process.exit(0)
}

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
// The checkout's native files, as the bundle embeds them (tsx cannot import `.md`).
const checkout = path.resolve(server, "..", "..", "..", "..")
const readSource = file => readFile(path.join(server, "design", file), "utf8")
const sources = {
  agent: await readSource(DESIGN_SOURCE_FILES.agent),
  skills: Object.fromEntries(await Promise.all(DESIGN_SKILL_IDS.map(async id => [id, await readSource(DESIGN_SOURCE_FILES.skill(id))]))),
  notice: await readSource(DESIGN_SOURCE_FILES.notice),
  apacheLicense: await readSource(DESIGN_SOURCE_FILES.apacheLicense),
}
const content = parseDesignContent(sources)
// Project discovery walks every ancestor directory: outside CI the fixture must live
// outside the user's home, or it would read the user's own agents and skills.
const root = await mkdtemp(path.join(await fixtureParent({ projectConfig: true }), "design-activation-"))
const configDirectory = path.join(root, "config")
const project = name => path.join(root, name)
// Children (Git, the CLI, the daemon, the backends) get only allowlisted variables and a private profile.
const childEnv = await fixtureEnvironment(root)
const version = spawnSync(cli, ["--version"], { env: childEnv, encoding: "utf8" }).stdout.trim()
const USER_AGENT = "USER-DESIGN-AGENT"
const USER_SKILL = "USER-DESIGN-CORE"
const files = {
  [path.join(configDirectory, "opencode.json")]: "{}\n",
  [path.join(configDirectory, "skills", "fixture-visible", "SKILL.md")]: "---\nname: fixture-visible\ndescription: Announced fixture skill\n---\nFixture.\n",
  [path.join(project("p2-ask"), "opencode.json")]: JSON.stringify({ permissions: [{ action: "experimental_image_generate", resource: "*", effect: "ask" }] }),
  [path.join(project("p3-user"), ".opencode", "agents", "design.md")]: `---\ndescription: The user's design agent\nmode: primary\n---\n${USER_AGENT}\n`,
  [path.join(project("p3-user"), ".opencode", "skills", "design-core", "SKILL.md")]: `---\nname: design-core\ndescription: The user's skill\n---\n${USER_SKILL}\n`,
}
for (const name of ["p1", "p2-ask", "p3-user", "p4-late"]) {
  await mkdir(project(name), { recursive: true })
  // A Git root stops OpenCode's upward project-configuration search.
  assert.equal(spawnSync("git", ["init", "-q", project(name)], { env: childEnv }).status, 0)
}
for (const [file, content] of Object.entries(files)) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

// Scripted chat model ("RUN <json>" emits those tool calls) and a fake image model.
const requests = []
let imageCalls = 0, providerError
const sse = (res, delta, finish) => {
  res.setHeader("content-type", "text/event-stream")
  for (const [d, f] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", model: "fixture",
    choices: [{ index: 0, delta: d, finish_reason: f }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
  res.end("data: [DONE]\n\n")
}
const text = content => typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.text ?? "").join("\n") : ""
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    if (req.url.startsWith("/v1/images/")) {
      imageCalls++
      res.setHeader("content-type", "application/json")
      return res.end(JSON.stringify({ created: 1, data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" }] }))
    }
    const body = JSON.parse(raw)
    const messages = body.messages ?? []
    requests.push({ session: req.headers["x-opencode-session"], all: messages.map(message => text(message.content)).join("\n"), tools: (body.tools ?? []).map(tool => tool.function?.name) })
    if (!body.tools?.length) return sse(res, { role: "assistant", content: "Images" }, "stop")
    const last = messages.findLastIndex(message => message.role === "assistant" || message.role === "tool")
    if (messages[last]?.role === "tool") return sse(res, { role: "assistant", content: "FIXTURE_AFTER_TOOL" }, "stop")
    const run = messages.slice(last + 1).map(message => /RUN (\[.*\])/s.exec(text(message.content))).findLast(Boolean)
    if (!run) return sse(res, { role: "assistant", content: "FIXTURE_OK" }, "stop")
    sse(res, { role: "assistant", tool_calls: JSON.parse(run[1]).map((call, index) => ({ index, id: `call_${randomUUID()}`, type: "function",
      function: { name: call.tool, arguments: JSON.stringify(call.args) } })) }, "tool_calls")
  } catch (error) { providerError = error; res.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
const settings = { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }

const password = randomUUID()
// Only the fixture providers load, so the image tool, on by default without `experimental.image_generate`,
// can only select the fake image model.
const env = await fixtureEnvironment(root, {
  OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "fixture/vision", small_model: "fixture/vision", enabled_providers: ["fixture", "fiximg"], providers: {
    fixture: { package: "@opencode/ai/providers/openai-compatible", settings, models: { vision: { name: "Fixture", capabilities: { tools: true, input: ["text", "image/png"], output: ["text"] } } } },
    fiximg: { package: "@opencode/ai/providers/openai-compatible/images", settings, models: { image: { name: "Fixture image", type: "image", capabilities: { tools: false, input: ["text"], output: ["image"] } } } },
  } }),
})

let output = ""
const daemon = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const daemonStopped = new Promise(resolve => daemon.once("close", resolve))
daemon.stdout.on("data", data => { output += data })
daemon.stderr.on("data", data => { output += data })
const backends = new Set(), lifecycles = []
const results = {}

async function until(label, predicate, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) {
    if (providerError) throw providerError
    const value = await predicate()
    if (value) return value
    if (daemon.exitCode !== null) throw new Error(`Isolated CLI exited: ${output.slice(-3000)}`)
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await delay(100)
  }
}

try {
  await until("daemon URL", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const client = connect(url, password)
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const api = async (method, route, body) => {
    const response = await fetch(url + route, { method, signal: AbortSignal.timeout(30_000),
      headers: { authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    const raw = await response.text()
    let json; try { json = JSON.parse(raw) } catch { json = raw }
    return { status: response.status, json }
  }
  const located = route => async directory => (await api("GET", `${route}?location[directory]=${encodeURIComponent(directory)}`)).json?.data ?? []
  const agents = located("/api/agent"), skills = located("/api/skill"), plugins = located("/api/plugin")
  // Discovery sees only the fixture's loopback providers, whatever the caller's environment holds.
  results.models = (await located("/api/model")(project("p1"))).map(model => `${model.providerID}/${model.id}`)
  assert(results.models.every(ref => /^(fixture|fiximg)\//.test(ref)), `only fixture models are discovered: ${results.models}`)
  const designSkills = async directory => (await skills(directory)).filter(skill => skill.id.startsWith("design-"))
  const hasDesign = async directory => (await agents(directory)).some(agent => agent.id === "design")
  const allHave = async (names, wanted) => (await Promise.all(names.map(name => hasDesign(project(name))))).every(value => value === wanted)
  const loaded = ["p1", "p2-ask", "p3-user"]

  async function startBackend(design) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--backend", url, password, design ? "design" : "none"], { env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    backends.add(child)
    const closed = new Promise(resolve => child.once("close", resolve))
    const lines = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    let errors = ""
    child.stderr.on("data", data => { errors += data })
    const next = async () => {
      // Unreferenced: a losing timeout never keeps the fixture process alive.
      const line = await Promise.race([lines.next(), delay(60_000, undefined, { ref: false }).then(() => ({ done: true }))])
      if (line.done) throw new Error(`Backend child failed: ${errors}`)
      return line.value
    }
    assert.equal(await next(), "ready")
    return {
      async design(value) { child.stdin.write(`${JSON.stringify({ design: value })}\n`); assert.equal(await next(), "ok") },
      // A crash: its lease is left behind and expires.
      async crash() { child.kill("SIGKILL"); await closed; backends.delete(child) },
      async stop() { child.stdin.end(); await closed; backends.delete(child) },
    }
  }
  async function snapshot() {
    const entries = []
    const walk = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) { if (entry.name !== ".git") await walk(file) }
        else entries.push(`${path.relative(root, file)} ${createHash("sha256").update(await readFile(file)).digest("hex")}`)
      }
    }
    for (const directory of [configDirectory, ...["p1", "p2-ask", "p3-user", "p4-late"].map(project)]) await walk(directory)
    return entries.sort()
  }
  const markers = async (sessionID, marker) => (JSON.stringify((await api("GET", `/api/session/${sessionID}/message`)).json).match(new RegExp(marker, "g")) ?? []).length
  async function turn(sessionID, prompt, marker, during = async () => {}) {
    const before = await markers(sessionID, marker)
    assert((await api("POST", `/api/session/${sessionID}/prompt`, { text: prompt })).status < 300)
    await until(`turn ${marker}`, async () => { await during(); return await markers(sessionID, marker) > before }).catch(async error => {
      const messages = JSON.stringify((await api("GET", `/api/session/${sessionID}/message`)).json).slice(-3000)
      const sent = requests.filter(entry => entry.session === sessionID).map(entry => ({ tools: entry.tools, tail: entry.all.slice(-300) }))
      throw new Error(`${error.message}\nmessages: ${messages}\nrequests: ${JSON.stringify(sent).slice(-3000)}`)
    })
  }
  const session = async (directory, body = {}) => {
    const response = await api("POST", "/api/session", { location: { directory }, ...body })
    assert(response.status < 300, JSON.stringify(response.json))
    return response.json?.data?.id ?? response.json?.id
  }
  const imagesSession = directory => session(directory, { agent: "design", title: "Images", metadata: { "codenomad.companion": "images" } })
  // Rejects every permission request of one generation turn and counts them.
  async function permissionRequests(sessionID, prompt) {
    const asked = []
    const reject = async () => {
      for (const request of (await api("GET", `/api/session/${sessionID}/permission`)).json?.data ?? []) {
        if (asked.includes(request.id)) continue
        asked.push(request.id)
        await api("POST", `/api/session/${sessionID}/permission/${request.id}/reply`, { decision: "reject" })
      }
    }
    // A rejected call ends the turn with the native declined error.
    await turn(sessionID, prompt, "declined this tool call", reject)
    await delay(2_000)
    await reject()
    return asked.length
  }

  // Locations load before any request, so registration happens before activation (V1 "early").
  for (const name of ["p1", "p2-ask"]) assert.equal(await hasDesign(project(name)), false)
  await until("the user's project agent", async () => designAgentStatus(await agents(project("p3-user"))).designAgent === "user")
  const backendA = await startBackend(false)
  for (const name of loaded) await until(`pruning plugin active in ${name}`, async () => (await plugins(project(name))).some(plugin => plugin.id === "codenomad-session-pruning" && plugin.state?.status === "active"))
  assert.equal(await readFile(path.join(configDirectory, "opencode.json"), "utf8"), "{}\n")
  const pristine = await snapshot()

  // AC-1: requested by a live backend, listed in every Location within 5 s, nothing written.
  let started = Date.now()
  await backendA.design(true)
  await until("Design listed everywhere", () => allHave(loaded, true), 10_000)
  results.activationMs = Date.now() - started
  assert(results.activationMs < 5_000, `Design took ${results.activationMs} ms`)
  for (const name of ["p1", "p2-ask"]) {
    const agent = (await agents(project(name))).find(entry => entry.id === "design")
    assert.equal(agent.mode, "primary")
    assert.deepEqual(designAgentStatus(await agents(project(name))), { designAgent: "present", contentVersion: 1 })
    const listed = await designSkills(project(name))
    assert.deepEqual(listed.map(skill => skill.id).sort(), [...DESIGN_SKILL_IDS].sort())
    assert(listed.every(skill => skill.autoinvoke === false), "Design skills are never auto-invoked")
    // AC-49: the installed bundle provides the checkout's content.
    assert.equal(agent.system, content.agent.system)
    assert.equal(agent.description, content.agent.description)
    for (const expected of content.skills) {
      const skill = listed.find(entry => entry.id === expected.id)
      assert.deepEqual([skill.name, skill.description, skill.content.trim()], [expected.name, expected.description, expected.content], expected.id)
    }
  }
  // AC-49: the skills point at the installed content-addressed bundle, outside the checkout, whose
  // bytes carry every file's notice, NOTICE.md and the Apache licence. ASCII lines without quotes or
  // backslashes appear verbatim in esbuild's string literals.
  const installed = (await designSkills(project("p1")))[0].path
  const fromCheckout = path.relative(checkout, installed)
  assert(/[\\/]session-pruning[\\/][a-f\d]{64}\.mjs$/.test(installed) && (fromCheckout.startsWith("..") || path.isAbsolute(fromCheckout)), installed)
  const bundleText = await readFile(installed, "utf8")
  assert(!bundleText.includes(checkout) && !bundleText.includes(checkout.replaceAll("\\", "/")), "The bundle never names the checkout")
  for (const source of [sources.agent, ...Object.values(sources.skills), sources.notice, sources.apacheLicense]) {
    for (const line of source.split(/\r?\n/).map(entry => entry.replace(/^#\s*/, "").trim()).filter(entry => /^[\x20-\x7e]{12,}$/.test(entry) && !/["'\\`$]/.test(entry))) {
      assert(bundleText.includes(line), `Installed bundle lacks: ${line}`)
    }
  }
  assert.deepEqual(await snapshot(), pristine, "Activation writes nothing in configuration roots or projects")

  // AC-3: no design-* skill announced to Design or Build; loadable by identifier.
  const images = await imagesSession(project("p1"))
  await turn(images, `RUN ${JSON.stringify([{ tool: "skill", args: { id: "design-core" } }])}`, "FIXTURE_AFTER_TOOL")
  const build = await session(project("p1"))
  await turn(build, "hello", "FIXTURE_OK")
  const designRequests = requests.filter(entry => entry.session === images && entry.tools.length)
  const buildRequests = requests.filter(entry => entry.session === build && entry.tools.length)
  assert(designRequests.length && buildRequests.length, "Both conversations reached the model")
  assert(designRequests.every(entry => entry.all.includes(DESIGN_CONTENT_MARK)), "The Design system prompt applies")
  assert(buildRequests.every(entry => !entry.all.includes(DESIGN_CONTENT_MARK)))
  for (const entry of [...designRequests, ...buildRequests]) {
    assert(entry.all.includes("<id>fixture-visible</id>"), "Ordinary skills are announced")
    assert(!/<id>design-/.test(entry.all), "No design-* skill is announced")
  }
  const core = (await skills(project("p1"))).find(skill => skill.id === "design-core")
  assert(JSON.stringify((await api("GET", `/api/session/${images}/message`)).json).includes(JSON.stringify(core.content.trim()).slice(1, -1)),
    "design-core loads by identifier")

  // AC-4: the user's ask rule on the image tool applies to Design exactly as to Build.
  for (const entry of [...designRequests, ...buildRequests])
    assert(entry.tools.includes("experimental_image_generate"), `The image tool is offered by default: ${entry.tools}`)
  const generate = JSON.stringify([{ tool: "experimental_image_generate",
    args: { prompt: "Flat blue app icon", path: ".codenomad/design/icon/app-icon-minimal-a.png" } }])
  const askedFor = async () => ({
    design: await permissionRequests(await imagesSession(project("p2-ask")), `RUN ${generate}`),
    build: await permissionRequests(await session(project("p2-ask")), `RUN ${generate}`),
  })
  results.ask = await askedFor()
  assert.deepEqual(results.ask, { design: 1, build: 1 })

  // AC-5: the user's own design agent and design-core win.
  const userWins = async () => {
    const directory = project("p3-user")
    assert.deepEqual(designAgentStatus(await agents(directory)), { designAgent: "user", contentVersion: null })
    const core = (await skills(directory)).find(skill => skill.id === "design-core")
    assert(core.content.includes(USER_SKILL))
    const id = await imagesSession(directory)
    await turn(id, "hello", "FIXTURE_OK")
    const sent = requests.filter(entry => entry.session === id && entry.tools.length)
    assert(sent.length && sent.every(entry => entry.all.includes(USER_AGENT) && !entry.all.includes(DESIGN_CONTENT_MARK)))
  }
  await userWins()

  // AC-7: A requests, B does not; a later Location starts from the current union.
  const backendB = await startBackend(false)
  const all = [...loaded, "p4-late"]
  // A Location loaded later starts from the current union once its plugins load.
  started = Date.now()
  await until("Design in a later Location", () => hasDesign(project("p4-late")), 5_000)
  results.lateLocationMs = Date.now() - started
  started = Date.now()
  await backendA.crash()
  await until("Design gone when only A expires", () => allHave(["p1", "p2-ask", "p4-late"], false), PRESENCE_EXPIRY_MS + 10_000)
  results.expiryMs = Date.now() - started
  assert(results.expiryMs <= PRESENCE_EXPIRY_MS + 2 * PRESENCE_INTERVAL_MS + 2_000, `Expiry took ${results.expiryMs} ms`)
  assert((await plugins(project("p1"))).some(plugin => plugin.id === "codenomad-session-pruning" && plugin.state?.status === "active"), "B keeps the plugin present")
  const backendA2 = await startBackend(true)
  await until("Design back with A", () => allHave(all.filter(name => name !== "p3-user"), true), 10_000)

  // AC-2: disabling the only request removes the agent and skills within the expiry plus one interval.
  started = Date.now()
  await backendA2.design(false)
  await until("Design gone after disabling", async () => await allHave(all.filter(name => name !== "p3-user"), false)
    && (await designSkills(project("p1"))).length === 0, PRESENCE_EXPIRY_MS + PRESENCE_INTERVAL_MS)
  results.disableMs = Date.now() - started

  // AC-57: one backend with two live installations rewrites both leases; a later installation gets the current state.
  const presenceOf = data => path.join(data, "session-pruning", "presence")
  const leaseNames = async data => (await readdir(presenceOf(data))).filter(name => name.endsWith(".lease"))
  const leases = async (data, names) => Promise.all((names ?? await leaseNames(data)).map(name => readFile(path.join(presenceOf(data), name), "utf8")))
  const daemonPaths = await resolveDesktopPluginPaths({ client, assertCurrent() {} }, { kind: "host", platform: process.platform, binary: "fixture" })
  const others = new Set(await leaseNames(daemonPaths.data))
  const backendC = new DesktopPluginLifecycle("session-pruning")
  lifecycles.push(backendC)
  await provision(client, backendC)
  const own = (await leaseNames(daemonPaths.data)).filter(name => !others.has(name))
  assert.equal(own.length, 1)
  const other = { config: path.join(root, "other-config"), data: path.join(root, "other-config-data") }
  await backendC.start(other)
  await backendC.setLeaseContent(designLeaseContent(true))
  assert.deepEqual(await leases(daemonPaths.data, own), [designLeaseContent(true)], "The older retained lease is rewritten")
  assert.deepEqual(await leases(other.data), [designLeaseContent(true)])
  await until("Design with C", () => hasDesign(project("p1")), 10_000)
  await backendC.setLeaseContent("")
  assert.deepEqual(await leases(daemonPaths.data, own), [""])
  assert.deepEqual(await leases(other.data), [""])
  await until("Design gone with C disabled", async () => !await hasDesign(project("p1")), 10_000)
  await backendC.setLeaseContent(designLeaseContent(true))
  await until("Design back with C", () => hasDesign(project("p1")), 10_000)
  const third = { config: path.join(root, "third-config"), data: path.join(root, "third-config-data") }
  await backendC.start(third)
  assert.deepEqual(await leases(third.data), [designLeaseContent(true)])
  await backendC.stop()
  await until("Design gone with C stopped", async () => !await hasDesign(project("p1")), 10_000)

  // AC-1 (replacement): another shim and bundle version keeps AC-4 and AC-5 true.
  const bundleFile = path.join(server, "..", "..", "dist", "plugins", "session-pruning", "plugin.mjs")
  const variant = Buffer.concat([await readFile(bundleFile), Buffer.from("\n// Isolated fixture variant\n")])
  const variantHash = createHash("sha256").update(variant).digest("hex")
  const backendD = new DesktopPluginLifecycle("session-pruning", async () => variant)
  lifecycles.push(backendD)
  await backendD.setLeaseContent(designLeaseContent(true))
  await provision(client, backendD)
  assert((await readFile(path.join(configDirectory, "plugins", "codenomad-session-pruning.ts"), "utf8")).includes(variantHash), "The shim names the replacement bundle")
  await until("replacement bundle loaded", async () => (await designSkills(project("p1"))).some(skill => skill.path.includes(variantHash)), 30_000)
  results.replacedAsk = await askedFor()
  assert.deepEqual(results.replacedAsk, { design: 1, build: 1 })
  await userWins()
  await backendD.stop()
  await backendA2.stop()
  await backendB.stop()
  assert.equal(imageCalls, 0, "Rejected requests never reach the image model")
  console.log(`PASS ${version}: ${JSON.stringify(results)}`)
} finally {
  for (const child of backends) child.kill("SIGKILL")
  await Promise.all(lifecycles.map(lifecycle => lifecycle.stop()))
  try { await stopFixtureChild(daemon, daemonStopped) } finally {
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    await writeFile(path.join(root, "daemon.log"), output).catch(() => {})
    console.log(`Isolated fixture: ${root}`)
  }
}
