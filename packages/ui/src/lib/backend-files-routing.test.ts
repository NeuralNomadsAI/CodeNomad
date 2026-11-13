import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer } from "node:http"
import { test, type TestContext } from "node:test"
import { createRoot } from "solid-js"
import toast from "solid-toast"
import { backendOf, backends, createBackendClient, type BackendClient } from "./backend-client"
import type { ServerApi } from "./api-client"
import { backendEvents } from "./backend-events"
import { captureBackendOperation } from "./backend-operation"
import { canOpenWorkspacePaths, openWorkspacePath } from "./workspace-open"
import { useWorkspaceTree } from "../components/instance/shell/right-panel/useWorkspaceTree"
import { useGitHistory } from "../components/instance/shell/right-panel/useGitHistory"
import { useWorkspaceFileEditor } from "../components/workspace-file-editor"
import { useGitChanges } from "../components/instance/shell/right-panel/useGitChanges"
import { reloadWorktrees, createWorktree, deleteWorktree, setWorktreeSlugForParentSession, clearPendingWorktreeMoves } from "../stores/worktrees"

type Wire = { url: string; method: string; body: string; headers: [string, string][]; credentials?: RequestCredentials }
const registry = backends as Map<string, BackendClient>
const directory = "/repo"
const image = { mime: "image/png", before: "YQ==", after: "Yg==" }

async function fixture(t: TestContext, id: string) {
  const requests: { url: string; method: string; body: string }[] = []
  let fail = false, gate: Promise<void> | undefined, entered: (() => void) | undefined
  const server = createServer(async (request, response) => {
    let body = ""
    for await (const chunk of request) body += chunk
    requests.push({ url: request.url!, method: request.method!, body })
    entered?.()
    await gate
    response.setHeader("Content-Type", "application/json")
    if (fail) { response.statusCode = 403; response.end('{"error":"denied"}'); return }
    const path = request.url!
    const value = path.includes("/instance/api/") ? []
      : path.includes("/git-status") ? [{ path: `${id}.txt`, originalPath: null, stagedStatus: "modified", unstagedStatus: "modified",
        stagedAdditions: 1, stagedDeletions: 0, unstagedAdditions: 1, unstagedDeletions: 0 }]
      : path.includes("/files/preview") || path.includes("/files/content") ? { contents: "baseline" }
      : path.endsWith("/git-history/c") ? { id: "c", parent: null, message: id, files: [] }
      : path.includes("/git-diff") || path.includes("/git-history/c") ? { before: "", after: "", isBinary: true, image }
      : path.includes("/git-history?") ? { commits: [{ id: "c", subject: id }], head: "c", hasMore: false }
      : path.includes("/files?") ? [{ path: `${id}.txt`, name: `${id}.txt`, type: "file" }]
      : { worktrees: [{ slug: "root", directory }], isGitRepo: true }
    response.end(JSON.stringify(value))
  })
  server.listen(0, "127.0.0.1"); await once(server, "listening")
  const backend = createBackendClient({ id, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` })
  registry.set(id, backend)
  const detach = backendEvents.attach(id, backend.events)
  t.after(async () => {
    detach(); backend.events.dispose(); registry.delete(id); server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return { backend, requests, detach, deny: () => { fail = true },
    hold: (wait: Promise<void>, notify: () => void) => { gate = wait; entered = notify } }
}

// Literal wire contract of b441b2371: query order, encoding, method and body are significant.
const cases: { path: string; method?: string; body?: string; call: (api: ServerApi, id: string) => Promise<unknown> }[] = [
  { path: "/worktrees?fresh=true", call: (a, id) => a.fetchWorktrees(id, true) },
  { path: "/git-branches?directory=%2Frepo", call: (a, id) => a.fetchLocalGitBranches(id, directory) },
  { path: "/repository-source?directory=%2Frepo", call: (a, id) => a.fetchRepositorySource(id, directory) },
  { path: "/worktrees", method: "POST", body: '{"slug":"new","fromSlug":"root"}', call: (a, id) => a.createWorktree(id, { slug: "new", fromSlug: "root" }) },
  { path: "/worktrees/new?force=true", method: "DELETE", call: (a, id) => a.deleteWorktree(id, "new", { force: true }) },
  { path: "/worktrees/feature%2Fa%20b%25", method: "DELETE", call: (a, id) => a.deleteWorktree(id, "feature/a b%") },
  { path: "/sessions/s/worktree", method: "POST", body: '{"worktreeSlug":"new"}', call: (a, id) => a.moveSessionFamily(id, "s", { worktreeSlug: "new" }) },
  { path: "/files?path=src&directory=%2Frepo", call: (a, id) => a.listWorkspaceFiles(id, "src", directory) },
  { path: "/files/search?q=a+b&directory=%2Frepo&limit=7&type=file", call: (a, id) => a.searchWorkspaceFiles(id, " a b ", { directory, limit: 7, type: "file" }) },
  { path: "/files/search?q=a+%2B%23%3F%C3%A9", call: (a, id) => a.searchWorkspaceFiles(id, " a +#?é ") },
  { path: "/files/search?q=a", call: (a, id) => a.searchWorkspaceFiles(id, "a", { limit: 0 }) },
  { path: "/files/search?q=a&limit=1&type=directory", call: (a, id) => a.searchWorkspaceFiles(id, "a", { limit: 1, type: "directory" }) },
  { path: "/files/preview?path=a.png&directory=%2Frepo", call: (a, id) => a.previewWorkspaceFile(id, "a.png", directory) },
  { path: "/files/content?path=a.png&encoding=base64", call: (a, id) => a.readWorkspaceFile(id, "a.png", { encoding: "base64" }) },
  { path: "/files/content?path=a.txt&directory=%2Frepo&worktree=other", method: "PUT", body: '{"contents":"hello"}', call: (a, id) => a.writeWorkspaceFile(id, "a.txt", "hello", { directory, worktree: "other" }) },
  { path: "/worktrees/root/git-status?hideWhitespace=1", call: (a, id) => a.fetchWorktreeGitStatus(id, "root", undefined, { hideWhitespace: true }) },
  { path: "/worktrees/root/git-history?offset=5&head=c", call: (a, id) => a.fetchGitHistory(id, "root", 5, "c") },
  { path: "/worktrees/root/git-history/c", call: (a, id) => a.fetchGitCommit(id, "root", "c") },
  { path: "/worktrees/root/git-history/c?path=a.png", call: (a, id) => a.fetchGitCommitDiff(id, "root", "c", "a.png") },
  { path: "/worktrees/root/git-diff?path=a.png&scope=staged&originalPath=old.png", call: (a, id) => a.fetchWorktreeGitDiff(id, "root", { path: "a.png", scope: "staged", originalPath: "old.png" }) },
  { path: "/worktrees/root/git-stage", method: "POST", body: '{"paths":["a.txt"]}', call: (a, id) => a.stageWorktreeGitPaths(id, "root", { paths: ["a.txt"] }) },
  { path: "/worktrees/root/git-unstage", method: "POST", body: '{"paths":["a.txt"]}', call: (a, id) => a.unstageWorktreeGitPaths(id, "root", { paths: ["a.txt"] }) },
  { path: "/git-init", method: "POST", body: '{"directory":"/repo"}', call: (a, id) => a.initializeWorkspaceGit(id, directory) },
  { path: "/worktrees/root/git-commit", method: "POST", body: '{"message":"hello"}', call: (a, id) => a.commitWorktreeGitChanges(id, "root", { message: "hello" }) },
]

test("real Files/Git HTTP boundaries isolate A and B and strip only the instance prefix", async t => {
  const a = await fixture(t, "filesA"), b = await fixture(t, "filesB")
  for (const owner of [a, b]) {
    const key = `${owner.backend.id}~w/1`
    for (const item of cases) await item.call(backendOf(key).api, key)
    assert.deepEqual(owner.requests, cases.map(item => ({ url: `/api/workspaces/w%2F1${item.path}`, method: item.method ?? "GET", body: item.body ?? "" })))
    const diff = await backendOf(key).api.fetchGitCommitDiff(key, "root", "c", "a.png")
    assert.deepEqual(diff.image, image, "Git image bytes belong to the chosen backend")
  }
  assert.equal(a.requests.length, cases.length + 1, "B cannot reach A")
  assert.equal(b.requests.length, cases.length + 1, "A cannot reach B")
  b.deny()
  await assert.rejects(backendOf("filesB~w").api.listWorkspaceFiles("filesB~w"), { status: 403 })
  assert.equal(a.requests.length, cases.length + 1, "a refusal never retries locally")
})

test("local Files/Git requests preserve the literal baseline contract", async t => {
  await new Promise<void>(resolve => setImmediate(resolve))
  const wire: Wire[] = []
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    wire.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? ""),
      headers: [...new Headers(init?.headers)], credentials: init?.credentials })
    return Response.json({})
  })
  for (const item of cases) await item.call(backendOf("w/1").api, "w/1")
  assert.deepEqual(wire, cases.map(item => ({ url: `/api/workspaces/w%2F1${item.path}`, method: item.method ?? "GET", body: item.body ?? "",
    headers: item.body ? [["content-type", "application/json"]] : [], credentials: "include" })))
  assert.throws(() => backendOf("missing~w").api.listWorkspaceFiles("missing~w"), /Backend unavailable/)
  assert.equal(wire.length, cases.length, "an absent backend sends nothing")
})

async function until(predicate: () => boolean) {
  for (let n = 0; n < 200 && !predicate(); n++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(predicate(), "consumer settled")
}

test("real tree, commit history and file editor consumers use their owning backend", async t => {
  const custom = toast.custom
  toast.custom = (() => "test") as typeof toast.custom
  t.after(() => { toast.custom = custom })
  const a = await fixture(t, "treeA"), b = await fixture(t, "treeB")
  for (const owner of [a, b]) {
    const key = `${owner.backend.id}~w`
    const target = { kind: "workspace" as const, slug: "root", sessionId: "s", directory, path: "a.txt" }
    const h = createRoot(dispose => ({ dispose,
      tree: useWorkspaceTree(key, () => directory, () => true, captureBackendOperation),
      history: useGitHistory(key, () => "root", () => true, captureBackendOperation),
      editor: useWorkspaceFileEditor({ instanceId: key,
        target: () => target,
        active: () => true, t: key => key, onError: message => assert.fail(message), captureOperation: captureBackendOperation }),
    }))
    t.after(h.dispose)
    await until(() => h.tree.rows().length === 1 && !!h.history.page())
    assert.equal(h.tree.rows()[0].path, `${owner.backend.id}.txt`)
    assert.equal(h.history.page()!.commits[0].subject, owner.backend.id)
    await h.history.select("c")
    assert.equal(h.history.error(), null)
    assert.deepEqual(h.history.details(), { id: "c", parent: null, message: owner.backend.id, files: [] })
    assert.ok(owner.requests.some(request => request.url === "/api/workspaces/w/worktrees/root/git-history/c"))
    h.editor.adopt("baseline"); h.editor.change("edited")
    await h.editor.save()
    assert.ok(owner.requests.some(request => request.method === "PUT" && request.body === '{"contents":"edited"}'))
    assert.ok(owner.requests.every(request => request.url.startsWith("/api/workspaces/w/")))
    h.dispose()
  }
  assert.equal(a.requests.length, b.requests.length)
})

test("a revoked tree/history request cannot publish into a replacement attachment", async t => {
  const owner = await fixture(t, "revokedFiles")
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  owner.hold(new Promise<void>(resolve => { release = resolve }), entered)
  const h = createRoot(dispose => ({ dispose,
    tree: useWorkspaceTree("revokedFiles~w", () => directory, () => true, captureBackendOperation),
    history: useGitHistory("revokedFiles~w", () => "root", () => true, captureBackendOperation),
  }))
  t.after(h.dispose)
  await started
  owner.detach(); release()
  await until(() => h.tree.busy().size === 0 && !h.history.loading())
  assert.equal(h.tree.rows().length, 0); assert.equal(h.history.page(), null)
  t.after(backendEvents.attach(owner.backend.id, owner.backend.events))
  await until(() => h.tree.rows().length === 1 && !!h.history.page())
  assert.equal(h.tree.rows()[0].path, "revokedFiles.txt")
})

test("Changes mutations and worktree consumers dispatch through B rather than local or A", async t => {
  const custom = toast.custom
  toast.custom = (() => "test") as typeof toast.custom
  t.after(() => { toast.custom = custom })
  const a = await fixture(t, "gitA"), b = await fixture(t, "gitB"), key = "gitB~w"
  await reloadWorktrees(key)
  await createWorktree(key, "new")
  await deleteWorktree(key, "new", undefined, async () => {})
  const h = createRoot(dispose => ({ dispose, git: useGitChanges({
    instanceId: key, isActive: () => true, rightPanelTab: () => "git-changes", worktreeSlug: () => "root",
    isPhoneLayout: () => false, promptInputApi: () => null, closeGitList: () => {}, t: key => key,
    externalDiff: true, captureOperation: captureBackendOperation,
  }) }))
  t.after(h.dispose)
  await until(() => !h.git.gitStatusLoading() && !!h.git.gitListItems().length)
  const statuses = () => b.requests.filter(request => request.url.includes("/git-status")).length
  let count = statuses()
  h.git.stageGitFile(h.git.gitListItems().find(item => item.section === "unstaged")!)
  await until(() => statuses() > count && !h.git.gitStatusLoading())
  count = statuses()
  h.git.unstageGitFile(h.git.gitListItems().find(item => item.section === "staged")!)
  await until(() => statuses() > count && !h.git.gitStatusLoading())
  h.git.setGitCommitMessage("owned commit"); await h.git.submitGitCommit()
  for (const suffix of ["/git-stage", "/git-unstage", "/git-commit"]) {
    assert.ok(b.requests.some(request => request.url.endsWith(suffix) && request.method === "POST"), suffix)
  }
  assert.ok(b.requests.some(request => request.url === "/api/workspaces/w/worktrees/new" && request.method === "DELETE"))
  assert.ok(b.requests.every(request => request.url.startsWith("/api/workspaces/w/") || request.url.startsWith("/workspaces/w/instance/")))
  assert.equal(a.requests.length, 0)
})

test("the real family-move consumer dispatches through B rather than local or A", async t => {
  const a = await fixture(t, "moveA"), b = await fixture(t, "moveB"), key = "moveB~w"
  t.after(() => clearPendingWorktreeMoves(key))
  t.mock.method(backendOf("w").api, "moveSessionFamily", async () => assert.fail("family move reached the local backend"))
  const custom = toast.custom
  toast.custom = (() => "test") as typeof toast.custom
  t.after(() => { toast.custom = custom })
  await reloadWorktrees(key)
  const refreshes: string[] = []
  await setWorktreeSlugForParentSession(key, "s/1", "root", {
    refreshSessions: async id => { refreshes.push(id) },
  })
  assert.deepEqual(b.requests.filter(request => request.method === "POST"), [{
    url: "/api/workspaces/w/sessions/s%2F1/worktree", method: "POST", body: '{"worktreeSlug":"root"}',
  }])
  assert.deepEqual(refreshes, [key])
  assert.equal(a.requests.length, 0)
})

test("Electron and Tauri reject remote workspace targets before local IPC", async t => {
  let calls = 0
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else delete (globalThis as any).window })
  for (const host of ["electron", "tauri"]) {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      __CODENOMAD_RUNTIME_HOST__: host, __CODENOMAD_WINDOW_CONTEXT__: "local",
      electronAPI: { openWorkspaceTarget: async () => { calls++ } },
      __TAURI__: { core: { invoke: async () => { calls++ } } },
    } })
    assert.equal(canOpenWorkspacePaths("w"), true)
    assert.equal(canOpenWorkspacePaths("remote~w"), false)
    for (const target of ["default", "reveal", "terminal", "editor"] as const) {
      await assert.rejects(openWorkspacePath({ instanceId: "remote~w", worktreeSlug: "root", path: "/remote/path", target }), /unavailable/)
      assert.equal(calls, host === "electron" ? 0 : 1)
    }
    assert.equal(calls, host === "electron" ? 0 : 1)
    await openWorkspacePath({ instanceId: "w", worktreeSlug: "root", target: "default" })
  }
  assert.equal(calls, 2)
})
