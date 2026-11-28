import { z } from "zod"
import type { PublicVoiceConversationConfig, VoiceConversationCapabilities, VoiceConversationProvider } from "../api-types"
import { isPlainObject } from "../settings/merge-patch"

export interface VoiceConversationProviderSettings {
  provider: VoiceConversationProvider
  apiKey: string
  model: string
  voice?: string
}

const ApiKeySchema = z.string().trim().regex(/^[!-~]{1,4096}$/)
const ModelSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/)
const VoiceSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const ProviderSchema = z.object({ apiKey: ApiKeySchema, model: ModelSchema, voice: VoiceSchema.nullish() }).strict()
const ProviderPatchSchema = ProviderSchema.extend({
  apiKey: ApiKeySchema.nullish(), model: ModelSchema.nullish(),
})
const VoiceConversationPatchSchema = z.object({
  geminiLive: ProviderPatchSchema.nullish(),
  openaiRealtime: ProviderPatchSchema.nullish(),
}).strict().nullish()

export function assertVoiceConversationPatch(serverPatch: unknown): void {
  if (isPlainObject(serverPatch) && !VoiceConversationPatchSchema.safeParse(serverPatch.voiceConversation).success) {
    throw new Error("Invalid voice conversation settings patch")
  }
}

export function resolveVoiceConversationProvider(
  value: unknown,
  provider: VoiceConversationProvider,
): VoiceConversationProviderSettings | undefined {
  if (!isPlainObject(value) || !isPlainObject(value[provider])) return undefined
  const parsed = ProviderSchema.safeParse(value[provider])
  if (!parsed.success) return undefined
  const { apiKey, model, voice } = parsed.data
  return { provider, apiKey, model, ...(voice ? { voice } : {}) }
}

export function publicVoiceConversationConfig(value: unknown): PublicVoiceConversationConfig | undefined {
  if (!isPlainObject(value)) return undefined
  // A public model/voice can be edited alongside either private credential.
  const secrets = ["geminiLive", "openaiRealtime"].map(provider => {
    const raw = value[provider]
    return isPlainObject(raw) && typeof raw.apiKey === "string" ? raw.apiKey.trim() : undefined
  })
  const project = (provider: VoiceConversationProvider) => {
    const raw = value[provider]
    if (!isPlainObject(raw)) return { hasApiKey: false }
    const model = ModelSchema.safeParse(raw.model)
    const voice = VoiceSchema.safeParse(raw.voice)
    return {
      hasApiKey: ApiKeySchema.safeParse(raw.apiKey).success,
      ...(model.success && !secrets.includes(model.data) ? { model: model.data } : {}),
      ...(voice.success && ProviderPatchSchema.safeParse(raw).success && !secrets.includes(voice.data) ? { voice: voice.data } : {}),
    }
  }
  return { geminiLive: project("geminiLive"), openaiRealtime: project("openaiRealtime") }
}

export function voiceConversationCapabilities(value: unknown): VoiceConversationCapabilities {
  return {
    geminiLive: { configured: Boolean(resolveVoiceConversationProvider(value, "geminiLive")) },
    openaiRealtime: { configured: Boolean(resolveVoiceConversationProvider(value, "openaiRealtime")) },
  }
}
