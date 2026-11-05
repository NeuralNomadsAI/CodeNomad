import assert from "node:assert/strict"
import { test } from "node:test"
import { projectAvailability, type ProjectFeature } from "./project-capability"
import type { Instance } from "../types/instance"
import { initialServerCapabilities } from "../../../server/src/opencode/servers/capabilities"

const features: ProjectFeature[] = ["worktrees", "terminal", "missions", "sessionPruning", "design", "integratedImages", "automation", "executionSettings", "serviceManagement", "conversationDiffs", "hostGit", "fileWrite", "pluginWrite"]
// prototype-1236: read-only panels an explicit server serves natively.
const nativePanels: ProjectFeature[] = ["files", "git", "backgroundShells", "yolo", "providerUsage", "plugins"]
const source = (serverId: string): Instance => ({ id: serverId, binding: { serverId, directory: "/same/" }, folder: "/same/", client: null, pid: 0, port: 0, proxyPath: "", status: "ready",
  capabilities: initialServerCapabilities({ id: serverId, kind: "explicit", origin: "http://127.0.0.1:4000", label: "Same" } as any, 1 as any) })

test("explicit delivery policy denies every host reader even with available native metadata", () => {
  for (const id of ["A", "B"]) {
    const instance = source(id)
    for (const status of Object.values(instance.capabilities!.features)) status.state = "available"
    for (const feature of features) assert.equal(projectAvailability(instance, feature, true).allowed, false, `${id}:${feature}`)
    assert.equal(projectAvailability(instance, "chat", true).allowed, true)
    assert.equal(projectAvailability(instance, "chat", false).allowed, false)
  }
})
test("explicit native panels follow their published availability and current metadata, like chat", () => {
  const instance = source("A")
  for (const feature of nativePanels) assert.equal(projectAvailability(instance, feature, true).allowed, false, `initial ${feature}`)
  const published = instance.capabilities!.features as Record<string, unknown>
  for (const feature of nativePanels) published[feature] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
  for (const feature of nativePanels) {
    assert.equal(projectAvailability(instance, feature, true).allowed, true, feature)
    assert.equal(projectAvailability(instance, feature, false).allowed, false, `stale ${feature}`)
  }
})
test("unresolved, mismatched, revoked and absent source fail closed while known legacy local remains functional", () => {
  assert.equal(projectAvailability(undefined, "files", true).allowed, false)
  assert.equal(projectAvailability({ ...source("local-shared"), folder: "", binding: undefined, capabilities: undefined }, "files").allowed, false)
  const invalid = source("A")
  invalid.capabilities!.generation = NaN as any
  assert.equal(projectAvailability(invalid, "files", true).allowed, false)
  invalid.binding = { serverId: "A", directory: "" }
  assert.equal(projectAvailability(invalid, "files", true).allowed, false)
  assert.equal(projectAvailability({ ...source("A"), binding: { serverId: "A", directory: 42 } as any }, "files", true).allowed, false)
  const instance = source("A")
  assert.equal(projectAvailability(instance, "files", false).allowed, false)
  instance.capabilities!.serverId = "B"
  assert.equal(projectAvailability(instance, "files", true).allowed, false)
  instance.capabilities!.serverId = "A"
  instance.capabilities!.features.files.reason = { code: "unexpected-technical-error" } as any
  assert.equal(projectAvailability(instance, "files", true).allowed, false)
  const retargeted = { ...instance, renderBinding: { serverId: "B", directory: "/same/", folder: "/same/" } }
  assert.equal(projectAvailability(retargeted, "files", true).allowed, false)
  assert.equal(projectAvailability({ ...source("A"), renderBinding: { serverId: "A", directory: "/same/", folder: "/other/" } }, "files", true).allowed, false)
  delete instance.binding
  assert.equal(projectAvailability(instance, "files", true).allowed, false)
  const local = { ...source("local-shared"), binding: undefined, capabilities: undefined }
  for (const feature of [...features, ...nativePanels]) assert.equal(projectAvailability(local, feature).allowed, true, feature)
})
