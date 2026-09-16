import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeSessionListScope, prepareLocationImport, readRequestLocations } from "./proxy-locations"

test("request selectors preserve legacy authority and retain modern rejection", () => {
  const url = new URL("http://localhost/api/form?location[directory]=/repo&location[workspace]=one")
  assert.deepEqual(readRequestLocations(url, undefined, "/root", "legacy"), {
    directories: ["/repo"], locations: [{ directory: "/repo", workspaceID: "one" }], invalid: false,
  })
  assert.equal(readRequestLocations(url, undefined, "/root", "modern").invalid, true)
  url.searchParams.append("location[workspace]", "two")
  assert.equal(readRequestLocations(url, undefined, "/root", "legacy").invalid, true)
  for (const body of [{ location: { directory: "/repo", workspaceID: "one" } }, { directory: "/repo", workspaceID: "one" }]) {
    const result = readRequestLocations(new URL("http://localhost/api/session"), body, "/root", "legacy")
    assert.deepEqual(result.locations, [{ directory: "/repo", workspaceID: "one" }])
    assert.equal(readRequestLocations(new URL("http://localhost/api/session"), body, "/root", "modern").invalid, true)
  }
})

test("imports authorize each full historical identity without rewriting it", () => {
  const body = {
    location: { directory: "/root", workspaceID: "root" },
    info: { location: { directory: "/repo", workspaceID: "one" } },
    messages: [{ type: "location-switched", location: { directory: "/repo", workspaceID: "two" }, previous: { location: { directory: "/repo", workspaceID: "one" } } }],
  }
  const result = prepareLocationImport(body, "/default", "legacy")
  assert.equal(result.invalid, false)
  assert.deepEqual(result.locations.map(location => location.workspaceID), ["root", "one", "two", "one"])
  assert.deepEqual(result.body, body)
  assert.notEqual(result.body, body)
  assert.equal(prepareLocationImport(body, "/default", "modern").invalid, true)
})

test("cursor parsing preserves native scope while rejecting foreign-schema authority", () => {
  const value = { directory: "/repo", workspace: "one", anchor: { id: "s", time: 1, direction: "next" } }
  const cursor = Buffer.from(JSON.stringify(value)).toString("base64url")
  assert.deepEqual(decodeSessionListScope(cursor, "legacy"), { directory: "/repo", workspaceID: "one" })
  assert.equal(decodeSessionListScope(cursor, "modern"), null)
  const withFields = (fields: object) => Buffer.from(JSON.stringify({ ...value, ...fields })).toString("base64url")
  assert.equal(decodeSessionListScope(withFields({ project: "other" }), "legacy"), null)
  assert.equal(decodeSessionListScope(withFields({ workspaceID: "other" }), "legacy"), null)
  assert.equal(decodeSessionListScope(withFields({ directory: undefined }), "legacy"), null)
  assert.deepEqual(JSON.parse(Buffer.from(cursor, "base64url").toString()), value, "the native token is not rewritten")
})
