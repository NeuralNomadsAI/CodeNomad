import { closeSync, mkdirSync, openSync, renameSync, fstatSync, writeSync } from "node:fs"
import path from "node:path"

/** The current file and the previous one together stay below twice this size. */
export const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024

/** Where the server keeps its own log, beside its configuration. */
export function serverLogFile(configDir: string): string {
  return path.join(configDir, "logs", "server.log")
}

/** The file a full log moves to: `server.log` → `server.previous.log`. */
export function previousLogFile(file: string): string {
  const extension = path.extname(file)
  return `${file.slice(0, file.length - extension.length)}.previous${extension}`
}

export interface LogFile {
  write(line: string): void
}

/**
 * Appends lines to `file`, synchronously so a crash loses none, and moves a full
 * file aside. Logging never fails its caller: a file that cannot be opened or
 * written stops being written.
 */
export function openLogFile(file: string, maxBytes = LOG_FILE_MAX_BYTES): LogFile {
  let descriptor: number | undefined
  let size = 0
  let failed = false
  const open = () => {
    mkdirSync(path.dirname(file), { recursive: true })
    descriptor = openSync(file, "a")
    size = fstatSync(descriptor).size
  }
  const rotate = () => {
    if (descriptor !== undefined) closeSync(descriptor)
    descriptor = undefined
    // Another backend may hold either file open: keep appending and try again a file later.
    try { renameSync(file, previousLogFile(file)) } catch { /* retried once `maxBytes` more are written */ }
    open()
    if (size >= maxBytes) size = 0
  }
  return {
    write(line) {
      if (failed) return
      try {
        if (descriptor === undefined) open()
        if (size >= maxBytes) rotate()
        size += writeSync(descriptor!, line)
      } catch {
        failed = true
      }
    },
  }
}
