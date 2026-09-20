import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import { createRuntimeFetch } from "./transport"
import { rememberRuntime } from "./runtime"
import {
  LOCATION_CONTEXT_HEADER, applyLocationContext, locationRequestOptions,
  moveSessionToLocation, readLocationContext, readLocationRef, sameLocation,
} from "./location"

test("generated calls preserve obsolete identity for rejection before upstream dispatch", async () => {
  const endpoint = { url: "http://localhost:1234" }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 1, discovery: "info" })
  const location = { directory: "/work/100% 工作", workspaceID: "workspace-1" }
  let calls = 0
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async () => {
    calls++
    return new Response(null, { status: 204 })
  }) })
  const options = locationRequestOptions(location)
  await assert.rejects(moveSessionToLocation(client, "s", location))
  await assert.rejects(client.session.list({ directory: location.directory }, options))
  await assert.rejects(client.rpc.call({ rpcID: "fixture", method: "check", input: {}, location: { directory: location.directory } }, options))
  await assert.rejects(client.debug.location.evict({ location: { directory: location.directory } }, options))
  await assert.rejects(client.credential.remove({ credentialID: "credential" }, options))
  assert.equal(calls, 0)
})

test("context parser accepts explicit directories and refuses malformed or obsolete selectors", () => {
  const location = { directory: "/repo" }
  const encoded = locationRequestOptions(location, { includeDirectory: true })!.headers[LOCATION_CONTEXT_HEADER]
  assert.deepEqual(readLocationContext(encoded), location)
  assert.equal(locationRequestOptions(location), undefined)
  const obsolete = locationRequestOptions({ ...location, workspaceID: "w" })!.headers[LOCATION_CONTEXT_HEADER]
  assert.throws(() => readLocationContext(obsolete), /Unsupported/)
  assert.throws(() => readLocationContext([encoded, encoded]))
  assert.throws(() => readLocationContext("%"))
  assert.throws(() => readLocationContext(encodeURIComponent('{"directory":"/repo","workspace":"w"}')))
  assert.throws(() => readLocationRef({ directory: "/repo", workspaceID: null }))
  assert.equal(sameLocation({ directory: "/repo", workspaceID: "one" }, { directory: "/repo", workspaceID: "two" }), false)
})

test("global Forms and catalog contexts validate directory scope and strip private headers", () => {
  const ref = { directory: "/工作/100% ready" }
  const options = locationRequestOptions(ref, { includeDirectory: true })!
  const headers = new Headers({ ...options.headers, "x-opencode-directory": encodeURIComponent(ref.directory) })
  const answer = { answer: {} }
  assert.equal(applyLocationContext(new URL("http://localhost/api/session/global/form/f/reply"), "POST", answer, headers), answer)
  assert.equal(headers.has("x-opencode-workspace"), false)
  assert.equal(headers.has(LOCATION_CONTEXT_HEADER), false)
  const url = new URL("http://localhost/api/form")
  url.searchParams.set("location[directory]", ref.directory)
  applyLocationContext(url, "GET", undefined, new Headers(options.headers))
  assert.equal(url.searchParams.has("location[workspace]"), false)
  const foreign = new URL("http://localhost/api/form?location[directory]=/other")
  assert.throws(() => applyLocationContext(foreign, "GET", undefined, new Headers(options.headers)), /does not match/)
  const foreignForm = new Headers({ ...options.headers, "x-opencode-directory": "/other" })
  assert.throws(() => applyLocationContext(new URL("http://localhost/api/session/global/form/f"), "DELETE", undefined, foreignForm), /does not match/)
  url.searchParams.set("location[workspace]", "old")
  assert.throws(() => applyLocationContext(url, "GET", undefined, new Headers(options.headers)), /Unsupported/)
})

test("move, creation and import validate context without reconstructing legacy body fields", () => {
  const headers = () => new Headers(locationRequestOptions({ directory: "/repo" }, { includeDirectory: true })!.headers)
  for (const [pathname, body] of [
    ["/api/session/s/move", { directory: "/repo" }],
    ["/api/session", { location: { directory: "/repo" } }],
    ["/api/experimental/session/import", { location: { directory: "/repo" }, messages: [] }],
  ] as const) {
    assert.equal(applyLocationContext(new URL(`http://localhost${pathname}`), "POST", body, headers()), body)
    const obsolete = "location" in body ? { ...body, location: { directory: "/repo", workspaceID: "old" } } : { ...body, workspaceID: "old" }
    assert.throws(() => applyLocationContext(new URL(`http://localhost${pathname}`), "POST", obsolete, headers()), /Unsupported/)
  }
  const cursorUrl = new URL("http://localhost/api/session?cursor=native&directory=/repo")
  assert.throws(() => applyLocationContext(cursorUrl, "GET", undefined, headers()), /Cursor already carries/)
})

test("directory-only credential context remains global", async () => {
  const endpoint = { url: "http://localhost:1234" }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 1, discovery: "info" })
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.headers.has(LOCATION_CONTEXT_HEADER), false)
    assert.equal(new URL(request.url).search, "")
    return new Response(null, { status: 204 })
  }) })
  await client.credential.remove({ credentialID: "credential" }, locationRequestOptions({ directory: "/repo" }, { includeDirectory: true }))
})

test("generated worktree methods preserve project payloads without location serialization", async () => {
  const endpoint = { url: "http://localhost:4321", auth: { type: "basic" as const, username: "fixture", password: "fixture" } }
  rememberRuntime(endpoint, { version: "2.0.11", pid: 1, discovery: "info" })
  const requests: Array<{ method: string; url: URL; body: any }> = []
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.headers.has(LOCATION_CONTEXT_HEADER), false)
    requests.push({ method: request.method, url: new URL(request.url), body: request.body ? await request.json() : undefined })
    if (request.method === "GET") return Response.json([{ directory: "/repo", strategy: "git" }])
    if (request.method === "POST" && !request.url.endsWith("/refresh")) return Response.json({ directory: "/repo/.codenomad/worktrees/new" })
    return new Response(null, { status: 204 })
  }) })
  const options = locationRequestOptions({ directory: "/repo" }, { includeDirectory: true })
  await client.worktree.list({ projectID: "project" }, options)
  await client.worktree.create({ projectID: "project", from: "/source", branch: "revision", directory: "/repo/.codenomad/worktrees", name: "new" }, options)
  await client.worktree.remove({ projectID: "project", directory: "/repo/.codenomad/worktrees/new", force: false }, options)
  await client.worktree.refresh({ projectID: "project" }, options)
  for (const request of requests) {
    assert.equal(request.url.searchParams.has("location[directory]"), false)
    assert.equal(request.url.searchParams.has("location[workspace]"), false)
    if (request.method === "GET") assert.equal(request.url.searchParams.get("projectID"), "project")
    else assert.equal(request.body.projectID, "project")
  }
  assert.equal(requests[1].body.branch, "revision")
  assert.equal(requests[1].body.from, "/source")
  assert.equal(requests[2].body.directory, "/repo/.codenomad/worktrees/new")
  assert.equal(requests[2].body.force, false)
})
