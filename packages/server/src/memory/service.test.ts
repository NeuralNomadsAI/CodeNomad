import assert from "node:assert/strict"
import test from "node:test"
import { MemoryService } from "./service"

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
const entry = { id: "editor", title: "Editor", type: "fact", text: "PROJECT_A_PRIVATE_TEXT",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", sessionId: "ses_owned", flagged: false }

function fixture() {
  let directory = "/a", owned = true, enabled = true, identity = "a".repeat(64)
  const manager = {
    get: () => owned ? { id: "owner", path: directory } : undefined,
    list: () => owned ? [{ id: "owner", path: directory }] : [],
    getSharedServiceClient: async () => ({ session: { get: async () => ({ location: { directory } }) } }),
    getServiceDirectoryForPath: async (_id: string, value: string) => owned ? value : undefined,
    getServiceWslDistro: () => undefined,
  }
  const store = { list: async () => [entry], listForUI: async () => [entry], cleanupWritable: async () => true,
    mutate: async (_namespace: unknown, decide: (entries: unknown[]) => Promise<{ result: unknown }>) => (await decide([])).result }
  const settings = { getRawConfigOwner: () => ({ memoryEnabled: enabled }) }
  const service = new MemoryService(store as never, settings as never, manager as never, { publish() {} } as never,
    async () => ({ id: identity, source: "local" }))
  return { store, service, manager, change: (kind: string) => {
    if (kind === "move") { directory = "/b"; identity = "b".repeat(64) }
    if (kind === "remote") identity = "c".repeat(64)
    if (kind === "owner") owned = false
    if (kind === "disable") enabled = false
  } }
}

for (const action of ["read", "list"] as const) for (const change of ["move", "remote", "owner", "disable"]) {
  test(`agent ${action} fences ${change} while storage is suspended`, async () => {
    const f = fixture(), reached = deferred(), gate = deferred()
    f.store.listForUI = async () => { reached.resolve(); await gate.promise; return [entry] }
    const pending = f.service.executeAgent("ses_owned", { action, scope: "project", ...(action === "read" ? { query: "editor" } : {}) })
    await reached.promise; f.change(change); gate.resolve()
    await assert.rejects(pending, { code: change === "owner" ? "invalid" : change === "disable" ? "disabled" : "conflict" })
  })
}

test("global agent reads recheck ownership and enablement; human review remains readable while disabled", async () => {
  for (const change of ["owner", "disable"]) {
    const f = fixture(), reached = deferred(), gate = deferred()
    f.store.listForUI = async () => { reached.resolve(); await gate.promise; return [entry] }
    const pending = f.service.executeAgent("ses_owned", { action: "read", scope: "global", query: "editor" })
    await reached.promise; f.change(change); gate.resolve()
    await assert.rejects(pending, { code: change === "owner" ? "invalid" : "disabled" })
  }
  const f = fixture(); f.change("disable")
  assert.equal((await f.service.executeUI({ action: "read", scope: "global", query: "editor" }) as any).entry.text, entry.text)
})

for (const scope of ["global", "project"] as const) test(`${scope} cleanup receives the server-authorized WSL directory`, async () => {
  const f = fixture(), unc = "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo"
  f.manager.getServiceDirectoryForPath = async (_id, value) => value === unc || value === "/home/user/repo" ? "/home/user/repo" : undefined
  const result = await f.service.executeUI({ action: "list", scope }, { workspaceId: "owner", directory: unc })
  assert.equal("cleanupDirectory" in result && result.cleanupDirectory, "/home/user/repo")
  await assert.rejects(f.service.executeUI({ action: "list", scope }, { workspaceId: "owner", directory: "/foreign" }), { code: "invalid" })
})

for (const change of ["move", "owner"]) test(`global cleanup location fences ${change} during storage reads`, async () => {
  const f = fixture(), reached = deferred(), gate = deferred()
  f.store.listForUI = async () => { reached.resolve(); await gate.promise; return [entry] }
  const pending = f.service.executeUI({ action: "list", scope: "global" }, { workspaceId: "owner" })
  await reached.promise; f.change(change); gate.resolve()
  await assert.rejects(pending, { code: change === "owner" ? "invalid" : "conflict" })
})

test("human project lists fence namespace changes after their last writability await", async () => {
  const f = fixture(), reached = deferred(), gate = deferred()
  f.store.cleanupWritable = async () => { reached.resolve(); await gate.promise; return true }
  const pending = f.service.executeUI({ action: "list", scope: "project" }, { workspaceId: "owner" })
  await reached.promise; f.change("remote"); gate.resolve()
  await assert.rejects(pending, { code: "conflict" })
})

for (const phase of ["locked decision", "committed result"]) test(`mutations revalidate ${phase}`, async () => {
  const f = fixture(), reached = deferred(), gate = deferred()
  const mutate = f.store.mutate
  f.store.mutate = async (namespace, decide) => {
    if (phase === "locked decision") { reached.resolve(); await gate.promise }
    const result = await mutate(namespace, decide)
    if (phase === "committed result") { reached.resolve(); await gate.promise }
    return result
  }
  const pending = f.service.executeAgent("ses_owned", { action: "save", scope: "project", content: { title: "Editor", type: "fact", text: "Use Vim" } })
  await reached.promise; f.change("move"); gate.resolve()
  await assert.rejects(pending, { code: "conflict" })
})

test("session titles fence a remote change after both scope reads", async () => {
  const f = fixture(), reached = deferred(), gate = deferred()
  f.store.list = async () => { reached.resolve(); await gate.promise; return [entry] }
  const pending = f.service.sessionTitles("ses_owned")
  await reached.promise; f.change("remote"); gate.resolve()
  await assert.rejects(pending, { code: "conflict" })
})

for (const phase of ["before dispatch", "storage read", "writability", "locked decision", "committed result"]) {
  test(`remote memory principal revocation fences ${phase} independently`, async () => {
    const f = fixture(), reached = deferred(), gate = deferred(), caller = new AbortController()
    const displayed = (await f.service.executeUI({ action: "read", scope: "global", query: entry.id }) as any).entry
    let reads = 0, decisions = 0
    const list = f.store.listForUI
    f.store.listForUI = async () => {
      reads++
      if (phase === "storage read") { reached.resolve(); await gate.promise }
      return list()
    }
    f.store.cleanupWritable = async () => {
      if (phase === "writability") { reached.resolve(); await gate.promise }
      return true
    }
    f.store.mutate = async (_namespace, decide) => {
      if (phase === "locked decision") { reached.resolve(); await gate.promise }
      const result = await decide([entry])
      decisions++
      if (phase === "committed result") { reached.resolve(); await gate.promise }
      return result.result
    }
    reads = 0
    if (phase === "before dispatch") caller.abort()
    const mutation = phase === "locked decision" || phase === "committed result"
    const operation = mutation
      ? { action: "delete", scope: "global", id: entry.id, revision: displayed.revision }
      : { action: "list", scope: "global" }
    const pending = f.service.executeUI(operation, undefined, caller.signal)
    const rejected = assert.rejects(pending, { name: "AbortError" })
    if (phase !== "before dispatch") { await reached.promise; caller.abort(); gate.resolve() }
    await rejected
    if (phase === "before dispatch") assert.equal(reads, 0)
    if (phase === "locked decision") assert.equal(decisions, 0)
    assert.equal((await f.service.executeUI({ action: "read", scope: "global", query: entry.id }) as any).entry.text, entry.text)
  })
}
