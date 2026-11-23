import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { parse } from "jsonc-parser"
import type { ConfigEntry } from "@opencode/client"

const MAX_DOCUMENT_BYTES = 1024 * 1024
export type NativeAutomationsSetting = { enabled: boolean; source: "setting" | "legacy-off" | "default"; path?: string }

function readRaw(path: string): unknown {
  const fd = openSync(path, "r")
  try {
    const size = fstatSync(fd).size
    if (size > MAX_DOCUMENT_BYTES) throw new Error("Native automations setting document too large")
    const bytes = Buffer.alloc(size)
    let read = 0
    while (read < size) { const count = readSync(fd, bytes, read, size - read, null); if (!count) break; read += count }
    return parse(bytes.subarray(0, read).toString("utf8").replace(/^﻿/, ""), [], { allowTrailingComma: true })
  } finally { closeSync(fd) }
}

/** A document's own `experimental.automations`/`schedules` OFF, as saved for runtimes that read
 * that block. Runtimes with the top-level setting drop the block from their entries, so it is
 * read from the document itself. */
export function legacyAutomationsOff(raw: unknown): boolean {
  const experimental = raw && typeof raw === "object" ? (raw as { experimental?: unknown }).experimental : undefined
  if (!experimental || typeof experimental !== "object") return false
  const block = experimental as { automations?: unknown; schedules?: unknown }
  return (block.automations ?? block.schedules) === false
}

/** The top-level `automations` setting: the highest-priority document that sets it wins, as in
 * OpenCode, and OpenCode enables automations by default. An explicit legacy OFF in a document
 * with no newer top-level choice above it stays OFF for Missions, so an upgrade never turns
 * schedules back on. A legacy ON adds nothing to the default. */
export function nativeAutomationsSetting(entries: readonly ConfigEntry[], read: (path: string) => unknown = readRaw): NativeAutomationsSetting {
  for (const entry of [...entries].reverse()) {
    if (entry.type !== "document") continue
    const value = (entry.info as { automations?: unknown }).automations
    if (value !== undefined) {
      if (typeof value !== "boolean") throw new Error("Native automations setting invalid")
      return { enabled: value, source: "setting", ...(entry.path ? { path: entry.path } : {}) }
    }
    if (entry.path && legacyAutomationsOff(read(entry.path))) return { enabled: false, source: "legacy-off", path: entry.path }
  }
  return { enabled: true, source: "default" }
}
