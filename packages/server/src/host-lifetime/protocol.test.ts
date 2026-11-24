import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import path from "node:path"
import test from "node:test"
import { canonicalScope, validateScope, type Scope } from "./protocol"

const scopeFor = (configIdentity: string, channel = "dev-v2"): Scope => ({ channel, configIdentity,
  key: createHash("sha256").update(`${channel}\0${configIdentity}`).digest("hex") })

test("scope validation preserves exact original Unicode Tauri and Electron identities and hashes", () => {
  const file = path.resolve("Émilie", "custom.yaml")
  const electron = canonicalScope("dev-v2", file, process.cwd(), process.cwd())
  const tauri = scopeFor(process.platform === "win32" ? file.replace(/[A-Z]/g, letter => letter.toLowerCase()) : file)
  if (process.platform === "win32") assert.notEqual(electron.key, tauri.key)
  for (const scope of [electron, tauri]) {
    const original = structuredClone(scope)
    assert.doesNotThrow(() => validateScope(scope))
    assert.deepEqual(scope, original)
    assert.throws(() => validateScope({ ...scope, key: "0".repeat(64) }), /scope-mismatch/)
  }
})

test("even correctly hashed malformed/noncanonical scopes cannot validate", () => {
  const valid = canonicalScope("dev-v2", path.resolve("Émilie", "custom.yaml"), process.cwd(), process.cwd()).configIdentity
  const separator = path.sep, base = path.dirname(valid)
  const invalid = ["relative/config.yaml", "~/config.yaml", `${base}${separator}.${separator}custom.yaml`,
    `${base}${separator}other${separator}..${separator}custom.yaml`, `${base}${separator}${separator}custom.yaml`,
    `${valid}${separator}`, `${valid} `, `${base}${separator}custom.json`, `${valid}\0`, "x".repeat(4097)]
  if (process.platform === "win32") invalid.push(valid.replaceAll("\\", "/"), valid.replace("custom", "Custom"), "\\config.yaml")
  for (const identity of invalid) assert.throws(() => validateScope(scopeFor(identity)), /scope-mismatch/, identity)
  assert.throws(() => validateScope(scopeFor(valid, "DEV")), /scope-mismatch/)
})
