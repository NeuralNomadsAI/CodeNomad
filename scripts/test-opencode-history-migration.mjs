// Native migration only: isolated synthetic storage, never service discovery or
// a user's database. Keep an untouched seed and migrate a copied DB via OpenCode.
import assert from "node:assert/strict"
import { spawn, execFileSync } from "node:child_process"
import { randomUUID, createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { SessionLegacy } from "@opencode/schema/session-legacy"
import { fixturePaginationGuard, stopFixtureChild } from "./native-fixture-guards.mjs"
const deadlineAt = Date.now() + 180_000
const signal = AbortSignal.timeout(180_000)
const [oldCli, newCli] = process.argv.slice(2)
if (![oldCli, newCli].every(value => value && path.isAbsolute(value))) throw new Error("Pass absolute old and target CLI paths")
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "codenomad-history-migration-"))
const repo = path.join(root, "repo"), worktree = path.join(root, "worktree")
await mkdir(repo)
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe", timeout: 15_000 })
git("init"); git("config", "user.name", "Synthetic fixture"); git("config", "user.email", "fixture@example.invalid")
await writeFile(path.join(repo, "fixture.txt"), "synthetic")
git("add", "."); git("commit", "-m", "fixture"); git("worktree", "add", "-b", "fixture-worktree", worktree)
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCODE_|XDG_)/.test(key)))
for (const key of ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
const password = randomUUID()
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_CONFIG_PROJECT_DISABLE: "1",
  OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1", OPENCODE_CONFIG_CONTENT: "{}" })
await mkdir(env.OPENCODE_CONFIG_DIR)
const providerConfig = JSON.stringify({ providers: { openai: { settings: { apiKey: "synthetic-migration-fixture" },
  models: { "migration-fixture": { name: "Historical fixture model" } } } } })
const configFile = path.join(env.OPENCODE_CONFIG_DIR, "opencode.json")
await writeFile(configFile, providerConfig)
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const versions = [oldCli, newCli].map(cli => execFileSync(cli, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim())
const hashes = await Promise.all([oldCli, newCli].map(async cli => createHash("sha256").update(await readFile(cli)).digest("hex")))
await writeFile(path.join(root, "artifacts.json"), JSON.stringify({ versions, hashes }, null, 2))

async function start(cli, database, name) {
  signal.throwIfAborted()
  let output = ""
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: root, env: { ...env, OPENCODE_DB: database }, windowsHide: true,
  })
  const stopped = new Promise(resolve => child.once("close", resolve))
  let spawnError
  child.once("error", error => { spawnError = error })
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  const close = async () => {
    try { await stopFixtureChild(child, stopped) }
    finally { await writeFile(path.join(root, `${name}.log`), output) }
  }
  try {
    const deadline = Date.now() + 30_000
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      signal.throwIfAborted()
      if (spawnError) throw spawnError
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture startup failed: ${output}`)
      await delay(20)
    }
    const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const raw = async (route, body, method = body === undefined ? "GET" : "POST", headers = {}) => {
      const response = await fetch(`${baseUrl}${route}`, { method, headers: { authorization, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) })
      const text = await response.text()
      assert.ok(response.ok, `${method} ${route}: ${response.status} ${text}`)
      return text ? JSON.parse(text) : undefined
    }
    return { baseUrl, raw, close }
  } catch (error) { await close(); throw error }
}

// Each pre-2.1 replay value must reach its 2.1 location, checked independently of the codec.
function assertReplayCarried(before, after) {
  let carried = 0
  const byID = new Map(after.map(message => [message.id, message]))
  for (const old of before) {
    const now = byID.get(old.id)
    assert.ok(now, `migrated message ${old.id}`)
    const check = (actual, expected, what) => { assert.deepEqual(actual, expected, `${what} of ${old.id}`); carried++ }
    if (old.type === "assistant") {
      if (old.providerState) check(now.native, old.providerState, "step native")
      old.content.forEach((part, index) => {
        if ((part.type === "text" || part.type === "reasoning") && part.state) check(now.content[index].native, part.state, `${part.type} native`)
        if (part.type === "tool" && (part.providerState || part.providerResultState)) {
          // Call and result data merge into one `native`; the result wins a shared key.
          check(now.content[index].native, { ...part.providerState, ...part.providerResultState }, "tool native")
        }
      })
    }
    if (old.type === "compaction") {
      if (old.recent) check(now.metadata?.recent, old.recent, "kept compaction text")
      if (old.providerContext) check(now.native, { messages: old.providerContext.messages }, "provider window")
      else if (old.providerState) check(now.native, old.providerState, "compaction native")
      for (const retired of ["recent", "providerContext", "providerState"]) assert.equal(retired in now, false, `${retired} of ${old.id}`)
    }
  }
  return carried
}

const seedDb = path.join(root, "seed.db"), migratedDb = path.join(root, "migrated.db")
const seed = await start(oldCli, seedDb, "seed")
const snapshots = []
const forms = []
let providerConnections
let pendingSession
let replay
try {
  // Seed every provider replay field the source contract declares (pre-2.1 names), so
  // the target's own codecs must carry each one to its 2.1 location.
  const sourceContract = await seed.raw("/openapi.json")
  const sourceSchemas = sourceContract.components?.schemas ?? {}
  const declares = (schema, field) => field in (sourceSchemas[schema]?.properties ?? {})
  // Later 2.0.x sources moved transcripts under /api/experimental and fork inclusively by default.
  const experimental = "/api/experimental/session/import" in (sourceContract.paths ?? {})
  const routes = experimental
    ? { import: "/api/experimental/session/import", export: id => `/api/experimental/session/${id}/export`, fork: {} }
    : { import: "/api/session/import", export: id => `/api/session/${id}/export`, fork: { boundary: { type: "through" } } }
  replay = {
    part: declares("Session.Message.Assistant.Text", "state") && declares("Session.Message.Assistant.Reasoning", "state"),
    tool: declares("Session.Message.Assistant.Tool", "providerState") && declares("Session.Message.Assistant.Tool", "providerResultState"),
    step: declares("Session.Message.Assistant", "providerState"),
    summary: declares("Session.Message.Compaction.Completed", "providerState"),
    window: declares("Session.Message.Compaction.Completed", "providerContext"),
  }
  // Historical workspace selectors exist only in sources predating directory-only locations.
  for (const workspaceID of experimental ? [undefined] : [undefined, "wrk_fixture_one", "wrk_fixture_two"]) {
    const location = { directory: repo, ...(workspaceID ? { workspaceID } : {}) }
    const created = (await seed.raw("/api/session", { location })).data
    const exported = (await seed.raw(routes.export(created.id))).data
    const time = Date.now()
    const messages = Array.from({ length: 213 }, (_, index) => ({ type: "synthetic", id: `msg_${randomUUID().replaceAll("-", "")}`,
      text: `history-${workspaceID ?? "local"}-${index}`, time: { created: time + index } }))
    messages.push({ type: "assistant", id: `msg_${randomUUID().replaceAll("-", "")}`, time: { created: time + 214, completed: time + 215 },
      agent: "build", model: { providerID: "fixture", id: "fixture" }, finish: "stop",
      ...(replay.step ? { providerState: { stepToken: `step-${workspaceID ?? "local"}` } } : {}), content: [
        { type: "reasoning", text: "historical reasoning", ...(replay.part ? { state: { signature: "historical-signature" } } : {}) },
        { type: "text", text: "historical answer", ...(replay.part ? { state: { itemID: "historical-item" } } : {}) },
        { type: "tool", id: "fixture-tool", name: "fixture", time: { created: time + 214, completed: time + 215 },
          ...(replay.tool ? { providerState: { callID: "historical-call", shared: "call" }, providerResultState: { resultID: "historical-result", shared: "result" } } : {}),
          state: { status: "completed", input: {}, content: [{ type: "text", text: "historical tool output" }] } },
      ] })
    messages.push({ type: "compaction", id: `msg_${randomUUID().replaceAll("-", "")}`, time: { created: time + 216 },
      status: "completed", reason: "manual", summary: "Synthetic historical checkpoint", recent: messages[212].id,
      ...(replay.summary ? { providerState: { cacheKey: "historical-summary-cache" } } : {}) })
    // A provider compaction's replacement window, replayed instead of its summary.
    if (replay.window) messages.push({ type: "compaction", id: `msg_${randomUUID().replaceAll("-", "")}`, time: { created: time + 217 },
      status: "completed", reason: "auto", summary: "Synthetic provider window", recent: "", model: { providerID: "fixture", id: "fixture" },
      providerContext: { version: 1, provenance: { providerID: "fixture", provider: "fixture", modelID: "fixture", route: "chat", protocol: "openai", endpoint: "digest" },
        messages: [{ role: "user", content: [{ type: "text", text: "historical window" }] }, { role: "assistant", content: [{ type: "text", text: "historical reply" }] }] } })
    const info = { ...exported.info, id: `ses_${randomUUID().replaceAll("-", "")}`, title: `history-${workspaceID ?? "local"}` }
    const imported = (await seed.raw(routes.import, { info, messages, location })).data
    const fork = (await seed.raw(`/api/session/${imported.id}/fork`, routes.fork)).data
    for (const session of [imported, fork]) snapshots.push((await seed.raw(routes.export(session.id))).data)
  }
  const moved = (await seed.raw("/api/session", { location: { directory: repo } })).data
  await seed.raw(`/api/session/${moved.id}/move`, { directory: worktree })
  // Move is queued by native OpenCode; wait for its authoritative record.
  for (let n = 0; n < 200; n++) {
    const current = (await seed.raw(`/api/session/${moved.id}`)).data
    if (current.location.directory.replaceAll("\\", "/").toLowerCase() === worktree.replaceAll("\\", "/").toLowerCase()) break
    if (n === 199) throw new Error("Native move did not settle")
    await delay(25)
  }
  snapshots.push((await seed.raw(routes.export(moved.id))).data)
  pendingSession = (await seed.raw("/api/session", { location: { directory: repo } })).data.id
  await seed.raw(`/api/session/${pendingSession}/synthetic`, { text: "pending migration fixture", resume: false })
  assert.equal((await seed.raw(`/api/session/${pendingSession}/inbox`)).data.length, 1)
  for (const owner of [pendingSession, "global"]) {
    const headers = owner === "global" ? { "x-opencode-directory": encodeURIComponent(repo) } : {}
    for (const action of ["reply", "cancel"]) {
      const form = (await seed.raw(`/api/session/${owner}/form`, {
        title: `Historical ${owner === "global" ? "global" : "session"} ${action}`,
        fields: [{ key: "answer", type: "string" }],
      }, "POST", headers)).data
      forms.push({ form, owner, action })
    }
  }
  const models = await seed.raw(`/api/model?location[directory]=${encodeURIComponent(repo)}`)
  assert.ok(JSON.stringify(models).includes("Historical fixture model"))
  await seed.raw(`/api/integration/openai/connect/key?location[directory]=${encodeURIComponent(repo)}`, {
    key: "synthetic-not-a-provider-key", label: "Historical fixture credential",
  })
  providerConnections = (await seed.raw(`/api/integration/openai?location[directory]=${encodeURIComponent(repo)}`)).data.connections
  assert.ok(JSON.stringify(providerConnections).includes("Historical fixture credential"))
  await writeFile(path.join(root, "seed-provider-connections.json"), JSON.stringify(providerConnections))
  await writeFile(path.join(root, "seed-exports.json"), JSON.stringify(snapshots))
} finally { await seed.close() }
await copyFile(seedDb, migratedDb)
await copyFile(`${seedDb}-wal`, `${migratedDb}-wal`).catch(error => { if (error.code !== "ENOENT") throw error })
const untouchedHash = createHash("sha256").update(await readFile(seedDb)).digest("hex")
const controlDb = path.join(root, "restart-control.db")
await copyFile(seedDb, controlDb)
await copyFile(`${seedDb}-wal`, `${controlDb}-wal`).catch(error => { if (error.code !== "ENOENT") throw error })
const control = await start(oldCli, controlDb, "same-version-restart-control")
try {
  for (const entry of forms) {
    const headers = entry.owner === "global" ? { "x-opencode-directory": encodeURIComponent(repo) } : {}
    try {
      await control.raw(`/api/session/${entry.owner}/form/${entry.form.id}`, undefined, "GET", headers)
      entry.durable = true
    } catch (error) {
      assert.match(String(error), /404.*FormNotFoundError/)
      entry.durable = false
    }
  }
} finally { await control.close() }
await writeFile(path.join(root, "forms-restart-control.json"), JSON.stringify(forms))
const target = await start(newCli, migratedDb, "target")
let shared
try {
  const { OpenCodeCliService } = await tsImport("../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
  const { OpenCodeSharedService } = await tsImport("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
  const lifecycle = new OpenCodeCliService({ label: "Migration fixture", timeoutMs: 30_000, command: args => ({ command: newCli, args, options: {} }) },
    { execFile: async (_file, args) => ({ stdout: args.at(-1) === "password" ? password : target.baseUrl, stderr: "" }) })
  shared = new OpenCodeSharedService({ headers: Service.headers, makeClient: options => OpenCode.make({ ...options,
    fetch: (input, init) => options.fetch(input, { ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
    }),
  }) })
  const client = await shared.client({ kind: "lifecycle", identity: "migration-fixture", lifecycle }, { deadlineAt })
  const inbox = await client.session.inbox.list({ sessionID: pendingSession })
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].payload.text, "pending migration fixture")
  assert.equal(typeof inbox[0].time.created, "number")
  for (const { form, owner, action, durable } of forms) {
    const headers = owner === "global" ? { headers: { "x-opencode-directory": encodeURIComponent(repo) } } : undefined
    if (!durable) {
      await assert.rejects(client.session.form.get({ sessionID: owner, formID: form.id }, headers), error => error?._tag === "FormNotFoundError")
      assert.ok(!(await client.form.list({ location: { directory: repo } })).data.some(item => item.id === form.id))
    }
    const restored = durable ? await client.session.form.get({ sessionID: owner, formID: form.id }, headers)
      : await client.session.form.create({ sessionID: owner, title: form.title, fields: form.fields }, headers)
    assert.equal(restored.title, form.title)
    assert.deepEqual(restored.fields, form.fields)
    assert.equal((await client.session.form.get({ sessionID: owner, formID: restored.id }, headers)).state.status, "pending")
    if (action === "reply") await client.session.form.reply({ sessionID: owner, formID: restored.id, answer: { answer: "migrated" } }, headers)
    else await client.session.form.cancel({ sessionID: owner, formID: restored.id }, headers)
    const settled = await client.session.form.get({ sessionID: owner, formID: restored.id }, headers)
    assert.equal(settled.state.status, action === "reply" ? "answered" : "cancelled")
  }
  assert.ok(JSON.stringify(await client.model.list({ location: { directory: repo } })).includes("Historical fixture model"))
  const restoredConnections = (await client.integration.get({ integrationID: "openai", location: { directory: repo } })).data.connections
  // New runtimes expose how a stored credential was obtained. The seed creates
  // a key credential; preserve all historical fields and validate the additive
  // metadata separately so older seed/target runtimes remain meaningful controls.
  const historicalConnections = connections => connections.map(connection => {
    if (connection.type !== "credential") return connection
    const { method, ...historical } = connection
    if (method !== undefined) assert.equal(method, "key", "the fixture's key credential must not become OAuth")
    return historical
  })
  assert.deepEqual(historicalConnections(restoredConnections), historicalConnections(providerConnections))
  assert.equal(await readFile(configFile, "utf8"), providerConfig)
  console.log("PASS global/session Forms match same-version native restart durability; fresh Forms settle and historical provider/model configuration remains intact")
  let replayed = 0
  for (const original of snapshots) {
    const restored = await client.session.export({ sessionID: original.info.id })
    assert.equal(restored.info.id, original.info.id)
    assert.equal(restored.info.location.directory, original.info.location.directory)
    assert.equal(restored.info.parentID, original.info.parentID)
    assert.deepEqual(restored.info.fork, original.info.fork)
    // The target upgrades pre-2.1 field names on read; compare with its own published codec.
    assert.deepEqual(restored.messages, SessionLegacy.messages(original.messages), `history survives native migration: ${original.info.id}`)
    replayed += assertReplayCarried(original.messages, restored.messages)
    const messages = []
    let page = await client.message.list({ sessionID: original.info.id, limit: 200 })
    messages.push(...page.data)
    const acceptCursor = fixturePaginationGuard()
    while (page.cursor.next) {
      acceptCursor(page.cursor.next)
      page = await client.message.list({ sessionID: original.info.id, cursor: page.cursor.next })
      messages.push(...page.data)
    }
    assert.equal(messages.length, original.messages.length)
    console.log(`PASS migrated ${original.info.id}: ${messages.length} messages, old identity ${original.info.location.workspaceID ?? "local"}, current identity ${restored.info.location.workspaceID ?? "local"}`)
  }
  if (Object.values(replay).some(Boolean)) assert.ok(replayed > 0, "declared replay fields were seeded and verified")
  console.log(`PASS replay data carried to 2.1 fields: ${replayed} values across migrated sessions (declared: ${Object.entries(replay).filter(([, value]) => value).map(([key]) => key).join(", ") || "none"})`)
  const listed = new Set()
  let page = await client.session.list({ directory: repo, limit: 2 })
  for (const item of page.data) listed.add(item.id)
  const acceptCursor = fixturePaginationGuard()
  while (page.cursor.next) {
    acceptCursor(page.cursor.next)
    page = await client.session.list({ cursor: page.cursor.next })
    for (const item of page.data) listed.add(item.id)
  }
  for (const original of snapshots.filter(snapshot => snapshot.info.title?.startsWith("history-"))) {
    assert.ok(listed.has(original.info.id), `native pagination retains migrated session ${original.info.id}`)
  }
} finally {
  try { await shared?.shutdown() }
  finally { await target.close() }
}
// Transcripts exported by the earlier release import through the same codecs. Use a fresh
// database: the migrated sessions already own these message IDs.
const reimport = await start(newCli, path.join(root, "reimport.db"), "reimport")
try {
  const source = snapshots[0]
  await reimport.raw("/api/experimental/session/import", { info: source.info, messages: source.messages, location: { directory: repo } })
  const reimported = (await reimport.raw(`/api/experimental/session/${source.info.id}/export`)).data
  assert.deepEqual(reimported.messages, SessionLegacy.messages(source.messages), "an earlier export re-imports without loss")
  console.log(`PASS earlier export re-imports into a fresh 2.1 database: ${reimported.messages.length} messages, ${assertReplayCarried(source.messages, reimported.messages)} replay values carried`)
} finally { await reimport.close() }
assert.equal(createHash("sha256").update(await readFile(seedDb)).digest("hex"), untouchedHash)
console.log(`PASS: native synthetic history migration ${versions.join(" -> ")}; evidence ${root}`)
