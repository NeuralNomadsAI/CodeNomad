import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { parse, type ParseError } from "jsonc-parser"
import type { ConfigEntry } from "@opencode/client"

const MAX_DOCUMENT_BYTES = 1024 * 1024
export const INLINE_CONFIG_SOURCE = "OPENCODE_CONFIG_CONTENT"
export type NativeAutomationsSetting = {
  enabled: boolean
  source: "setting" | "legacy-off" | "environment" | "default"
  /** The deciding document, or `OPENCODE_CONFIG_CONTENT` for inline config. */
  path?: string
  /** Every OFF in a layer below the deciding one, as activation refuses any explicit OFF. */
  hiddenOff: string[]
}
type Raw = { off: boolean }
export type NativeAutomationsSources = {
  /** The daemon's environment, which owns `OPENCODE_FLAGS` and inline config. */
  env: Readonly<Record<string, string | undefined>>
  read(path: string): Raw
}

/** `experimental.automations`/`schedules: false`, as saved for runtimes that read that block.
 * Runtimes with the top-level setting drop the block from their entries, so it is read from
 * the source itself, after the same `{env:}` substitution OpenCode applies. Text that does
 * not parse is unknown, never absent. */
export function legacyAutomationsOff(text: string, env: NativeAutomationsSources["env"]): boolean {
  const substituted = text.replace(/^﻿/, "").replace(/\{env:([^}]+)\}/g, (_, name: string) => env[name] ?? "")
  const errors: ParseError[] = []
  const raw = parse(substituted, errors, { allowTrailingComma: true })
  if (errors.length) throw new Error("Native automations setting unreadable")
  const experimental = raw && typeof raw === "object" ? (raw as { experimental?: unknown }).experimental : undefined
  if (!experimental || typeof experimental !== "object") return false
  const block = experimental as { automations?: unknown; schedules?: unknown }
  return (block.automations ?? block.schedules) === false
}

// One read per file revision, shared by every flag read in this process.
const cache = new Map<string, { mtimeMs: number; size: number; raw: Raw }>()
export function readAutomationsSource(path: string, env: NativeAutomationsSources["env"] = process.env): Raw {
  let fd: number
  try { fd = openSync(path, "r") } catch { throw new Error("Native automations setting unreadable") }
  try {
    const { mtimeMs, size } = fstatSync(fd), cached = cache.get(path)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.raw
    if (size > MAX_DOCUMENT_BYTES) throw new Error("Native automations setting unreadable")
    const bytes = Buffer.alloc(size)
    let read = 0
    while (read < size) { const count = readSync(fd, bytes, read, size - read, null); if (!count) break; read += count }
    if (read !== size) throw new Error("Native automations setting unreadable")
    const raw = { off: legacyAutomationsOff(bytes.toString("utf8"), env) }
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(path, { mtimeMs, size, raw })
    return raw
  } finally { closeSync(fd) }
}

/** OpenCode's top-level `automations`: the highest-priority document that sets it, on by default.
 * An explicit legacy OFF (in a document, in inline config, or `-automations`/`-schedules` in
 * `OPENCODE_FLAGS`) keeps Missions schedules off unless a newer top-level choice above it decides,
 * so an upgrade never turns them back on. Inline config is the highest-priority pathless document;
 * other pathless documents are remote configuration and carry no locally saved setting. */
export function nativeAutomationsSetting(entries: readonly ConfigEntry[],
  sources: NativeAutomationsSources = { env: process.env, read: path => readAutomationsSource(path) }): NativeAutomationsSetting {
  const flags = (sources.env.OPENCODE_FLAGS ?? "").split(",").map(item => item.trim())
  const inlineText = sources.env[INLINE_CONFIG_SOURCE]
  const inline = inlineText ? legacyAutomationsOff(inlineText, sources.env) : false
  const documents = [...entries].reverse().flatMap(entry => entry.type === "document" ? [entry] : [])
  const inlineEntry = documents.find(entry => !entry.path)
  let decided: Omit<NativeAutomationsSetting, "hiddenOff"> | undefined
  const hiddenOff: string[] = []
  const off = (path: string, source: "setting" | "legacy-off") => {
    if (!decided) decided = { enabled: false, source, path }
    else hiddenOff.push(path)
  }
  if (flags.includes("-automations") || flags.includes("-schedules")) decided = { enabled: false, source: "environment" }
  for (const entry of documents) {
    const label = entry.path ?? INLINE_CONFIG_SOURCE
    const value = (entry.info as { automations?: unknown }).automations
    if (value !== undefined) {
      if (typeof value !== "boolean") throw new Error("Native automations setting invalid")
      if (value === false) off(label, "setting")
      else decided ??= { enabled: true, source: "setting", path: label }
      continue
    }
    if (entry.path ? sources.read(entry.path).off : entry === inlineEntry && inline) off(label, "legacy-off")
  }
  return { ...(decided ?? { enabled: true, source: "default" }), hiddenOff }
}
