import assert from "node:assert/strict"
import { test } from "node:test"
import { patchBundleType } from "./patch-bundle-type.mjs"

const binary = (...parts) => Buffer.concat(parts.map((part) => Buffer.from(part)))

test("the first bundle type placeholder is rewritten in place", () => {
  const input = binary("MZ\0head", "__TAURI_BUNDLE_TYPE_VAR_UNK", "\0tail__TAURI_BUNDLE_TYPE_VAR_UNK")
  const patched = patchBundleType(input, "nsis")
  assert.equal(patched.length, input.length)
  assert.deepEqual(patched, binary("MZ\0head", "__TAURI_BUNDLE_TYPE_VAR_NSS", "\0tail__TAURI_BUNDLE_TYPE_VAR_UNK"))
  assert.equal(input.includes("__TAURI_BUNDLE_TYPE_VAR_NSS"), false, "the input buffer is left unchanged")
})

test("a binary without the placeholder or an unknown bundle type is refused", () => {
  const patched = patchBundleType(binary("x__TAURI_BUNDLE_TYPE_VAR_UNK"), "nsis")
  assert.throws(() => patchBundleType(patched, "nsis"), /placeholder not found/)
  assert.throws(() => patchBundleType(binary("__TAURI_BUNDLE_TYPE_VAR_UNK"), "deb"), /Unsupported bundle type/)
})
