import assert from "node:assert/strict"
import { test } from "node:test"
import { backendEvents } from "../lib/backend-events"
import { sdkManager } from "../lib/sdk-manager"
import { serverApi } from "../lib/api-client"
import { addInstance, removeInstance } from "./instances"
import { fetchSessions, searchSessions } from "./session-api"
import { loading, sessions, setSessions, beginSessionSearch, setSessionSearchResults, getSessionSearchResultIds,
  getSessionSearchQuery, isSessionSearchLoading } from "./session-state"
import type { Session } from "../types/session"

const source = { on: () => () => {}, onOpen: () => () => {}, onTransportStatus: () => () => {}, onDispose: () => () => {} }
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
function deferred() {
  let resolve!: (value: { data: never[]; cursor: object }) => void, reject!: (error: Error) => void
  const promise = new Promise<{ data: never[]; cursor: object }>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(condition: () => boolean) {
  for (let n = 0; n < 100 && !condition(); n++) await tick()
  assert.ok(condition(), "read dispatched")
}

for (const kind of ["list", "search"] as const) for (const outcome of ["success", "failure"] as const) {
  for (const replacement of [false, true]) test(`${kind} ${outcome}, replacement=${replacement}: settled A releases only its own read indicator`, async t => {
    const backend = `read_flags_${kind}_${outcome}_${replacement}`, id = `${backend}~ws`
    const requests: ReturnType<typeof deferred>[] = [], pending: Promise<unknown>[] = []
    const client = { session: { list: async () => { const gate = deferred(); requests.push(gate); return gate.promise }, active: async () => ({}) } }
    let detach = backendEvents.attach(backend, source)
    ;(Reflect.get(sdkManager, "clients") as Map<string, unknown>).set(`${id}:/workspaces/${id}/instance`, client)
    addInstance({ id, backendId: backend, folder: "/repo", port: 0, pid: 0, proxyPath: "", status: "ready", client: client as never })
    const retained = { id: "kept", instanceId: id, title: "Retained", parentId: null, location: { directory: "/repo" }, status: "idle" } as Session
    setSessions(previous => new Map(previous).set(id, new Map([[retained.id, retained]])))
    const baseline = beginSessionSearch(id, "previous")
    setSessionSearchResults(id, "previous", [retained.id], baseline)
    t.mock.method(serverApi, "fetchWorktrees", async () => ({ worktrees: [], isGitRepo: false }))
    const start = (query: string) => {
      const work = (kind === "list" ? fetchSessions(id) : searchSessions(id, query)).then(() => "success", () => "failure")
      pending.push(work)
      return work
    }
    const busy = () => kind === "list" ? loading().fetchingSessions.get(id) : isSessionSearchLoading(id)
    try {
      const first = start("owner A")
      await until(() => requests.length === 1)
      assert.equal(busy(), true)
      detach(); detach = backendEvents.attach(backend, source)
      const second = replacement ? start("owner B") : undefined
      if (replacement) await until(() => requests.length === 2)
      if (outcome === "success") requests[0].resolve({ data: [], cursor: {} })
      else requests[0].reject(new Error("A failed"))
      await first
      assert.equal(busy(), replacement, "A never leaves a completed indicator or clears B's active indicator")
      assert.equal(sessions().get(id)?.get(retained.id), retained, "revoked A publishes no session data")
      if (kind === "search") {
        assert.equal(getSessionSearchQuery(id), replacement ? "owner B" : "owner A")
        assert.deepEqual(getSessionSearchResultIds(id), [retained.id], "cleanup preserves query and last displayed IDs")
      }
      if (second) { requests[1].reject(new Error("B failed")); await second; assert.equal(busy(), false) }
      assert.equal(requests.length, replacement ? 2 : 1, "no obsolete replay or follow-up")
    } finally {
      for (const request of requests) request.reject(new Error("fixture cleanup"))
      await Promise.allSettled(pending)
      detach(); removeInstance(id, { authoritative: false }); sdkManager.destroyClientsForInstance(id)
    }
  })
}
