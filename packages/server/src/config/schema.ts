import { z } from "zod"

const ModelPreferenceSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
})

const AgentModelSelectionSchema = z.record(z.string(), ModelPreferenceSchema)
const AgentModelSelectionsSchema = z.record(z.string(), AgentModelSelectionSchema)

const PreferencesSchema = z
  .object({
  showThinkingBlocks: z.boolean().default(false),
  thinkingBlocksExpansion: z.enum(["expanded", "collapsed"]).default("expanded"),
  showTimelineTools: z.boolean().default(true),
  promptSubmitOnEnter: z.boolean().default(false),
  lastUsedBinary: z.string().optional(),
  locale: z.string().optional(),
  environmentVariables: z.record(z.string()).default({}),
  modelRecents: z.array(ModelPreferenceSchema).default([]),
  modelFavorites: z.array(ModelPreferenceSchema).default([]),
  modelThinkingSelections: z.record(z.string(), z.string()).default({}),
  diffViewMode: z.enum(["split", "unified"]).default("split"),
  toolOutputExpansion: z.enum(["expanded", "collapsed"]).default("expanded"),
  diagnosticsExpansion: z.enum(["expanded", "collapsed"]).default("expanded"),
  showUsageMetrics: z.boolean().default(true),
  autoCleanupBlankSessions: z.boolean().default(true),
  listeningMode: z.enum(["local", "all"]).default("local"),

  // OS notifications
  osNotificationsEnabled: z.boolean().default(false),
  osNotificationsAllowWhenVisible: z.boolean().default(false),
  notifyOnNeedsInput: z.boolean().default(true),
  notifyOnIdle: z.boolean().default(true),
  })
  // Preserve unknown preference keys so newer configs survive older binaries.
  .passthrough()

const RecentFolderSchema = z.object({
  path: z.string(),
  lastAccessed: z.number().nonnegative(),
})

const OpenCodeBinarySchema = z.object({
  path: z.string(),
  version: z.string().optional(),
  lastUsed: z.number().nonnegative(),
  label: z.string().optional(),
})

const ConfigFileSchema = z
  .object({
    preferences: PreferencesSchema.default({}),
    recentFolders: z.array(RecentFolderSchema).default([]),
    opencodeBinaries: z.array(OpenCodeBinarySchema).default([]),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  // Preserve unknown top-level keys so optional future features survive downgrades.
  .passthrough()

// On-disk config.yaml only stores stable configuration (not volatile state like recent folders).
const ConfigYamlSchema = z
  .object({
    preferences: PreferencesSchema.default({}),
    opencodeBinaries: z.array(OpenCodeBinarySchema).default([]),
    theme: z.enum(["light", "dark", "system"]).optional(),
  })
  .passthrough()

// On-disk state.yaml stores server-scoped mutable state (per-server, not per-client).
const StateFileSchema = z
  .object({
    recentFolders: z.array(RecentFolderSchema).default([]),
  })
  .passthrough()

const DEFAULT_CONFIG = ConfigFileSchema.parse({})
const DEFAULT_CONFIG_YAML = ConfigYamlSchema.parse({})
const DEFAULT_STATE = StateFileSchema.parse({})

export {
  ModelPreferenceSchema,
  AgentModelSelectionSchema,
  AgentModelSelectionsSchema,
  PreferencesSchema,
  RecentFolderSchema,
  OpenCodeBinarySchema,
  ConfigFileSchema,
  ConfigYamlSchema,
  StateFileSchema,
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_YAML,
  DEFAULT_STATE,
}

export type ModelPreference = z.infer<typeof ModelPreferenceSchema>
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>
export type AgentModelSelections = z.infer<typeof AgentModelSelectionsSchema>
export type Preferences = z.infer<typeof PreferencesSchema>
export type RecentFolder = z.infer<typeof RecentFolderSchema>
export type OpenCodeBinary = z.infer<typeof OpenCodeBinarySchema>
export type ConfigFile = z.infer<typeof ConfigFileSchema>
export type ConfigYamlFile = z.infer<typeof ConfigYamlSchema>
export type StateFile = z.infer<typeof StateFileSchema>
