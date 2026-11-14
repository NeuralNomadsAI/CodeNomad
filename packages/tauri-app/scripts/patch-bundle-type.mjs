import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

// The Tauri runtime reports its installation type from this placeholder, which
// the bundler rewrites in place. Windows signing patches it before Authenticode
// signing and bundles with --no-binary-patching, so the signature stays valid.
const PLACEHOLDER = Buffer.from("__TAURI_BUNDLE_TYPE_VAR_UNK")
const bundleTypes = { nsis: Buffer.from("__TAURI_BUNDLE_TYPE_VAR_NSS") }

// Same rewrite as tauri-bundler's patch_binary: the first placeholder only.
export function patchBundleType(bytes, bundle) {
  const marker = bundleTypes[bundle]
  if (!marker) throw new Error(`Unsupported bundle type: ${bundle}`)
  const index = bytes.indexOf(PLACEHOLDER)
  if (index < 0) throw new Error("Bundle type placeholder not found; the binary is already patched or not a Tauri app")
  const patched = Buffer.from(bytes)
  marker.copy(patched, index)
  return patched
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [binary, bundle] = process.argv.slice(2)
  if (!binary || !bundle) throw new Error("Usage: patch-bundle-type.mjs <binary> nsis")
  writeFileSync(binary, patchBundleType(readFileSync(binary), bundle))
  console.log(`${binary}: bundle type set to ${bundle}`)
}
