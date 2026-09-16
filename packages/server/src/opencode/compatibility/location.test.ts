import assert from "node:assert/strict"
import { test } from "node:test"
import { OpenCode } from "@opencode/client"
import { createRuntimeFetch } from "./transport"
import { rememberRuntime } from "./runtime"
import {
  LOCATION_CONTEXT_HEADER, applyLocationContext, locationRequestOptions,
  moveSessionToLocation, readLocationContext, readLocationRef, sameLocation,
} from "./location"

test("identity context survives real modern generated move serialization", async () => {
  const original = { directory: "/work/100% 工作", workspaceID: "workspace-1" }
  let calls = 0
  const client = OpenCode.make({ baseUrl: "http://localhost:1234", fetch: async (input, init) => {
    calls++
    const request = new Request(input, init)
    const before = await request.json()
    assert.deepEqual(before, { directory: original.directory })
    const headers = new Headers(request.headers)
    const after = applyLocationContext(new URL(request.url), request.method, before, headers, "legacy")
    assert.deepEqual(after, original)
    assert.equal(headers.has(LOCATION_CONTEXT_HEADER), false)
    return new Response(null, { status: 204 })
  } })
  await moveSessionToLocation(client, "s", original)
  assert.equal(calls, 1)
})

test("context parser refuses malformed, duplicate, unknown and modern identity selectors", () => {
  const encoded = locationRequestOptions({ directory: "/repo", workspaceID: "w" })!.headers[LOCATION_CONTEXT_HEADER]
  assert.deepEqual(readLocationContext(encoded, "legacy"), { directory: "/repo", workspaceID: "w" })
  for (const profile of ["modern", "unknown"] as const) assert.throws(() => readLocationContext(encoded, profile), /Unsupported/)
  assert.throws(() => readLocationContext([encoded, encoded], "legacy"))
  assert.throws(() => readLocationContext("%", "legacy"))
  assert.throws(() => readLocationContext(encodeURIComponent('{"directory":"/repo","workspace":"w"}'), "legacy"))
  assert.throws(() => readLocationRef({ directory: "/repo", workspaceID: null }))
  assert.equal(sameLocation({ directory: "/repo", workspaceID: "one" }, { directory: "/repo", workspaceID: "two" }), false)
})

test("global Forms and catalog requests preserve explicit identity without forwarding private headers", () => {
  const ref = { directory: "/工作/100% ready", workspaceID: "worktree" }
  const options = locationRequestOptions(ref)!
  const headers = new Headers({ ...options.headers, "x-opencode-directory": encodeURIComponent(ref.directory) })
  applyLocationContext(new URL("http://localhost/api/session/global/form/f/reply"), "POST", { answer: {} }, headers, "legacy")
  assert.equal(headers.get("x-opencode-workspace"), "worktree")
  assert.equal(headers.has(LOCATION_CONTEXT_HEADER), false)
  const url = new URL("http://localhost/api/form")
  url.searchParams.set("location[directory]", ref.directory)
  applyLocationContext(url, "GET", undefined, new Headers(options.headers), "legacy")
  assert.equal(url.searchParams.get("location[workspace]"), "worktree")
  const foreign = new URL("http://localhost/api/form?location[directory]=/other")
  assert.throws(() => applyLocationContext(foreign, "GET", undefined, new Headers(options.headers), "legacy"), /does not match/)
  assert.throws(() => applyLocationContext(url, "GET", undefined, new Headers(options.headers), "modern"), /Unsupported/)
})

test("real generated list, RPC, eviction and credential calls use their distinct legacy wire locations", async () => {
  const endpoint = { url: "http://localhost:1234" }
  rememberRuntime(endpoint, { version: "2.0.3", pid: 1, discovery: "health" })
  const location = { directory: "/repo", workspaceID: "wrk_one" }
  const calls: URL[] = []
  const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async (input, init) => {
    const request = new Request(input, init)
    assert.equal(request.headers.has(LOCATION_CONTEXT_HEADER), false)
    const url = new URL(request.url)
    calls.push(url)
    if (url.pathname === "/api/session") {
      assert.equal(url.searchParams.get("directory"), "/repo")
      assert.equal(url.searchParams.get("workspace"), "wrk_one")
      assert.equal(url.searchParams.has("location[directory]"), false)
      return Response.json({ data: [], cursor: {} })
    }
    assert.equal(url.searchParams.get("location[directory]"), "/repo")
    assert.equal(url.searchParams.get("location[workspace]"), "wrk_one")
    return url.pathname.startsWith("/api/rpc/") ? Response.json({ output: true }) : new Response(null, { status: 204 })
  }) })
  const options = locationRequestOptions(location)
  await client.session.list({ directory: location.directory }, options)
  await client.rpc.call({ rpcID: "fixture", method: "check", input: {}, location: { directory: location.directory } }, options)
  await client.debug.location.evict({ location: { directory: location.directory } }, options)
  await client.credential.remove({ credentialID: "credential" }, options)
  assert.equal(calls.length, 4)
  await assert.rejects(client.session.list({ cursor: "native-cursor" }, options))
  assert.equal(calls.length, 4, "conflicting cursor context never dispatches")
})

test("directory-only credential context is native-scoped on legacy and global on modern", async () => {
  for (const version of ["2.0.3", "2.0.4"]) {
    const endpoint = { url: "http://localhost:1234" }
    rememberRuntime(endpoint, { version, pid: 1, discovery: version === "2.0.3" ? "health" : "status" })
    const client = OpenCode.make({ baseUrl: endpoint.url, fetch: createRuntimeFetch(endpoint, async (input, init) => {
      const request = new Request(input, init)
      assert.equal(request.headers.has(LOCATION_CONTEXT_HEADER), false)
      assert.equal(new URL(request.url).search, version === "2.0.3" ? "?location%5Bdirectory%5D=%2Frepo" : "")
      return new Response(null, { status: 204 })
    }) })
    await client.credential.remove({ credentialID: "credential" }, locationRequestOptions({ directory: "/repo" }, { includeDirectory: true }))
  }
})
