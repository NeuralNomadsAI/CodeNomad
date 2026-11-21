import assert from "node:assert/strict"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const marker = "FIXTURE_WAYFINDER_REPORT"
const key = "seam"
const invoke = (name, input, id) => ({ role: "assistant", tool_calls: [{
  index: 0, type: "function", id, function: { name, arguments: JSON.stringify(input) },
}] })
export const prepare = () => ({ permissions: [{ action: "question", resource: "*", effect: "allow" }] })
export const runtime = { service: true, respond({ messages, tools }) {
  if (!JSON.stringify(messages).includes(marker) || !tools?.some(t => t.function.name === "mission_report")) return
  const returned = id => messages.find(m => m.tool_call_id === id)?.content
  if (!returned("call_declare"))
    return invoke("mission_delegate", { taskKey: key, title: "Choose the seam", role: "decision", brief: "Record the human's choice" }, "call_declare")
  const assignment = JSON.parse(returned("call_declare"))
  assert.match(assignment.questionTag, /^\[decision seam [0-9a-f]{8}\]$/)
  if (!returned("call_ask"))
    return invoke("question", { questions: [{ question: `Which seam? ${assignment.questionTag}`, header: "Seam",
      options: [{ label: "Module", description: "Own the boundary" }, { label: "Adapter", description: "Add a layer" }] }] }, "call_ask")
  if (!returned("call_read"))
    return invoke("mission_inspect", { taskKey: key }, "call_read")
  if (!returned("call_report")) {
    assert.match(returned("call_read"), /coordinator-form-answer/)
    return invoke("mission_report", { taskKey: key, outcome: "completed", summary: "The human chose Module." }, "call_report")
  }
  if (!returned("call_final")) {
    assert.equal(JSON.parse(returned("call_report")).disposition, "reported")
    return invoke("mission_report", { final: true, outcome: "completed", summary: "Decision recorded and the Mission is complete." }, "call_final")
  }
} }

async function until(name, read) {
  for (const deadline = Date.now() + 45_000; Date.now() < deadline; await delay(100)) {
    const value = await read()
    if (value) return value
  }
  throw new Error(`Timed out: ${name}`)
}

export async function run({ call, fixture: {client}, root, folder }) {
  const post = async (route, payload, status, headers) => {
    const res = await call(route, { method: "POST", headers: { "content-type":"application/json", ...headers },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(90_000) })
    const text = await res.text()
    assert.equal(res.status, status, text)
    return text ? JSON.parse(text) : undefined
  }
  const ws = await post("/api/workspaces", { path: path.join(root, folder) }, 201)
  const location = { directory: ws.location.directory }
  const base = `/api/workspaces/${ws.id}/missions`
  try {
    await until("active Missions plugin", async () => (await client.plugin.list({ location })).data
      .some(p => p.id === "codenomad.missions" && p.state.status === "active"))
    const profiles = { coordinator: { agent: "build", model: { providerID: "fixture", id: "fixture" } } }
    const { mission } = await post(base, { requestId: "wayfinder-create", objective: "Choose the seam", template: "wayfinder",
      profiles, taskMode: "native" }, 200)
    const sid = mission.coordinatorSessionId
    await post(`${base}/${mission.id}/control`, { requestId: "wayfinder-play", action: "start", expectedRevision: mission.revision }, 200)
    await client.session.wait({ sessionID: sid }, { signal: AbortSignal.timeout(30_000) })
    await client.session.prompt({ sessionID: sid, text: marker })
    const form = await until("Wayfinder Form", async () => (await client.form.list({ location })).data.find(f => f.sessionID === sid))
    await post(`/workspaces/${ws.id}/instance/api/session/${sid}/form/${form.id}/reply`, { answer: { q0: "Module" } }, 204,
      { "x-codenomad-human-answer": "1" })
    const done = await until("Wayfinder terminal report", async () => {
      const messages = (await client.message.list({ sessionID: sid, limit: { order: "desc", limit: 20 } })).data
      const parts = messages.flatMap(m => m.content ?? []).filter(p => p.type === "tool")
      for (const p of parts) if (p.state.status === "error") throw new Error(`${p.name}: ${JSON.stringify(p.state.error)}`)
      const terminal = parts.find(p => p.id === "call_final" && p.state.status === "completed")
      return terminal && JSON.parse(terminal.state.content.find(p => p.type === "text").text)
    })
    assert.equal(done.disposition, "finished")
    const response = await call(`${base}/${mission.id}/admission`, { signal: AbortSignal.timeout(30_000) })
    assert.equal(response.status, 200)
    const final = (await response.json()).mission
    const report = final.tasks.find(t => t.key === key).report
    assert.equal(final.status, "completed")
    assert.equal(report.artifact.answer, "Module")
    assert.equal(report.artifact.decidedBy, "human")
    assert.equal(report.artifact.provenance.formID, form.id)
    return { status:final.status, outcome:report.outcome, by:report.artifact.decidedBy,
      answer:report.artifact.answer, proof:report.artifact.provenance.kind, terminal:done.disposition }
  } finally {
    await call(`/api/workspaces/${ws.id}`, { method: "DELETE" })
  }
}
