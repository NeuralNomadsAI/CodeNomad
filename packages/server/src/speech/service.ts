import { z } from "zod"
import type { Readable } from "node:stream"
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
      ttsFormat: z.enum(["mp3", "wav", "opus", "aac"]).optional(),
      separateProviders: z.boolean().optional(),
      stt: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
          model: z.string().optional(),
        })
        .optional(),
      tts: z
        .object({
          apiKey: z.string().optional(),
          baseUrl: z.string().optional(),
          model: z.string().optional(),
        })
        .optional(),
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
  format?: "mp3" | "wav" | "opus" | "aac"
}

export interface SpeechSynthesisStreamResponse {
  stream: Readable
  mimeType: string
}

export interface SpeechProvider {
  getCapabilities(): Omit<
    SpeechCapabilitiesResponse,
    "separateProviders" | "sttConfigured" | "ttsConfigured" | "sttBaseUrl" | "ttsBaseUrl"
  >
  transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse>
  synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse>
  synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse>
}

export interface NormalizedSpeechSettings {
  provider: string
  apiKey?: string
  baseUrl?: string
  sttModel: string
  ttsModel: string
  ttsVoice: string
  ttsFormat: "mp3" | "wav" | "opus" | "aac"
}

const DEFAULT_PROVIDER = "openai-compatible"
const DEFAULT_STT_MODEL = "gpt-4o-mini-transcribe"
const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts"
const DEFAULT_TTS_VOICE = "alloy"
const DEFAULT_TTS_FORMAT = "mp3"
export class SpeechService {
  constructor(
    private readonly settings: SettingsService,
    private readonly logger: Logger,
  ) {}

  getCapabilities(): SpeechCapabilitiesResponse {
    const parsed = this.parseConfig()
    const speech = parsed.speech ?? {}
    const separate = speech.separateProviders === true
    const sttSettings = this.resolveSttSettingsFrom(speech)
    const ttsSettings = this.resolveTtsSettingsFrom(speech)

    const sttConfigured = Boolean(sttSettings.apiKey)
    const ttsConfigured = Boolean(ttsSettings.apiKey)

    return {
      available: true,
      configured: sttConfigured || ttsConfigured,
      provider: sttSettings.provider,
      supportsStt: true,
      supportsTts: true,
      supportsStreamingTts: true,
      baseUrl: speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
      sttModel: sttSettings.sttModel,
      ttsModel: ttsSettings.ttsModel,
      ttsVoice: ttsSettings.ttsVoice,
      ttsFormats: ["mp3", "wav", "opus", "aac"],
      streamingTtsFormats: ["mp3", "wav", "opus", "aac"],
      separateProviders: separate,
      sttConfigured,
      ttsConfigured,
      ...(separate ? { sttBaseUrl: sttSettings.baseUrl, ttsBaseUrl: ttsSettings.baseUrl } : {}),
    }
  }

  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    return this.createSttProvider().transcribe(input)
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    return this.createTtsProvider().synthesize(input)
  }

  async synthesizeStream(input: SynthesizeSpeechInput): Promise<SpeechSynthesisStreamResponse> {
    return this.createTtsProvider().synthesizeStream(input)
  }

  private parseConfig() {
    return ServerSpeechSettingsSchema.parse(this.settings.getOwner("config", "server") ?? {})
  }

  private createSttProvider(): SpeechProvider {
    const settings = this.resolveSttSettings()
    return new OpenAICompatibleSpeechProvider({
      settings,
      logger: this.logger.child({ provider: settings.provider, direction: "stt" }),
    })
  }

  private createTtsProvider(): SpeechProvider {
    const settings = this.resolveTtsSettings()
    return new OpenAICompatibleSpeechProvider({
      settings,
      logger: this.logger.child({ provider: settings.provider, direction: "tts" }),
    })
  }

  private resolveSttSettings(): NormalizedSpeechSettings {
    return this.resolveSttSettingsFrom(this.parseConfig().speech ?? {})
  }

  private resolveTtsSettings(): NormalizedSpeechSettings {
    return this.resolveTtsSettingsFrom(this.parseConfig().speech ?? {})
  }

  private resolveShared(speech: NonNullable<z.infer<typeof ServerSpeechSettingsSchema>["speech"]>): NormalizedSpeechSettings {
    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
      sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
      ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
      ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
    }
  }

  private resolveSttSettingsFrom(speech: NonNullable<z.infer<typeof ServerSpeechSettingsSchema>["speech"]>): NormalizedSpeechSettings {
    if (speech.separateProviders !== true) {
      return this.resolveShared(speech)
    }
    const stt = speech.stt ?? {}
    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: stt.apiKey?.trim() || speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: stt.baseUrl?.trim() || speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
      sttModel: stt.model?.trim() || speech.sttModel?.trim() || DEFAULT_STT_MODEL,
      ttsModel: speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
      ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
    }
  }

  private resolveTtsSettingsFrom(speech: NonNullable<z.infer<typeof ServerSpeechSettingsSchema>["speech"]>): NormalizedSpeechSettings {
    if (speech.separateProviders !== true) {
      return this.resolveShared(speech)
    }
    const tts = speech.tts ?? {}
    return {
      provider: speech.provider?.trim() || DEFAULT_PROVIDER,
      apiKey: tts.apiKey?.trim() || speech.apiKey?.trim() || process.env.OPENAI_API_KEY,
      baseUrl: tts.baseUrl?.trim() || speech.baseUrl?.trim() || process.env.OPENAI_BASE_URL || undefined,
      sttModel: speech.sttModel?.trim() || DEFAULT_STT_MODEL,
      ttsModel: tts.model?.trim() || speech.ttsModel?.trim() || DEFAULT_TTS_MODEL,
      ttsVoice: speech.ttsVoice?.trim() || DEFAULT_TTS_VOICE,
      ttsFormat: speech.ttsFormat ?? DEFAULT_TTS_FORMAT,
    }
  }
}
