import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer, request } from "node:http"
import { readFile } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"
import { promisify } from "node:util"
import { privateGit } from "./fixtures.mjs"

const relays = new WeakMap()
const json = (body, method = "POST") => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})

export async function nativeRelay(fixture) {
  const endpoint = new URL(fixture.connection.endpoint.url)
  assert.equal(endpoint.hostname, "127.0.0.1")
  const auth = `Basic ${Buffer.from(`opencode:${fixture.connection.endpoint.auth.password}`).toString("base64")}`
  const held = { path: null, release: null }
  const server = createServer((incoming, response) => {
    if (incoming.headers.authorization !== auth || !incoming.url.startsWith("/") || incoming.url.startsWith("//"))
      return response.writeHead(403).end()
    const forward = () => {
      if (response.destroyed) return
      const { host, ...headers } = incoming.headers
      const upstream = request({ hostname: endpoint.hostname, port: endpoint.port, path: incoming.url, method: incoming.method, headers }, native => {
        response.writeHead(native.statusCode, native.headers)
        native.pipe(response)
      })
      upstream.on("error", () => response.destroy())
      response.on("close", () => upstream.destroy())
      incoming.pipe(upstream)
    }
    if (incoming.method === "POST" && new URL(incoming.url, endpoint).pathname === held.path) {
      assert.equal(held.release, null, "the relay must not replay a mutation")
      let released = false
      held.release = () => {
        if (!released) { released = true; forward() }
      }
    } else forward()
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  relays.set(fixture, held)
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }) }
}

export async function run({ call, fixture, folder, other }) {
  await privateGit(other, "mutation-fence-b")
  const held = relays.get(fixture)
  const open = async directory => {
    const response = await call("/api/workspaces", json({ path: directory }))
    assert.equal(response.status, 201, await response.clone().text())
    return response.json()
  }
  const a = await open(folder), b = await open(other)
  let inFlight
  try {
    const [left, right] = await Promise.all([a, b].map(workspace =>
      fixture.client.session.create({ location: workspace.location, title: "Mutation fence fixture" })))
    held.path = `/api/session/${left.id}/interrupt`
    const stop = (workspace, session, signal) => call(
      `${workspace.proxyPath}/api/session/${session.id}/interrupt?resume=false`, { method: "POST", signal },
    )
    inFlight = stop(a, left, AbortSignal.timeout(30_000))
    void inFlight.catch(() => {})
    for (const end = Date.now() + 10_000; !held.release; await delay(25)) {
      assert(Date.now() < end, "the first native POST did not reach the hold")
    }
    const independent = AbortSignal.timeout(10_000)
    const stopB = await stop(b, right, independent)
    assert.equal(stopB.status, 200, await stopB.clone().text())
    await stopB.arrayBuffer()
    const content = "written while another project is held\n"
    const save = await call(`/api/workspaces/${b.id}/files/content?path=fixture.txt`,
      { ...json({ contents: content }, "PUT"), signal: independent })
    assert.equal(save.status, 204, await save.text())
    assert.equal(await readFile(path.join(other, "fixture.txt"), "utf8"), content)
    const staged = await call(`/api/workspaces/${b.id}/worktrees/root/git-stage`,
      { ...json({ paths: ["fixture.txt"] }), signal: independent })
    assert.equal(staged.status, 200, await staged.clone().text())
    assert.deepEqual(await staged.json(), { ok: true })
    const index = await promisify(execFile)("git", ["-C", other, "show", ":fixture.txt"],
      { windowsHide: true, env: fixture.env })
    assert.equal(index.stdout.replace(/\r\n/g, "\n"), content)
    held.release()
    const stopA = await inFlight
    assert.equal(stopA.status, 200, await stopA.clone().text())
    await stopA.arrayBuffer()
    return { otherProjectStop: 200, otherProjectSave: 204, otherProjectStage: 200, heldStop: 200 }
  } finally {
    if (inFlight) {
      held.release?.()
      await inFlight.catch(() => {})
    }
    await Promise.all([a, b].map(workspace => call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })))
  }
}
