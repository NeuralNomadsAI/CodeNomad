import fs from "node:fs/promises"
import { constants } from "node:fs"
import { TextDecoder } from "node:util"
import { parseDocument } from "yaml"
import type { ConfigLocation } from "../config/location"
import { isPlainObject } from "./merge-patch"

const MAX_CONFIG_BYTES = 1024 * 1024
const READ_TIMEOUT_MS = 2_000

export class ProfileEnvironmentReadError extends Error {
  readonly code = "PROFILE_ENVIRONMENT_UNAVAILABLE"

  constructor() {
    // Never attach parser/I/O errors: they may contain paths, keys or secret values.
    super("Profile environment is unavailable")
    this.name = "ProfileEnvironmentReadError"
  }
}

/** Admission-only read. No cache, migration, persistence, logging or discovery. */
export async function readAdmissionEnvironment(
  location: Pick<ConfigLocation, "configYamlPath">,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(abort, READ_TIMEOUT_MS)
  const cancelled = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new ProfileEnvironmentReadError()), { once: true })
  })
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  try {
    return await Promise.race([readConfigEnvironment(location.configYamlPath, controller.signal), cancelled])
  } catch {
    throw new ProfileEnvironmentReadError()
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", abort)
  }
}

async function readConfigEnvironment(filePath: string, signal: AbortSignal): Promise<Record<string, string>> {
  signal.throwIfAborted()
  // Nonblocking open lets us reject FIFOs/devices rather than waiting for a writer.
  // O_NONBLOCK is ignored for regular files and on Windows.
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK).catch(error => {
    // A missing canonical document is the normal empty-profile default. Do not
    // resurrect a cached document, state.yaml, JSON backup or another profile.
    if (error?.code === "ENOENT" && !signal.aborted) return undefined
    throw error
  })
  if (!handle) return {}
  try {
    signal.throwIfAborted()
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) throw new ProfileEnvironmentReadError()
    // Read one extra byte to catch growth after stat, without allocating unbounded buffers.
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      signal.throwIfAborted()
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    signal.throwIfAborted()
    if (length > MAX_CONFIG_BYTES) throw new ProfileEnvironmentReadError()
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))
    const document = parseDocument(content, { prettyErrors: false, strict: true, uniqueKeys: true, logLevel: "silent" })
    if (document.errors.length || document.warnings.length) throw new ProfileEnvironmentReadError()
    const config: unknown = document.toJS({ maxAliasCount: 50 })
    if (!isPlainObject(config)) throw new ProfileEnvironmentReadError()
    if (config.server !== undefined && !isPlainObject(config.server)) throw new ProfileEnvironmentReadError()
    // Legacy preferences are migration input only. A replacement with that layout
    // cannot silently drop its overrides; migration remains an explicit startup concern.
    if (config.preferences !== undefined) throw new ProfileEnvironmentReadError()
    const configured = (config.server as Record<string, unknown> | undefined)?.environmentVariables
    if (configured === undefined) return {}
    if (!isPlainObject(configured)) throw new ProfileEnvironmentReadError()
    const entries = Object.entries(configured)
    for (const [key, value] of entries) {
      if (typeof value !== "string" || !key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
        throw new ProfileEnvironmentReadError()
      }
    }
    signal.throwIfAborted()
    return Object.fromEntries(entries) as Record<string, string>
  } finally {
    await handle.close()
  }
}
