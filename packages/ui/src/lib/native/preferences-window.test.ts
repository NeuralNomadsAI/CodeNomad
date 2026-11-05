import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeNativePreferencesRequest, readPreferencesRequestFromUrl } from "./preferences-window.ts"

describe("native Preferences requests", () => {
  it("accepts current section-only events and contextual requests", () => {
    assert.deepEqual(normalizeNativePreferencesRequest("speech"), { section: "speech" })
    assert.deepEqual(normalizeNativePreferencesRequest("usage"), { section: "usage" })
    assert.deepEqual(normalizeNativePreferencesRequest({
      section: "providers",
      instanceId: "workspace-1",
      location: { directory: "/repo", workspaceID: "worktree-1" },
    }), {
      section: "providers",
      instanceId: "workspace-1",
      location: { directory: "/repo", workspaceID: "worktree-1" },
    })
    assert.equal(normalizeNativePreferencesRequest("workspace"), null)
    // The Missions panel gear opens Mission preferences in Settings, including native Preferences.
    assert.deepEqual(normalizeNativePreferencesRequest({ section: "missions", instanceId: "workspace-1", location: { directory: "/repo" } }),
      { section: "missions", instanceId: "workspace-1", location: { directory: "/repo" } })
  })

  it("reads initial section and provider context from the native URL", () => {
    assert.deepEqual(readPreferencesRequestFromUrl(
      "http://localhost:3000/?preferences=providers&preferencesInstanceId=workspace-1&preferencesDirectory=%2Frepo&preferencesWorkspaceId=worktree-1",
    ), {
      section: "providers",
      instanceId: "workspace-1",
      location: { directory: "/repo", workspaceID: "worktree-1" },
    })
  })

  it("retains unknown server identity and opaque directories, rejecting explicit malformed identities and ambiguous URLs", () => {
    const request = { section: "providers", serverId: "unknown-A", instanceId: "same", workspacePath: "C:\\App/", location: { directory: "/App//" } }
    assert.deepEqual(normalizeNativePreferencesRequest(request), request)
    const base = "http://localhost/?preferences=providers&preferencesInstanceId=same&preferencesWorkspacePath=C%3A%5CApp%2F&preferencesDirectory=%2FApp%2F%2F"
    assert.deepEqual(readPreferencesRequestFromUrl(base + "&preferencesServerId=unknown-A"), request)
    for (const serverId of [null, undefined, "", "a/b", "a".repeat(129), 4]) {
      assert.equal(normalizeNativePreferencesRequest({ ...request, serverId }), null)
    }
    assert.equal(readPreferencesRequestFromUrl(base + "&preferencesServerId="), null)
    assert.equal(readPreferencesRequestFromUrl(base + "&preferencesServerId=A&preferencesServerId=B"), null)
    assert.equal(readPreferencesRequestFromUrl("http://localhost/?preferences=providers&preferencesWorkspaceId=orphan"), null)
    assert.equal(Object.prototype.hasOwnProperty.call(normalizeNativePreferencesRequest({ section: "general" })!, "serverId"), false)
  })

  it("rejects a malformed supplied opened folder instead of dropping its constraint", () => {
    const request = { section: "providers", serverId: "A", instanceId: "same" }
    const base = "http://localhost/?preferences=providers&preferencesServerId=A&preferencesInstanceId=same"
    for (const workspacePath of ["\0", "x".repeat(32769), "", 42, {}, []]) {
      assert.equal(normalizeNativePreferencesRequest({ ...request, workspacePath }), null)
      if (typeof workspacePath === "string") {
        assert.equal(readPreferencesRequestFromUrl(base + "&preferencesWorkspacePath=" + encodeURIComponent(workspacePath)), null)
      }
    }
    for (const workspacePath of ["/App//", "x".repeat(32768)]) {
      const expected = { ...request, workspacePath }
      assert.deepEqual(normalizeNativePreferencesRequest(JSON.parse(JSON.stringify(expected))), expected)
      assert.deepEqual(readPreferencesRequestFromUrl(base + "&preferencesWorkspacePath=" + encodeURIComponent(workspacePath)), expected)
    }
    assert.deepEqual(readPreferencesRequestFromUrl(base), request)
    const legacy = { section: "providers", instanceId: "same" }
    assert.deepEqual(normalizeNativePreferencesRequest(JSON.parse(JSON.stringify(legacy))), legacy)
    assert.deepEqual(normalizeNativePreferencesRequest({ ...legacy, workspacePath: null }), legacy)
  })
})
