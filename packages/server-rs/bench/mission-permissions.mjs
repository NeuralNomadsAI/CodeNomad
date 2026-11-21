// Ordered native permissions, exact creation and a lost transport acknowledgement.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createServer, request } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fromDist } from "./fixtures.mjs"

const rule = (action, resource, effect) => ({ action, resource, effect })
const lead = [rule("edit", "*", "ask"), rule("shell", "*", "ask")]
const deny = rule("edit", "fixture-denied", "deny")
const trailing = rule("read", "fixture-preserved", "deny")
const later = rule("shell", "fixture-new-deny", "deny")
const prefix = rule("edit", "fixture-local-deny", "deny")
const configured = [rule("*", "fixture-all", "allow"), deny, rule("read", "fixture-hidden", "deny")]
const expected = [...lead, rule("edit", "fixture-all", "ask"), rule("shell", "fixture-all", "ask"), deny]
const lost = "permissions-lost"
const changed = "permissions-changed"
const duplicate = "permissions-duplicate"

export async function prepare({ configDirectory }) {
  await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({
    permissions: configured,
  }))
}

// Only the fixture's authenticated native endpoint. Keep the Native client direct
// for independent assertions and the intervening edit on a positively created root.
export async function nativeRelay(fixture) {
  const endpoint = new URL(fixture.connection.endpoint.url)
  assert.equal(endpoint.hostname, "127.0.0.1")
  const auth = `Basic ${Buffer.from(`opencode:${fixture.connection.endpoint.auth.password}`).toString("base64")}`
  const server = createServer((req, res) => {
    if (req.headers.authorization !== auth || !req.url.startsWith("/") || req.url.startsWith("//")) {
      res.writeHead(403).end()
      return
    }
    const { host, ...headers } = req.headers
    const creating = req.url.startsWith("/api/rpc/codenomad.missions/create?")
    if (creating) headers["accept-encoding"] = "identity"
    const upstream = request({ hostname: endpoint.hostname, port: endpoint.port, method: req.method, path: req.url, headers }, async native => {
      if (original.length && native.statusCode === 200) {
        try {
          const id = JSON.parse(Buffer.concat(original).toString()).input.requestID
          if ([lost, changed, duplicate].includes(id)) {
            const parts = []
            for await (const part of native) parts.push(part)
            const bytes = Buffer.concat(parts)
            const sessionID = JSON.parse(bytes.toString()).output.mission.coordinatorSessionId
            const permissions = id === duplicate ? [...expected, trailing, ...expected] : [...expected, trailing]
            await fixture.client.session.update({ sessionID, permissions })
            if (id === lost) return res.destroy()
            return res.writeHead(native.statusCode, native.headers).end(bytes)
          }
        } catch (error) {
          console.error("Fixture could not alter its acknowledged root", error)
          return res.destroy()
        }
      }
      res.writeHead(native.statusCode, native.headers)
      native.pipe(res)
    })
    const original = []
    if (creating) req.on("data", part => original.push(part))
    upstream.on("error", () => res.destroy())
    res.on("close", () => upstream.destroy())
    req.pipe(upstream)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }) }
}

export async function run({ call, fixture, root, folder, data }) {
  const send = async (url, method = "GET", body, status = 200) => {
    const r = await call(url, { method, signal: AbortSignal.timeout(95_000), ...(body && {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) })
    const text = await r.text()
    assert.equal(r.status, status, text)
    return text ? JSON.parse(text) : undefined
  }
  const { client } = fixture
  const w = await send("/api/workspaces", "POST", { path: path.join(root, folder) }, 201)
  const location = { directory: w.location.directory }
  const workspace = `/api/workspaces/${w.id}`
  const missions = `${workspace}/missions`
  const mode = (id, next, status) => send(`${workspace}/sessions/${id}/permission-mode`, next ? "PUT" : "GET", next && { mode: next }, status)
  const launch = requestId => ({ requestId, objective: "Prepare a supervised fixture", template: "custom" })
  const lookup = sessionID => client.session.get({ sessionID })
  const prefs = value => send("/api/storage/config/ui", "PATCH", { settings: { newConversationPermissions: value } })
  const readState = async (session, own = true) => {
    const key = createHash("sha256").update(JSON.stringify([`host:${process.platform}`, session.id, session.time.created])).digest("hex")
    const { parse } = await import("yaml")
    const state = parse(await readFile(path.join(data ?? fixture.root, "state.yaml"), "utf8"))
    const saved = state.sessionPermissionBlocks[key]
    if (!own) return assert.equal(saved, undefined)
    assert.deepEqual(saved.active, expected)
    assert.equal(saved.target.id, session.id)
    assert.equal(saved.target.created, session.time.created)
    assert.equal(saved.target.directory, session.location.directory)
    const { SessionPermissionModes } = await fromDist("permissions/session-mode.js")
    const modes = new SessionPermissionModes({ getPrivateSessionPermissionState: () => state.sessionPermissionBlocks })
    assert.deepEqual(await modes.read({ sessionID: session.id, read: () => Promise.resolve(session), current() {} }), { mode: "supervised" })
  }
  try {
    const end = Date.now() + 30_000
    for (;;) {
      const plugins = await client.plugin.list({ location })
      if (plugins.data.some(p => p.id === "codenomad.missions" && p.state.status === "active")) break
      assert(Date.now() < end, "Missions plugin failed to activate in its fixture")
      await delay(50)
    }
    await prefs("supervised")
    const normal = await send(missions, "POST", launch("permissions-fresh"))
    const fresh = await lookup(normal.mission.coordinatorSessionId)
    assert.deepEqual(fresh.permissions, expected)
    await readState(fresh)
    assert.equal((await mode(fresh.id)).mode, "supervised")
    const child = await client.session.create({ parentID: fresh.id, location })
    assert.deepEqual(await mode(child.id), { mode: "supervised", rootSessionID: fresh.id })
    assert.deepEqual(child.permissions, expected)
    const before = await client.session.create({ permissions: [trailing], location })
    await mode(before.id, "supervised")
    assert.deepEqual((await lookup(before.id)).permissions, [trailing, ...expected])
    await mode(before.id, "autonomous")
    assert.deepEqual((await lookup(before.id)).permissions, [trailing])
    const ordinary = await send(`/workspaces/${w.id}/instance/api/session`, "POST", { title: "Supervised fixture", location })
    assert.deepEqual((await lookup(ordinary.data.id)).permissions, expected)
    const attached = await client.session.create({ location, permissions: [trailing] })
    const attachedMission = await send(missions, "POST", { ...launch("permissions-attached"), coordinatorSessionId: attached.id })
    assert.equal(attachedMission.mission.coordinatorSessionId, attached.id)
    assert.deepEqual((await lookup(attached.id)).permissions, [trailing])
    const recovered = []
    for (const requestId of [changed, lost]) {
      const refusal = await send(missions, "POST", launch(requestId), 409)
      assert.equal(refusal.code, "creation-uncertain")
      // Changing the preference cannot change the original receipt's frozen projection.
      await prefs("autonomous")
      const receipt = await send(`${missions}/creation/${requestId}`)
      assert.equal(receipt.state, "created")
      const session = await lookup(receipt.mission.coordinatorSessionId)
      assert.deepEqual(session.permissions, [...expected, trailing])
      await readState(session)
      await mode(session.id, "autonomous")
      assert.deepEqual((await lookup(session.id)).permissions, [trailing])
      const replay = await send(`${missions}/creation/${requestId}`)
      assert.equal(replay.mission.coordinatorSessionId, session.id)
      assert.equal((await mode(session.id)).mode, "autonomous")
      recovered.push(requestId)
      await prefs("supervised")
    }
    assert.equal((await send(missions, "POST", launch(duplicate), 409)).code, "creation-uncertain")
    const ambiguous = await send(`${missions}/creation/${duplicate}`)
    assert.equal(ambiguous.state, "created")
    const ambiguousRoot = await lookup(ambiguous.mission.coordinatorSessionId)
    assert.deepEqual(ambiguousRoot.permissions, [...expected, trailing, ...expected])
    await readState(ambiguousRoot, false)
    const starting = (await send(missions, "POST", launch("permissions-start"))).mission
    assert.equal(fixture.requests.length, 0, "Preparation must not start a provider turn")
    for (const sessionID of [fresh.id, starting.coordinatorSessionId]) {
      await client.session.update({ sessionID, permissions: [prefix, ...expected, trailing] })
    }
    await writeFile(path.join(fixture.env.OPENCODE_CONFIG_DIR, "opencode.json"), JSON.stringify({ permissions: [...configured, later] }))
    await client.location.reload({ location })
    assert((await client.config.get({ location })).some(entry => entry.info?.permissions?.some(rule => rule.resource === later.resource)))
    await send(`/workspaces/${w.id}/instance/api/session/${fresh.id}/prompt`, "POST", { text: "Fixture: check refreshed permissions" })
    const refreshed = (await lookup(fresh.id)).permissions
    assert.deepEqual(refreshed, [prefix, ...expected, later, prefix, trailing])
    const started = await send(`${missions}/${starting.id}/control`, "POST", {
      requestId: "permissions-start-play", action: "start", expectedRevision: starting.revision,
    })
    assert.equal(started.mission.runState, "running")
    assert.deepEqual((await lookup(starting.coordinatorSessionId)).permissions, refreshed)
    const decision = await client.permission.create({ sessionID: fresh.id, agent: "build", action: "shell", resources: [later.resource] })
    assert.equal(decision.effect, "deny")
    return { paused: normal.mission.runState, projected: expected, recovered, preparationTurns: 0, refreshed }
  } finally {
    await call(workspace, { method: "DELETE" })
  }
}
