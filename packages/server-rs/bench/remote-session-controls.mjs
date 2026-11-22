import assert from "node:assert/strict"
import http from "node:http"
import https from "node:https"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

export const remoteDirect = "https://direct.fixture.test"
export const holdProvider = "BENCH-REMOTE-INTERRUPT-HOLD"
const post = body => ({ method: "POST", ...(body === undefined ? {} : {
  body: JSON.stringify(body), headers: { "content-type": "application/json" },
}) })

async function pairedSurface({ call, secureOrigin, origin: local, data }) {
  const transport = secureOrigin ? https : http
  const origin = secureOrigin ?? remoteDirect
  const { host, hostname, port } = new URL(origin)
  const ca = secureOrigin ? await readFile(path.join(data, "tls", "ca-cert.pem")) : undefined
  const request = (route, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: "127.0.0.1", port: secureOrigin ? Number(port) : Number(new URL(local).port),
      path: route, ...(secureOrigin ? { servername: hostname, rejectUnauthorized: true } : {}),
      ca, method, headers: { host, ...headers }, agent: false, signal: AbortSignal.timeout(15_000),
    }, async res => {
      try {
        const chunks = []
        for await (const chunk of res) chunks.push(chunk)
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      } catch (error) { reject(error) }
    })
    req.on("error", reject)
    req.end(body)
  })
  const issue = await call("/api/remote-control/pairings", post({ origin }))
  assert.equal(issue.status, 200)
  const code = new URL((await issue.json()).url).hash.slice(1)
  const pair = post({ code })
  const paired = await request("/api/remote-control/pair", { ...pair, headers: { ...pair.headers, origin } })
  assert.equal(paired.status, 200)
  const [cookie, ...flags] = paired.headers["set-cookie"][0].split(";").map(value => value.trim())
  assert.match(cookie, /^__Host-codenomad_device=[\w-]{43}$/)
  for (const flag of ["secure", "httponly", "path=/", "samesite=lax"])
    assert(flags.some(value => value.toLowerCase() === flag), `device cookie requires ${flag}`)
  assert(!flags.some(value => /^domain=/i.test(value)), "device cookie is host-only")
  return { request, cookie, origin }
}

export async function run(ctx) {
  const { call, fixture: { client, requests }, folder, other } = ctx
  const { request, cookie, origin } = await pairedSurface(ctx)
  const opened = await call("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201)
  const workspace = await opened.json()
  const location = { directory: workspace.location.directory }
  const session = await client.session.create({ location, title: "Remote session controls",
    permissions: [{ action: "bench.permission", resource: "*", effect: "ask" }] })
  const prefix = `/workspaces/${workspace.id}/instance/api/session/${session.id}`
  const device = (route, init = {}, headers = { origin }) =>
    request(`${prefix}/${route}`, { ...init, headers: { ...init.headers, cookie, ...headers } })
  try {
    const result = {}
    const permission = await client.permission.create({ sessionID: session.id, id: "per_bench_remote", agent: "build",
      action: "bench.permission", resources: ["remote fixture"] })
    assert.equal(permission.effect, "ask")
    const form = await client.session.form.create({ sessionID: session.id, title: "Remote fixture", fields: [{ key: "value", type: "string" }] })
    for (const [route, id] of [["permission", "per_bench_remote"], ["form", form.id]]) {
      const local = await call(`${prefix}/${route}`)
      const remote = await device(route, {}, {})
      assert.equal(local.status, 200, `local ${route}`)
      assert.equal(remote.status, 200, `paired ${route}: ${remote.body}`)
      const body = JSON.parse(remote.body)
      assert.deepEqual(body, await local.json(), route)
      assert(body.data.some(row => row.id === id), `pending ${route} returned`)
      assert.equal((await request(`${prefix}/${route}`, { headers: { origin } })).status, 401)
      result[route] = true
    }
    const foreign = await client.session.create({ location: { directory: other }, title: "Foreign remote fixture" })
    const foreignPath = `/workspaces/${workspace.id}/instance/api/session/${foreign.id}`
    for (const route of ["permission", "form"])
      assert.equal((await request(`${foreignPath}/${route}`, { headers: { cookie } })).status, 403)
    await client.permission.reply({ sessionID: session.id, requestID: "per_bench_remote", decision: "once" })
    await client.session.form.cancel({ sessionID: session.id, formID: form.id })
    const interrupt = post()
    const route = "interrupt?resume=false"
    assert.equal((await request(`${foreignPath}/${route}`, { ...interrupt, headers: { ...interrupt.headers, cookie, origin } })).status, 403)
    const local = await call(`${prefix}/${route}`, interrupt)
    assert.equal(local.status, 200)
    const startHeld = async () => {
      const start = requests.length
      assert.equal((await call(`${prefix}/prompt`, post({ text: holdProvider }))).status, 200)
      const held = () => requests.slice(start).some(value => JSON.stringify(value.messages).includes(holdProvider))
      for (let i = 0; i < 100 && !held(); i++) await delay(50)
      assert(held(), "the synthetic provider is holding the active execution")
    }
    const stopHeld = async (stopRoute, init) => {
      const stopped = await device(stopRoute, init)
      assert.equal(stopped.status, 200, `paired interrupt: ${stopped.body}`)
      for (let i = 0; i < 100 && (await client.session.active())[session.id]; i++) await delay(50)
      assert.equal((await client.session.get({ sessionID: session.id })).outcome, "interrupted")
      return JSON.parse(stopped.body)
    }
    await startHeld()
    for (const [response, status] of [
      [() => request(`${prefix}/${route}`, { ...interrupt, headers: { ...interrupt.headers, origin } }), 401],
      // The TS proxy's loopback peer passes the source hook but never authenticates the device.
      [() => device(route, interrupt, {}), ctx.secureOrigin ? 403 : 401],
      [() => device(route, interrupt, { origin: "https://outside.invalid" }), 403],
    ]) {
      assert((await client.session.active())[session.id], "the native execution is active")
      assert.equal((await response()).status, status)
    }
    assert((await client.session.active())[session.id], "refusals left the execution active")
    const stopped = await stopHeld(route, interrupt)
    await startHeld()
    const stoppedFromRune = await stopHeld("interrupt", post({ resume: false }))
    const idle = await device(route, interrupt)
    assert.equal(idle.status, 200)
    assert.deepEqual(JSON.parse(idle.body), await local.json())
    return { ...result, interrupt: stopped, interruptFromRune: stoppedFromRune, outcome: "interrupted" }
  } finally {
    await call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })
  }
}
