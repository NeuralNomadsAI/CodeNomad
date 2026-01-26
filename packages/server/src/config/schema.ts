import { z } from "zod"

const ModelPreferenceSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
})

const AgentModelSelectionSchema = z.record(z.string(), ModelPreferenceSchema)
const AgentModelSelectionsSchema = z.record(z.string(), AgentModelSelectionSchema)

const PreferencesSchema = z.object({
  showThinkingBlocks: z.boolean().default(false),
  thinkingBlocksExpansion: z.enum(["expanded", "collapsed"]).default("expanded"),
  showTimelineTools: z.boolean().default(true),
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
})

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

const ConfigFileSchema = z.object({
  preferences: PreferencesSchema.default({}),
  recentFolders: z.array(RecentFolderSchema).default([]),
  opencodeBinaries: z.array(OpenCodeBinarySchema).default([]),
  theme: z.enum(["light", "dark", "system"]).optional(),
})

const DEFAULT_CONFIG = ConfigFileSchema.parse({})

export {
  ModelPreferenceSchema,
  AgentModelSelectionSchema,
  AgentModelSelectionsSchema,
  PreferencesSchema,
  RecentFolderSchema,
  OpenCodeBinarySchema,
  ConfigFileSchema,
  DEFAULT_CONFIG,
}

export type ModelPreference = z.infer<typeof ModelPreferenceSchema>
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>
export type AgentModelSelections = z.infer<typeof AgentModelSelectionsSchema>
export type Preferences = z.infer<typeof PreferencesSchema>
export type RecentFolder = z.infer<typeof RecentFolderSchema>
export type OpenCodeBinary = z.infer<typeof OpenCodeBinarySchema>
export type ConfigFile = z.infer<typeof ConfigFileSchema>
