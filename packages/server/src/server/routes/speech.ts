import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { z } from "zod"
import type { SpeechService } from "../../speech/service"
import { SpeechNotConfiguredError } from "../../speech/providers/openai-compatible"
import { requestAdmission } from "../request-admission"
import { TRANSCRIPTION_BODY_LIMIT } from "../../speech/transcription-contract"
import { isLocalRequest } from "../../remote-control/request-origin"
import { LIVE_VOICE_CONSENT_PATH, LIVE_VOICE_NOTICE_VERSION } from "../../speech/live-voice-contract"

interface RouteDeps {
  speechService: SpeechService
}

const TranscribeBodySchema = z.object({
  audioBase64: z.string().min(1, "Audio payload is required"),
  mimeType: z.string().min(1, "Audio MIME type is required"),
  filename: z.string().optional(),
  language: z.string().optional(),
  prompt: z.string().optional(),
})

const SynthesizeBodySchema = z.object({
  text: z.string().trim().min(1, "Text is required"),
  format: z.enum(["mp3", "wav", "opus", "aac"]).optional(),
})

function getSpeechErrorStatus(error: unknown): number {
  if (error instanceof z.ZodError) {
    return 400
  }
  if (error instanceof SpeechNotConfiguredError) {
    return 503
  }
  return 502
}

function respondSpeechError(error: unknown, fallback: string, request: FastifyRequest, reply: FastifyReply) {
  const status = getSpeechErrorStatus(error)
  if (status === 502) request.log.error(fallback)
  reply.code(status)
  // Upstream diagnostics may echo request credentials.
  return { error: error instanceof SpeechNotConfiguredError ? error.message : fallback }
}

export function registerSpeechRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/speech/capabilities", async (request, reply) => {
    try {
      const capabilities = deps.speechService.getCapabilities()
      if (!isLocalRequest(request)) return { ...capabilities, desktopVoiceConversationEngine: false }
      return {
        ...capabilities,
        ...(capabilities.desktopVoiceConversationEngine ? { desktopLiveVoiceConsent: {
          "gemini-live": deps.speechService.desktopLiveVoiceConsent("gemini-live"),
          "openai-realtime": deps.speechService.desktopLiveVoiceConsent("openai-realtime"),
        } } : {}),
      }
    } catch { return reply.code(503).send({ error: "Speech capabilities unavailable" }) }
  })
  const enginePath = "/api/speech/conversation/engine"
  const engineBody = z.object({ engine: z.enum(["classic", "gemini-live", "openai-realtime"]) }).strict()
  app.get(enginePath, async (request, reply) => {
    try {
      const engine = isLocalRequest(request) && deps.speechService.desktopVoiceConversationEngine()
      return engine ? { engine } : reply.code(404).send()
    } catch { return reply.code(503).send({ error: "Conversation engine unavailable" }) }
  })
  app.patch(enginePath, async (request, reply) => {
    if (!isLocalRequest(request)) return reply.code(404).send()
    const parsed = engineBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid conversation engine" })
    try {
      const engine = deps.speechService.desktopVoiceConversationEngine(parsed.data.engine)
      return engine ? { engine } : reply.code(404).send()
    } catch { return reply.code(503).send({ error: "Conversation engine could not be saved" }) }
  })
  const consentBody = z.object({ engine: z.enum(["gemini-live", "openai-realtime"]), version: z.literal(LIVE_VOICE_NOTICE_VERSION) }).strict()
  app.put(LIVE_VOICE_CONSENT_PATH, async (request, reply) => {
    if (!isLocalRequest(request)) return reply.code(404).send()
    const parsed = consentBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: "Invalid voice notice" })
    try {
      const version = deps.speechService.desktopLiveVoiceConsent(parsed.data.engine, true)
      return reply.code(version === undefined ? 404 : 204).send()
    } catch { return reply.code(503).send({ error: "Voice consent could not be saved" }) }
  })

  app.post("/api/speech/transcribe", { bodyLimit: TRANSCRIPTION_BODY_LIMIT }, async (request, reply) => {
    const admission = requestAdmission(request, reply)
    try {
      const body = TranscribeBodySchema.parse(request.body ?? {})
      admission.signal.throwIfAborted()
      const result = await deps.speechService.transcribe(body, admission.signal)
      admission.signal.throwIfAborted()
      return result
    } catch (error) {
      if (admission.signal.aborted) return
      return respondSpeechError(error, "Failed to transcribe audio", request, reply)
    } finally {
      admission.dispose()
    }
  })

  app.post("/api/speech/synthesize/stream", async (request, reply) => {
    const admission = requestAdmission(request, reply)
    // The downstream can disconnect after the provider has started streaming.
    reply.raw.once("close", admission.dispose)
    try {
      const body = SynthesizeBodySchema.parse(request.body ?? {})
      const result = await deps.speechService.synthesizeStream(body, admission.signal)
      if (admission.signal.aborted) {
        result.stream.destroy()
        return
      }
      reply.header("Content-Type", result.mimeType)
      reply.header("Cache-Control", "no-store")
      return reply.send(result.stream)
    } catch (error) {
      if (admission.signal.aborted) return
      return respondSpeechError(error, "Failed to stream synthesized audio", request, reply)
    }
  })
}
