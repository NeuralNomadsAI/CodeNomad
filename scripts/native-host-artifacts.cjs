const fs = require("node:fs")
const path = require("node:path")
const { createHash } = require("node:crypto")

const MAX_ARTIFACT = 32 * 1024 * 1024
function refuse(code) { throw new Error(`Native host resources: ${code}`) }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex") }

// Packaging integrity only. This is not native ownership, ACL or launch evidence.
function exactPath(file, directory = false) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) refuse("noncanonical-path")
  for (let current = file; ; current = path.dirname(current)) {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) refuse("linked-path")
    if (current === file ? (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) : !stat.isDirectory())
      refuse("unsafe-artifact-type")
    if (path.dirname(current) === current) break
  }
  const physical = fs.realpathSync.native(file)
  if ((process.platform === "win32" ? physical.toLowerCase() : physical) !== (process.platform === "win32" ? file.toLowerCase() : file))
    refuse("redirected-path")
}
function readArtifact(file, expected, maximum = MAX_ARTIFACT) {
  exactPath(file)
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const before = fs.fstatSync(fd), named = fs.lstatSync(file)
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum || before.ino !== named.ino || before.dev !== named.dev)
      refuse("unsafe-artifact-read")
    // A growing file must not make readFileSync allocate unbounded memory after
    // the initial stat. Read only the observed extent plus one growth sentinel.
    const bounded = Buffer.alloc(before.size + 1)
    let length = 0
    while (length < bounded.length) {
      const count = fs.readSync(fd, bounded, length, bounded.length - length, null)
      if (!count) break
      length += count
    }
    const after = fs.fstatSync(fd), bytes = bounded.subarray(0, length)
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || expected && sha256(bytes) !== expected) refuse("artifact-digest-mismatch")
    return bytes
  } finally { fs.closeSync(fd) }
}

function verifyPe(bytes, target, addon = false) {
  const u16 = offset => { if (offset < 0 || offset + 2 > bytes.length) refuse("invalid-pe"); return bytes.readUInt16LE(offset) }
  const u32 = offset => { if (offset < 0 || offset + 4 > bytes.length) refuse("invalid-pe"); return bytes.readUInt32LE(offset) }
  if (bytes.length < 64 || u16(0) !== 0x5a4d) refuse("invalid-pe")
  const pe = u32(0x3c)
  if (u32(pe) !== 0x4550 || u16(pe + 4) !== ({ "win32-x64": 0x8664, "win32-arm64": 0xaa64 })[target]) refuse("pe-target-mismatch")
  const sections = u16(pe + 6), optionalSize = u16(pe + 20), optional = pe + 24
  if (!sections || sections > 96 || optionalSize < 120 || optional + optionalSize > bytes.length || u16(optional) !== 0x20b)
    refuse("invalid-pe")
  if (optional + optionalSize + sections * 40 > bytes.length) refuse("invalid-pe")
  if (Boolean(u16(pe + 22) & 0x2000) !== addon) refuse("pe-kind-mismatch")
  for (const marker of ["fixtureAuthorizeNestedResponse", "native-fixture-outer-owner-changed", "native-fixture-outer-job-required"])
    if (bytes.includes(Buffer.from(marker))) refuse("fixture-artifact-forbidden")
  if (!addon) return
  const sectionTable = optional + optionalSize
  const resolve = (rva, size) => {
    for (let index = 0; index < sections; index++) {
      const section = sectionTable + index * 40
      const virtualAddress = u32(section + 12), rawSize = u32(section + 16), raw = u32(section + 20)
      if (rva >= virtualAddress && rva - virtualAddress + size <= rawSize && raw + rva - virtualAddress + size <= bytes.length)
        return raw + rva - virtualAddress
    }
    refuse("invalid-pe-export")
  }
  const exports = resolve(u32(optional + 112), 40), count = u32(exports + 24)
  if (!count || count > 4096) refuse("invalid-pe-export")
  const names = resolve(u32(exports + 32), count * 4)
  let napi = false
  for (let index = 0; index < count; index++) {
    const start = resolve(u32(names + index * 4), 1), end = bytes.indexOf(0, start)
    if (end < start || end - start > 256) refuse("invalid-pe-export")
    if (bytes.toString("ascii", start, end) === "napi_register_module_v1") napi = true
  }
  if (!napi) refuse("napi-export-missing")
}

module.exports = { exactPath, readArtifact, refuse, sha256, verifyPe }
