import { open } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parse, type ParseError } from "jsonc-parser"
import type { ConfigEntry } from "@opencode/client"

const MAX_DOCUMENT_BYTES = 1024 * 1024
export const INLINE_CONFIG_SOURCE = "OPENCODE_CONFIG_CONTENT"
/** Pathless configuration other than inline config: served remotely by a provider or organization. */
export const REMOTE_CONFIG_SOURCE = "well-known"
export type NativeAutomationsSetting = {
  enabled: boolean
  source: "setting" | "legacy-off" | "environment" | "default"
  /** The deciding document's path, or `OPENCODE_CONFIG_CONTENT`/`well-known` for pathless config. */
  path?: string
  /** Every other legacy or top-level OFF, as activation refuses any explicit OFF. */
  hiddenOff: string[]
}
type Env = Readonly<Record<string, string | undefined>>
export type NativeAutomationsSources = { env: Env; readText(file: string): Promise<string>; budget?: Budget }
/** One flag read inspects at most this many bytes of documents and substituted values, and this many
 * references; beyond them the setting is unknown. */
type Budget = { bytes: number; references: number }
const BUDGET_BYTES = 8 * 1024 * 1024, BUDGET_REFERENCES = 64
const spend = (sources: NativeAutomationsSources, bytes: number, references = 0) => {
  const budget = sources.budget
  if (!budget) return
  budget.bytes += bytes; budget.references += references
  if (budget.bytes > BUDGET_BYTES || budget.references > BUDGET_REFERENCES) throw unreadable()
}
const unreadable = () => new Error("Native automations setting unreadable")

async function readBounded(file: string) {
  const handle = await open(file, "r").catch(() => { throw unreadable() })
  try {
    if (!(await handle.stat()).isFile()) throw unreadable()
    // One handle, at most one byte past the limit, whatever the file became since it was listed.
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1)
    let size = 0
    for (;;) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > MAX_DOCUMENT_BYTES) throw unreadable()
    }
    return bytes.subarray(0, size).toString("utf8")
  } finally { await handle.close() }
}
const defaults: NativeAutomationsSources = { env: process.env, readText: readBounded }

/** OpenCode's `{env:}` and `{file:}` substitution (core/src/config/variable.ts): raw environment
 * values first, JSON-escaped ones only when the raw text does not parse; file contents are
 * JSON-escaped, and a missing or unreadable file substitutes empty, as OpenCode does. */
async function substitute(text: string, directory: string, sources: NativeAutomationsSources) {
  const env = (escape: boolean) => text.replace(/\{env:([^}]+)\}/g, (_, name: string) => {
    const value = sources.env[name] || ""
    const replacement = escape ? JSON.stringify(value).slice(1, -1) : value
    spend(sources, Buffer.byteLength(replacement))
    return replacement
  })
  const files = async (input: string) => {
    let out = "", cursor = 0
    for (const match of input.matchAll(/\{file:[^}]+\}/g)) {
      const index = match.index!, token = match[0]
      out += input.slice(cursor, index); cursor = index + token.length
      if (input.slice(input.lastIndexOf("\n", index - 1) + 1, index).trimStart().startsWith("//")) { out += token; continue }
      const name = token.slice("{file:".length, -1)
      const resolved = path.resolve(directory, name.startsWith("~/") ? path.join(os.homedir(), name.slice(2)) : name)
      spend(sources, 0, 1)
      const content = await sources.readText(resolved).catch(() => "")
      const escaped = JSON.stringify(content.trim()).slice(1, -1)
      spend(sources, Buffer.byteLength(escaped))
      out += escaped
    }
    return out + input.slice(cursor)
  }
  const raw = await files(env(false)), errors: ParseError[] = []
  if (text.includes("{env:")) parse(raw, errors, { allowTrailingComma: true })
  return errors.length ? files(env(true)) : raw
}

/** A managed preference plist (XML or binary), which OpenCode converts before publishing its entry.
 * Any other file, whatever its name, is JSONC as OpenCode's file loader reads it. */
const managedPreferences = (text: string) => /^(?:﻿?\s*(?:<\?xml|<!DOCTYPE plist|<plist)|bplist0)/.test(text)

/** The legacy `experimental.automations` (or its `schedules` alias) is OFF, decoded as 2.3.2 did:
 * only booleans count, the canonical key before the alias. Text OpenCode would not parse is unknown. */
export async function legacyAutomationsOff(text: string, directory: string, sources: NativeAutomationsSources = defaults): Promise<boolean> {
  const errors: ParseError[] = []
  const raw = parse(await substitute(text.replace(/^﻿/, ""), directory, sources), errors, { allowTrailingComma: true })
  if (errors.length) throw unreadable()
  const experimental = raw && typeof raw === "object" ? (raw as { experimental?: unknown }).experimental : undefined
  if (!experimental || typeof experimental !== "object") return false
  const block = experimental as { automations?: unknown; schedules?: unknown }
  const value = typeof block.automations === "boolean" ? block.automations : block.schedules
  return value === false
}

/** OpenCode's top-level `automations`: the highest-priority document that sets it, on by default.
 * An explicit legacy OFF (in a local JSON/JSONC document, in inline config, or
 * `-automations`/`-schedules` in `OPENCODE_FLAGS`) keeps Missions schedules off unless a newer
 * top-level choice above it decides, so an upgrade never turns them back on. Managed preference
 * plists and remote (well-known) configuration are administered for the runtime that reads them
 * and are not inspected for the legacy block. Inline config is the highest-priority pathless document. */
export async function nativeAutomationsSetting(entries: readonly ConfigEntry[], directory: string,
  given: NativeAutomationsSources = defaults): Promise<NativeAutomationsSetting> {
  const sources = { ...given, budget: { bytes: 0, references: 0 } }
  const flags = (sources.env.OPENCODE_FLAGS ?? "").split(",").map(item => item.trim())
  const inlineText = sources.env[INLINE_CONFIG_SOURCE]
  const documents = [...entries].reverse().flatMap(entry => entry.type === "document" ? [entry] : [])
  const inlineEntry = inlineText ? documents.find(entry => !entry.path) : undefined
  let decided: Omit<NativeAutomationsSetting, "hiddenOff"> | undefined
  const off: string[] = []
  if (flags.includes("-automations") || flags.includes("-schedules")) decided = { enabled: false, source: "environment" }
  for (const entry of documents) {
    const label = entry.path ?? (entry === inlineEntry ? INLINE_CONFIG_SOURCE : REMOTE_CONFIG_SOURCE)
    const value = (entry.info as { automations?: unknown }).automations
    if (value !== undefined && typeof value !== "boolean") throw new Error("Native automations setting invalid")
    // Inline `{file:}` references resolve from the Location, as OpenCode resolves them.
    const text = entry.path ? await sources.readText(entry.path) : entry === inlineEntry ? inlineText! : undefined
    if (text !== undefined) spend(sources, Buffer.byteLength(text))
    const legacy = text !== undefined && !managedPreferences(text)
      && await legacyAutomationsOff(text, entry.path ? path.dirname(entry.path) : directory, sources)
    const deciding = !decided && (value !== undefined || legacy)
    if (deciding) decided = value !== undefined ? { enabled: value, source: "setting", path: label } : { enabled: false, source: "legacy-off", path: label }
    // The deciding OFF is reported as the decision; any other OFF, including a legacy OFF beside
    // a deciding top-level ON in the same document, is hidden.
    if (value === false && !deciding || legacy && !(deciding && value === undefined)) off.push(label)
  }
  return { ...(decided ?? { enabled: true, source: "default" }), hiddenOff: off }
}
