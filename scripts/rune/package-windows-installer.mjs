// Assemble, verify and zip the Windows installer payload (`payload.zip`) for `codenomad-rune-setup`.
import { spawnSync } from "node:child_process"
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib"

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url))
export const REQUIRED_EXECUTABLES = ["codenomad-rune.exe", "codenomad-rs.exe"]
export const REQUIRED_PLUGIN_FEATURES = ["automation", "memory", "missions", "session-pruning"]
const OPTIONAL_PLUGIN_FILES = new Map([["missions", new Set(["provider.mjs"])]])
const FORBIDDEN_CRT_IMPORT = /^(vcruntime140|msvcp140|ucrtbased|vccorlib140|concrt140|msvcr1[0-4]0)/i
const FORBIDDEN_EXTENSIONS = new Set([
  ".pdb", ".d", ".ilk", ".exp", ".lib", ".obj", ".o", ".rlib", ".rmeta",
  ".map", ".log", ".tmp", ".bak", ".ts", ".tsx", ".mts", ".cts",
])
const FORBIDDEN_NAMES = new Set([
  "thumbs.db", "desktop.ini", ".ds_store", "__macosx", "node_modules", ".git", ".cache",
])
const DOS_TIME_EPOCH = 0x0000 // 00:00:00
const DOS_DATE_EPOCH = 0x0021 // 1980-01-01
const ZIP_UTF8_FLAG = 0x0800

function isForbiddenEntryName(name) {
  const lower = name.toLowerCase()
  if (lower.startsWith(".") || FORBIDDEN_NAMES.has(lower) || lower.endsWith(".d.ts")) return true
  const ext = path.extname(lower)
  return ext !== "" && FORBIDDEN_EXTENSIONS.has(ext)
}

function readCString(buf, offset, limit = 260) {
  if (offset < 0 || offset >= buf.length) return null
  let end = offset
  const max = Math.min(buf.length, offset + limit)
  while (end < max && buf[end] !== 0) end++
  if (end === offset || end >= buf.length || buf[end] !== 0) return null
  return buf.subarray(offset, end).toString("ascii")
}

/**
 * Parses imported DLL names from a PE32 or PE32+ image (standard + delay-load import tables).
 */
export function inspectPeImports(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("Not a valid PE executable (missing MZ header)")
  }
  const peOffset = buf.readUInt32LE(0x3c)
  if (peOffset + 24 > buf.length || buf.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error("Not a valid PE executable (missing PE signature)")
  }
  const numberOfSections = buf.readUInt16LE(peOffset + 6)
  const sizeOfOptionalHeader = buf.readUInt16LE(peOffset + 20)
  const optOffset = peOffset + 24
  if (sizeOfOptionalHeader < 96 || optOffset + sizeOfOptionalHeader > buf.length) {
    throw new Error("Invalid PE optional header")
  }
  const magic = buf.readUInt16LE(optOffset)
  let numRvaOffset
  let dataDirOffset
  if (magic === 0x10b) {
    numRvaOffset = optOffset + 92
    dataDirOffset = optOffset + 96
  } else if (magic === 0x20b) {
    numRvaOffset = optOffset + 108
    dataDirOffset = optOffset + 112
  } else {
    throw new Error(`Unsupported PE optional header magic: 0x${magic.toString(16)}`)
  }
  if (numRvaOffset + 4 > optOffset + sizeOfOptionalHeader) {
    throw new Error("Truncated PE data directory count")
  }
  const numberOfRvaAndSizes = buf.readUInt32LE(numRvaOffset)
  const sectionsStart = optOffset + sizeOfOptionalHeader
  if (sectionsStart + numberOfSections * 40 > buf.length) {
    throw new Error("Truncated PE section table")
  }
  const sections = []
  for (let i = 0; i < numberOfSections; i++) {
    const s = sectionsStart + i * 40
    sections.push({
      virtualSize: buf.readUInt32LE(s + 8),
      virtualAddress: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    })
  }
  const rvaToOffset = (rva) => {
    for (const sec of sections) {
      const span = Math.max(sec.virtualSize, sec.rawSize)
      if (rva >= sec.virtualAddress && rva < sec.virtualAddress + span) {
        const delta = rva - sec.virtualAddress
        if (delta < sec.rawSize && sec.rawPtr + delta < buf.length) return sec.rawPtr + delta
      }
    }
    return -1
  }
  const imports = new Set()
  const readDir = (index) => {
    const pos = dataDirOffset + index * 8
    if (index >= numberOfRvaAndSizes || pos + 8 > optOffset + sizeOfOptionalHeader) return null
    const rva = buf.readUInt32LE(pos)
    const size = buf.readUInt32LE(pos + 4)
    return rva !== 0 && size !== 0 ? { rva, size } : null
  }
  const importDir = readDir(1)
  if (importDir) {
    const base = rvaToOffset(importDir.rva)
    if (base < 0) throw new Error("PE import directory RVA is unmapped")
    for (let i = 0; i < 4096; i++) {
      const desc = base + i * 20
      if (desc + 20 > buf.length) break
      const origThunk = buf.readUInt32LE(desc)
      const nameRva = buf.readUInt32LE(desc + 12)
      const firstThunk = buf.readUInt32LE(desc + 16)
      if (origThunk === 0 && nameRva === 0 && firstThunk === 0) break
      if (nameRva === 0) continue
      const nameOff = rvaToOffset(nameRva)
      const name = readCString(buf, nameOff)
      if (!name) throw new Error(`Unreadable PE import DLL name at RVA 0x${nameRva.toString(16)}`)
      imports.add(name)
    }
  }
  const delayDir = readDir(13)
  if (delayDir) {
    const base = rvaToOffset(delayDir.rva)
    if (base >= 0) {
      for (let i = 0; i < 4096; i++) {
        const desc = base + i * 32
        if (desc + 32 > buf.length) break
        const attrs = buf.readUInt32LE(desc)
        const nameRva = buf.readUInt32LE(desc + 4)
        const iatRva = buf.readUInt32LE(desc + 12)
        if (attrs === 0 && nameRva === 0 && iatRva === 0) break
        if ((attrs & 1) === 0 || nameRva === 0) continue
        const name = readCString(buf, rvaToOffset(nameRva))
        if (name) imports.add(name)
      }
    }
  }
  return [...imports].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export async function assertStaticCrtPe(filePath, label = path.basename(filePath)) {
  const buf = await readFile(filePath)
  const imports = inspectPeImports(buf)
  const forbidden = imports.filter((dll) => FORBIDDEN_CRT_IMPORT.test(dll))
  if (forbidden.length > 0) {
    throw new Error(
      `${label} links dynamic/debug MSVC CRT (${forbidden.join(", ")}); rebuild with +crt-static`,
    )
  }
  return imports
}

async function assertRegularNonEmptyFile(filePath, label) {
  let info
  try {
    info = await lstat(filePath)
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`Missing required file: ${label} (${filePath})`)
    throw error
  }
  if (info.isSymbolicLink()) throw new Error(`Symlink not allowed for ${label}: ${filePath}`)
  if (!info.isFile()) throw new Error(`Expected a regular file for ${label}: ${filePath}`)
  if (info.size === 0) throw new Error(`Required file is empty: ${label} (${filePath})`)
  return info.size
}

async function assertPlainDirectory(dirPath, label) {
  let info
  try {
    info = await lstat(dirPath)
  } catch (error) {
    if (error && error.code === "ENOENT") throw new Error(`Missing required directory: ${label} (${dirPath})`)
    throw error
  }
  if (info.isSymbolicLink()) throw new Error(`Symlink not allowed for ${label}: ${dirPath}`)
  if (!info.isDirectory()) throw new Error(`Expected a directory for ${label}: ${dirPath}`)
}

async function copyPublicTree(sourceDir, destDir, rel = "") {
  const current = rel ? path.join(sourceDir, rel) : sourceDir
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  await mkdir(rel ? path.join(destDir, rel) : destDir, { recursive: true })
  let count = 0
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    const srcPath = path.join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed in public/: public/${childRel}`)
    if (isForbiddenEntryName(entry.name)) {
      throw new Error(`Forbidden debug/cache file in public/: public/${childRel}`)
    }
    if (entry.isDirectory()) {
      count += await copyPublicTree(sourceDir, destDir, childRel)
    } else if (entry.isFile()) {
      await assertRegularNonEmptyFile(srcPath, `public/${childRel}`)
      await copyFile(srcPath, path.join(destDir, childRel))
      count++
    } else {
      throw new Error(`Unsupported entry in public/: public/${childRel}`)
    }
  }
  return count
}

async function stagePlugins(pluginsDir, destPluginsDir) {
  await assertPlainDirectory(pluginsDir, "plugins")
  const topEntries = await readdir(pluginsDir, { withFileTypes: true })
  const allowedFeatures = new Set(REQUIRED_PLUGIN_FEATURES)
  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink not allowed in plugins/: ${entry.name}`)
    if (isForbiddenEntryName(entry.name) || !entry.isDirectory() || !allowedFeatures.has(entry.name)) {
      throw new Error(`Unexpected entry in plugins/: ${entry.name}`)
    }
  }
  const staged = []
  for (const feature of REQUIRED_PLUGIN_FEATURES) {
    const srcFeatureDir = path.join(pluginsDir, feature)
    await assertPlainDirectory(srcFeatureDir, `plugins/${feature}`)
    const files = (await readdir(srcFeatureDir, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    const optionalSet = OPTIONAL_PLUGIN_FILES.get(feature) ?? new Set()
    const destFeatureDir = path.join(destPluginsDir, feature)
    await mkdir(destFeatureDir, { recursive: true })
    let sawPlugin = false
    for (const entry of files) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Symlink not allowed in plugins/${feature}: ${entry.name}`)
      }
      if (!entry.isFile() || isForbiddenEntryName(entry.name)) {
        throw new Error(`Forbidden entry in plugins/${feature}: ${entry.name}`)
      }
      if (entry.name !== "plugin.mjs" && !optionalSet.has(entry.name)) {
        throw new Error(`Unexpected file in plugins/${feature}: ${entry.name}`)
      }
      const srcFile = path.join(srcFeatureDir, entry.name)
      await assertRegularNonEmptyFile(srcFile, `plugins/${feature}/${entry.name}`)
      await copyFile(srcFile, path.join(destFeatureDir, entry.name))
      staged.push(`plugins/${feature}/${entry.name}`)
      if (entry.name === "plugin.mjs") sawPlugin = true
    }
    if (!sawPlugin) {
      throw new Error(`Missing required plugin payload: plugins/${feature}/plugin.mjs`)
    }
  }
  return staged
}

async function collectFilesSorted(rootDir, rel = "") {
  const current = rel ? path.join(rootDir, rel) : rootDir
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const out = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Symlink found in staged payload: ${rel}/${entry.name}`)
    if (isForbiddenEntryName(entry.name)) {
      throw new Error(`Forbidden file found in staged payload: ${rel ? `${rel}/` : ""}${entry.name}`)
    }
    const posixRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...(await collectFilesSorted(rootDir, posixRel)))
    } else if (entry.isFile()) {
      out.push(posixRel)
    } else {
      throw new Error(`Unsupported file type in staged payload: ${posixRel}`)
    }
  }
  return out
}

function pathsOverlap(a, b) {
  const norm = (p) => {
    const resolved = path.resolve(p)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  const pa = norm(a)
  const pb = norm(b)
  const relAB = path.relative(pa, pb)
  const relBA = path.relative(pb, pa)
  return (
    relAB === "" ||
    (!relAB.startsWith("..") && !path.isAbsolute(relAB)) ||
    (!relBA.startsWith("..") && !path.isAbsolute(relBA))
  )
}

/**
 * Stages and validates the Windows installer directory (`codenomad-rune.exe`, `codenomad-rs.exe`,
 * `plugins/`, optional `public/`).
 */
export async function stageInstallerPayload(options) {
  const {
    runeExe,
    serverExe,
    pluginsDir,
    publicDir = null,
    stageDir,
    cleanStage = false,
    skipPeCheck = false,
  } = options
  if (!runeExe) throw new Error("Missing --rune-exe (or --from-dir containing codenomad-rune.exe)")
  if (!serverExe) throw new Error("Missing --server-exe (or --from-dir containing codenomad-rs.exe)")
  if (!pluginsDir) throw new Error("Missing --plugins-dir (or --from-dir containing plugins/)")
  if (!stageDir) throw new Error("Missing stageDir")
  for (const [label, src] of [
    ["--rune-exe", runeExe],
    ["--server-exe", serverExe],
    ["--plugins-dir", pluginsDir],
    ...(publicDir ? [["--public-dir", publicDir]] : []),
  ]) {
    if (pathsOverlap(stageDir, src)) {
      throw new Error(`Stage directory (${stageDir}) must not overlap ${label} (${src})`)
    }
  }

  await assertRegularNonEmptyFile(runeExe, "codenomad-rune.exe")
  await assertRegularNonEmptyFile(serverExe, "codenomad-rs.exe")

  const peImports = {}
  if (!skipPeCheck) {
    peImports["codenomad-rune.exe"] = await assertStaticCrtPe(runeExe, "codenomad-rune.exe")
    peImports["codenomad-rs.exe"] = await assertStaticCrtPe(serverExe, "codenomad-rs.exe")
  }

  let existingStage = null
  try {
    existingStage = await lstat(stageDir)
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error
  }
  if (existingStage) {
    if (existingStage.isSymbolicLink()) throw new Error(`Stage path must not be a symlink: ${stageDir}`)
    if (!existingStage.isDirectory()) throw new Error(`Stage path is not a directory: ${stageDir}`)
    const existingEntries = await readdir(stageDir)
    if (existingEntries.length > 0 && !cleanStage) {
      throw new Error(`Stage directory is not empty: ${stageDir} (pass --clean-stage to replace)`)
    }
    if (cleanStage) {
      for (const name of existingEntries) {
        await rm(path.join(stageDir, name), { recursive: true, force: true })
      }
    }
  } else {
    await mkdir(stageDir, { recursive: true })
  }

  await copyFile(runeExe, path.join(stageDir, "codenomad-rune.exe"))
  await copyFile(serverExe, path.join(stageDir, "codenomad-rs.exe"))
  const stagedPlugins = await stagePlugins(pluginsDir, path.join(stageDir, "plugins"))

  let publicFilesCount = 0
  if (publicDir) {
    await assertPlainDirectory(publicDir, "public")
    await assertRegularNonEmptyFile(path.join(publicDir, "index.html"), "public/index.html")
    const hasBoot = await lstat(path.join(publicDir, "boot.js")).then(() => true, () => false)
    const hasWasm = await lstat(path.join(publicDir, "app_bg.wasm")).then(() => true, () => false)
    if (hasBoot !== hasWasm) {
      throw new Error("Incomplete Rune web bundle in public/: boot.js and app_bg.wasm must both be present")
    }
    if (hasBoot) {
      await assertRegularNonEmptyFile(path.join(publicDir, "boot.js"), "public/boot.js")
      await assertRegularNonEmptyFile(path.join(publicDir, "app_bg.wasm"), "public/app_bg.wasm")
    }
    publicFilesCount = await copyPublicTree(publicDir, path.join(stageDir, "public"))
  }

  const files = await collectFilesSorted(stageDir)
  return { stageDir, files, plugins: stagedPlugins, publicFilesCount, peImports }
}

function validateZipEntryName(name) {
  if (!name || name.startsWith("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`Invalid ZIP entry path: ${name}`)
  }
  const parts = name.split("/")
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`Invalid ZIP entry path segment: ${name}`)
  }
}

/**
 * Builds a deterministic, streaming-safe ZIP buffer (exact sizes + CRC32 in every local header,
 * fixed 1980-01-01 DOS timestamps, sorted POSIX paths) compatible with Windows `tar.exe -xf -`.
 */
export async function createDeterministicZip(stageDir) {
  const files = (await collectFilesSorted(stageDir)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  if (files.length === 0) throw new Error("Cannot create payload.zip from an empty staging directory")
  if (files.length >= 0xffff) throw new Error("ZIP64 entry count not supported")

  const localChunks = []
  const centralChunks = []
  const seenLower = new Set()
  let offset = 0

  for (const rel of files) {
    validateZipEntryName(rel)
    const lower = rel.toLowerCase()
    if (seenLower.has(lower)) throw new Error(`Case-colliding ZIP entry path: ${rel}`)
    seenLower.add(lower)
    const nameBuf = Buffer.from(rel, "utf8")
    const raw = await readFile(path.join(stageDir, rel))
    if (raw.length > 0xffffffff) throw new Error(`File exceeds 4 GiB ZIP limit: ${rel}`)
    const checksum = crc32(raw) >>> 0
    const deflated = deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const method = useDeflate ? 8 : 0
    const body = useDeflate ? deflated : raw

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME_EPOCH, 10)
    local.writeUInt16LE(DOS_DATE_EPOCH, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by: MS-DOS / 2.0
    central.writeUInt16LE(20, 6) // version needed: 2.0
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME_EPOCH, 12)
    central.writeUInt16LE(DOS_DATE_EPOCH, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0x20, 38) // archive attribute
    central.writeUInt32LE(offset, 42)

    localChunks.push(local, nameBuf, body)
    centralChunks.push(central, nameBuf)
    offset += local.length + nameBuf.length + body.length
    if (offset > 0xffffffff) throw new Error("Archive exceeds 4 GiB ZIP limit")
  }

  const centralDir = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, centralDir, eocd])
}

/**
 * Reads and verifies all entries from a ZIP buffer (used for self-checks and unit tests).
 */
export function listZipEntries(zipBuffer) {
  let eocdOffset = -1
  const minOffset = Math.max(0, zipBuffer.length - 65557)
  for (let i = zipBuffer.length - 22; i >= minOffset; i--) {
    if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid ZIP archive: missing EOCD record")
  const entryCount = zipBuffer.readUInt16LE(eocdOffset + 10)
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16)
  const entries = []
  let pos = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (pos + 46 > eocdOffset || zipBuffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error("Invalid ZIP central directory header")
    }
    const method = zipBuffer.readUInt16LE(pos + 10)
    const expectedCrc = zipBuffer.readUInt32LE(pos + 16)
    const compressedSize = zipBuffer.readUInt32LE(pos + 20)
    const uncompressedSize = zipBuffer.readUInt32LE(pos + 24)
    const nameLen = zipBuffer.readUInt16LE(pos + 28)
    const extraLen = zipBuffer.readUInt16LE(pos + 30)
    const commentLen = zipBuffer.readUInt16LE(pos + 32)
    const localOffset = zipBuffer.readUInt32LE(pos + 42)
    const name = zipBuffer.subarray(pos + 46, pos + 46 + nameLen).toString("utf8")
    pos += 46 + nameLen + extraLen + commentLen

    if (zipBuffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${name}`)
    }
    const localNameLen = zipBuffer.readUInt16LE(localOffset + 26)
    const localExtraLen = zipBuffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const compressed = zipBuffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(compressed) : method === 8 ? inflateRawSync(compressed) : null
    if (!data) throw new Error(`Unsupported ZIP compression method ${method} for ${name}`)
    if (data.length !== uncompressedSize || (crc32(data) >>> 0) !== expectedCrc) {
      throw new Error(`ZIP integrity check failed for ${name}`)
    }
    entries.push({ name, method, crc32: expectedCrc, compressedSize, uncompressedSize, data })
  }
  return entries
}

async function atomicWriteFile(destPath, buffer) {
  await mkdir(path.dirname(destPath), { recursive: true })
  const tmp = `${destPath}.tmp-${randomUUID()}`
  try {
    await writeFile(tmp, buffer)
    await rename(tmp, destPath)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

async function resolveInputs(opts) {
  const fromDir = opts.fromDir ? path.resolve(opts.fromDir) : null
  const runeExe = opts.runeExe
    ? path.resolve(opts.runeExe)
    : fromDir
      ? path.join(fromDir, "codenomad-rune.exe")
      : null
  const serverExe = opts.serverExe
    ? path.resolve(opts.serverExe)
    : fromDir
      ? path.join(fromDir, "codenomad-rs.exe")
      : null
  const pluginsDir = opts.pluginsDir
    ? path.resolve(opts.pluginsDir)
    : fromDir
      ? path.join(fromDir, "plugins")
      : null
  let publicDir = null
  if (!opts.noPublic) {
    if (opts.publicDir) {
      publicDir = path.resolve(opts.publicDir)
    } else if (fromDir) {
      const candidate = path.join(fromDir, "public")
      const exists = await lstat(candidate).then(() => true, () => false)
      if (exists) publicDir = candidate
    }
  }
  return { runeExe, serverExe, pluginsDir, publicDir }
}

function buildSetupBinary({ payloadZip, version, setupOut, skipPeCheck, offline }) {
  if (process.platform !== "win32") {
    throw new Error("--build-setup must run on a Windows host (winresource embeds the setup manifest)")
  }
  const env = { ...process.env, CODENOMAD_RUNE_SETUP_PAYLOAD: payloadZip }
  if (version !== undefined) {
    const trimmed = version.trim()
    if (!trimmed) throw new Error("--version must not be empty")
    env.CODENOMAD_RUNE_VERSION = trimmed
  }
  const cargoArgs = ["build", "--release", "--locked", ...(offline ? ["--offline"] : []), "-p", "codenomad-rune-setup"]
  const res = spawnSync("cargo", cargoArgs, {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
    windowsHide: true,
  })
  if (res.error) throw res.error
  if (res.status !== 0) {
    throw new Error(`cargo ${cargoArgs.join(" ")} exited with status ${res.status}`)
  }
  const targetDir = env.CARGO_TARGET_DIR
    ? path.resolve(env.CARGO_TARGET_DIR)
    : path.join(REPO_ROOT, "target")
  const builtExe = path.join(targetDir, "release", "codenomad-rune-setup.exe")
  return { builtExe, setupOut: setupOut ? path.resolve(setupOut) : null, skipPeCheck }
}

export async function packageWindowsInstaller(opts) {
  const inputs = await resolveInputs(opts)
  if (opts.stageOnly) {
    if (!opts.stageDir) throw new Error("--stage-only requires --stage-dir <path>")
    return await stageInstallerPayload({
      ...inputs,
      stageDir: path.resolve(opts.stageDir),
      cleanStage: Boolean(opts.cleanStage),
      skipPeCheck: Boolean(opts.skipPeCheck),
    })
  }

  const outZip = path.resolve(opts.out ?? path.join(REPO_ROOT, "target/rune-windows-installer/payload.zip"))
  const ownedTemp = !opts.stageDir
  const stageDir = ownedTemp
    ? await mkdtemp(path.join(os.tmpdir(), "codenomad-rune-stage-"))
    : path.resolve(opts.stageDir)

  try {
    const staged = await stageInstallerPayload({
      ...inputs,
      stageDir,
      cleanStage: ownedTemp ? true : Boolean(opts.cleanStage),
      skipPeCheck: Boolean(opts.skipPeCheck),
    })
    const zipBuffer = await createDeterministicZip(stageDir)
    await atomicWriteFile(outZip, zipBuffer)

    let setupExe = null
    if (opts.buildSetup) {
      const built = buildSetupBinary({
        payloadZip: outZip,
        version: opts.version,
        setupOut: opts.setupOut,
        skipPeCheck: Boolean(opts.skipPeCheck),
        offline: Boolean(opts.offline),
      })
      await assertRegularNonEmptyFile(built.builtExe, "codenomad-rune-setup.exe")
      if (!built.skipPeCheck) {
        await assertStaticCrtPe(built.builtExe, "codenomad-rune-setup.exe")
      }
      if (built.setupOut && built.setupOut !== built.builtExe) {
        await atomicWriteFile(built.setupOut, await readFile(built.builtExe))
        setupExe = built.setupOut
      } else {
        setupExe = built.builtExe
      }
    }
    return { ...staged, payloadZip: outZip, payloadBytes: zipBuffer.length, setupExe }
  } finally {
    if (ownedTemp) await rm(stageDir, { recursive: true, force: true })
  }
}

const USAGE = `Usage: node scripts/rune/package-windows-installer.mjs [options]

Inputs:
  --from-dir <dir>       Folder holding codenomad-rune.exe, codenomad-rs.exe, plugins/, [public/]
  --rune-exe <path>      Explicit path to codenomad-rune.exe
  --server-exe <path>    Explicit path to codenomad-rs.exe
  --plugins-dir <dir>    Explicit path to bundled OpenCode plugins directory
  --public-dir <dir>     Optional Web/WASM UI bundle directory (included as public/)
  --no-public            Omit public/ even when present under --from-dir

Outputs & actions:
  --stage-only           Populate and verify --stage-dir without creating payload.zip
  --stage-dir <dir>      Explicit staging directory (use --clean-stage to replace contents)
  --clean-stage          Clear an existing non-empty --stage-dir before staging
  --out <path>           Output path for payload.zip (default: target/rune-windows-installer/payload.zip)
  --build-setup          Build codenomad-rune-setup.exe embedding payload.zip via Cargo
  --setup-out <path>     Copy the built codenomad-rune-setup.exe to this path
  --version <semver>     Version passed to CODENOMAD_RUNE_VERSION when building setup
  --offline              Pass --offline to Cargo when --build-setup is set
  --skip-pe-check        Skip the PE +crt-static import table check
  -h, --help             Show this help
`

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "from-dir": { type: "string" },
      "rune-exe": { type: "string" },
      "server-exe": { type: "string" },
      "plugins-dir": { type: "string" },
      "public-dir": { type: "string" },
      "no-public": { type: "boolean", default: false },
      "stage-only": { type: "boolean", default: false },
      "stage-dir": { type: "string" },
      "clean-stage": { type: "boolean", default: false },
      out: { type: "string" },
      "build-setup": { type: "boolean", default: false },
      "setup-out": { type: "string" },
      version: { type: "string" },
      offline: { type: "boolean", default: false },
      "skip-pe-check": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  const result = await packageWindowsInstaller({
    fromDir: values["from-dir"],
    runeExe: values["rune-exe"],
    serverExe: values["server-exe"],
    pluginsDir: values["plugins-dir"],
    publicDir: values["public-dir"],
    noPublic: values["no-public"],
    stageOnly: values["stage-only"],
    stageDir: values["stage-dir"],
    cleanStage: values["clean-stage"],
    out: values.out,
    buildSetup: values["build-setup"],
    setupOut: values["setup-out"],
    version: values.version,
    offline: values.offline,
    skipPeCheck: values["skip-pe-check"],
  })
  console.log(
    JSON.stringify({
      payloadZip: result.payloadZip ?? null,
      payloadBytes: result.payloadBytes ?? null,
      stageDir: values["stage-only"] || values["stage-dir"] ? result.stageDir : null,
      files: result.files.length,
      plugins: result.plugins.length,
      publicFiles: result.publicFilesCount,
      setupExe: result.setupExe ?? null,
    }),
  )
}
