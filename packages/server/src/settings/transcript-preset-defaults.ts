import { isPlainObject } from "./merge-patch"

const CONFIGURABLE_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "patch",
  "webfetch",
  "websearch",
  "glob",
  "grep",
  "task",
  "execute",
  "skill",
  "question",
  "invalid",
  "other",
] as const

const BALANCED_EXPANDED_TOOLS = new Set(["bash", "write", "edit", "patch", "task", "execute", "question"])
const DETAILED_COLLAPSED_TOOLS = new Set(["read", "skill", "invalid"])

function isVisibility(value: unknown): value is "hidden" | "collapsed" | "expanded" {
  return value === "hidden" || value === "collapsed" || value === "expanded"
}

function isExpansion(value: unknown): value is "collapsed" | "expanded" {
  return value === "collapsed" || value === "expanded"
}

function toolDefaultForPreset(
  preset: unknown,
  tool: string,
  baseTools: Record<string, unknown>,
  baseToolOutput: unknown,
): "hidden" | "collapsed" | "expanded" {
  if (preset === "nothing") return "hidden"
  if (preset === "everything") return "expanded"
  if (preset === "minimal") return "collapsed"
  if (preset === "detailed") {
    if (DETAILED_COLLAPSED_TOOLS.has(tool)) return "collapsed"
    return isVisibility(baseTools.other) ? baseTools.other : "expanded"
  }
  if (preset === "custom") {
    if (isVisibility(baseTools.other)) return baseTools.other
    return isExpansion(baseToolOutput) ? baseToolOutput : "expanded"
  }
  return BALANCED_EXPANDED_TOOLS.has(tool) ? "expanded" : "collapsed"
}

export function transcriptPresetFallbacks(preset: unknown) {
  return {
    toolGroupVisibility: preset === "everything" ? "expanded" : "collapsed",
    usageMetricsExpansion: preset === "everything" || preset === "custom" || preset === "detailed" ? "expanded" : "collapsed",
  } as const
}

export function stripNullEntriesForNewObjects(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): boolean {
  let changed = false
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === null) {
      if (!base) {
        delete patch[key]
        changed = true
      }
      continue
    }
    if (isPlainObject(value)) {
      const nextBase = base && isPlainObject(base[key]) ? (base[key] as Record<string, unknown>) : undefined
      const copy: Record<string, unknown> = { ...value }
      if (stripNullEntriesForNewObjects(nextBase, copy)) {
        patch[key] = copy
        changed = true
      }
    }
  }
  return changed
}

export function stripNewObjectNulls(owner: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch
  const ownerObj = isPlainObject(owner) ? (owner as Record<string, unknown>) : undefined
  const copy: Record<string, unknown> = { ...patch }
  return stripNullEntriesForNewObjects(ownerObj, copy) ? copy : patch
}

const NOTIFICATION_CATEGORIES = [
  "needsInput", "sessionDone", "updates", "files", "projects", "sessions", "opencode", "copy", "settings",
] as const
const NOTIFICATION_DESTINATIONS = ["screen", "history", "system"] as const
const DEFAULT_SYSTEM_CATEGORIES = new Set<string>(["needsInput", "sessionDone", "updates"])
const DEFAULT_HISTORY_CATEGORIES = new Set<string>(["updates", "files", "projects", "opencode"])

function seedNotificationRouting(base: Record<string, unknown>, patchRouting: Record<string, unknown>): Record<string, unknown> {
  const osEnabled = base.osNotificationsEnabled !== false
  const seeded: Record<string, unknown> = {}
  for (const category of NOTIFICATION_CATEGORIES) {
    if (Object.hasOwn(patchRouting, category) && patchRouting[category] === null) continue
    const incoming = isPlainObject(patchRouting[category]) ? (patchRouting[category] as Record<string, unknown>) : {}
    let systemDefault = DEFAULT_SYSTEM_CATEGORIES.has(category) && osEnabled
    if (category === "needsInput") systemDefault &&= base.notifyOnNeedsInput !== false
    if (category === "sessionDone") systemDefault &&= base.notifyOnIdle !== false
    const defaults: Record<string, boolean> = {
      screen: category !== "needsInput" && category !== "sessionDone",
      history: DEFAULT_HISTORY_CATEGORIES.has(category),
      system: systemDefault,
    }
    const row: Record<string, unknown> = { ...incoming }
    for (const dest of NOTIFICATION_DESTINATIONS) {
      if (!Object.hasOwn(row, dest)) row[dest] = defaults[dest]
    }
    seeded[category] = row
  }
  for (const [key, value] of Object.entries(patchRouting)) {
    if (!Object.hasOwn(seeded, key)) seeded[key] = value
  }
  return seeded
}

export function applySecureEnvVarsMask(owner: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch
  const ownerObj = isPlainObject(owner) ? (owner as Record<string, unknown>) : undefined
  const next: Record<string, unknown> = { ...patch }
  let modified = false
  if (Object.hasOwn(patch, "secureEnvVarsMask")) {
    const mask = patch.secureEnvVarsMask
    if (!isPlainObject(mask) || Object.values(mask).some((value) => typeof value !== "boolean")) {
      throw new Error("Invalid secureEnvVarsMask")
    }
    delete next.secureEnvVarsMask
    modified = true
    const survivingEnvKeys = new Set<string>()
    const beforeEnv = ownerObj && isPlainObject(ownerObj.environmentVariables)
      ? (ownerObj.environmentVariables as Record<string, unknown>)
      : undefined
    if (beforeEnv) {
      for (const [k, v] of Object.entries(beforeEnv)) {
        if (v !== null && v !== undefined) {
          survivingEnvKeys.add(k)
        }
      }
    }
    const deletedEnvKeys = new Set<string>()
    if (Object.hasOwn(patch, "environmentVariables")) {
      if (patch.environmentVariables === null) {
        for (const k of survivingEnvKeys) deletedEnvKeys.add(k)
        survivingEnvKeys.clear()
      } else if (isPlainObject(patch.environmentVariables)) {
        for (const [k, v] of Object.entries(patch.environmentVariables as Record<string, unknown>)) {
          if (v === null) {
            survivingEnvKeys.delete(k)
            deletedEnvKeys.add(k)
          } else if (v !== undefined) {
            survivingEnvKeys.add(k)
          }
        }
      }
    }
    const hasCaseSibling = (name: string) => {
      const upper = name.toUpperCase()
      for (const key of survivingEnvKeys) {
        if (key !== name && key.toUpperCase() === upper) return true
      }
      return false
    }
    const source = Object.hasOwn(patch, "secureEnvVars") && patch.secureEnvVars === null
      ? []
      : Array.isArray(patch.secureEnvVars)
        ? patch.secureEnvVars
        : ownerObj && Array.isArray(ownerObj.secureEnvVars)
          ? ownerObj.secureEnvVars
          : []
    const masked: string[] = source.filter((item): item is string => typeof item === "string")
    const entries = Object.entries(mask)
      .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    for (const [name, wantMasked] of entries) {
      if (wantMasked) continue
      // Deleting one POSIX case-variant must not unmask a surviving sibling with another casing.
      if (deletedEnvKeys.has(name) && hasCaseSibling(name)) {
        continue
      }
      const upper = name.toUpperCase()
      for (let i = masked.length - 1; i >= 0; i--) {
        if (masked[i].toUpperCase() === upper) {
          masked.splice(i, 1)
        }
      }
    }
    for (const [name, wantMasked] of entries) {
      if (!wantMasked) continue
      const upper = name.toUpperCase()
      for (let i = masked.length - 1; i >= 0; i--) {
        if (masked[i].toUpperCase() === upper) {
          masked.splice(i, 1)
        }
      }
      masked.push(name)
    }
    next.secureEnvVars = masked
  }
  const stripped = stripNullEntriesForNewObjects(ownerObj, next)
  return modified || stripped ? next : patch
}

export function preserveLegacyTranscriptDefaults(owner: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return patch
  const ownerIsObject = isPlainObject(owner)
  if (!isPlainObject(patch.settings)) {
    const copy: Record<string, unknown> = { ...patch }
    return stripNullEntriesForNewObjects(ownerIsObject ? (owner as Record<string, unknown>) : undefined, copy)
      ? copy
      : patch
  }
  const changes = patch.settings
  const baseIsObject = ownerIsObject && isPlainObject((owner as Record<string, unknown>).settings)
  const base = baseIsObject ? ((owner as Record<string, unknown>).settings as Record<string, unknown>) : {}
  const baseDefaultsIsObject = isPlainObject(base.toolCallExpansionDefaults)
  const baseDefaults = baseDefaultsIsObject ? (base.toolCallExpansionDefaults as Record<string, unknown>) : {}
  const baseToolsIsObject = isPlainObject(baseDefaults.tools)
  const baseTools = baseToolsIsObject ? (baseDefaults.tools as Record<string, unknown>) : {}
  const preset = baseDefaults.preset
  const inherited = transcriptPresetFallbacks(preset)
  const custom = transcriptPresetFallbacks("custom")
  const settings: Record<string, unknown> = { ...changes }
  let modified = false

  if (
    changes.showUsageMetrics === false &&
    !Object.hasOwn(changes, "usageMetricsExpansion") &&
    !isExpansion(base.usageMetricsExpansion)
  ) {
    settings.usageMetricsExpansion = inherited.usageMetricsExpansion
    modified = true
  }

  if (isPlainObject(changes.toolCallExpansionDefaults)) {
    const patchDefaults = changes.toolCallExpansionDefaults
    const nextDefaults: Record<string, unknown> = { ...patchDefaults }
    let defaultsModified = false

    if (patchDefaults.preset === "custom") {
      for (const key of ["toolGroupVisibility", "usageMetricsExpansion"] as const) {
        if (inherited[key] === custom[key] || Object.hasOwn(changes, key) || Object.hasOwn(settings, key)) continue
        const saved = base[key]
        if (saved === "collapsed" || saved === "expanded" || (key === "toolGroupVisibility" && saved === "hidden")) continue
        settings[key] = inherited[key]
        modified = true
      }

      const hasExplicitToolsDeletion = Object.hasOwn(patchDefaults, "tools") && !isPlainObject(patchDefaults.tools)
      const touchesCustomToolsOrThinking =
        isPlainObject(patchDefaults.tools) ||
        Object.hasOwn(changes, "showThinkingBlocks") ||
        Object.hasOwn(changes, "thinkingBlocksExpansion") ||
        Object.hasOwn(patchDefaults, "thinking")
      if (touchesCustomToolsOrThinking && !Object.hasOwn(patchDefaults, "thinking") && !isExpansion(baseDefaults.thinking)) {
        const thinkingSource = Object.hasOwn(changes, "thinkingBlocksExpansion")
          ? changes.thinkingBlocksExpansion
          : base.thinkingBlocksExpansion
        nextDefaults.thinking = isExpansion(thinkingSource) ? thinkingSource : "collapsed"
        defaultsModified = true
      }
      const patchTools = isPlainObject(patchDefaults.tools) ? patchDefaults.tools : {}
      const nextOther = isVisibility(patchTools.other)
        ? patchTools.other
        : Object.hasOwn(patchTools, "other")
          ? undefined
          : isVisibility(baseTools.other)
            ? baseTools.other
            : undefined
      const nextToolOutput = isExpansion(changes.toolOutputExpansion)
        ? changes.toolOutputExpansion
        : Object.hasOwn(changes, "toolOutputExpansion")
          ? undefined
          : isExpansion(base.toolOutputExpansion)
            ? base.toolOutputExpansion
            : undefined
      const customToolFallback = nextOther ?? nextToolOutput ?? "expanded"
      const changesAnyToolDefault = CONFIGURABLE_TOOLS.some(
        (tool) =>
          !Object.hasOwn(patchTools, tool) &&
          !isVisibility(baseTools[tool]) &&
          toolDefaultForPreset(preset, tool, baseTools, base.toolOutputExpansion) !== customToolFallback,
      )
      const shouldMaterializeTools =
        !hasExplicitToolsDeletion &&
        ((preset !== "custom" && touchesCustomToolsOrThinking) || changesAnyToolDefault)
      if (shouldMaterializeTools) {
        const nextTools: Record<string, unknown> = { ...patchTools }
        let addedTool = false
        for (const tool of CONFIGURABLE_TOOLS) {
          if (Object.hasOwn(patchTools, tool) || isVisibility(baseTools[tool])) continue
          nextTools[tool] = toolDefaultForPreset(preset, tool, baseTools, base.toolOutputExpansion)
          addedTool = true
        }
        if (addedTool) {
          nextDefaults.tools = nextTools
          defaultsModified = true
        }
      }
    }

    if (defaultsModified) {
      settings.toolCallExpansionDefaults = nextDefaults
      modified = true
    }
  }
  if (isPlainObject(changes.notificationRouting) && !isPlainObject(base.notificationRouting)) {
    settings.notificationRouting = seedNotificationRouting(base, changes.notificationRouting)
    modified = true
  }
  const result: Record<string, unknown> = modified ? { ...patch, settings } : { ...patch, settings: { ...settings } }
  const stripped = stripNullEntriesForNewObjects(ownerIsObject ? (owner as Record<string, unknown>) : undefined, result)
  return modified || stripped ? result : patch
}
