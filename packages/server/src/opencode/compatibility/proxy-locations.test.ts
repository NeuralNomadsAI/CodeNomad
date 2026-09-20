import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeSessionListScope, prepareLocationImport, readRequestLocations } from "./proxy-locations"

test("request selectors preserve directories and reject every obsolete workspace slot", () => {
  const url = new URL("http://localhost/api/form?location[directory]=/repo")
  assert.deepEqual(readRequestLocations(url, undefined, "/root"), {
    directories: ["/repo"], locations: [{ directory: "/repo" }], invalid: false,
  })
  for (const key of ["workspace", "location[workspace]", "workspaceID", "location[workspaceID]"]) {
    const obsolete = new URL(url)
    obsolete.searchParams.set(key, "one")
    assert.equal(readRequestLocations(obsolete, undefined, "/root").invalid, true, key)
  }
  url.searchParams.append("location[directory]", "/other")
  assert.equal(readRequestLocations(url, undefined, "/root").invalid, true)
  for (const workspaceID of ["one", null]) {
    for (const body of [{ location: { directory: "/repo", workspaceID } }, { directory: "/repo", workspaceID }]) {
      assert.equal(readRequestLocations(new URL("http://localhost/api/session"), body, "/root").invalid, true)
    }
  }
})

test("imports authorize every historical directory without rewriting it to the destination", () => {
  const body = {
    location: { directory: "/root" },
    info: { location: { directory: "/repo" } },
    messages: [{ type: "location-switched", location: { directory: "/repo/moved" }, previous: { location: { directory: "/repo/original" } } }],
  }
  const result = prepareLocationImport(body, "/default")
  assert.equal(result.invalid, false)
  assert.deepEqual(result.directories, ["/root", "/repo", "/repo/moved", "/repo/original"])
  assert.deepEqual(result.body, body)
  assert.notEqual(result.body, body)
  for (const select of [
    (copy: typeof body) => copy.location,
    (copy: typeof body) => copy.info.location,
    (copy: typeof body) => copy.messages[0].location,
    (copy: typeof body) => copy.messages[0].previous.location,
  ]) {
    const copy = structuredClone(body)
    Object.assign(select(copy), { workspaceID: "historical" })
    const before = structuredClone(copy)
    assert.equal(prepareLocationImport(copy, "/default").invalid, true)
    assert.deepEqual(copy, before, "rejected history must not be rewritten")
  }
})

test("cursor parsing preserves native scope while rejecting obsolete and foreign-schema authority", () => {
  const value = { directory: "/repo", anchor: { id: "s", time: 1, direction: "next" } }
  const cursor = Buffer.from(JSON.stringify(value)).toString("base64url")
  assert.deepEqual(decodeSessionListScope(cursor), { directory: "/repo" })
  const withFields = (fields: object) => Buffer.from(JSON.stringify({ ...value, ...fields })).toString("base64url")
  for (const fields of [{ workspace: "one" }, { workspaceID: "one" }, { workspace: null }, { project: "other" }, { directory: undefined }]) {
    assert.equal(decodeSessionListScope(withFields(fields)), null)
  }
  assert.deepEqual(decodeSessionListScope(withFields({ directory: undefined, project: "owned", subpath: "src" })), { project: "owned", subpath: "src" })
  assert.equal(decodeSessionListScope(withFields({ directory: undefined, project: "owned", subpath: "../foreign" })), null)
  assert.deepEqual(JSON.parse(Buffer.from(cursor, "base64url").toString()), value, "the native token is not rewritten")
})
