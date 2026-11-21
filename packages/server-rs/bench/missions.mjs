// One-time Missions through both HTTP backends, using their shared native plugin.
import assert from "node:assert/strict"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export async function run({ call, fixture: { client }, root, folder }) {
  const result = {}
  async function observe(key, method, url, payload, status, project = v => v) {
    const response = await call(url, { method, signal: AbortSignal.timeout(90_000), ...(payload === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
    }) })
    const text = await response.text()
    let value
    try { value = JSON.parse(text) }
    catch { throw new Error(`${key}: expected JSON, received HTTP ${response.status}`) }
    if (status !== undefined) assert.equal(response.status, status, `${key}: ${JSON.stringify(value)}`)
    result[key] = [response.status, project(value)]
    return value
  }
  const read = (key, url, status, project) => observe(key, "GET", url, undefined, status, project)
  const post = (key, url, value, status, project) => observe(key, "POST", url, value, status, project)
  const workspace = await post("workspace", "/api/workspaces", { path: path.join(root, folder) }, 201, () => true)
  const location = { directory: workspace.location?.directory ?? workspace.path }
  const base = `/api/workspaces/${workspace.id}/missions`
  const deadline = Date.now() + 30_000
  try {
    while (!(await client.plugin.list({ location })).data.some(p => p.id === "codenomad.missions" && p.state.status === "active")) {
      assert(Date.now() < deadline, "Missions plugin activation")
      await delay(100)
    }
    const state = ({ mission: m }) => ({ present: Boolean(m), status: m?.status, runState: m?.runState, revision: m?.revision })
    const refusal = v => ({ code: v.code, available: v.available, reason: v.reason, refused: v.refused, rejected: typeof v.error === "string" })
    const requestId = "missions-route-fixture"
    const objective = "Mission route fixture: verify native journal parity."
    const branches = `/api/workspaces/${workspace.id}/git-branches?directory=`
    const local = await read("branches", branches + encodeURIComponent(location.directory), 200)
    assert(local.branches.length > 0 && local.branches.every(ref => ref.startsWith("refs/heads/")))
    await read("branches-foreign", branches + encodeURIComponent(path.join(root, "Rich")), 403, refusal)
    await read("playbooks", "/api/missions/playbooks", 200, v => Object.keys(v).sort())
    await read("receipt-missing", `${base}/creation/${requestId}`, 200)
    await post("create-invalid", base, {}, 400)
    const created = await post("create", base, { requestId, template: "custom", taskMode: "native", objective }, 200, state)
    const { mission } = created
    const url = `${base}/${mission.id}`
    await read("creation-receipt", `${base}/creation/${requestId}`, 200, ({ state: receipt, mission: m }) =>
      ({ receipt, same: m?.id === mission.id && m.coordinatorSessionId === mission.coordinatorSessionId }))
    await read("list", `${base}?include=${mission.id}`, 200, v => ({ available: v.available, has: JSON.stringify(v).includes(mission.id) }))
    await read("read", url, 200, state)
    await read("admission", `${url}/admission`, 200, v => ({ ...state(v), objective: v.mission?.objective }))
    await read("content", `${url}/content?kind=mission&field=objective&offset=0`, 200, v => ({ ...refusal(v), text: v.content?.text }))
    await read("content-invalid", `${url}/content?kind=mission&field=objective&offset=1`, 400)
    await read("tasks", `${url}/tasks?offset=0`, 200, v => ({ ...refusal(v), count: v.tasks?.length, total: v.taskPage?.total }))
    await read("tasks-invalid", `${url}/tasks`, 400)
    await post("panel", `${base}/panel-page`, { source: "summaries" }, 200, v => ({ available: v.available, source: v.source, has: JSON.stringify(v).includes(mission.id) }))
    await post("panel-invalid", `${base}/panel-page`, { source: "bogus" }, 400)
    const update = { requestId: "mission-text", expectedRevision: mission.revision, objective: "Updated fixture objective", notes: "  retained  " }
    const updated = await observe("update", "PATCH", url, update, 200, state)
    assert.equal(updated.mission.objective, update.objective)
    assert.equal(updated.mission.notes, update.notes)
    await observe("update-replay", "PATCH", url, update, 200, state)
    await post("control-invalid", `${url}/control`, { requestId: "invalid", expectedRevision: updated.mission.revision, action: "start", graceful: true }, 400)
    await post("recover-invalid", `${url}/recover`, { expectedRevision: updated.mission.revision, target: "bogus" }, 400)
    await post("recover-stale", `${url}/recover`, { expectedRevision: mission.revision, target: "coordinator" }, undefined, refusal)
    const deletion = { requestId: "mission-delete", expectedRevision: updated.mission.revision, deleteManagedSessions: false }
    await observe("delete", "DELETE", url, deletion, 200, v => ({ deleted: v.deleted }))
    await observe("delete-replay", "DELETE", url, deletion, 200, v => ({ deleted: v.deleted }))
    await read("deleted-admission", `${url}/admission`, 200, state)
    assert.equal((await client.session.get({ sessionID: mission.coordinatorSessionId })).id, mission.coordinatorSessionId)
    return result
  } catch (error) {
    error.partial = result
    throw error
  } finally {
    await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })
  }
}
