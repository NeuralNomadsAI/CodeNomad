import OpenAI from "openai"
import { toFile } from "openai/uploads"
import type { SpeechSynthesisResponse, SpeechTranscriptionResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type { NormalizedSpeechSettings, SynthesizeSpeechInput, TranscribeAudioInput } from "../service"

interface OpenAICompatibleSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

export class OpenAICompatibleSpeechProvider {
  constructor(private readonly options: OpenAICompatibleSpeechProviderOptions) {}

  getCapabilities() {
    const { settings } = this.options
    return {
      available: true,
      configured: Boolean(settings.apiKey),
      provider: settings.provider,
      supportsStt: true,
      supportsTts: true,
      supportsRealtimeTranscription: true,
      realtimeInputFormat: {
        type: "audio/pcm" as const,
        rate: 24000 as const,
      },
      baseUrl: settings.baseUrl,
      realtimeModel: settings.realtimeModel,
      sttModel: settings.sttModel,
      ttsModel: settings.ttsModel,
      ttsVoice: settings.ttsVoice,
    }
  }

  async transcribe(input: TranscribeAudioInput): Promise<SpeechTranscriptionResponse> {
    const client = this.createClient()
    const startedAt = Date.now()
    const extension = extensionForMime(input.mimeType)
    const buffer = Buffer.from(input.audioBase64, "base64")
    const filename = input.filename?.trim() || `prompt-input.${extension}`

    this.options.logger.info(
      {
        mimeType: input.mimeType,
        bytes: buffer.byteLength,
        language: input.language,
        model: this.options.settings.sttModel,
      },
      "speech.transcribe",
    )

    const response = await this.requestTranscription(client, buffer, filename, input)

    return {
      text: typeof response?.text === "string" ? response.text : "",
      language: typeof response?.language === "string" ? response.language : input.language,
      durationMs: Number.isFinite(response?.duration) ? Math.round(Number(response.duration) * 1000) : Date.now() - startedAt,
      segments: Array.isArray(response?.segments)
        ? response.segments
            .filter((segment: any) => typeof segment?.text === "string")
            .map((segment: any) => ({
              startMs: Math.max(0, Math.round(Number(segment.start ?? 0) * 1000)),
              endMs: Math.max(0, Math.round(Number(segment.end ?? 0) * 1000)),
              text: String(segment.text),
            }))
        : undefined,
    }
  }

  private async requestTranscription(
    client: OpenAI,
    buffer: Buffer,
    filename: string,
    input: TranscribeAudioInput,
  ): Promise<any> {
    const baseRequest = {
      model: this.options.settings.sttModel,
      ...(input.language ? { language: input.language } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
    }

    try {
      const file = await toFile(buffer, filename, { type: input.mimeType })
      return (await client.audio.transcriptions.create({
        ...baseRequest,
        file,
        response_format: "verbose_json" as any,
      } as any)) as any
    } catch (error) {
      this.options.logger.warn({ err: error }, "speech.transcribe verbose_json failed; retrying default format")
      const retryFile = await toFile(buffer, filename, { type: input.mimeType })
      return (await client.audio.transcriptions.create({
        ...baseRequest,
        file: retryFile,
      } as any)) as any
    }
  }

  async synthesize(input: SynthesizeSpeechInput): Promise<SpeechSynthesisResponse> {
    const client = this.createClient()
    const format = input.format ?? "mp3"

    this.options.logger.info(
      {
        model: this.options.settings.ttsModel,
        voice: this.options.settings.ttsVoice,
        format,
      },
      "speech.synthesize",
    )

    const response = await client.audio.speech.create({
      model: this.options.settings.ttsModel,
      voice: this.options.settings.ttsVoice as any,
      input: input.text,
      response_format: format as any,
    })

    const audioBuffer = Buffer.from(await response.arrayBuffer())
    return {
      audioBase64: audioBuffer.toString("base64"),
      mimeType: mimeTypeForFormat(format),
    }
  }

  private createClient(): OpenAI {
    const { settings } = this.options
    if (!settings.apiKey) {
      throw new Error("Speech provider is not configured. Add an API key in Speech settings.")
    }

    return new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
    })
  }
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.toLowerCase()
  if (normalized.includes("webm")) return "webm"
  if (normalized.includes("ogg")) return "ogg"
  if (normalized.includes("wav")) return "wav"
  if (normalized.includes("mpeg") || normalized.includes("mp3")) return "mp3"
  if (normalized.includes("mp4") || normalized.includes("aac")) return "m4a"
  return "webm"
}

function mimeTypeForFormat(format: "mp3" | "wav" | "opus"): string {
  if (format === "wav") return "audio/wav"
  if (format === "opus") return "audio/opus"
  return "audio/mpeg"
}
