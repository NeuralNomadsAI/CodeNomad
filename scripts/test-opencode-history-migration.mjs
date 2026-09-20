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
const [oldCli, newCli] = process.argv.slice(2)
if (![oldCli, newCli].every(value => value && path.isAbsolute(value))) throw new Error("Pass absolute old and target CLI paths")
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "codenomad-history-migration-"))
const repo = path.join(root, "repo"), worktree = path.join(root, "worktree")
await mkdir(repo)
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
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
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const versions = [oldCli, newCli].map(cli => execFileSync(cli, ["--version"], { encoding: "utf8" }).trim())
const hashes = await Promise.all([oldCli, newCli].map(async cli => createHash("sha256").update(await readFile(cli)).digest("hex")))
await writeFile(path.join(root, "artifacts.json"), JSON.stringify({ versions, hashes }, null, 2))

async function start(cli, database, name) {
  let output = ""
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], {
    cwd: root, env: { ...env, OPENCODE_DB: database }, windowsHide: true,
  })
  const stopped = new Promise(resolve => child.once("close", resolve))
  child.stdout.on("data", data => { output += data }); child.stderr.on("data", data => { output += data })
  const close = async () => { child.kill(); await stopped; await writeFile(path.join(root, `${name}.log`), output) }
  try {
    const deadline = Date.now() + 30_000
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Fixture startup failed: ${output}`)
      await delay(20)
    }
    const baseUrl = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const raw = async (route, body, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(`${baseUrl}${route}`, { method, headers: { authorization, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) })
      const text = await response.text()
      assert.ok(response.ok, `${method} ${route}: ${response.status} ${text}`)
      return text ? JSON.parse(text) : undefined
    }
    return { baseUrl, raw, close }
  } catch (error) { await close(); throw error }
}

const seedDb = path.join(root, "seed.db"), migratedDb = path.join(root, "migrated.db")
const seed = await start(oldCli, seedDb, "seed")
const snapshots = []
let pendingSession
try {
  for (const workspaceID of [undefined, "wrk_fixture_one", "wrk_fixture_two"]) {
    const location = { directory: repo, ...(workspaceID ? { workspaceID } : {}) }
    const created = (await seed.raw("/api/session", { location })).data
    const exported = (await seed.raw(`/api/session/${created.id}/export`)).data
    const time = Date.now()
    const messages = Array.from({ length: 213 }, (_, index) => ({ type: "synthetic", id: `msg_${randomUUID().replaceAll("-", "")}`,
      text: `history-${workspaceID ?? "local"}-${index}`, time: { created: time + index } }))
    messages.push({ type: "assistant", id: `msg_${randomUUID().replaceAll("-", "")}`, time: { created: time + 214, completed: time + 215 },
      agent: "build", model: { providerID: "fixture", id: "fixture" }, finish: "stop", content: [
        { type: "reasoning", text: "historical reasoning" }, { type: "text", text: "historical answer" },
        { type: "tool", id: "fixture-tool", name: "fixture", time: { created: time + 214, completed: time + 215 },
          state: { status: "completed", input: {}, content: [{ type: "text", text: "historical tool output" }] } },
      ] })
    messages.push({ type: "compaction", id: `msg_${randomUUID().replaceAll("-", "")}`, time: { created: time + 216 },
      status: "completed", reason: "manual", summary: "Synthetic historical checkpoint", recent: messages[212].id })
    const info = { ...exported.info, id: `ses_${randomUUID().replaceAll("-", "")}`, title: `history-${workspaceID ?? "local"}` }
    const imported = (await seed.raw("/api/session/import", { info, messages, location })).data
    const fork = (await seed.raw(`/api/session/${imported.id}/fork`, { boundary: { type: "through" } })).data
    for (const session of [imported, fork]) snapshots.push((await seed.raw(`/api/session/${session.id}/export`)).data)
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
  snapshots.push((await seed.raw(`/api/session/${moved.id}/export`)).data)
  pendingSession = (await seed.raw("/api/session", { location: { directory: repo } })).data.id
  await seed.raw(`/api/session/${pendingSession}/synthetic`, { text: "pending migration fixture", resume: false })
  assert.equal((await seed.raw(`/api/session/${pendingSession}/inbox`)).data.length, 1)
  await writeFile(path.join(root, "seed-exports.json"), JSON.stringify(snapshots))
} finally { await seed.close() }
await copyFile(seedDb, migratedDb)
await copyFile(`${seedDb}-wal`, `${migratedDb}-wal`).catch(error => { if (error.code !== "ENOENT") throw error })
const untouchedHash = createHash("sha256").update(await readFile(seedDb)).digest("hex")
const target = await start(newCli, migratedDb, "target")
try {
  const { OpenCodeCliService } = await tsImport("../packages/server/src/workspaces/opencode-cli-service.ts", import.meta.url)
  const { OpenCodeSharedService } = await tsImport("../packages/server/src/workspaces/opencode-service.ts", import.meta.url)
  const lifecycle = new OpenCodeCliService({ label: "Migration fixture", timeoutMs: 30_000, command: args => ({ command: newCli, args, options: {} }) },
    { execFile: async (_file, args) => ({ stdout: args.at(-1) === "password" ? password : target.baseUrl, stderr: "" }) })
  const shared = new OpenCodeSharedService()
  const client = await shared.client({ kind: "lifecycle", identity: "migration-fixture", lifecycle })
  const inbox = await client.session.inbox.list({ sessionID: pendingSession })
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].payload.text, "pending migration fixture")
  assert.equal(typeof inbox[0].time.created, "number")
  for (const original of snapshots) {
    const restored = await client.session.export({ sessionID: original.info.id })
    assert.equal(restored.info.id, original.info.id)
    assert.equal(restored.info.location.directory, original.info.location.directory)
    assert.deepEqual(restored.messages, original.messages, `history survives native migration: ${original.info.id}`)
    const messages = []
    let page = await client.message.list({ sessionID: original.info.id, limit: 200 })
    messages.push(...page.data)
    while (page.cursor.next) { page = await client.message.list({ sessionID: original.info.id, cursor: page.cursor.next }); messages.push(...page.data) }
    assert.equal(messages.length, original.messages.length)
    console.log(`PASS migrated ${original.info.id}: ${messages.length} messages, old identity ${original.info.location.workspaceID ?? "local"}, current identity ${restored.info.location.workspaceID ?? "local"}`)
  }
  const listed = new Set()
  let page = await client.session.list({ directory: repo, limit: 2 })
  for (const item of page.data) listed.add(item.id)
  while (page.cursor.next) {
    page = await client.session.list({ cursor: page.cursor.next })
    for (const item of page.data) listed.add(item.id)
  }
  for (const original of snapshots.filter(snapshot => snapshot.info.title?.startsWith("history-"))) {
    assert.ok(listed.has(original.info.id), `native pagination retains migrated session ${original.info.id}`)
  }
  await shared.shutdown()
} finally { await target.close() }
assert.equal(createHash("sha256").update(await readFile(seedDb)).digest("hex"), untouchedHash)
console.log(`PASS: native synthetic history migration ${versions.join(" -> ")}; evidence ${root}`)
