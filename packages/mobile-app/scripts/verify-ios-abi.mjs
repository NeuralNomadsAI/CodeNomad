import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const mobileRoot = dirname(dirname(fileURLToPath(import.meta.url)))
export const vendorRoot = join(mobileRoot, "src-tauri/vendor/tauri-2.12.1")
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n")

export function assertCommandABI(swift) {
  const command = swift.slice(swift.indexOf('@_cdecl("run_plugin_command")'))
  if (!/id: Int32,/.test(command) ||
      !/callback: @escaping @convention\(c\) \(Int32, Int32, UnsafePointer<CChar>\) -> Void/.test(command) ||
      !/callback\(id, success \? 1 : 0, payload \?\? "null"\)/.test(command)) {
    throw new Error("Rust i32/C-int command ABI mismatch")
  }
}

export function verifyIOSABI(root = mobileRoot) {
  const vendor = join(root, "src-tauri/vendor/tauri-2.12.1")
  const receipt = new Map(read(join(vendor, "codenomad-ios-abi.sha256")).trim().split("\n")
    .map((line) => line.split("  ").reverse()))
  const upstream = JSON.parse(read(join(vendor, "../tauri-2.12.1-upstream.json")))
  const local = JSON.parse(read(join(vendor, "../tauri-2.12.1-local.json")))
  if (upstream.version !== "2.12.1" || upstream.archiveSHA256 !==
      "ed99ee9694a2deb776d91cae48ac7411ddfc89ecae2f9b5041111d8c88f2ace9") {
    throw new Error("Upstream dependency provenance drift")
  }
  if (local.upstreamArchiveSHA256 !== upstream.archiveSHA256 ||
      hash(readFileSync(join(vendor, "../tauri-2.12.1-codenomad.patch"))) !== local.patchSHA256) {
    throw new Error("Local dependency patch provenance drift")
  }
  for (const [name, expected] of Object.entries(local.added)) {
    if (hash(readFileSync(join(vendor, name))) !== expected) {
      throw new Error(`Vendored Tauri guard input drift: ${name}`)
    }
  }
  for (const [name, entry] of Object.entries(upstream.files)) {
    const patch = local.modified[name]
    if (patch && patch.upstreamSHA256 !== entry.sha256) {
      throw new Error(`Patch base input drift: ${name}`)
    }
    const expected = patch?.patchedSHA256 ?? entry.sha256
    if (hash(readFileSync(join(vendor, name))) !== expected) {
      throw new Error(`Vendored Tauri input drift: ${name}`)
    }
    if (receipt.has(name) && receipt.get(name) !== expected) {
      throw new Error(`Native ABI hash receipt drift: ${name}`)
    }
  }
  const cargo = read(join(root, "src-tauri/Cargo.toml"))
  if (!/\[patch\.crates-io\]\s+tauri = \{ path = "vendor\/tauri-2\.12\.1" \}/.test(cargo) ||
      !/tauri = \{ version = "=2\.12\.1"/.test(cargo)) {
    throw new Error("Mobile Cargo patch/version wiring drift")
  }
  const lock = read(join(root, "src-tauri/Cargo.lock"))
  const tauri = lock.match(/\[\[package\]\]\nname = "tauri"\n([\s\S]*?)(?=\n\[\[package\]\])/)?.[1]
  if (!tauri?.startsWith('version = "2.12.1"\n') || /source =|checksum =/.test(tauri)) {
    throw new Error("Cargo.lock does not select the local Tauri patch")
  }
  if (!/name = "swift-rs"\nversion = "1\.0\.8"\nsource = [^\n]+\nchecksum = "e45c444e496845d3f2a351146bff59aae4975b2280238df1dfaa0c7d1846f38e"/.test(lock)) {
    throw new Error("Rust SwiftRs lock identity drift")
  }
  assertCommandABI(read(join(vendor, "mobile/ios-api/Sources/Tauri/Tauri.swift")))
  const swiftPackage = read(join(vendor, "mobile/ios-api/Package.swift"))
  if (!swiftPackage.includes('.revision("f64a4514de07f450ec5b6aa297624cd3479d9579")')) {
    throw new Error("SwiftRs commit pin drift")
  }
  const build = read(join(vendor, "build.rs"))
  if (build.indexOf("codenomad_ios_abi_guard::verify()") < 0 ||
      build.indexOf("codenomad_ios_abi_guard::verify()") > build.indexOf("link_apple_library(")) {
    throw new Error("Native integrity guard must precede Swift compilation/linking")
  }
  const rust = read(join(vendor, "src/ios.rs"))
  const caller = read(join(vendor, "src/plugin/mobile.rs"))
  if (!/run_plugin_command\(\s+id: i32,/.test(rust) ||
      !rust.includes('unsafe extern "C" fn(c_int, c_int, *const c_char)') ||
      !caller.includes("let id: i32 = PENDING_PLUGIN_CALLS_ID.fetch_add") ||
      !caller.includes("success == 1")) throw new Error("Rust production ABI drift")
  return { upstreamFiles: Object.keys(upstream.files).length, nativeGuardInputs: receipt.size }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(verifyIOSABI()))
}
