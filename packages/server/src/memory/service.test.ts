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
  return { store, service, change: (kind: string) => {
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
