import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"

const mobile = fileURLToPath(new URL("../..", import.meta.url))
const [library, output] = process.argv.slice(2)
assert(library && output, "Usage: node verify-embedded-assets.mjs <extracted-APK-library> <evidence-json>")
const binary = fs.readFileSync(library)
assert.equal(binary.readUInt16LE(18), 183, "ELF machine must be AArch64")
assert.equal(binary[4], 2, "ELF must be 64 bit")
const linked = fs.readFileSync(path.join(mobile, "src-tauri/target/aarch64-linux-android/debug/libcodenomad_mobile_lib.so"))
assert(binary.equals(linked), "Packaged library must equal actual current linked Rust output")
const build = path.join(mobile, "src-tauri/target/aarch64-linux-android/debug/build")
const blobs = fs.readdirSync(build).filter(name => name.startsWith("codenomad-mobile-")).flatMap(name => {
  const generated = path.join(build, name, "out/tauri-codegen-assets")
  if (!fs.existsSync(generated)) return []
  return fs.readdirSync(generated).map(file => {
    const packed = fs.readFileSync(path.join(generated, file))
    let decoded
    try { decoded = zlib.brotliDecompressSync(packed) } catch { decoded = packed }
    return { name: file, packed, decoded }
  })
})
const assets = path.join(mobile, "dist")
const verified = []
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name)
    if (item.isDirectory()) { walk(file); continue }
    const raw = fs.readFileSync(file)
    const relative = path.relative(assets, file).replaceAll("\\", "/")
    const references = [...raw.toString().matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
    const blob = blobs.find(candidate => binary.includes(candidate.packed) && (relative === "index.html"
      ? candidate.name.endsWith(".html") && references.every(reference => candidate.decoded.toString().includes(reference)) &&
        candidate.decoded.toString().includes('<div id="root"></div>')
      : candidate.decoded.equals(raw)))
    assert(blob, `Current launcher bytes missing from packaged native library: ${relative}`)
    verified.push({ asset: relative, sha256: crypto.createHash("sha256").update(raw).digest("hex"),
      embeddedBytes: blob.packed.length, offset: binary.indexOf(blob.packed) })
  }
}
walk(assets)
assert.equal(verified.length, 13, "Expected index, CSS, main JS and ten locale assets")
fs.writeFileSync(output, JSON.stringify(verified, null, 2) + "\n")
console.log("All 13 current launcher assets verified inside packaged AArch64 library; JS/CSS exact bytes, augmented HTML current references/root; library equals current Rust output.")
