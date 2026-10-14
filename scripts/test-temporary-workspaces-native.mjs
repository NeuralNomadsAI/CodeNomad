// Explicit isolated CLI and private database: never the shared service.
// Usage: node scripts/test-temporary-workspaces-native.mjs <absolute OpenCode CLI executable>
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import pino from "pino"
import { OpenCode, isSessionNotFoundError } from "@opencode/client"
import { tsImport } from "tsx/esm/api"
import { stopFixtureChild } from "./native-fixture-guards.mjs"

const cli = process.argv[2]
assert(cli && path.isAbsolute(cli), "Pass an absolute isolated CLI executable path")
const parent = path.join(os.tmpdir(), "opencode")
await mkdir(parent, { recursive: true })
const root = await mkdtemp(path.join(parent, "codenomad-temporary-native-"))
const other = path.join(root, "other-project")
await mkdir(other)
const original = { ...process.env }
const env = Object.fromEntries(Object.entries(original).filter(([key]) => !/^(OPENCODE_|XDG_|CODENOMAD_)/i.test(key)))
for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) env[key] = path.join(root, key)
const password = randomUUID()
Object.assign(env, { HOME: root, USERPROFILE: root, OPENCODE_TEST_HOME: root,
  OPENCODE_CONFIG_DIR: path.join(root, "config"), OPENCODE_DB: path.join(root, "fixture.db"),
  OPENCODE_CONFIG_PROJECT_DISABLE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_FFF: "1",
  OPENCODE_SERVER_PASSWORD: password })
await mkdir(env.OPENCODE_CONFIG_DIR)
let output = "", spawnError, manager
const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env, windowsHide: true })
const stopped = new Promise(resolve => child.once("close", resolve))
child.on("error", error => { spawnError = error })
child.stdout.on("data", data => { output += data })
child.stderr.on("data", data => { output += data })
try {
  const deadline = Date.now() + 30_000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
    if (spawnError) throw spawnError
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(output)
    await delay(25)
  }
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
  const endpoint = { url, auth: { type: "basic", username: "opencode", password } }
  const native = OpenCode.make({ baseUrl: url, headers })
  const info = await native.server.info()
  const { rememberRuntime } = await tsImport("../packages/server/src/opencode/compatibility/runtime.ts", import.meta.url)
  rememberRuntime(endpoint, { version: info.version, pid: info.pid, discovery: "info" })
  const { WorkspaceManager } = await tsImport("../packages/server/src/workspaces/manager.ts", import.meta.url)
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const { WorktreeDeletionFence } = await tsImport("../packages/server/src/workspaces/worktree-session-evacuation.ts", import.meta.url)
  const { TemporaryFolderRegistry, TemporaryWorkspaces } = await tsImport("../packages/server/src/workspaces/temporary-workspaces.ts", import.meta.url)
  const registry = await TemporaryFolderRegistry.open(path.join(root, "temporary-workspaces"), path.join(root, "temporary-workspaces.json"))
  manager = new WorkspaceManager({ rootDir: root, temporaryFolders: registry, settings: { getOwner: () => ({ environmentVariables: {} }) },
    binaryResolver: { resolveDefault: () => ({ path: cli, label: "isolated" }) }, eventBus: new EventBus(), logger: pino({ level: "silent" }),
    hostServiceLifecycleFactory: () => ({ discover: async () => endpoint, ensure: async () => endpoint }),
  })
  const temporary = new TemporaryWorkspaces({ registry, workspaceManager: manager, deletionFence: new WorktreeDeletionFence() })

  // Discard: conversations (with a child), files and the folder disappear; others stay.
  const discarded = await temporary.createFolder()
  await writeFile(path.join(discarded, "script.py"), "print('scratch')\n")
  const { workspace } = await manager.create(discarded)
  assert.equal(workspace.temporary, true)
  assert.equal((await manager.getWorktrees(workspace.id, "fresh")).isGitRepo, false)
  const location = manager.getServiceLocation(workspace.id)
  const root1 = await native.session.create({ location })
  const child1 = await native.session.create({ location, parentID: root1.id })
  const foreign = await native.session.create({ location: { directory: other } })
  await temporary.discard(workspace.id)
  await assert.rejects(stat(discarded), { code: "ENOENT" })
  for (const id of [root1.id, child1.id]) {
    await assert.rejects(native.session.get({ sessionID: id }), (error) => isSessionNotFoundError(error))
  }
  assert.equal((await native.session.get({ sessionID: foreign.id })).id, foreign.id)
  assert.equal(registry.has(discarded), false)
  assert.equal(manager.get(workspace.id), undefined)

  // Keep: the folder and its conversation stay; the workspace is no longer temporary.
  const kept = await temporary.createFolder()
  const created = await manager.create(kept)
  const keptSession = await native.session.create({ location: manager.getServiceLocation(created.workspace.id) })
  await temporary.keep(created.workspace.id)
  assert.equal(manager.get(created.workspace.id).temporary, undefined)
  assert.equal(registry.has(kept), false)
  assert.ok((await stat(kept)).isDirectory())
  assert.equal((await native.session.get({ sessionID: keptSession.id })).id, keptSession.id)
  await assert.rejects(temporary.discard(created.workspace.id), /not temporary/)
  assert.equal((await native.server.info()).pid, info.pid)
  console.log(`PASS OpenCode ${info.version}: discard removed parent/child conversations, files and folder while a foreign conversation survived; keep retained folder and conversation`)
} finally {
  await manager?.shutdown()
  try { await stopFixtureChild(child, stopped) } finally {
    await writeFile(path.join(root, "daemon.log"), output)
    console.log(`Isolated fixture: ${root}`)
  }
}
