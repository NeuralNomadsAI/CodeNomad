import assert from "node:assert/strict"
import Fastify from "fastify"
import { OpenCode } from "@opencode/client"
import { MissionControl, MissionControlError } from "../../../../server/src/missions/control"
import { MissionJournal, type MissionStorage } from "../../../../server/src/missions/journal"
import type { MissionJsonValue, MissionMap } from "../../../../server/src/missions/model"
import { registerMissionRoutes } from "../../../../server/src/server/routes/missions"
import { admitMissionInput } from "../../../../server/src/server/routes/mission-input"
import { WorktreeDeletionFence } from "../../../../server/src/workspaces/worktree-session-evacuation"

// Private in-memory state and generated-client fetch only. Never connect this
// fixture to a native daemon, installed application, provider or user database.
export function cleanupBackend() {
  const values = new Map<string, MissionJsonValue>(), native = new Map<string, any>()
  const removed: string[] = [], wire: string[] = [], failing = new Set<string>(), children = new Set<string>()
  const state = { owned: true }
  const storage: MissionStorage = {
    get: async key => values.get(key), set: async (key, value) => { values.set(key, structuredClone(value)) },
    scan: async ({ prefix, after, limit = 100 }) => {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value }))
      return { entries, next: entries.length === limit ? entries.at(-1)?.key : undefined }
    },
  }
  const http = OpenCode.make({ baseUrl: "http://private-mock.invalid", fetch: async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url)
    wire.push(`${request.method} ${url.pathname}${url.search}`)
    if (url.pathname === "/api/session") return Response.json({ data: children.has(url.searchParams.get("parentID")!) ? [{ id: "ses_private_child" }] : [] })
    const id = decodeURIComponent(url.pathname.split("/").at(-1)!)
    if (!native.has(id)) return Response.json({ _tag: "SessionNotFoundError", sessionID: id }, { status: 404 })
    if (request.method === "DELETE") {
      if (failing.has(id)) return Response.json({ error: "Private simulated outage" }, { status: 503 })
      assert.ok(native.has(id)); native.delete(id); removed.push(id); return new Response(null, { status: 204 })
    }
    return Response.json({ data: structuredClone(native.get(id)) })
  } })
  let control: MissionControl
  const client = { ...http,
    location: { get: async () => ({ project: { id: "private-project" } }) },
    plugin: { list: async () => ({ data: [{ id: "codenomad.missions", state: { status: "active" } }] }) },
    rpc: () => ({ cleanupTarget: (input: any) => control.cleanupTarget(input), delete: async (input: any) => {
      try { return await control.delete(input) } catch (error) {
        if (error instanceof MissionControlError) throw { type: "mission.rejected", message: error.message, data: { code: error.code } }
        throw error
      }
    } }),
  }
  const manager = {
    list: () => [{ id: "fixture" }], get: () => ({ id: "fixture" }), getServiceLocation: () => ({ directory: "/private-fixture" }),
    getSharedServiceClient: async () => client, getSharedServiceConnection: async () => ({ client, assertCurrent() {} }),
    ownsLocation: async (_id: string, location: { directory: string }) => state.owned && location.directory === "/private-fixture",
    getWorktreeIdentityForPath: async () => "/private-fixture",
  }
  const fence = new WorktreeDeletionFence()
  control = new MissionControl({ project: { id: "private-project", canonical: "/private-fixture", location: { directory: "/private-fixture" } }, storage,
    createManagedRoot: async (_coordinator, input) => {
      // Creation admission itself has independent coverage. Seed only this
      // private fixture's already-persisted deterministic actor contract.
      const mission = (await control.snapshot()).missions.find(item => item.id === input.missionID)!
      const task = mission.tasks.find(item => item.key === input.taskKey)!
      const actor = mission.actors.find(item => item.sessionId === task.actorSessionId)!
      const session = { id: actor.sessionId, projectID: mission.projectID, title: actor.title, location: actor.location,
        metadata: { "codenomad.mission": { version: 1, missionID: mission.id, kind: "actor", role: task.role } } }
      native.set(session.id, session); return structuredClone(session)
    },
    sessions: { get: http.session.get, create: async input => {
      const session = { ...input, projectID: "private-project" }; native.set(input.id, session); return structuredClone(session)
    }, prompt: async () => {}, synthetic: async () => {} },
    transport: { prompt: async () => {}, synthetic: async () => {}, cleanup: (coordinator, input) => admitMissionInput(manager as never, fence, coordinator,
      { kind: "cleanup", input }, new AbortController().signal) },
  })
  const app = Fastify()
  registerMissionRoutes(app, { workspaceManager: manager as never })
  const journal = new MissionJournal(storage, "private-project", "/private-fixture")
  async function create(name: string, count = 1): Promise<MissionMap> {
    let mission = (await control.create({ requestID: name, objective: `Private cleanup ${name}`, template: "custom" })).mission
    for (let index = 0; index < count; index++) mission = (await control.delegate(mission.coordinatorSessionId, {
      missionID: mission.id, taskKey: `worker-${index}`, title: `Private worker ${index}`, brief: "Private fixture only", role: "specialist", blockedBy: [], delivery: "queue",
    })).mission
    return mission
  }
  return { app, journal, control, create, native, removed, failing, children, state, wire }
}
