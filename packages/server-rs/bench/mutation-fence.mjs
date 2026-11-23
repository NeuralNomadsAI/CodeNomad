import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createServer, request } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import path from "node:path"
import { promisify } from "node:util"
import { privateGit } from "./fixtures.mjs"

const relays = new WeakMap()
export const environment = () => ({
  CNRS_MUTATION_FENCE_TRACE: "1", CNRS_FIXTURE_ROUTE_TRACE: "1",
})
const json = (body, method = "POST") => ({
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})

export async function nativeRelay(fixture) {
  const endpoint = new URL(fixture.connection.endpoint.url)
  assert.equal(endpoint.hostname, "127.0.0.1")
  const auth = `Basic ${Buffer.from(`opencode:${fixture.connection.endpoint.auth.password}`).toString("base64")}`
  const held = { path: null, release: null, mode: "forward", verb: "POST", moves: 0, removals: 0, prompts: 0, trace: [] }
  const trace = (action, url) => {
    if (held.trace.length < 250) held.trace.push([Date.now(), action, url])
  }
  const server = createServer((incoming, response) => {
    if (incoming.headers.authorization !== auth || !incoming.url.startsWith("/") || incoming.url.startsWith("//"))
      return response.writeHead(403).end()
    const forward = () => {
      if (response.destroyed) return
      const { host, ...headers } = incoming.headers
      const upstream = request({ hostname: endpoint.hostname, port: endpoint.port, path: incoming.url, method: incoming.method, headers }, native => {
        trace(`HTTP ${native.statusCode}`, incoming.url)
        native.on("end", () => trace("EOF", incoming.url))
        response.writeHead(native.statusCode, native.headers)
        native.pipe(response)
      })
      upstream.on("error", () => response.destroy())
      response.on("close", () => upstream.destroy())
      incoming.pipe(upstream)
    }
    const pathname = new URL(incoming.url, endpoint).pathname
    if (pathname !== "/api/event") trace(incoming.method, incoming.url)
    if (incoming.method === "POST" && /^\/api\/session\/[^/]+\/move$/.test(pathname)) held.moves++
    if (incoming.method === "POST" && /^\/api\/session\/[^/]+\/prompt$/.test(pathname)) held.prompts++
    if (incoming.method === "DELETE" && pathname === "/api/worktree") held.removals++
    if (incoming.method === held.verb && pathname === held.path) {
      assert.equal(held.release, null, "the relay must not replay a mutation")
      const mode = held.mode
      if (mode === "once") held.path = null
      trace("hold", incoming.url)
      let released = false
      if (mode === "body") {
        incoming.resume()
        held.closed = false
        response.on("close", () => { held.closed = true })
        response.writeHead(200, { "content-type": "application/json" })
        response.write('{"data":')
      }
      held.release = () => {
        if (released) return
        released = true
        trace("release", incoming.url)
        if (mode === "body") response.end('{"type":"user"}}')
        else forward()
      }
    } else forward()
  })
  const sockets = new Set()
  server.on("connection", socket => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  relays.set(fixture, held)
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {
    server.close(resolve)
    for (const socket of sockets) socket.destroy()
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
  const base = `/api/workspaces/${a.id}`
  const trees = `${base}/worktrees`
  const arm = (path, mode = "forward", verb = "POST") => Object.assign(held, { path, mode, verb, release: null })
  const reached = async () => {
    for (const end = Date.now() + 20_000; !held.release; await delay(25)) {
      assert(Date.now() < end, `native ${held.verb} did not reach the hold: ${held.path}`)
    }
  }
  const checked = async (response, status) => {
    assert.equal(response.status, status, `${response.url}: ${await response.clone().text()}`)
    return response
  }
  let inFlight
  let removal
  try {
    const [left, right] = await Promise.all([a, b].map(workspace =>
      fixture.client.session.create({ location: workspace.location, title: "Mutation fence fixture" })))
    arm(`/api/session/${left.id}/interrupt`)
    const stop = (workspace, session, signal) => call(
      `${workspace.proxyPath}/api/session/${session.id}/interrupt?resume=false`, { method: "POST", signal },
    )
    inFlight = stop(a, left, AbortSignal.timeout(30_000))
    void inFlight.catch(() => {})
    await reached()
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
    const git = (dir, ...args) => promisify(execFile)("git", ["-C", dir, ...args], { windowsHide: true, env: fixture.env })
    const index = await git(other, "show", ":fixture.txt")
    assert.equal(index.stdout.replace(/\r\n/g, "\n"), content)
    held.release()
    const stopA = await inFlight
    assert.equal(stopA.status, 200, await stopA.clone().text())
    await stopA.arrayBuffer()

    const create = slug => call(trees, { ...json({ slug, fromSlug: "root" }), signal: AbortSignal.timeout(45_000) })
    const target = await (await checked(await create("fence-target"), 201)).json()
    arm("/api/worktree")
    inFlight = create("fence-concurrent-create")
    void inFlight.catch(() => {})
    await reached()
    const move = `${base}/sessions/${left.id}/worktree`
    const moved = await checked(await call(move, {
      ...json({ worktreeSlug: target.slug }), signal: AbortSignal.timeout(20_000),
    }), 200)
    assert.deepEqual((await moved.json()).sessionIds, [left.id])
    const location = await fixture.client.session.get({ sessionID: left.id })
    assert.equal(location.location.directory, target.serviceDirectory)
    held.release()
    await (await checked(await inFlight, 201)).arrayBuffer()

    const probe = await fixture.client.session.create({ location: a.location, title: "Fence probe" })
    arm(`/api/session/${left.id}/prompt`, "body")
    const abort = new AbortController()
    inFlight = call(`${a.proxyPath}${held.path}`, {
      ...json({ text: "Synthetic held prompt" }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(45_000)]),
    })
    void inFlight.catch(() => {})
    await reached()
    const prompt = await inFlight
    assert.equal(prompt.status, 200)
    const body = prompt.body.getReader()
    assert.equal(Buffer.from((await body.read()).value).toString(), '{"data":')
    const disconnected = body.read()
    abort.abort()
    await assert.rejects(disconnected, { name: "AbortError" })
    const before = [held.moves, held.removals]
    removal = call(`${trees}/${target.slug}`, { method: "DELETE", signal: AbortSignal.timeout(45_000) })
    let removalSettled = false
    void removal.then(() => { removalSettled = true }, () => { removalSettled = true })
    for (const end = Date.now() + 20_000;; await delay(50)) {
      const response = await stop(a, probe, AbortSignal.timeout(10_000))
      if (response.status === 409) {
        assert.deepEqual(await response.json(), { error: "Worktree deletion is in progress" })
        break
      }
      await (await checked(response, 200)).arrayBuffer()
      assert(!removalSettled && Date.now() < end, "deletion did not block new checkout writes while draining the prompt")
    }
    await delay(1_000)
    assert(!removalSettled, "the admitted prompt must still hold deletion")
    assert.equal(held.closed, false, "the native response must remain open after breaking the client connection")
    assert.deepEqual([held.moves, held.removals], before, "deletion must not evacuate or remove before native EOF")
    assert((await stat(target.directory)).isDirectory())
    held.release()
    await checked(await removal, 204)
    await assert.rejects(stat(target.directory), { code: "ENOENT" })

    for (const backendDelete of [true, false]) {
      const outside = path.join(path.dirname(a.path), backendDelete ? "combined-fence-checkout" : "external-fence-checkout")
      await git(a.path, "worktree", "add", "--quiet", "--detach", outside)
      const inventory = await (await checked(await call(`${trees}?fresh=true`), 200)).json()
      const external = inventory.worktrees.find(tree => path.resolve(tree.directory) === outside)
      assert(external, "the external checkout must be registered before the prompt")
      const prospective = path.join(external.serviceDirectory, "not-created", "nested")
      const seen = held.prompts
      held.trace.length = 0
      const send = () => call(`${a.proxyPath}/api/session/${probe.id}/prompt?${new URLSearchParams({ directory: prospective })}`, {
        ...json({ text: "Prospective checkout", directory: prospective }), signal: AbortSignal.timeout(90_000),
      })
      if (backendDelete) {
        // Hold deletion after it acquires the fence. The inverse ordering
        // (prompt parked just before admission) is exercised in mutation_race.rs.
        arm("/api/worktree", "once", "DELETE")
        removal = call(`${trees}/${external.slug}`, { method: "DELETE", signal: AbortSignal.timeout(45_000) })
        void removal.catch(() => {})
        await reached()
        const refused = await checked(await send(), 409)
        assert.deepEqual(await refused.json(), { error: "Worktree deletion is in progress" })
        held.release()
        await (await checked(await removal, 204)).arrayBuffer()
        await assert.rejects(stat(outside), { code: "ENOENT" })
        const stale = await checked(await send(), 403)
        assert.deepEqual(await stale.json(), { error: "Location does not belong to workspace" })
        assert.equal(held.prompts, seen, "CodeNomad deletion must invalidate the prior ownership")
      } else {
        arm(`/api/session/${probe.id}`, "once", "GET")
        inFlight = send()
        void inFlight.catch(() => {})
        await reached()
        // Git removal has no CodeNomad deletion notification.
        await git(a.path, "worktree", "remove", outside)
        await assert.rejects(stat(outside), { code: "ENOENT" })
        held.release()
        // TS's hot inventory still admits a prospective path after external
        // removal. Native queues the text on the existing session, not there.
        const accepted = await checked(await inFlight, 200)
        const { data } = await accepted.json()
        assert.equal(data.sessionID, probe.id)
        assert.equal(data.type, "user")
        assert.deepEqual(data.payload, { text: "Prospective checkout" })
        assert.equal(held.prompts, seen + 1)
        assert.equal((await fixture.client.session.get({ sessionID: probe.id })).location.directory, a.location.directory)
        await assert.rejects(stat(outside), { code: "ENOENT" })
      }
    }

    return {
      otherProjectStop: 200, otherProjectSave: 204, otherProjectStage: 200, heldStop: 200,
      moveDuringCreation: 200, heldCreation: 201, newWriteDuringDeletion: 409, disconnectedAfterBody: true, deletion: 204,
      prospectiveCheckoutDuringDeletion: 409, deletedProspectiveCheckout: 403,
      externallyRemovedProspectiveCheckout: 200, nativeRecreatedCheckout: false,
    }
  } catch (error) {
    error.partial = { native: held.trace, promptPosts: held.prompts }
    throw error
  } finally {
    if (inFlight) {
      held.release?.()
      await inFlight.catch(() => {})
    }
    await removal?.catch(() => {})
    await Promise.all([a, b].map(workspace => call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })))
  }
}
