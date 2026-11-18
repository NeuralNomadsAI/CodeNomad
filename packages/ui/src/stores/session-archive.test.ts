import assert from "node:assert/strict"
import { after, test } from "node:test"
import { serverApi } from "../lib/api-client"
import { sdkManager } from "../lib/sdk-manager"
import { createClientSession } from "../types/session"
import { addInstance, removeInstance, updateInstance } from "./instances"
import { setSessionArchived } from "./session-archive"
import { handleNativeSessionEvent } from "./session-events"
import { activeSessionId, sessions, setActiveSession, setSessions } from "./session-state"
import { ensureWorktreesLoaded } from "./worktrees"

const originalWorktrees = serverApi.fetchWorktrees
serverApi.fetchWorktrees = async () => ({ isGitRepo: false, worktrees: [] })
after(() => { serverApi.fetchWorktrees = originalWorktrees })

async function fixture(t: any, archived = false) {
  const id = `archive-${crypto.randomUUID()}`
  let info: any = { id: "session", title: "Session", location: { directory: "/work" }, projectID: "fixture", agent: "build",
    model: { providerID: "fixture", id: "fixture" }, time: { created: 1, updated: 1, ...(archived ? { archived: 1 } : {}) } }
  const updates: unknown[] = [], lists: unknown[] = []
  const client: any = { session: {
    update: async (input: any) => { updates.push(input); info = { ...info, time: { created: 1, updated: 2, ...(input.archived ? { archived: 2 } : {}) } } },
    get: async () => structuredClone(info),
    list: async (input: any) => { lists.push(input); return { data: [structuredClone(info)], cursor: {} } },
    active: async () => ({}),
    prompt: async () => { throw new Error("Archiving must never prompt") },
  } }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  addInstance({ id, folder: "/work", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
  setSessions(previous => new Map(previous).set(id, new Map([[info.id, createClientSession(info, id)]])))
  setActiveSession(id, info.id)
  await ensureWorktreesLoaded(id)
  t.after(() => {
    setSessions(previous => { const next = new Map(previous); next.delete(id); return next })
    removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id)
  })
  return { id, client, updates, lists, current: () => sessions().get(id)?.get("session"), info: () => structuredClone(info) }
}

test("native archive and restore are confirmed through ordinary authoritative reads without changing selection", async t => {
  const f = await fixture(t)
  await setSessionArchived(f.id, "session", true)
  assert.deepEqual(f.updates, [{ sessionID: "session", archived: true }])
  assert.equal(f.current()?.time.archived, 2)
  await setSessionArchived(f.id, "session", false)
  assert.equal(f.current()?.time.archived, undefined)
  assert.equal(activeSessionId().get(f.id), "session")
  assert(f.lists.length > 0)
})

test("refused or silently unsupported archive writes never synthesize an archive flag", async t => {
  for (const refused of [true, false]) {
    const f = await fixture(t)
    f.client.session.update = async () => { if (refused) throw new Error("Refused") }
    await assert.rejects(setSessionArchived(f.id, "session", true), refused ? /Refused/ : /not confirmed/)
    assert.equal(f.current()?.time.archived, undefined)
    if (refused) assert.equal(f.lists.length, 0)
  }
})

test("a late archive acknowledgement cannot refresh a replacement connection", async t => {
  const f = await fixture(t)
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  f.client.session.update = async () => { entered(); await gate }
  const pending = setSessionArchived(f.id, "session", true)
  await ready
  updateInstance(f.id, { client: {} as any })
  release(); await pending
  assert.equal(f.lists.length, 0)
  assert.equal(f.current()?.time.archived, undefined)
})

test("native archive events fence metadata reads started before the event", async t => {
  const f = await fixture(t), stale = f.info()
  let entered!: () => void, release!: (value: unknown) => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  f.client.session.get = () => { entered(); return new Promise(resolve => { release = resolve }) }
  const event = (type: string, created: number) => ({ id: `evt_${crypto.randomUUID()}`, type, created,
    location: { directory: "/work" }, data: { sessionID: "session" }, durable: { aggregateID: "session", seq: created, version: 1 } })
  handleNativeSessionEvent(f.id, event("session.forked", 2) as any)
  await ready
  handleNativeSessionEvent(f.id, event("session.archived", 3) as any)
  release(stale)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(f.current()?.time.archived, 3)
  handleNativeSessionEvent(f.id, event("session.unarchived", 4) as any)
  assert.equal(f.current()?.time.archived, undefined)
})
