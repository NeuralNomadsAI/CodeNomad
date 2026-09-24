import type { SettingsService } from "../settings/service"
import type { LiveVoiceProvider } from "../api-types"

export interface LiveUpstreamOptions {
  host: string
  port: number
  path: string
  headers: Record<string, string>
  secure: boolean
}

export interface ResolveLiveUpstreamParams {
  provider?: LiveVoiceProvider
  model?: string
  voice?: string
}

interface ServerLiveSettings {
  geminiApiKey?: string | null
  openaiApiKey?: string | null
  geminiModel?: string
  openaiModel?: string
  geminiVoice?: string
  openaiVoice?: string
  provider?: LiveVoiceProvider
}

interface ServerSettingsDoc {
  speech?: {
    apiKey?: string
    live?: ServerLiveSettings
  }
}

export function resolveLiveUpstream(
  settings: SettingsService,
  params: ResolveLiveUpstreamParams = {},
): LiveUpstreamOptions {
  const config = (settings.getOwner("config", "server") ?? {}) as ServerSettingsDoc
  const live = config.speech?.live ?? {}
  const speech = config.speech ?? {}

  const provider: LiveVoiceProvider = params.provider ?? live.provider ?? "gemini"

  if (provider === "gemini") {
    const apiKey = live.geminiApiKey?.trim() || process.env.GEMINI_API_KEY
    if (!apiKey) {
      throw new Error("Gemini API key is not configured for live speech")
    }

    const host = "generativelanguage.googleapis.com"
    const port = 443
    const path = `/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`

    return {
      host,
      port,
      path,
      headers: {},
      secure: true,
    }
  }

  if (provider === "openai") {
    const apiKey = live.openaiApiKey?.trim() || speech.apiKey?.trim() || process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error("OpenAI API key is not configured for live speech")
    }

    const model = params.model?.trim() || live.openaiModel?.trim() || "gpt-4o-realtime-preview"
    const host = "api.openai.com"
    const port = 443
    const path = `/v1/realtime?model=${encodeURIComponent(model)}`

    return {
      host,
      port,
      path,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
      secure: true,
    }
  }

  throw new Error(`Unsupported live speech provider: ${String(provider)}`)
}
