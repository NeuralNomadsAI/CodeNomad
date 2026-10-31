import { isDeepStrictEqual } from "node:util"
import npa from "npm-package-arg"
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser"
import type { PluginSourceErrorCode } from "../plugin-source-types"
import {
  inferPluginControlFormatting,
  PluginControlDocumentError,
  type PluginConfigEntry,
  type PluginControlDocument,
} from "./plugin-control-document"

export const PLUGIN_SOURCE_MAX_SPEC_LENGTH = 512

export class PluginSourceSpecError extends Error {
  constructor(message: string, readonly code: PluginSourceErrorCode) {
    super(message)
    this.name = "PluginSourceSpecError"
  }
}

/** The target an entry declares: the string itself, or an object entry's `package`. */
export function pluginEntryTarget(entry: PluginConfigEntry): string {
  return typeof entry === "string" ? entry : entry.package
}

/**
 * Accepts only registry (version, range, tag, `npm:` alias) and remote Git specs, as OpenCode's
 * own `plugin add` does. Local paths, tarball URLs, `git+file:`, configuration variables and
 * activation selectors are refused before any file is touched.
 */
export function validatePluginSourceSpec(spec: string): npa.Result {
  if (spec.length === 0 || spec.length > PLUGIN_SOURCE_MAX_SPEC_LENGTH || spec !== spec.trim()
    || /[\s\u0000-\u001f\u007f]/.test(spec)) {
    throw new PluginSourceSpecError("Plugin package spec is invalid", "invalid-spec")
  }
  if (/\{(?:env|file):/i.test(spec)) throw new PluginSourceSpecError("Configuration variables are not accepted in a plugin spec", "invalid-spec")
  if (spec.startsWith("-") || spec.includes("*") || spec.startsWith("opencode.")) {
    throw new PluginSourceSpecError("Plugin activation selectors are not package specs", "plugin-id")
  }
  if (/^(?:\.{1,2}[\\/]|[\\/~]|[a-z]:[\\/]|file:|git\+file:)/i.test(spec)) {
    throw new PluginSourceSpecError("Local plugin paths are not accepted", "local-path")
  }
  let parsed: npa.Result
  try {
    parsed = npa(spec)
  } catch {
    throw new PluginSourceSpecError("Plugin package spec is invalid", "invalid-spec")
  }
  if (parsed.type === "directory" || parsed.type === "file") throw new PluginSourceSpecError("Local plugin paths are not accepted", "local-path")
  if (parsed.type === "alias") {
    const target = (parsed as npa.AliasResult).subSpec
    if (!target?.registry) throw new PluginSourceSpecError("Plugin package alias must name a registry package", "invalid-spec")
  } else if (parsed.type === "git") {
    if (/^file:/i.test(parsed.fetchSpec ?? "")) throw new PluginSourceSpecError("Local plugin paths are not accepted", "local-path")
  } else if (!parsed.registry) {
    throw new PluginSourceSpecError("Only registry and Git plugin specs are accepted", "invalid-spec")
  }
  return parsed
}

/**
 * Normalized keys naming the package a spec installs: registry names (both sides of an alias,
 * case-insensitive, whatever the version, range or tag) and the Git repository without
 * committish. Two specs sharing a key would load the same plugin ID twice. Entries that are not
 * registry or Git specs (local paths, rules) yield no key.
 */
export function pluginPackageIdentities(spec: string): string[] {
  let parsed: npa.Result
  try {
    parsed = npa(spec)
  } catch {
    return []
  }
  const keys = new Set<string>()
  const addName = (name: string | null | undefined) => { if (name) keys.add(`name:${name.toLowerCase()}`) }
  if (parsed.type === "alias") {
    addName(parsed.name)
    addName((parsed as npa.AliasResult).subSpec?.name)
  } else if (parsed.type === "git") {
    addName(parsed.name)
    // hosted-git-info's shortcut (`github:user/repo`) is missing from the published typings.
    const hosted = parsed.hosted as unknown as { shortcut(options: { noCommittish: boolean }): string } | undefined
    const repository = hosted
      ? hosted.shortcut({ noCommittish: true })
      : parsed.fetchSpec?.replace(/#.*$/, "").replace(/\.git$/i, "")
    if (repository) keys.add(`git:${repository.toLowerCase()}`)
  } else if (parsed.registry) {
    addName(parsed.name)
  }
  return [...keys]
}

/**
 * Deletes exactly `plugins[entryIndex]` (string or object entry) while it still declares
 * `target`; anything else is a conflict. The result must parse to the original document minus
 * that element, so comments, other entries, line endings and the BOM stay untouched.
 */
export function removePluginSourceEntry(document: PluginControlDocument, entryIndex: number, target: string): string {
  const entry = document.plugins[entryIndex]
  if (!Number.isSafeInteger(entryIndex) || entryIndex < 0 || entry === undefined || pluginEntryTarget(entry) !== target) {
    throw new PluginControlDocumentError("OpenCode plugin entry changed since it was displayed", "conflict")
  }
  const formatting = inferPluginControlFormatting(document.text)
  let updated: string
  try {
    updated = applyEdits(document.text, modify(document.text, ["plugins", entryIndex], undefined, { formattingOptions: formatting }))
  } catch (error) {
    throw new PluginControlDocumentError("Unable to update OpenCode plugins without replacing the document", "invalid", { cause: error })
  }
  const original = parse(document.text, [], { allowTrailingComma: true }) as Record<string, unknown>
  const expected = { ...original, plugins: (original.plugins as unknown[]).filter((_, at) => at !== entryIndex) }
  const errors: ParseError[] = []
  const result = parse(updated, errors, { allowTrailingComma: true })
  if (errors.length || !isDeepStrictEqual(result, expected)) {
    throw new PluginControlDocumentError("Unable to remove the OpenCode plugin entry without changing other settings", "invalid")
  }
  return `${document.byteOrderMark ? "﻿" : ""}${updated}${updated.endsWith("\n") ? "" : formatting.eol}`
}
