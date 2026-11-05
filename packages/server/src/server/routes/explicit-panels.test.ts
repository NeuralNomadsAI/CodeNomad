// prototype-1236: panels of a project on an explicit OpenCode server read natively, bounded, read-only.
import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import fs from "node:fs/promises"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import Fastify, { type FastifyInstance } from "fastify"
import pino from "pino"
import { EventBus } from "../../events/bus"
import { explicitContractFixture } from "../../opencode/compatibility/contract-fixture"
import { OpenCodeServerConnections } from "../../opencode/servers/connections"
import { OpenCodeServerCredentials } from "../../opencode/servers/credentials"
import { OpenCodeServerRegistry } from "../../opencode/servers/registry"
import type { OpenCodeServerProfile } from "../../opencode/servers/types"
import { locationPrefix, patchSides, REMOTE_FILE_READ_LIMIT, remoteRelativePath } from "../../opencode/servers/remote-workspace"
import { WorkspaceManager } from "../../workspaces/manager"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { PluginControls } from "../../opencode/plugin-controls"
import { AutoAcceptManager } from "../../permissions/auto-accept-manager"
import { createOpencodeYoloPersistence } from "../../permissions/opencode-yolo-metadata"
import { registerWorkspaceRoutes } from "./workspaces"
import { registerUsageRoutes } from "./usage"
import { registerPluginControlRoutes } from "./plugin-controls"

const DIRECTORY = "/repo/app"

async function fixture(t: TestContext) {
  const calls: { path: string; query: URLSearchParams; method: string }[] = []
  const state = {
    provider: "git" as string | undefined, root: "/repo" as string | undefined, big: false,
    diff: [] as unknown[], limits: null as unknown, pending: [] as unknown[],
  }
  const forbidden = () => { throw new Error("Host adapter forbidden") }
  const upstream: FastifyInstance = Fastify()
  upstream.all("/*", async (request, reply) => {
    const url = new URL(request.url, "http://fixture")
    calls.push({ path: url.pathname, query: url.searchParams, method: request.method })
    const location = { directory: url.searchParams.get("location[directory]") ?? DIRECTORY }
    if (url.pathname === "/openapi.json") return explicitContractFixture()
    if (url.pathname === "/api/location") return { directory: location.directory, project: { id: "p", directory: state.root ?? "/elsewhere", canonical: "/repo" } }
    if (url.pathname === "/api/fs/list") {
      const path = url.searchParams.get("path")
      if (!path || path === ".") return { location, data: [{ path: "src", type: "directory" }, { path: "README.md", type: "file" },
        { path: "../secret", type: "file" }, { path: "/etc/passwd", type: "file" }, { path: "src/deep.ts", type: "file" }, { path: "C:\\x", type: "file" }] }
      return { location, data: [{ path: `${path}/index.ts`, type: "file" }, { path: `${path}/../../escape`, type: "file" }] }
    }
    if (url.pathname === "/api/fs/find") return { location, data: [{ path: "src/index.ts", type: "file" }, { path: "../outside.ts", type: "file" }] }
    if (url.pathname.startsWith("/api/fs/read/")) {
      if (url.pathname.endsWith("missing.ts")) return reply.code(404).send({ _tag: "FileNotFoundError" })
      return reply.type("application/octet-stream").send(state.big ? Buffer.alloc(REMOTE_FILE_READ_LIMIT + 1, 97) : Buffer.from("hello\n"))
    }
    if (url.pathname === "/api/vcs") return { location, data: { ...(state.provider ? { provider: state.provider } : {}), branch: { current: "main" } } }
    if (url.pathname === "/api/vcs/diff") return { location, data: state.diff }
    if (url.pathname === "/api/experimental/usage/limits") return { location, data: state.limits }
    if (url.pathname === "/api/session/ses_s") return { data: { id: "ses_s", location: { directory: DIRECTORY } } }
    if (url.pathname === "/api/session/ses_s/permission") return { data: state.pending }
    if (url.pathname === "/api/session" && request.method === "GET") return { data: [{ id: "ses_s", location: { directory: DIRECTORY } }], cursor: {} }
    if (url.pathname === "/api/config") return [{ type: "directory", path: "/home/user/.config/opencode" }]
    if (url.pathname === "/api/plugin") return { location, data: [{ id: "remote.plugin", source: { type: "package", target: "remote-plugin@1", version: "1.0.0" }, features: { server: true }, state: { status: "active" } }] }
    return reply.code(404).send({})
  })
  await upstream.listen({ host: "127.0.0.1", port: 0 })
  const origin = `http://127.0.0.1:${(upstream.server.address() as { port: number }).port}`
  const profiles: OpenCodeServerProfile[] = [{ id: "A", kind: "explicit", label: "A", origin }]
  const registry = new OpenCodeServerRegistry(() => profiles, forbidden)
  const credentials = new OpenCodeServerCredentials({ profileKey: "panels-test", configIdentity: "panels-test" }, registry)
  await credentials.set("A", JSON.stringify({ username: "A", password: "fixture-A" }))
  const connections = new OpenCodeServerConnections({ registry, credentials, local: { acquire: forbidden, existing: forbidden, invalidate: forbidden } })
  const bus = new EventBus()
  const settingsState: Record<string, unknown> = {}
  const manager = new WorkspaceManager({ rootDir: "C:/forbidden", logger: pino({ level: "silent" }), eventBus: bus,
    binaryResolver: { resolveDefault: forbidden } as never,
    settings: { getOpenCodeServerConnections: () => connections, getOwner: () => settingsState, mergePatchOwner: forbidden,
      readEnvironmentForAdmission: forbidden, disposeOpenCodeServers: () => connections.dispose() } as never,
    sharedService: { endpoint: forbidden, client: forbidden, headers: forbidden, validateLocation: forbidden, subscribe: forbidden, shutdown: async () => {} },
  })
  const workspace = (await manager.create(DIRECTORY, undefined, { serverId: "A" })).workspace
  const app = Fastify()
  const deps = { workspaceManager: manager, worktreeDeletionFence: new WorktreeDeletionFence() }
  registerWorkspaceRoutes(app, deps)
  registerUsageRoutes(app, deps)
  registerPluginControlRoutes(app, { controls: new PluginControls({ ...deps, logger: pino({ level: "silent" }) }) })
  await app.ready()
  t.after(async () => { await app.close(); await manager.shutdown(); await upstream.close() })
  // Host disk and processes are forbidden from here on: every read must be native.
  const hostCalls: string[] = []
  const mocks = [
    ...(["realpath", "stat", "lstat", "readdir", "readFile", "writeFile", "open"] as const).map(method =>
      t.mock.method(fs, method, () => { hostCalls.push(method); throw new Error("Host FS forbidden") })),
    ...(["spawn", "spawnSync", "execFile", "execFileSync"] as const).map(method =>
      t.mock.method(childProcess, method, () => { hostCalls.push(method); throw new Error("Host process forbidden") })),
  ]
  syncBuiltinESMExports()
  t.after(() => { for (const mock of mocks) mock.mock.restore(); syncBuiltinESMExports() })
  const base = `/api/workspaces/${encodeURIComponent(workspace.id)}`
  return { app, manager, bus, workspace, base, calls, state, hostCalls }
}

test("relative paths only: absolute, drive, parent and NUL paths are refused", () => {
  for (const value of ["/etc/passwd", "C:\\Windows", "c:/x", "../x", "a/../../b", "a\0b", "\\\\server\\share"]) {
    assert.throws(() => remoteRelativePath(value), { code: "invalid_path" }, value)
  }
  assert.equal(remoteRelativePath("./src//a\\b.ts"), "src/a/b.ts")
  assert.equal(remoteRelativePath(""), ".")
})

test("Git paths come back to the opened folder from the worktree root", () => {
  assert.equal(locationPrefix("/repo", "/repo"), "")
  assert.equal(locationPrefix("/repo", "/repo/app"), "app/")
  assert.equal(locationPrefix("D:\\Repo", "d:\\repo\\App\\web"), "App/web/")
  assert.equal(locationPrefix("/repo", "/repository"), undefined)
  assert.equal(locationPrefix("/other", "/repo/app"), undefined)
})

test("whole-file patches rebuild both sides exactly or not at all", () => {
  assert.deepEqual(patchSides("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n"), { before: "keep\nold\n", after: "keep\nnew\n" })
  assert.deepEqual(patchSides("@@ -0,0 +1,1 @@\n+only\n\\ No newline at end of file\n"), { before: "", after: "only" })
  assert.deepEqual(patchSides("@@ -1 +0,0 @@\n-gone\n"), { before: "gone\n", after: "" })
  // Partial context, two hunks, wrong counts or mode-only headers prove nothing.
  assert.equal(patchSides("@@ -10,2 +10,2 @@\n a\n-b\n+c\n"), undefined)
  assert.equal(patchSides("@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-c\n+d\n"), undefined)
  assert.equal(patchSides("@@ -1,3 +1,3 @@\n-a\n+b\n"), undefined)
  assert.equal(patchSides("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n"), undefined)
})

test("Files list, search and read go through the server, filtered to the folder and bounded", async t => {
  const f = await fixture(t)
  const list = await f.app.inject(`${f.base}/files?path=.`)
  assert.equal(list.statusCode, 200, list.body)
  assert.deepEqual(list.json(), [{ name: "README.md", path: "README.md", type: "file" }, { name: "src", path: "src", type: "directory" }])
  assert.deepEqual((await f.app.inject(`${f.base}/files?path=src&directory=${encodeURIComponent(DIRECTORY)}`)).json(), [{ name: "index.ts", path: "src/index.ts", type: "file" }])
  assert.deepEqual((await f.app.inject(`${f.base}/files/search?q=index`)).json(), [{ name: "index.ts", path: "src/index.ts", type: "file" }])
  const read = await f.app.inject(`${f.base}/files/content?path=src/index.ts`)
  assert.deepEqual(read.json(), { workspaceId: f.workspace.id, relativePath: "src/index.ts", contents: "hello\n", encoding: "utf-8" })
  assert.equal((await f.app.inject(`${f.base}/files/preview?path=src/index.ts`)).json().contents, Buffer.from("hello\n").toString("base64"))
  assert.equal((await f.app.inject(`${f.base}/files/content?path=missing.ts`)).statusCode, 404)
  f.state.big = true
  const big = await f.app.inject(`${f.base}/files/preview?path=big.bin`)
  assert.equal(big.statusCode, 413)
  assert.equal(big.json().code, "too_large")
  const before = f.calls.length
  for (const path of ["../secret", "/etc/passwd", "C:%5Cx"]) {
    assert.equal((await f.app.inject(`${f.base}/files/content?path=${path}`)).statusCode, 400, path)
    assert.equal((await f.app.inject(`${f.base}/files?path=${path}`)).statusCode, 400, path)
  }
  assert.equal((await f.app.inject(`${f.base}/files?directory=%2Frepo`)).statusCode, 403)
  assert.equal((await f.app.inject({ method: "PUT", url: `${f.base}/files/content?path=a.ts`, payload: { contents: "x" } })).statusCode, 403)
  assert.equal(f.calls.length, before, "refused paths, other folders and writes never reach the server")
  assert(f.calls.filter(call => call.path.startsWith("/api/fs")).every(call => call.query.get("location[directory]") === DIRECTORY))
  assert(f.calls.every(call => call.method === "GET" && call.path !== "/api/credential"))
  assert.deepEqual(f.hostCalls, [])
})

test("Changes read native working changes relative to the folder; unknown or partial state is never clean", async t => {
  const f = await fixture(t)
  const status = () => f.app.inject(`${f.base}/worktrees/root/git-status`)
  f.state.diff = [
    { file: "app/src/a.ts", patch: "@@ -1,1 +1,1 @@\n-old\n+new\n", additions: 1, deletions: 1, status: "modified" },
    { file: "other/b.ts", patch: "", additions: 3, deletions: 0, status: "added" },
    { file: "app/new/", patch: "", additions: 0, deletions: 0, status: "added", more: true },
  ]
  const rows = await status()
  assert.equal(rows.statusCode, 200, rows.body)
  assert.deepEqual(rows.json().map((row: { path: string; unstagedStatus: string; stagedStatus: null }) => [row.path, row.unstagedStatus, row.stagedStatus]),
    [["src/a.ts", "modified", null], ["new/", "added", null]])
  const diff = await f.app.inject(`${f.base}/worktrees/root/git-diff?path=src/a.ts&scope=unstaged`)
  assert.deepEqual(diff.json(), { path: "src/a.ts", originalPath: null, scope: "unstaged", before: "old\n", after: "new\n" })
  assert.equal(f.calls.find(call => call.path === "/api/vcs/diff" && call.query.has("context"))!.query.get("mode"), "working")
  assert.equal((await f.app.inject(`${f.base}/worktrees/root/git-diff?path=new&scope=unstaged`)).statusCode, 404)
  f.state.diff = [{ file: "app/src/a.ts", patch: "", additions: 1, deletions: 1, status: "modified" }]
  assert.equal((await f.app.inject(`${f.base}/worktrees/root/git-diff?path=src/a.ts&scope=unstaged`)).json().code, "ambiguous")
  // An untraversed ancestor folder, an unknown worktree root or no repository: an error, never an empty list.
  f.state.diff = [{ file: "app/", patch: "", additions: 0, deletions: 0, status: "added", more: true }]
  assert.deepEqual([(await status()).statusCode, (await status()).json().code], [409, "ambiguous"])
  f.state.diff = []
  f.state.root = undefined
  assert.deepEqual([(await status()).statusCode, (await status()).json().code], [409, "ambiguous"])
  f.state.root = "/repo"
  f.state.provider = undefined
  assert.deepEqual([(await status()).statusCode, (await status()).json().code], [409, "not_repository"])
  f.state.provider = "git"
  assert.deepEqual((await status()).json(), [])
  for (const [method, suffix, payload] of [["POST", "git-stage", { paths: ["src/a.ts"] }], ["POST", "git-unstage", { paths: ["src/a.ts"] }],
    ["POST", "git-commit", { message: "x" }], ["GET", "git-history", undefined]] as const) {
    assert.equal((await f.app.inject({ method, url: `${f.base}/worktrees/root/${suffix}`, ...(payload ? { payload } : {}) })).statusCode, 403, suffix)
  }
  assert.equal((await f.app.inject({ method: "POST", url: `${f.base}/git-init`, payload: { directory: DIRECTORY } })).statusCode, 403)
  assert.equal((await f.app.inject(`${f.base}/git-branches?directory=${encodeURIComponent(DIRECTORY)}`)).statusCode, 403)
  assert(f.calls.every(call => call.method === "GET"), "no Git mutation reaches the server")
  assert.deepEqual(f.hostCalls, [])
})

test("Usage shows only quotas OpenCode publishes and never reads server credentials", async t => {
  const f = await fixture(t)
  const usage = (provider: string) => f.app.inject(`/api/usage/${provider}?instanceId=${f.workspace.id}&sessionId=ses_s`)
  f.state.limits = { workspace: { id: "w", usageURL: "https://opencode.ai" }, budgets: [],
    go: { rolling: { percent: 12, limited: false, resetsAt: 1000 }, weekly: { percent: 40, limited: false, resetsAt: 2000 }, monthly: { percent: 5, limited: true, resetsAt: 3000 } } }
  const go = await usage("opencode-go")
  assert.equal(go.statusCode, 200, go.body)
  assert.deepEqual(Object.fromEntries(Object.entries(go.json().windows).map(([key, value]: [string, any]) => [key, value.usedPercent])), { "5h": 12, weekly: 40, monthly: 100 })
  assert.equal(go.json().ok, true)
  f.state.limits = null
  assert.deepEqual([(await usage("opencode-go")).json().configured, (await usage("opencode-go")).json().ok], [false, false])
  for (const provider of ["openai", "anthropic", "claude-code", "openrouter"]) {
    const response = await usage(provider)
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().supported, false, provider)
  }
  assert(f.calls.every(call => call.path !== "/api/credential"), "credentials are never read")
  assert.deepEqual(f.hostCalls, [])
})

test("Plugins list the server's inventory read-only; activation writes are refused", async t => {
  const f = await fixture(t)
  const read = await f.app.inject(`${f.base}/plugin-controls?directory=${encodeURIComponent(DIRECTORY)}`)
  assert.equal(read.statusCode, 200, read.body)
  assert.deepEqual(read.json().targets, [])
  assert.equal(read.json().runtime[0].source.target, "remote-plugin@1")
  const write = await f.app.inject({ method: "PATCH", url: `${f.base}/plugin-controls`, payload: { location: { directory: DIRECTORY }, pluginId: "remote.plugin", scope: "global", enabled: false } })
  assert.equal(write.statusCode, 403)
  assert(f.calls.every(call => call.method === "GET" && call.path !== "/api/credential"))
  assert.deepEqual(f.hostCalls, [])
})

test("Yolo re-reads pending permissions of its own sessions after a reconnect and replies on the server", async t => {
  const f = await fixture(t)
  const settings = { getOwner: () => ({ sessions: { ses_s: { yoloEnabled: true } } }), mergePatchOwner: () => {} } as never
  const persistence = createOpencodeYoloPersistence(f.manager, settings)
  const replies: string[] = []
  const yolo = new AutoAcceptManager({ eventBus: f.bus, logger: pino({ level: "silent" }) as never, persistence,
    replier: async reply => { replies.push(`${reply.sessionId}:${reply.permissionId}`) } })
  yolo.start()
  t.after(() => yolo.stop())
  await yolo.hydrateInstance(f.workspace.id)
  assert.equal(yolo.isEnabled(f.workspace.id, "ses_s"), true)
  f.state.pending = [{ id: "per_1", sessionID: "ses_s", action: "bash", resources: ["ls"] }, { id: "per_x", sessionID: "ses_other", action: "bash", resources: [] }]
  f.bus.publish({ type: "instance.eventStatus", instanceId: f.workspace.id, status: "connected", generation: 2 } as never)
  for (let i = 0; i < 50 && replies.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(replies, ["ses_s:per_1"])
  assert.equal(f.calls.filter(call => call.path.endsWith("/permission")).length, 1, "only the Yolo session is re-read")
  assert.deepEqual(f.hostCalls, [])
})
