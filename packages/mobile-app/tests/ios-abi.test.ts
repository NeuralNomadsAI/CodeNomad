import assert from "node:assert/strict"
import { readFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { assertCommandABI, mobileRoot, vendorRoot, verifyIOSABI } from "../scripts/verify-ios-abi.mjs"

test("source-owned Cargo patch, native pre-link guard and actual Rust/Swift callers agree", () => {
  assert.deepEqual(verifyIOSABI(), { upstreamFiles: 142, nativeGuardInputs: 13 })
  const appBuild = readFileSync(join(mobileRoot, "src-tauri/build.rs"), "utf8")
  assert.match(appBuild, /DEP_TAURI_IOS_LIBRARY_PATH/)
  assert.match(appBuild, /assert_eq!\(actual, expected, "unpatched Tauri iOS dependency selected"\)/)
  const recovery = readFileSync(join(mobileRoot, "src-tauri/recovery/src/lib.rs"), "utf8")
  assert.match(recovery, /run_mobile_plugin/)
})

test("regression rejects the original Tauri Int/Bool export, not a parallel contract model", () => {
  const patched = readFileSync(join(vendorRoot, "mobile/ios-api/Sources/Tauri/Tauri.swift"), "utf8")
  const original = patched.replace("id: Int32,", "id: Int,")
    .replace("(Int32, Int32, UnsafePointer<CChar>)", "(Int, Bool, UnsafePointer<CChar>)")
    .replace('callback(id, success ? 1 : 0, payload ?? "null")', 'callback(id, success, payload ?? "null")')
  assert.throws(() => assertCommandABI(original), /ABI mismatch/)
  for (const broken of [patched.replace("id: Int32,", "id: Int,"),
    patched.replace("(Int32, Int32,", "(Int32, Bool,"),
    patched.replace("success ? 1 : 0", "success")]) {
    assert.throws(() => assertCommandABI(broken), /ABI mismatch/)
  }
})

test("integrated verification fails closed on Swift source and Cargo route drift", () => {
  const parent = join(mobileRoot, "test-results/ios-abi")
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, "negative-"))
  try {
    cpSync(join(mobileRoot, "src-tauri/vendor"), join(root, "src-tauri/vendor"), { recursive: true })
    for (const file of ["Cargo.toml", "Cargo.lock"]) {
      cpSync(join(mobileRoot, "src-tauri", file), join(root, "src-tauri", file))
    }
    verifyIOSABI(root)
    const swift = join(root, "src-tauri/vendor/tauri-2.12.1/mobile/ios-api/Sources/Tauri/Tauri.swift")
    const source = readFileSync(swift, "utf8")
    writeFileSync(swift, source.replace("id: Int32,", "id: Int,"))
    assert.throws(() => verifyIOSABI(root), /input drift/)
    writeFileSync(swift, source)
    const cargo = join(root, "src-tauri/Cargo.toml")
    writeFileSync(cargo, readFileSync(cargo, "utf8").replace('path = "vendor/tauri-2.12.1"', 'path = "wrong"'))
    assert.throws(() => verifyIOSABI(root), /wiring drift/)
  } finally {
    rmSync(root, { recursive: true })
  }
})
