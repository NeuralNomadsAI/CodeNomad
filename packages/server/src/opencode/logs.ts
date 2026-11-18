import { execFile } from "node:child_process"
import { open } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { buildSpawnSpec, parseWslUncPath } from "../workspaces/spawn"
import { wslServiceMetadataPath } from "../workspaces/native-service-registration"

export const OPENCODE_LOG_BYTES = 128 * 1024
export interface OpenCodeLogsResponse { path: string; text: string; truncated: boolean }

async function logDirectory(binary: string): Promise<string> {
  const spec = buildSpawnSpec(binary, ["debug", "paths", "log"])
  const result = await promisify(execFile)(spec.command, spec.args, {
    ...spec.options, ...(spec.cwd ? { cwd: spec.cwd } : {}), ...(spec.env ? { env: spec.env } : {}),
    windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024, encoding: "utf8", shell: false,
  })
  return result.stdout.trim()
}

/** Explicit snapshot of the selected execution host's documented global log. */
export async function readOpenCodeLogs(binary: string, discover = logDirectory): Promise<OpenCodeLogsResponse> {
  const directory = await discover(binary)
  const wsl = parseWslUncPath(binary)
  const paths = wsl || directory.startsWith("/") ? path.posix : path
  if (!paths.isAbsolute(directory) || /[\x00-\x1f\x7f]/.test(directory)) throw new Error("Invalid OpenCode log directory")
  const nativeFile = paths.join(directory, "opencode.log")
  const file = wsl ? await wslServiceMetadataPath(wsl.distro, nativeFile, Date.now() + 10_000) : nativeFile
  const handle = await open(file, "r")
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error("OpenCode log is not a file")
    const start = Math.max(0, stat.size - OPENCODE_LOG_BYTES)
    const buffer = Buffer.alloc(Math.min(stat.size, OPENCODE_LOG_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    let offset = 0
    if (start) {
      const newline = buffer.subarray(0, bytesRead).indexOf(10)
      if (newline !== -1) offset = newline + 1
      else while (offset < bytesRead && (buffer[offset]! & 0xc0) === 0x80) offset++
    }
    return { path: nativeFile, text: buffer.subarray(offset, bytesRead).toString("utf8"), truncated: start > 0 }
  } finally { await handle.close() }
}
