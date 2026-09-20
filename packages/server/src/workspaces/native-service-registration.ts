import { open, readdir } from "node:fs/promises"
import path from "node:path"
import { assertLoopbackServiceUrl } from "./service-state"
import { resolveDesktopPluginWslPath, type WslPathExecutor } from "../opencode/desktop-plugin-wsl-paths"

const MAX_BYTES = 64 * 1024
const MAX_CONFIGS = 64
const serviceFile = /^service(?:-[a-zA-Z0-9._-]+)?\.json$/

export interface NativeServiceRegistration {
  url: string
  /** Present for a validated native registration; absent only after native
   * registration ENOENT, when returning a configured endpoint to probe. */
  pid?: number
}

/** Read-only recovery for CLI 2.0.11's info-only service discovery. These paths
 * are exclusively for native service records, NEVER plugin/config provisioning.
 * The selected CLI's credential uniquely identifies its channel's config file;
 * ambiguity fails closed rather than guessing a channel, default port or PID.
 */
export async function readNativeServiceRegistration(input: {
  stateDirectory: string
  configDirectory: string
  password: string
  mapPath?: (nativePath: string) => string | Promise<string>
}): Promise<NativeServiceRegistration | undefined> {
  const map = input.mapPath ?? (value => value)
  for (const directory of [input.stateDirectory, input.configDirectory]) {
    if ((!path.posix.isAbsolute(directory) && !path.win32.isAbsolute(directory)) || /[\x00-\x1f\x7f]/.test(directory)) {
      throw new Error("OpenCode returned an invalid native service directory")
    }
  }
  const stateDirectory = await map(input.stateDirectory)
  const configDirectory = await map(input.configDirectory)
  const join = (root: string, name: string) => (root.startsWith("/") ? path.posix : path.win32).join(root, name)
  const names = (await readdir(configDirectory)).filter(name => serviceFile.test(name))
  if (names.length > MAX_CONFIGS) throw new Error("Too many native service configurations")
  const matches: Array<{ name: string; config: Record<string, unknown> }> = []
  for (const name of names) {
    const config = await readRecord(join(configDirectory, name))
    if (config?.password === input.password) matches.push({ name, config })
  }
  if (matches.length !== 1) throw new Error("Cannot uniquely identify the selected OpenCode service channel")
  const { name, config } = matches[0]!
  const registration = await readRecord(join(stateDirectory, name))
  if (!registration) {
    // A configured endpoint can still have an occupied listener without a
    // registration. Authenticate it before allowing the CLI to start anything.
    if (config.port === undefined) return undefined
    if (!Number.isInteger(config.port) || Number(config.port) < 1 || Number(config.port) > 65535) throw new Error("Invalid native service port")
    const host = config.hostname ?? "127.0.0.1"
    if (typeof host !== "string" || !host || /[^a-zA-Z0-9.:[\]-]/.test(host)) throw new Error("Invalid native service hostname")
    const url = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${config.port}`
    assertLoopbackServiceUrl(url)
    return { url }
  }
  if (typeof registration.url !== "string" || !Number.isSafeInteger(registration.pid) || Number(registration.pid) <= 0
    || registration.password !== input.password) throw new Error("Invalid native service registration or credential mismatch")
  return { url: registration.url, pid: Number(registration.pid) }
}

async function readRecord(file: string): Promise<Record<string, unknown> | undefined> {
  const handle = await open(file, "r").catch(error => {
    if (error?.code === "ENOENT") return undefined
    throw new Error("Cannot read native service metadata")
  })
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(MAX_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    if (size > MAX_BYTES) throw new Error("Native service metadata exceeds limit")
    const record: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"))
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid native service metadata")
    return record as Record<string, unknown>
  } catch {
    // Native records contain credentials: never include parsing/file contents.
    throw new Error("Invalid native service metadata")
  } finally { await handle.close() }
}

export async function wslServiceMetadataPath(distro: string, nativePath: string, deadlineAt: number, execute?: WslPathExecutor): Promise<string> {
  if (!distro || /[\\/\x00-\x1f]/.test(distro) || !nativePath.startsWith("/") || /[\\\x00-\x1f]/.test(nativePath)
    || nativePath.split("/").some(part => part === ".." || part === ".")) throw new Error("Invalid WSL native service metadata path")
  // Reuse the bounded realpath/wslpath filesystem translator, including mounted
  // and aliased roots. This does not discover or provision any plugin paths.
  return (await resolveDesktopPluginWslPath(nativePath, distro, deadlineAt, () => {}, execute)).host
}
