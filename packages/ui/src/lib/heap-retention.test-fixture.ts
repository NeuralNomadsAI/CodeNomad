import { setFlagsFromString } from "node:v8"
import { runInNewContext } from "node:vm"

setFlagsFromString("--expose-gc")
const collect = runInNewContext("gc") as () => void

function heapUsedAfterCollection(): number {
  collect()
  collect()
  return process.memoryUsage().heapUsed
}

/** Heap bytes that stay reachable through what `build` returns once its temporaries are collected. */
export function measureRetainedBytes<T>(build: () => T): { value: T; bytes: number } {
  const before = heapUsedAfterCollection()
  const value = build()
  return { value, bytes: heapUsedAfterCollection() - before }
}

/** A distinct, flat one-byte string of at least `length` characters (like a native tool output). */
export function largeOutput(tag: string, length: number): string {
  const line = `${tag} output line with enough text to look like a real tool result\n`
  return Array.from({ length: Math.ceil(length / line.length) }, () => line).join("")
}
