import { z } from "zod"
import type { Logger } from "../logger"
import type { SettingsService } from "../settings/service"
import type { SpeechCapabilitiesResponse, SpeechSynthesisResponse, SpeechTranscriptionResponse } from "../api-types"
import { OpenAICompatibleSpeechProvider } from "./providers/openai-compatible"

const ServerSpeechSettingsSchema = z.object({
  speech: z
    .object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      sttModel: z.string().optional(),
      ttsModel: z.string().optional(),
      ttsVoice: z.string().optional(),
    })
    .optional(),
})

export interface TranscribeAudioInput {
  audioBase64: string
  mimeType: string
  filename?: string
  language?: string
  prompt?: string
}

export interface SynthesizeSpeechInput {
  text: string
  format?: "mp3" | "wav" | "opus"
}

export interface SpeechProvider {
  getCapabilities(): SpeechCapabilitiesResponse
  transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse>
  synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse>
}

export interface NormalizedSpeechSettings {
  provider: string
  apiKey?: string
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
}

const DEFAULT_PROVIDER = "openai-compatible"
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe"
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts"
const DEFAULT_TTS_VOICE = "alloy"
export class SpeechService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    return this.createProvider().getCapabilities()
  }

  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    return this.createProvider().transcribe(input)
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    return this.createProvider().synthesize(input)
  }

  private createProvider(): SpeechProvider {
    const settings = this.resolveSettings()
    return new OpenAICompatibleSpeechProvider({
      settings,
      logger: this.logger.child({ provider: settings.provider }),
    })
  }

  private resolveSettings(): NormalizedSpeechSettings {
    const parsed = ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
    const speech = parsed.speech ?? {}

    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
      sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
      ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
    }
  }
}
