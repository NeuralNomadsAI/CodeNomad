import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot } from "solid-js"
import { addInstance, instances, removeInstance, updateInstance } from "./instances"
import { createContentMediaPolicy } from "../lib/content-media-policy"
import { clearCacheForInstance } from "../lib/global-cache"
import type { Instance } from "../types/instance"

test("retained media keeps its occurrence binding across updates, cache eviction and remount", () => {
  const id = "media-binding-unit"
  const instance: Instance = { id, folder: "/same", binding: { serverId: "A", directory: "/same" },
    port: 0, pid: 0, proxyPath: "", status: "ready", client: null }
  const mount = () => createRoot(dispose => ({ dispose, policy: createContentMediaPolicy(() => id, () => "same") }))
  try {
    addInstance(instance)
    assert.equal(instances().get(id), instance, "initial occurrence identity stays intact")
    assert.equal(Object.keys(instance).includes("renderBinding"), false, "renderer origin stays out of serialized metadata")
    const origin = instance.renderBinding
    assert.deepEqual(origin, { serverId: "A", directory: "/same", folder: "/same" })
    const first = mount()
    assert.equal(first.policy().kind, "explicit")
    updateInstance(id, { binding: { serverId: "local-shared", directory: "/same" }, renderBinding: { serverId: "local-shared", directory: "/same", folder: "/same" } })
    assert.equal(instances().get(id)?.renderBinding, origin)
    assert.equal(first.policy().kind, "unknown")
    first.dispose()
    clearCacheForInstance(id)
    const remount = mount()
    assert.equal(remount.policy().kind, "unknown")
    remount.dispose()
    removeInstance(id, { authoritative: false })
    addInstance({ ...instance, binding: { serverId: "local-shared", directory: "/same" } })
    const local = mount()
    assert.equal(local.policy().kind, "local", "a genuinely new local occurrence keeps its legacy behavior")
    updateInstance(id, { folder: "/same/", binding: { serverId: "local-shared", directory: "/same/" } })
    assert.equal(local.policy().kind, "local", "local display aliases retain the existing normalization")
    local.dispose()
  } finally { removeInstance(id, { authoritative: false }) }
})
