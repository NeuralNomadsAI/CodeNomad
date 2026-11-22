import { Readable } from "node:stream"
import OpenAI from "openai"
import { toFile } from "openai/uploads"
import type { SpeechTranscriptionResponse } from "../../api-types"
import type { Logger } from "../../logger"
import type { NormalizedSpeechSettings, SpeechSynthesisStreamResponse, SynthesizeSpeechInput, TranscribeAudioInput } from "../service"

interface OpenAICompatibleSpeechProviderOptions {
  settings: NormalizedSpeechSettings
  logger: Logger
}

export class SpeechNotConfiguredError extends Error {
  constructor() { super("Speech provider is not configured. Add an API key in Speech settings.") }
}

export class OpenAICompatibleSpeechProvider {
  constructor(private readonly options: OpenAICompatibleSpeechProviderOptions) {}

  async transcribe(input: TranscribeAudioInput, signal?: AbortSignal): Promise<SpeechTranscriptionResponse> {
    signal?.throwIfAborted()
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

    const response = await this.requestTranscription(client, buffer, filename, input, signal)
    signal?.throwIfAborted()

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
    signal?: AbortSignal,
  ): Promise<any> {
    const baseRequest = {
      model: this.options.settings.sttModel,
      ...(input.language ? { language: input.language } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
    }

    const requestOptions = { signal, maxRetries: 0 }
    const file = await toFile(buffer, filename, { type: input.mimeType })
    signal?.throwIfAborted()
    try {
      return (await client.audio.transcriptions.create({
        ...baseRequest,
        file,
        response_format: "verbose_json" as any,
      } as any, requestOptions)) as any
    } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof OpenAI.APIError) || (error.status !== 400 && error.status !== 422)
        || (error.param !== "response_format" && !/response[ _-]format|verbose_json/i.test(error.message))) throw error
      return (await client.audio.transcriptions.create({
        ...baseRequest,
        file,
      } as any, requestOptions)) as any
    }
  }

  async synthesizeStream(input: SynthesizeSpeechInput, signal?: AbortSignal): Promise<SpeechSynthesisStreamResponse> {
    const format = input.format ?? this.options.settings.ttsFormat

    this.options.logger.info(
      {
        model: this.options.settings.ttsModel,
        voice: this.options.settings.ttsVoice,
        format,
      },
      "speech.synthesize.stream",
    )

    const response = await this.requestSpeechAudio(input.text, format, signal)
    if (!response.body) {
      throw new Error("Speech provider did not return a stream.")
    }

    return {
      stream: Readable.fromWeb(response.body as any),
      mimeType: response.headers.get("content-type") || mimeTypeForFormat(format),
    }
  }

  private async requestSpeechAudio(text: string, format: "mp3" | "wav" | "opus" | "aac", signal?: AbortSignal): Promise<Response> {
    const { settings } = this.options
    if (!settings.apiKey) {
      throw new SpeechNotConfiguredError()
    }

    const endpoint = new URL("audio/speech", ensureTrailingSlash(settings.baseUrl ?? "https://api.openai.com/v1"))
    const response = await fetch(endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.ttsModel,
        voice: settings.ttsVoice,
        input: text,
        response_format: format,
      }),
    })

    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Speech synthesis failed with ${response.status}`)
    }

    return response
  }

  private createClient(): OpenAI {
    const { settings } = this.options
    if (!settings.apiKey) {
      throw new SpeechNotConfiguredError()
    }

    return new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      logLevel: "off",
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

function mimeTypeForFormat(format: "mp3" | "wav" | "opus" | "aac"): string {
  if (format === "wav") return "audio/wav"
  if (format === "opus") return 'audio/ogg; codecs="opus"'
  if (format === "aac") return "audio/aac"
  return "audio/mpeg"
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`
}
