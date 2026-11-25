import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, rmdir, writeFile } from "node:fs/promises"
import { createServer, request } from "node:http"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"

const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
const inventoryCounts = new WeakMap()
export const comparable = ({ cost, ...observations }) => observations

export async function nativeRelay(fixture) {
  const endpoint = new URL(fixture.connection.endpoint.url)
  assert.equal(endpoint.hostname, "127.0.0.1")
  const auth = `Basic ${Buffer.from(`opencode:${fixture.connection.endpoint.auth.password}`).toString("base64")}`
  const inventories = []
  inventoryCounts.set(fixture, inventories)
  const server = createServer((incoming, response) => {
    if (incoming.headers.authorization !== auth || !incoming.url.startsWith("/") || incoming.url.startsWith("//"))
      return response.writeHead(403).end()
    const url = new URL(incoming.url, endpoint)
    if (incoming.method === "GET" && url.pathname === "/api/worktree")
      inventories.push({ projectID: url.searchParams.get("projectID"), at: performance.now() })
    const { host, ...headers } = incoming.headers
    const upstream = request({ hostname: endpoint.hostname, port: endpoint.port, path: incoming.url, method: incoming.method, headers }, native => {
      response.writeHead(native.statusCode, native.headers)
      native.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    response.on("close", () => upstream.destroy())
    incoming.pipe(upstream)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => {
    server.close(resolve); server.closeAllConnections()
  }) }
}

export async function run({ call, fixture, folder, root, other }) {
  const open = async directory => {
    const response = await call("/api/workspaces", post({ path: directory }))
    assert.equal(response.status, 201, `${directory}: ${response.status}`)
    return response.json()
  }
  const project = await open(folder)
  const gitSettings = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key))),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "fixture.gitconfig") }
  const git = (directory, ...args) => execFileSync("git", ["-C", directory, ...args], { windowsHide: true, env: gitSettings })
  git(other, "init", "--quiet")
  const foreign = await open(other)
  let nested
  const { client } = fixture
  try {
    const linked = path.join(root, "receipt-linked")
    const blocked = path.join(root, "receipt-blocked-projection")
    const outside = path.join(fixture.root, "receipt-outside-workspace-root")
    git(project.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "receipt")
    git(project.path, "worktree", "add", "--quiet", "--detach", linked, "HEAD")
    const name = "receipt-subfolder"
    await mkdir(path.join(project.path, name))
    nested = await open(path.join(project.path, name))
    const directory = path.join(linked, name)
    await mkdir(directory)
    const { project: native } = await client.location.get({ location: project.location })
    await client.worktree.refresh({ projectID: native.id })
    const session = await client.session.create({ location: { directory },
      permissions: [{ action: "receipt_fixture", resource: "*", effect: "ask" }] })
    assert.equal(path.normalize(session.location.directory), path.normalize(directory))
    const requestID = "per_fixture_receipt_worktree", messageId = "msg_fixture_receipt_worktree"
    const source = { type: "tool", messageID: messageId, id: "call_fixture" }
    const creating = client.permission.create({ sessionID: session.id, id: requestID,
      action: "receipt_fixture", resources: ["fixture-path"], source })
    void creating.catch(() => {})
    for (const end = Date.now() + 15_000;; await delay(25)) {
      if ((await client.permission.list({ sessionID: session.id })).some(row => row.id === requestID)) break
      assert(Date.now() < end, "linked permission was not queued")
    }
    const reply = await call(`/workspaces/${nested.id}/instance/api/session/${session.id}/permission/${requestID}/reply`,
      post({ decision: "reject", message: "fixture reason" }))
    assert.equal(reply.status, 204, await reply.text())
    const read = (workspace, query) => call(`/api/workspaces/${workspace.id}/sessions/${session.id}/permission-receipts?${query}`)
    const owned = await read(project, `messageId=${messageId}`)
    assert.equal(owned.status, 200, `linked receipt: ${owned.status}`)
    assert.equal(owned.headers.get("cache-control"), "no-store")
    const { receipts } = await owned.json()
    assert.equal(receipts.length, 1)
    const { sessionId, resolvedAt, ...receipt } = receipts[0]
    assert.equal(sessionId, session.id)
    assert(Number.isFinite(resolvedAt) && resolvedAt > 0)
    assert.deepEqual(receipt, { requestId: requestID, source: { messageId, callId: source.id },
      action: "receipt_fixture", resources: ["fixture-path"], decision: "reject", origin: "codenomad", reason: "fixture reason" })
    const unanchored = await read(project, "unanchored=true")
    assert.equal(unanchored.status, 200)
    assert.deepEqual(await unanchored.json(), { receipts: [] })
    const refused = await read(foreign, `messageId=${messageId}`)
    assert.equal(refused.status, 403)
    git(project.path, "worktree", "add", "--quiet", "--detach", blocked, "HEAD")
    git(project.path, "worktree", "add", "--quiet", "--detach", outside, "HEAD")
    await writeFile(path.join(blocked, name), "ordinary file")
    await client.worktree.refresh({ projectID: native.id })
    await rmdir(directory)
    const missingProjectDirectory = await read(nested, `messageId=${messageId}`)
    assert.equal(missingProjectDirectory.status, 200)
    assert.deepEqual(await missingProjectDirectory.json(), { receipts })
    const listing = await call(`/api/workspaces/${nested.id}/worktrees`)
    assert.equal(listing.status, 200)
    const projected = (await listing.json()).worktrees.find(w => path.normalize(w.directory) === path.join(blocked, name))
    assert.equal(projected?.nestedFolderMissing, true)
    const outsideProject = path.join(outside, name)
    await mkdir(outsideProject)
    await client.session.move({ sessionID: session.id, directory: outsideProject })
    const external = await read(nested, `messageId=${messageId}`)
    assert.equal(external.status, 200, `${external.status}: ${await external.clone().text()}`)
    assert.deepEqual(await external.json(), { receipts })
    assert.equal((await read(foreign, `messageId=${messageId}`)).status, 403)
    // Model transcript rows mounting together. Bound inventory calls in a
    // cache lifetime; a sequential Windows run can span several lifetimes.
    const reads = 12, inventory = inventoryCounts.get(fixture)
    const started = performance.now()
    await Promise.all(Array.from({ length: reads }, async () => {
      const response = await read(nested, `messageId=${messageId}`)
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { receipts })
    }))
    const calls = inventory.filter(call => call.projectID === native.id && call.at >= started)
    const cost = { reads, nativeInventoryReads: calls.length, withinTtl: calls.filter(call => call.at - started < 10_000).length,
      milliseconds: Math.round(performance.now() - started) }
    assert(cost.milliseconds < 10_000, `the warm burst must fit in one cache lifetime: ${JSON.stringify(cost)}`)
    assert(cost.withinTtl <= 1, `receipt reads must reuse the loaded inventory: ${JSON.stringify(cost)}`)
    const inside = path.join(project.path, "independent-nested-repository")
    await mkdir(inside)
    git(inside, "init", "--quiet")
    const contained = await client.session.create({ location: { directory: inside } })
    const ownEmpty = await call(`/api/workspaces/${project.id}/sessions/${contained.id}/permission-receipts?unanchored=true`)
    assert.equal(ownEmpty.status, 200)
    assert.deepEqual(await ownEmpty.json(), { receipts: [] })
    return { receipt, unanchored: 0, foreign: refused.status, missingProjectDirectory: missingProjectDirectory.status,
      blockedProjection: projected.nestedFolderMissing, external: external.status, contained: ownEmpty.status, cost }
  } finally {
    await Promise.all([project, foreign, nested].filter(Boolean).map(workspace => call(`/api/workspaces/${workspace.id}`, { method: "DELETE" })))
  }
}
