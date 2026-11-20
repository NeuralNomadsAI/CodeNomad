import { createHash, randomUUID } from "node:crypto"
import { lstatSync, openSync, closeSync, readSync, mkdirSync, renameSync, rmSync, writeFileSync, constants } from "node:fs"
import { open, lstat, rm } from "node:fs/promises"
import { dirname } from "node:path"

export class HexFailure extends Error {
  constructor(code = "failed") {
    super(code)
    this.code = code
  }
}

function stat(path) {
  try {
    const info = lstatSync(path, { bigint: true })
    if (info.isSymbolicLink()) throw new HexFailure()
    return info
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
}

function fileStamp(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String).join(":")
}

export function fileInfo(path) {
  const info = stat(path)
  if (!info) return
  if (!info.isFile() || info.nlink < 1n) throw new HexFailure()
  return { bytes: Number(info.size), stamp: fileStamp(info), modifiedNs: String(info.mtimeNs) }
}

export function ensureDirectory(path, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 })
  const info = stat(path)
  if (info && !info.isDirectory()) throw new HexFailure()
  return !!info
}

export function readReceipt(path) {
  if (!fileInfo(path)) return
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const buffer = Buffer.alloc(2049)
    const bytes = readSync(fd, buffer, 0, buffer.length, null)
    if (bytes < buffer.length) return JSON.parse(buffer.subarray(0, bytes).toString("utf8"))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  } finally {
    closeSync(fd)
  }
}

export function publish(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, data, { flag: "wx", mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export async function hashFile(path, expected, signal, copyTo) {
  // The descriptor is checked below; a replaced special file must not block discovery.
  const input = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let output
  try {
    const start = await input.stat({ bigint: true })
    if (!start.isFile() || start.size !== BigInt(expected.bytes)) return false
    if (copyTo) output = await open(copyTo, "wx", 0o600)
    const hash = createHash("sha256")
    const block = Buffer.allocUnsafe(256 * 1024)
    let remaining = expected.bytes
    while (remaining) {
      signal.throwIfAborted()
      const { bytesRead } = await input.read(block, 0, Math.min(block.length, remaining), null)
      if (!bytesRead) return false
      const bytes = block.subarray(0, bytesRead)
      hash.update(bytes)
      if (output) await writeChunk(output, bytes)
      remaining -= bytesRead
    }
    const end = await input.stat({ bigint: true })
    const byPath = await lstat(path, { bigint: true })
    if (fileStamp(start) !== fileStamp(end) || fileStamp(end) !== fileStamp(byPath)) return false
    if (output) await output.sync()
    return hash.digest("hex") === expected.sha256
  } finally {
    try { await input.close() } finally { await output?.close() }
  }
}

export async function writeChunk(file, bytes) {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null)
    if (!bytesWritten) throw new HexFailure()
    offset += bytesWritten
  }
}

export async function cleanCopy(destination, run) {
  const candidate = `${destination}.${randomUUID()}.copy`
  try {
    return await run(candidate)
  } finally {
    await rm(candidate, { force: true })
  }
}

export function artifactReceipt(path, artifact) {
  const { stamp, modifiedNs } = fileInfo(path)
  // Hex v3.4.0 reads the integer modified_ns field as u64; JS numbers lose its precision.
  publish(`${path}.verified.json`,
    `{"bytes":${artifact.bytes},"sha256":"${artifact.sha256}","modified_ns":${modifiedNs},"stamp":"${stamp}"}`)
}

export function candidateDirectory(path) {
  // Also refuse redirected immediate parents when discovering external artifacts.
  if (!ensureDirectory(dirname(path))) return
  return fileInfo(path)
}
