import assert from "node:assert/strict"
import { test } from "node:test"
import { browserPermissionDecision, permissionOrigin, permissionResource } from "./browser-permission-policy"

test("four protected permissions stay denied and unknown kinds fail closed", () => {
  for (const permission of ["media", "camera", "microphone", "geolocation", "geolocation-approximate", "notifications"])
    assert.equal(browserPermissionDecision(permission), "deny")
  for (const permission of ["unknown", "future-permission", "openExternal"]) assert.equal(browserPermissionDecision(permission), "unknown")
  for (const permission of ["clipboard-read", "local-network-access", "local-network", "loopback-network", "fullscreen", "pointerLock", "midi", "local-fonts", "sensors", "screen-wake-lock", "storage-access", "window-management", "payment-handler"])
    assert.equal(browserPermissionDecision(permission), "consent")
  for (const permission of ["hid", "usb", "serial"]) assert.equal(browserPermissionDecision(permission), "chooser")
  assert.equal(browserPermissionDecision("clipboard-sanitized-write"), "browser")
})

test("file grants remain path/access scoped and storage access remains embedder scoped", () => {
  const file = { filePath: "/tmp/one", fileAccessType: "readable", isDirectory: false }
  assert.notEqual(permissionResource("fileSystem", file), permissionResource("fileSystem", { ...file, filePath: "/tmp/two" }))
  assert.notEqual(permissionResource("fileSystem", file), permissionResource("fileSystem", { ...file, fileAccessType: "writable" }))
  assert.equal(permissionResource("fileSystem", {}), undefined)
  assert.notEqual(permissionResource("storage-access", {}, "https://one.example"), permissionResource("storage-access", {}, "https://two.example"))
  assert.equal(permissionResource("storage-access", {}), undefined)
})

test("permission identity is the requesting HTTP origin, never its embedding page", () => {
  assert.equal(permissionOrigin("https://frame.example:8443/path"), "https://frame.example:8443")
  for (const raw of ["about:blank", "file:///private", "https://user:pass@example.com", "null", "blob:https://example.com/id"])
    assert.equal(permissionOrigin(raw), undefined)
})
