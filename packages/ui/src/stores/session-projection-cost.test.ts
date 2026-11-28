import assert from "node:assert/strict"
import { test } from "node:test"
import { createMemo, createRoot } from "solid-js"
import { useInstanceSessionContext } from "../components/instance/shell/useInstanceSessionContext"
import { serverApi } from "../lib/api-client"
import { serverEvents } from "../lib/server-events"
import type { Session } from "../types/session"
import { addInstance, removeInstance } from "./instances"
import { getListedSessionMap, setActiveSessionFromList, setSessionPage, setSessions } from "./session-state"
import { ensureWorktreesLoaded } from "./worktrees"
import type { WorkspaceEventPayload } from "../../../server/src/api-types"

test("native usage bursts only republish the receiving tab's session projections", async () => {
  const ids = ["perf-main", "perf-other", "perf-temp"]
  const roots = Array.from({ length: 30 }, (_, i) => `root-${i}`)
  const children = Array.from({ length: 110 }, (_, i) => `child-${i}`)
  const client = { session: { active: async () => ({}) } }
  const originalWorktrees = serverApi.fetchWorktrees
  serverApi.fetchWorktrees = async id => ({ isGitRepo: id !== ids[2], worktrees: [{ slug: "root", directory: `/${id}` }] }) as never
  try {
    for (const id of ids) {
      const directory = `/${id}`
      addInstance({ id, folder: directory, port: 0, pid: 0, proxyPath: "", status: "ready", client } as never)
      await ensureWorktreesLoaded(id)
      setSessions(previous => new Map(previous).set(id, new Map([...roots, ...children].map((sessionId, index) => [sessionId, {
        id: sessionId, instanceId: id, title: sessionId, location: { directory },
        parentId: index < roots.length ? null : roots[0],
        status: index >= roots.length && index < roots.length + 23 ? "working" : "idle",
        time: { created: 1, updated: index + 1 },
      } as Session]))))
      setSessionPage(id, roots, false, true)
      setActiveSessionFromList(id, roots[0])
    }
    createRoot(dispose => {
      try {
        const views = ids.map(id => useInstanceSessionContext({ instanceId: () => id }))
        const published = ids.map((id, index) => {
          const counts = { listed: 0, threads: 0, family: 0 }
          const listed = createMemo(() => getListedSessionMap(id))
          createMemo(() => { listed(); counts.listed++ })
          createMemo(() => { views[index].sessionThreads(); counts.threads++ })
          createMemo(() => { views[index].activeSessions(); counts.family++ })
          return counts
        })
        const dispatch = (serverEvents as unknown as { dispatchBatch(events: WorkspaceEventPayload[]): void })
        for (let i = 0; i < 60; i++) {
          const sessionID = children[i % 23]
          dispatch.dispatchBatch([{ type: "instance.event", instanceId: ids[0], event: {
            id: `perf-event-${i}`, type: "session.usage.updated", created: i + 2, location: { directory: `/${ids[0]}` },
            data: { sessionID, cost: i + 1, tokens: { input: i + 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
          } } as WorkspaceEventPayload])
        }
        // N untouched rows in two sibling catalogues must cost no new projection per SSE batch.
        assert.equal(views[0].activeSessions().get(children[59 % 23])?.tokens?.input, 60)
        assert.deepEqual(published, [
          { listed: 61, threads: 61, family: 61 },
          { listed: 1, threads: 1, family: 1 },
          { listed: 1, threads: 1, family: 1 },
        ])
      } finally {
        dispose()
      }
    })
  } finally {
    serverApi.fetchWorktrees = originalWorktrees
    for (const id of ids) removeInstance(id, { authoritative: false })
    setSessions(previous => new Map([...previous].filter(([id]) => !ids.includes(id))))
  }
})
