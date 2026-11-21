// Pause and Stop a real, isolated OpenCode family while its provider is still streaming.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"

export const holdProvider = "FIXTURE_MISSION_FAMILY_HELD"

async function until(check, label) {
  const end = Date.now() + 30_000
  while (Date.now() < end) {
    if (await check()) return
    await delay(50)
  }
  throw Error(`Timed out: ${label}`)
}

export async function run({ call, fixture: { client, requests }, root, folder }) {
  const send = async (url, body, status = 200) => {
    const response = await call(url, body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
    })
    const value = await response.json()
    assert.equal(response.status, status, JSON.stringify(value))
    return value
  }
  const workspace = await send("/api/workspaces", { path: path.join(root, folder) }, 201)
  const location = { directory: workspace.location?.directory ?? workspace.path }
  const base = `/api/workspaces/${workspace.id}/missions`
  try {
    await until(async () => (await client.plugin.list({ location })).data
      .some(p => p.id === "codenomad.missions" && p.state.status === "active"), "Missions plugin activation")
    const observations = {}
    for (const action of ["stop", "pause"]) {
      let { mission } = await send(base, { requestId: `family-create-${action}`, template: "custom", taskMode: "native",
        objective: `${holdProvider}: keep the synthetic provider stream open.` })
      const url = `${base}/${mission.id}`
      const chain = [mission.coordinatorSessionId]
      const control = (kind, requestId, expectedRevision = mission.revision) => send(`${url}/control`, { action: kind, requestId, expectedRevision })
      const held = () => requests.filter(r => JSON.stringify(r.messages).includes(holdProvider)).length
      const initial = held()
      ;({ mission } = await control("start", `family-start-${action}`))
      await until(() => held() > initial, "coordinator provider call")
      for (let i = 0; i < 3; i++) {
        const child = await client.session.create({ parentID: chain.at(-1), location, title: `Family ${i + 1}` })
        assert.equal(child.parentID, chain.at(-1))
        chain.push(child.id)
        await client.session.prompt({ sessionID: child.id, text: holdProvider })
      }
      await until(async () => {
        const active = await client.session.active()
        return chain.every(id => active[id]) && held() >= initial + chain.length
      }, "all family members at the provider")
      const enqueue = async (sessionID, metadata) => {
        const id = `msg_${randomUUID().replaceAll("-", "").slice(0, 26)}`
        await client.session.synthetic({ sessionID, id, text: "Parked fixture input", delivery: "queue", resume: false, metadata })
        await until(async () => (await client.session.inbox.list({ sessionID })).some(x => x.id === id), "parked input")
        return id
      }
      const queued = []
      for (const id of chain) queued.push(await enqueue(id, { "codenomad.mission": { version: 1, kind: "report", missionID: mission.id } }))
      const foreign = await enqueue(chain[0], {})
      const revision = mission.revision, request = `family-${action}`
      ;({ mission } = await control(action, request))
      const ack = mission.control.receipts.find(r => r.sessionID === chain[0])?.nativeAcknowledgement
      assert.equal(ack?.disposition, "interrupt-observed")
      const active = await client.session.active()
      const queuedAfter = await Promise.all(chain.map(sessionID => client.session.inbox.list({ sessionID })))
      const replay = (await control(action, request, revision)).mission
      assert.equal(replay.revision, mission.revision)
      assert.deepEqual(replay.control.receipts, mission.control.receipts)
      observations[action] = { state: mission.runState, rootInterrupted: ack.interrupt.interrupted, ...ack.descendants,
        sessions: ack.descendants.sessions.map(id => chain.indexOf(id)), active: chain.map(id => Boolean(active[id])),
        retained: queued.map((id, i) => queuedAfter[i].some(item => item.id === id)),
        rootMissionCancelled: ack.cancellations.some(c => c.inboxID === queued[0]),
        foreignCancelled: ack.cancellations.some(c => c.inboxID === foreign) }
      if (action === "pause") await control("stop", "family-pause-cleanup")
    }
    return observations
  } finally {
    await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })
  }
}

export function comparable(value) {
  for (const [action, receipt] of Object.entries(value)) {
    assert.equal(receipt.state, action === "stop" ? "stopped" : "paused")
    assert.equal(receipt.complete, true, JSON.stringify({ action, receipt }))
    assert.equal(receipt.unconfirmed, 0)
    assert.deepEqual(receipt.sessions, [3, 2, 1])
    assert.equal(receipt.foreignCancelled, false)
    assert.equal(receipt.rootMissionCancelled, action === "stop")
    assert(receipt.active.every(x => !x))
    assert.deepEqual(receipt.retained.slice(1), Array(3).fill(action === "pause"))
  }
  return value
}
