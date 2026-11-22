// Workspace occurrence ownership; no provider request, session or tool invocation.
import assert from "node:assert/strict"

const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
export async function run({ call, fixture, folder }) {
  const owned = new Set(), statuses = []
  const request = async (route, init, expected) => {
    const response = await call(route, init), text = await response.text()
    statuses.push(response.status)
    if (route === "/api/workspaces" && init?.method === "POST" && response.status === 201) owned.add(JSON.parse(text).id)
    assert.equal(response.status, expected, `${init?.method ?? "GET"} ${route}: ${text}`)
    if (!text) return null
    return response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text
  }
  const cancel = id => request("/api/workspaces/creation/cancel", post({ requestId: id }), 204)
  const create = (id, status = 201) => request("/api/workspaces", post({ path: folder, requestId: id }), status)
  const inventory = () => request("/api/workspaces", undefined, 200)
  try {
    await cancel("\ufeff early-request \ufeff")
    await create("early-request", 400)
    await create("\ufeff early-request \ufeff", 400)
    assert.equal((await inventory()).length, 0)
    for (const id of [`${"🦀".repeat(64)}x`, "🦀".repeat(128), "x".repeat(128)]) {
      const workspace = await create(id)
      await request(`/api/workspaces/${workspace.id}/creation/release`, post({ requestId: id }), 204)
      await cancel(id)
      assert.deepEqual((await inventory()).map(w => w.id), [workspace.id])
      await request(`/api/workspaces/${workspace.id}`, { method: "DELETE" }, 204)
      await cancel(id); await create(id, 400)
    }
    const first = await create("retained-request"), second = await create("cancelled-request")
    assert.notEqual(first.id, second.id)
    for (const id of ["🦀".repeat(129), "x".repeat(129)]) {
      await create(id, 400)
      await request("/api/workspaces/creation/cancel", post({ requestId: id }), 400)
      await request(`/api/workspaces/${first.id}/creation/release`, post({ requestId: id }), 400)
    }
    assert.equal((await inventory()).length, 2)
    await request(`/api/workspaces/${first.id}/creation/release`, post({ requestId: "retained-request" }), 204)
    await cancel("retained-request")
    assert.equal((await inventory()).length, 2)
    await cancel("cancelled-request"); await cancel("cancelled-request")
    assert.deepEqual((await inventory()).map(w => w.id), [first.id])
    await request(`/api/workspaces/${first.id}`, { method: "DELETE" }, 204)
    assert.equal((await inventory()).length, 0)
    assert.equal(fixture.requests.length, 0, "No model request")
    return { statuses, earlyRejected: true, unicodeScalarBound: 128, mixed129CodeUnitsAccepted: true,
      distinctOccurrences: 2, releasedRetained: true, recordsRemaining: 0, modelRequests: 0 }
  } finally {
    await Promise.all([...owned].map(id => call(`/api/workspaces/${id}`, { method: "DELETE" }).catch(() => {})))
  }
}
