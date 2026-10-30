// The Design companion end to end against an explicit isolated CLI: private home, config,
// database, ProgramData and temp, loopback scripted chat and fake image models (no paid
// call), the shipped session-pruning bundle requested by an in-process backend lease, and
// only processes this script starts. The scripted model applies the Design rules (files under
// `.codenomad/design/<subject>/`, one `read` per image, a refinement naming its parent); this
// validates the wiring, never a real model's behaviour.
//   AC-16: 3 files, one `read` part per image, `images` gives the read images in 2 series,
//          proven, with lineage and pixels.
//   AC-52: a completed generation without read-back, its reference, the request sent, a read
//          more than 32 messages later, shown with its pixels and an unverifiable origin.
// Usage: node scripts/test-design-companion-native.mjs <absolute opencode executable> [--ui <design ZIP>]
// `--ui` plays the AC-52 request through the real panel, composer and transcript (AC-54).
// Requires the session-pruning bundle (npm run build:pruning --workspace @neuralnomads/codenomad).
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { crc32, deflateSync } from "node:zlib"
import { tsImport } from "tsx/esm/api"
import { OpenCode } from "@opencode/client"
import { clearFixtureGitEnvironment, stopFixtureChild } from "./native-fixture-guards.mjs"
import { fixtureEnvironment, fixtureParent } from "./native-product-fixture.mjs"

const load = file => tsImport(`../packages/server/src/${file}`, import.meta.url)
const { DesktopPluginLifecycle, prepareDesktopPluginPresence } = await load("opencode/desktop-plugin-lifecycle.ts")
const { resolveDesktopPluginPaths } = await load("opencode/desktop-plugin-paths.ts")
const { designLeaseContent } = await load("opencode/design/activation.ts")
const { locationRequestOptions } = await load("opencode/compatibility/location.ts")
const { imagesResultSchema } = await load("opencode/session-pruning/assets-gallery-contract.ts")

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const uiIndex = process.argv.indexOf("--ui")
const designZip = uiIndex > 0 ? process.argv[uiIndex + 1] : undefined
assert(uiIndex < 0 || (designZip && path.isAbsolute(designZip)), "--ui takes the absolute path of the packaged Design ZIP")
// Browser dependencies load before the native preamble (see test-session-pruning-ui.mjs).
const companionUI = designZip ? await import("./test-design-companion-ui.mjs") : undefined
await companionUI?.loadDesignCompanionUIDependencies()
// Project discovery walks every ancestor directory: outside CI the fixture lives outside the home.
const root = await mkdtemp(path.join(await fixtureParent({ projectConfig: true }), "design-companion-"))
const configDirectory = path.join(root, "config")
const project = path.join(root, "project")
await mkdir(configDirectory, { recursive: true })
await mkdir(project, { recursive: true })
await writeFile(path.join(configDirectory, "opencode.json"), "{}\n")
await writeFile(path.join(project, "README.md"), "Design companion fixture\n")
// Children (Git, the CLI, the daemon) get only allowlisted variables and a private profile;
// the in-process host routes' Git also runs without inherited GIT_* (a GIT_DIR or
// GIT_WORK_TREE would send its writes outside the fixture).
const childEnv = await fixtureEnvironment(root)
clearFixtureGitEnvironment(process.env)
const version = spawnSync(cli, ["--version"], { env: childEnv, encoding: "utf8" }).stdout.trim()
const git = args => spawnSync("git", args, { cwd: project, env: childEnv, encoding: "utf8" })
assert.equal(git(["init", "-q", project]).status, 0)
const samePath = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
assert.equal(samePath(git(["rev-parse", "--absolute-git-dir"]).stdout.trim()), samePath(path.join(await realpath(project), ".git")),
  "Git writes only the fixture's own repository")

// Distinct, decodable 16 × 16 PNGs, so each file's pixels identify its generation.
function png() {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8)
    out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length)
    return out
  }
  const side = 16, header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((side * 3 + 1) * side)
  for (let y = 0; y < side; y++) for (let x = 0; x < side * 3; x++) rows[y * (side * 3 + 1) + 1 + x] = Math.floor(Math.random() * 256)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))])
}
const sha = bytes => createHash("sha256").update(bytes).digest("hex")

// Scripted chat model. "RUN <json>" emits those tool calls in one response. A finished image
// notice reads every saved, unread image in one response once all generations have their
// notice (or only says "Noted." while `readBack` is off). The AC-52 request ("Read the
// generated image `X`") takes PAD separate steps, then reads X, then answers with a relative
// Markdown image of it.
const PAD = 34
const state = { readBack: true, imageCalls: [], chat: 0, providerError: undefined }
const text = content => typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.text ?? "").join("\n") : ""
const carriesImage = message => message.role === "user" && Array.isArray(message.content) && message.content.some(part => part.type === "image_url")
const sse = (res, delta, finish) => {
  res.setHeader("content-type", "text/event-stream")
  for (const [d, f] of [[delta, null], [{}, finish]]) res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", model: "fixture",
    choices: [{ index: 0, delta: d, finish_reason: f }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
  res.end("data: [DONE]\n\n")
}
const say = (res, value) => sse(res, { role: "assistant", content: value }, "stop")
const call = (res, calls) => sse(res, { role: "assistant", tool_calls: calls.map((entry, index) => ({ index, id: `call_${randomUUID()}`, type: "function",
  function: { name: entry.tool, arguments: JSON.stringify(entry.args) } })) }, "tool_calls")
const relative = file => (path.isAbsolute(file) ? path.relative(project, file) : file).replaceAll("\\", "/")
function respond(res, body) {
  const messages = body.messages ?? []
  if (!body.tools?.length) return say(res, "Images")
  const pathKey = name => {
    const tool = body.tools.find(entry => entry.function?.name === name)?.function
    assert(tool, `the ${name} tool is available`)
    return Object.keys(tool.parameters.properties).find(key => /^(path|file_?path)$/i.test(key))
  }
  const trigger = messages.findLastIndex(message => message.role === "user" && !carriesImage(message))
  const steps = messages.slice(trigger + 1).filter(message => message.role === "assistant" && message.tool_calls?.length).length
  const instruction = text(messages[trigger]?.content)
  const calls = messages.flatMap(message => message.tool_calls ?? []).map(entry => ({ name: entry.function?.name, args: JSON.parse(entry.function?.arguments || "{}") }))
  const run = /RUN (\[.*\])/s.exec(instruction)
  if (run) return steps ? say(res, "Started.") : call(res, JSON.parse(run[1]))
  // Reads name the absolute file, as the notice does; answers cite it as relative Markdown.
  const markdown = file => `![${path.posix.basename(relative(file))}](${relative(file)})`
  const show = /Read the generated image `([^`]+)`/.exec(instruction)
  if (show) {
    if (steps < PAD) return call(res, [{ tool: "glob", args: { pattern: "*.md" } }])
    if (steps === PAD) return call(res, [{ tool: "read", args: { [pathKey("read")]: path.resolve(project, show[1]) } }])
    return say(res, `Here it is: ${markdown(show[1])}\n\nCritique: clean edges.`)
  }
  if (/Saved image: /.test(instruction)) {
    const answeredReads = messages.slice(trigger + 1).flatMap(message => message.tool_calls ?? []).filter(entry => entry.function?.name === "read")
    if (steps) return say(res, `Read back: ${answeredReads.map(entry => markdown(Object.values(JSON.parse(entry.function.arguments))[0])).join(" ")}`)
    const saved = [...messages.filter(message => message.role === "user").map(message => text(message.content)).join("\n").matchAll(/Saved image: (.+?) \(/g)].map(match => match[1])
    const read = new Set(calls.filter(entry => entry.name === "read").map(entry => path.resolve(project, Object.values(entry.args)[0] ?? "")))
    const unread = [...new Set(saved)].filter(file => !read.has(path.resolve(project, file)))
    const generations = calls.filter(entry => entry.name === "experimental_image_generate").length
    if (!state.readBack || saved.length < generations || !unread.length) return say(res, "Noted.")
    return call(res, unread.map(file => ({ tool: "read", args: { [pathKey("read")]: file } })))
  }
  return say(res, "FIXTURE_OK")
}
const provider = createServer(async (req, res) => {
  try {
    let raw = ""
    for await (const chunk of req) raw += chunk
    if (req.url.startsWith("/v1/images/")) {
      const bytes = png()
      state.imageCalls.push({ url: req.url, sha: sha(bytes), edit: req.url.includes("edits") })
      res.setHeader("content-type", "application/json")
      return res.end(JSON.stringify({ created: 1, data: [{ b64_json: bytes.toString("base64") }] }))
    }
    state.chat++
    respond(res, JSON.parse(raw))
  } catch (error) { state.providerError = error; res.destroy(error) }
})
await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))
const settings = { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "fixture-only" }

const password = randomUUID()
// Only the fixture providers load, and the fake image model is named, so automatic selection can never pick another provider.
const env = await fixtureEnvironment(root, {
  OPENCODE_CONFIG_DIR: configDirectory, OPENCODE_DB: path.join(root, "fixture.db"), OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "fixture/vision", small_model: "fixture/vision", enabled_providers: ["fixture", "fiximg"], experimental: { image_generate: { model: "fiximg/image" } }, providers: {
    fixture: { package: "@opencode/ai/providers/openai-compatible", settings, models: { vision: { name: "Fixture vision", capabilities: { tools: true, input: ["text", "image/png"], output: ["text"] } } } },
    fiximg: { package: "@opencode/ai/providers/openai-compatible/images", settings, models: { image: { name: "Fixture image", type: "image", capabilities: { tools: false, input: ["text", "image/png"], output: ["image"] } } } },
  } }),
})

let output = ""
const daemon = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const daemonStopped = new Promise(resolve => daemon.once("close", resolve))
daemon.stdout.on("data", data => { output += data })
daemon.stderr.on("data", data => { output += data })
const lifecycle = new DesktopPluginLifecycle("session-pruning")
const results = { version }
let passed = false

async function until(label, predicate, ms = 60_000) {
  const end = Date.now() + ms
  for (;;) {
    if (state.providerError) throw state.providerError
    const value = await predicate()
    if (value) return value
    if (daemon.exitCode !== null) throw new Error(`Isolated CLI exited: ${output.slice(-3000)}`)
    if (Date.now() > end) throw new Error(`Timed out: ${label}`)
    await delay(150)
  }
}

try {
  await until("daemon URL", () => /http:\/\/127\.0\.0\.1:\d+/.test(output))
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
  const client = OpenCode.make({ baseUrl: url, headers: { authorization } })
  const location = { directory: project }
  const locationOptions = locationRequestOptions(location)
  const rpc = async (method, input) => (await client.rpc.call({ rpcID: "codenomad.session-pruning", method, location, input }, locationOptions)).output
  await client.location.get({ location })
  // Discovery sees only the fixture's loopback providers, whatever the caller's environment holds.
  const models = async types => (await (await fetch(`${url}/api/model?${types ? `types=${types}&` : ""}location[directory]=${encodeURIComponent(project)}`,
    { headers: { authorization }, signal: AbortSignal.timeout(30_000) })).json()).data.map(model => `${model.providerID}/${model.id}`)
  results.models = await models()
  assert(results.models.every(ref => /^(fixture|fiximg)\//.test(ref)), `only fixture models are discovered: ${results.models}`)
  assert.deepEqual(await models("image"), ["fiximg/image"])
  await lifecycle.setLeaseContent(designLeaseContent(true))
  await prepareDesktopPluginPresence(await resolveDesktopPluginPaths({ client, assertCurrent() {} }, { kind: "host", platform: process.platform, binary: "fixture" }),
    () => {}, { pruning: lifecycle })
  await until("Design agent and gallery RPC", async () => (await client.agent.list({ location })).data.some(agent => agent.id === "design")
    && await rpc("imagesConversation", { mode: "lookup" }).then(answer => answer.status === "absent", () => false))

  const opened = await rpc("imagesConversation", { mode: "open", title: "Images", agent: "design", model: { providerID: "fixture", id: "vision" } })
  assert.equal(opened.created, true, JSON.stringify(opened))
  const sessionID = opened.sessionID
  const messages = async () => {
    const { data } = await client.message.list({ sessionID, limit: 200, order: "asc" })
    assert(data.length < 200, "the whole fixture conversation fits one native page")
    return data
  }
  const notices = list => list.filter(message => message.type === "synthetic" && message.metadata?.source === "experimental_image_generate")
  const readParts = list => list.flatMap(message => message.type === "assistant"
    ? message.content.filter(part => part.type === "tool" && part.name === "read" && part.state?.status === "completed").map(part => ({ message: message.id, part })) : [])
  const idle = async () => { await client.session.wait({ sessionID }, { signal: AbortSignal.timeout(60_000) }); await delay(300) }
  async function turn(prompt, settled, label) {
    await client.session.prompt({ sessionID, text: prompt })
    await until(label, async () => settled(await messages()))
    await idle()
  }
  // Every page, as the panel reads them; each answer is checked against the published contract.
  async function gallery() {
    const entries = []
    let cursor
    do {
      const page = await rpc("images", { sessionID, prompts: true, ...(cursor ? { cursor } : {}) })
      assert.equal(page.status, "page", JSON.stringify(page))
      imagesResultSchema.parse(page)
      entries.push(...page.entries)
      cursor = page.cursor
    } while (cursor)
    return entries
  }
  const pixels = async target => {
    const answer = await rpc("imageRead", { sessionID, target })
    assert.equal(answer.status, "asset", JSON.stringify(answer).slice(0, 300))
    return Buffer.from(answer.uri.slice(answer.uri.indexOf(",") + 1), "base64")
  }
  const design = path.join(project, ".codenomad", "design", "icon")
  const file = name => path.join(design, name)
  const gen = (prompt, name, extra = {}) => ({ tool: "experimental_image_generate", args: { prompt, path: `.codenomad/design/icon/${name}`, ...extra } })

  // AC-16, series 1: two generations, both read back in one answer once both are saved.
  await turn(`RUN ${JSON.stringify([gen("Flat blue app icon", "icon-minimal-a.png"), gen("Bold orange app icon", "icon-bold-a.png")])}`,
    list => notices(list).length >= 2 && readParts(list).length >= 2, "series 1 generated and read")
  // Series 2: a refinement of icon-minimal-a, which names it as its parent.
  await turn(`RUN ${JSON.stringify([gen("Same icon, warmer", "icon-minimal-a2.png", { images: [".codenomad/design/icon/icon-minimal-a.png"] })])}`,
    list => notices(list).length >= 3 && readParts(list).length >= 3, "refinement generated and read")

  const files = (await readdir(design)).sort()
  assert.deepEqual(files, ["icon-bold-a.png", "icon-minimal-a.png", "icon-minimal-a2.png"], "3 files under .codenomad/design/<subject>/")
  assert.equal(state.imageCalls.length, 3)
  assert.deepEqual(state.imageCalls.map(entry => entry.edit), [false, false, true], "the refinement sends its parent to the image model")
  const transcript = await messages()
  const reads = readParts(transcript)
  assert.equal(reads.length, 3, "one read part per image")
  for (const { part } of reads) assert.equal(part.state.content.filter(item => item.type === "file" && /^image\//.test(item.mime ?? "")).length, 1, JSON.stringify(part.state.content).slice(0, 300))
  assert.equal(new Set(reads.slice(0, 2).map(entry => entry.message)).size, 1, "the first two reads share one answer")
  let entries = await gallery()
  const images = entries.filter(entry => entry.kind === "image")
  const generations = entries.filter(entry => entry.kind === "generation")
  assert.equal(images.length, 3, JSON.stringify(entries))
  assert.equal(generations.length, 3)
  const byLabel = Object.fromEntries(images.map(entry => [entry.label, entry]))
  assert.deepEqual(Object.keys(byLabel).sort(), ["icon-bold-a", "icon-minimal-a", "icon-minimal-a2"])
  assert.equal(new Set(images.map(entry => entry.series)).size, 2, "two series")
  assert.equal(byLabel["icon-minimal-a"].series, byLabel["icon-bold-a"].series)
  assert.notEqual(byLabel["icon-minimal-a2"].series, byLabel["icon-minimal-a"].series)
  for (const entry of images) {
    assert.equal(entry.origin, "proven", JSON.stringify(entry))
    assert(generations.some(generation => generation.key === entry.generationKey && generation.tool === "completed" && generation.outcome === "completed"), JSON.stringify(entry))
    assert.equal(typeof entry.prompt, "string")
    assert.equal(entry.model, "fiximg/image", "the named fake image model generated it")
    const bytes = await pixels(entry.target)
    assert.deepEqual(bytes, await readFile(file(`${entry.label}.png`)), `${entry.label}: the gallery pixels are the file's`)
    assert(state.imageCalls.some(item => item.sha === sha(bytes)), `${entry.label}: the pixels come from the image model`)
  }
  assert.deepEqual([byLabel["icon-minimal-a"].prompt, byLabel["icon-bold-a"].prompt, byLabel["icon-minimal-a2"].prompt],
    ["Flat blue app icon", "Bold orange app icon", "Same icon, warmer"])
  assert.deepEqual(byLabel["icon-minimal-a2"].parentKeys, [byLabel["icon-minimal-a"].generationKey], "lineage: the refinement's parent")
  assert.equal(byLabel["icon-minimal-a2"].otherRefs ?? 0, 0)
  assert.equal(byLabel["icon-minimal-a"].parentKeys?.length ?? 0, 0)
  const raw = JSON.stringify(entries)
  for (const leak of [project, project.replaceAll("\\", "/"), "ses_", "call_", "Saved image"]) assert(!raw.includes(leak), `the gallery never carries ${leak}`)
  results.ac16 = { files, series: 2, images: images.map(entry => ({ label: entry.label, origin: entry.origin, parents: entry.parentKeys?.length ?? 0 })) }
  console.log("PASS AC-16: 3 files under .codenomad/design/icon/, one read part per image, 2 series, proven, lineage and pixels")

  // AC-52: a completed generation the agent does not read back.
  state.readBack = false
  const answered = (list, words) => list.some(message => message.type === "assistant" && message.content.some(part => part.type === "text" && part.text.includes(words)))
  await turn(`RUN ${JSON.stringify([gen("Monochrome app icon", "icon-mono-a.png")])}`, list => notices(list).length >= 4, "unread generation")
  await until("the notice answered without a read", async () => {
    const list = await messages()
    return answered(list.slice(list.indexOf(notices(list)[3])), "Noted.")
  })
  await idle()
  entries = await gallery()
  const unread = entries.find(entry => entry.kind === "generation" && entry.prompt === "Monochrome app icon")
  assert(unread && unread.tool === "completed" && unread.outcome === "completed", JSON.stringify(unread))
  assert(!entries.some(entry => entry.kind === "image" && entry.generationKey === unread.key), "no read-back image is attached")
  assert.equal(entries.filter(entry => entry.kind === "image").length, 3)
  const reference = await rpc("imageReference", { sessionID, target: unread.target })
  assert.deepEqual(reference, { status: "path", path: ".codenomad/design/icon/icon-mono-a.png" })
  const generatedAt = (await messages()).findLastIndex(message => message.type === "assistant" && message.content.some(part => part.type === "tool" && part.name === "experimental_image_generate"))

  if (companionUI) await companionUI.testDesignCompanionUI({ cli, client, url, password, root, location, sessionID, designZip, until, idle })
  else {
    // The Design extension's English request, as `composer.prefill` substitutes its reference.
    await turn(`Read the generated image \`${reference.path}\` and show it here with your critique.`,
      list => readParts(list).length >= 4 && answered(list, "Here it is"), "late read-back")
  }

  const after = await messages()
  const lateRead = readParts(after).at(-1)
  const readAt = after.findIndex(message => message.id === lateRead.message)
  const between = after.slice(generatedAt + 1, readAt).filter(message => message.type === "assistant").length
  assert(between > 32, `the read comes ${between} assistant messages after its generation`)
  entries = await gallery()
  const late = entries.filter(entry => entry.kind === "image" && entry.label === "icon-mono-a")
  assert.equal(late.length, 1, JSON.stringify(entries.filter(entry => entry.kind === "image")))
  assert.equal(late[0].origin, "unverifiable", JSON.stringify(late[0]))
  for (const key of ["generationKey", "parentKeys", "prompt", "model"]) assert.equal(late[0][key], undefined, `an unverifiable image carries no ${key}`)
  assert.deepEqual(await pixels(late[0].target), await readFile(file("icon-mono-a.png")), "the late read shows the file's pixels")
  assert.deepEqual(await rpc("imageReference", { sessionID, target: late[0].target }), { status: "refused", reason: "unverifiable" })
  // The earlier series stay proven on older pages.
  assert.deepEqual(entries.filter(entry => entry.kind === "image" && entry.label !== "icon-mono-a").map(entry => entry.origin), ["proven", "proven", "proven"])
  results.ac52 = { assistantMessagesBetween: between, origin: late[0].origin, ui: Boolean(designZip) }
  console.log(`PASS AC-52${designZip ? " (native and browser)" : " (native)"}: no read-back, reference, request sent, read ${between} assistant messages later, pixels, unverifiable origin`)
  assert.equal(state.imageCalls.length, 4, "every image request reached the fake image provider")
  console.log(`PASS ${version}: ${JSON.stringify({ ...results, imageCalls: state.imageCalls.length, chatRequests: state.chat })}`)
  passed = true
} finally {
  await lifecycle.stop()
  try { await stopFixtureChild(daemon, daemonStopped) } finally {
    provider.closeAllConnections()
    await new Promise(resolve => provider.close(resolve))
    if (passed && !process.env.CODENOMAD_KEEP_FIXTURE) await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }).catch(() => {})
    else { await writeFile(path.join(root, "daemon.log"), output).catch(() => {}); console.log(`Isolated fixture retained: ${root}`) }
  }
}
