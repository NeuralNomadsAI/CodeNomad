import { z } from "zod"

const ModelPreferenceSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
})

const AgentModelSelectionSchema = z.record(z.string(), ModelPreferenceSchema)
const AgentModelSelectionsSchema = z.record(z.string(), AgentModelSelectionSchema)

const McpLocalServerConfigSchema = z.object({
  type: z.literal("local"),
  command: z.array(z.string()).min(1),
  environment: z.record(z.string()).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
})

const McpRemoteServerConfigSchema = z.object({
  type: z.literal("remote"),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  oauth: z.union([z.boolean(), z.record(z.unknown())]).optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
})

const McpServerConfigSchema = z.union([McpLocalServerConfigSchema, McpRemoteServerConfigSchema])

const PreferencesSchema = z.object({
  showThinkingBlocks: z.boolean().default(false),
  thinkingBlocksExpansion: z.enum(["expanded", "collapsed"]).default("expanded"),
  showTimelineTools: z.boolean().default(true),
  lastUsedBinary: z.string().optional(),
  // Tracks whether lastUsedBinary was explicitly set by user or auto-detected
  // "user" = user explicitly selected this binary, honor their choice
  // "auto" = system auto-detected/defaulted, can be overridden by era-code detection
  binaryPreferenceSource: z.enum(["user", "auto"]).default("auto"),
  environmentVariables: z.record(z.string()).default({}),
  modelRecents: z.array(ModelPreferenceSchema).default([]),
  diffViewMode: z.enum(["split", "unified"]).default("split"),
  toolOutputExpansion: z.enum(["expanded", "collapsed"]).default("expanded"),
  diagnosticsExpansion: z.enum(["expanded", "collapsed"]).default("expanded"),
  showUsageMetrics: z.boolean().default(true),
  autoCleanupBlankSessions: z.boolean().default(true),
  stopInstanceOnLastSessionDelete: z.boolean().default(false),
  idleInstanceTimeoutMinutes: z.number().min(0).default(0), // 0 = disabled
  listeningMode: z.enum(["local", "all"]).default("local"),

  // Permissions
  autoApprovePermissions: z.boolean().default(true), // Skip permission prompts by default

  modelDefaultsByAgent: z.record(ModelPreferenceSchema).default({}),

  mcpRegistry: z.record(McpServerConfigSchema).default({}),
  mcpDesiredState: z.record(z.boolean()).default({}),
  mcpAutoApply: z.boolean().default(true),
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
  McpLocalServerConfigSchema,
  McpRemoteServerConfigSchema,
  McpServerConfigSchema,
  PreferencesSchema,
  RecentFolderSchema,
  OpenCodeBinarySchema,
  ConfigFileSchema,
  DEFAULT_CONFIG,
}

export type ModelPreference = z.infer<typeof ModelPreferenceSchema>
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>
export type AgentModelSelections = z.infer<typeof AgentModelSelectionsSchema>
export type McpLocalServerConfig = z.infer<typeof McpLocalServerConfigSchema>
export type McpRemoteServerConfig = z.infer<typeof McpRemoteServerConfigSchema>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
export type Preferences = z.infer<typeof PreferencesSchema>
export type RecentFolder = z.infer<typeof RecentFolderSchema>
export type OpenCodeBinary = z.infer<typeof OpenCodeBinarySchema>
export type ConfigFile = z.infer<typeof ConfigFileSchema>
