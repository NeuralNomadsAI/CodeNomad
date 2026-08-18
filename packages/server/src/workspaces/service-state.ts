import { constants, closeSync, chmodSync, lstatSync, mkdirSync, openSync, readFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { isIP } from "node:net"
import os from "node:os"
import path from "node:path"
import type { Info } from "@opencode-ai/client/service"

const CODENOMAD_HOME = path.join(os.homedir(), ".codenomad")
const CODENOMAD_STATE = path.join(CODENOMAD_HOME, "state")
export const SERVICE_STATE_ROOT = path.join(CODENOMAD_STATE, "opencode-v2")
export const SERVICE_REGISTRATION_FILE = path.join(SERVICE_STATE_ROOT, "opencode", "service.json")
export const SERVICE_LEASE_DIRECTORY = path.join(SERVICE_STATE_ROOT, "leases")
export const SERVICE_STOP_LOCK = path.join(SERVICE_STATE_ROOT, "stop.lock")

const preparedFiles = new Set<string>()

export function prepareServiceState(contenderFile: string): void {
  ensurePrivateDirectory(CODENOMAD_HOME)
  ensurePrivateDirectory(CODENOMAD_STATE)
  ensurePrivateDirectory(SERVICE_STATE_ROOT)
  ensurePrivateDirectory(path.dirname(SERVICE_REGISTRATION_FILE))
  ensurePrivateDirectory(SERVICE_LEASE_DIRECTORY)
  validateRegistrationFile(SERVICE_REGISTRATION_FILE)
  if (preparedFiles.has(contenderFile)) return
  closeSync(openSync(contenderFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600))
  preparedFiles.add(contenderFile)
}

export async function readSecureServiceInfo(file: string | undefined): Promise<Info | undefined> {
  if (!file) return undefined
  let handle
  try {
    const before = lstatSync(file)
    if (!before.isFile() || before.isSymbolicLink()) return undefined
    const flags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
    handle = await open(file, flags)
    const after = await handle.stat()
    if (process.platform !== "win32" && (before.dev !== after.dev || before.ino !== after.ino)) return undefined
    return parseInfo(await handle.readFile("utf8"))
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

export function assertLoopbackServiceUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported OpenCode service protocol: ${url.protocol}`)
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  const ipVersion = isIP(hostname)
  const loopback = hostname === "localhost"
    || (ipVersion === 4 && hostname.startsWith("127."))
    || (ipVersion === 6 && (hostname === "::1" || hostname.startsWith("::ffff:127.")))
  if (!loopback) throw new Error(`OpenCode service endpoint must be loopback: ${url.hostname}`)
  return url
}

function ensurePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe OpenCode service state directory: ${directory}`)
  if (process.platform === "win32") return
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`OpenCode service state directory is owned by another user: ${directory}`)
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(directory, 0o700)
}

function validateRegistrationFile(file: string): void {
  let stat
  try {
    stat = lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe OpenCode service registration file: ${file}`)
  const text = readFileSync(file, "utf8")
  let value: unknown
  try { value = JSON.parse(text) } catch { return }
  if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") {
    assertLoopbackServiceUrl(value.url)
  }
}

function parseInfo(text: string): Info | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  if (!("url" in value) || typeof value.url !== "string") return undefined
  if (!("id" in value) || typeof value.id !== "string" || !value.id) return undefined
  if (!("pid" in value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined
  try {
    assertLoopbackServiceUrl(value.url)
  } catch {
    return undefined
  }
  return value as Info
}
