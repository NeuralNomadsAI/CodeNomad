import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { createHash } from "node:crypto"
import { canonicalScope } from "../../host-lifetime/protocol"
import { ProtectedAuthorityFiles, physical } from "./private-files"

test("Unicode Tauri/Electron protected descriptors retain exact original scope keys without storage or grants", () => {
  const profile = path.resolve("Émilie"), config = path.join(profile, "custom.yaml")
  const electron = canonicalScope("dev-v2", config, process.cwd(), process.cwd())
  const configIdentity = process.platform === "win32" ? config.replace(/[A-Z]/g, letter => letter.toLowerCase()) : config
  const tauri = { channel: "dev-v2", configIdentity,
    key: createHash("sha256").update(`dev-v2\0${configIdentity}`).digest("hex") }
  if (process.platform === "win32") assert.notEqual(tauri.key, electron.key)
  for (const scope of [tauri, electron]) {
    const descriptor = { scope, physicalProfile: physical(profile), executionHost: "local" }
    const files = new ProtectedAuthorityFiles(path.resolve("isolated-descriptor-storage"), descriptor)
    assert.deepEqual(files.descriptor, descriptor)
    assert.ok(files.directory.endsWith(scope.key))
    const original = structuredClone(files.descriptor)
    scope.key = "0".repeat(64)
    assert.deepEqual(files.descriptor, original, "the protected descriptor detaches and freezes its original scope")
    assert.throws(() => new ProtectedAuthorityFiles(path.resolve("isolated-descriptor-storage"), descriptor), /scope-mismatch/)
  }
  const configIdentityBad = path.join(profile, "custom.json")
  assert.throws(() => new ProtectedAuthorityFiles(path.resolve("isolated-descriptor-storage"), {
    scope: { channel: "dev-v2", configIdentity: configIdentityBad,
      key: createHash("sha256").update(`dev-v2\0${configIdentityBad}`).digest("hex") },
    physicalProfile: physical(profile), executionHost: "local",
  }), /scope-mismatch/)
})

