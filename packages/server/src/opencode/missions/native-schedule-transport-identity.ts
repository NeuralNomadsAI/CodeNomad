import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import path from "node:path"
import type { Info } from "@opencode/client/service"

export const NATIVE_SCHEDULE_REGISTRATION_BYTES = 32 * 1024
export type NativeScheduleIncarnation = Readonly<Required<Pick<Info, "id" | "pid" | "url">> & Pick<Info, "version">>

export function assertNativeScheduleIncarnation(value: unknown): asserts value is NativeScheduleIncarnation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schedule-incarnation")
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || !record.id.trim() || record.id.length > 1024
    || !Number.isSafeInteger(record.pid) || Number(record.pid) <= 0
    || typeof record.url !== "string" || record.url.length > 4096
    || (record.version !== undefined && (typeof record.version !== "string" || !record.version || record.version.length > 1024)))
    throw new Error("schedule-incarnation")
  const url = new URL(record.url)
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("schedule-incarnation")
}

/** The owned absolute service-namespace path is resolved at arming, by the caller. */
export function readNativeScheduleIncarnation(file: string): NativeScheduleIncarnation {
  if (!path.isAbsolute(file)) throw new Error("schedule-registration-path")
  const handle = openSync(file, "r")
  try {
    const stat = fstatSync(handle)
    if (!stat.isFile() || stat.size > NATIVE_SCHEDULE_REGISTRATION_BYTES) throw new Error("schedule-registration-size")
    const bytes = Buffer.alloc(NATIVE_SCHEDULE_REGISTRATION_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(handle, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size > NATIVE_SCHEDULE_REGISTRATION_BYTES) throw new Error("schedule-registration-size")
    const raw: unknown = JSON.parse(bytes.subarray(0, size).toString("utf8"))
    assertNativeScheduleIncarnation(raw)
    // Select the public Info projection; credentials never leave this reader.
    return Object.freeze({ id: raw.id, pid: raw.pid, url: raw.url, ...(raw.version === undefined ? {} : { version: raw.version }) })
  } finally { closeSync(handle) }
}

export const sameNativeScheduleIncarnation = (a: NativeScheduleIncarnation, b: NativeScheduleIncarnation) =>
  a.id === b.id && a.pid === b.pid && a.url === b.url && a.version === b.version

/** Call inside the current RPC, after I/O and synchronously before every CAS/effect. */
export function nativeScheduleIncarnationGuard(file: string, expected: NativeScheduleIncarnation): () => true {
  assertNativeScheduleIncarnation(expected)
  const captured = { ...expected }
  return () => {
    if (captured.pid !== process.pid || !sameNativeScheduleIncarnation(readNativeScheduleIncarnation(file), captured))
      throw new Error("schedule-incarnation-changed")
    return true
  }
}
