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
  diagnosticsExpansion: z.enum(["hidden", "expanded", "collapsed"]).default("expanded"),
  systemMessagesVisibility: z.enum(["hidden", "expanded", "collapsed"]).default("hidden"),
  showUsageMetrics: z.boolean().default(true),
  usageMetricsExpansion: z.enum(["expanded", "collapsed"]).default("collapsed"),
  autoCleanupBlankSessions: z.boolean().default(true),
  listeningMode: z.enum(["local", "all"]).default("local"),
  logLevel: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]).default("DEBUG"),

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
  projectName: z.string().optional(),
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

export const LiveVoiceProviderSchema = z.enum(["gemini", "openai"])

export const SpeechLiveConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    provider: LiveVoiceProviderSchema.default("gemini"),
    geminiApiKey: z.string().nullish(),
    openaiApiKey: z.string().nullish(),
    geminiModel: z.string().optional().default("gemini-2.0-flash-exp"),
    openaiModel: z.string().optional().default("gpt-4o-realtime-preview"),
    geminiVoice: z.string().optional().default("Aoede"),
    openaiVoice: z.string().optional().default("alloy"),
    systemPrompt: z.string().nullish(),
  })
  .passthrough()

export const ServerSpeechConfigSchema = z
  .object({
    provider: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    sttModel: z.string().optional(),
    ttsModel: z.string().optional(),
    ttsVoice: z.string().optional(),
    ttsFormat: z.enum(["mp3", "wav", "opus", "aac"]).optional(),
    separateProviders: z.boolean().optional(),
    stt: z
      .object({
        apiKey: z.string().nullish(),
        baseUrl: z.string().nullish(),
        model: z.string().nullish(),
      })
      .optional(),
    tts: z
      .object({
        apiKey: z.string().nullish(),
        baseUrl: z.string().nullish(),
        model: z.string().nullish(),
      })
      .optional(),
    live: SpeechLiveConfigSchema.optional(),
  })
  .passthrough()

export const ServerConfigSchema = z
  .object({
    speech: ServerSpeechConfigSchema.optional(),
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
export type LiveVoiceProviderConfig = z.infer<typeof LiveVoiceProviderSchema>
export type SpeechLiveConfig = z.infer<typeof SpeechLiveConfigSchema>
export type ServerSpeechConfig = z.infer<typeof ServerSpeechConfigSchema>
export type ServerConfig = z.infer<typeof ServerConfigSchema>
