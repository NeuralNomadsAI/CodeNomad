import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SpeechService } from "../../speech/service"
import type { Logger } from "../../logger"
import { SpeechRealtimeSessionManager } from "../../speech/realtime-session-manager"

interface RouteDeps {
  speechService: SpeechService
  logger: Logger
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
  format: z.enum(["mp3", "wav", "opus"]).optional(),
})

const RealtimeSessionBodySchema = z.object({
  language: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
})

const RealtimeAudioBodySchema = z.object({
  audioBase64: z.string().min(1, "Audio payload is required"),
})

export function registerSpeechRoutes(app: FastifyInstance, deps: RouteDeps) {
  const realtimeSessions = new SpeechRealtimeSessionManager(
    deps.speechService,
    deps.logger.child({ component: "speech-realtime" }),
  )

  app.addHook("onClose", async () => {
    await realtimeSessions.dispose()
  })

  app.get("/api/speech/capabilities", async () => deps.speechService.getCapabilities())

  app.post("/api/speech/realtime/sessions", async (request, reply) => {
    try {
      const body = RealtimeSessionBodySchema.parse(request.body ?? {})
      return await realtimeSessions.createSession(body)
    } catch (error) {
      request.log.error({ err: error }, "Failed to create realtime speech session")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to create realtime speech session" }
    }
  })

  app.get<{ Params: { sessionId: string } }>("/api/speech/realtime/sessions/:sessionId/events", (request, reply) => {
    try {
      reply.raw.setHeader("Content-Type", "text/event-stream")
      reply.raw.setHeader("Cache-Control", "no-cache")
      reply.raw.setHeader("Connection", "keep-alive")
      reply.raw.flushHeaders?.()
      reply.hijack()

      const unsubscribe = realtimeSessions.subscribe(request.params.sessionId, (event) => {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      })

      const heartbeat = setInterval(() => {
        reply.raw.write(`:hb ${Date.now()}\n\n`)
      }, 15000)

      const close = () => {
        clearInterval(heartbeat)
        unsubscribe()
        reply.raw.end?.()
      }

      request.raw.on("close", close)
      request.raw.on("error", close)
    } catch (error) {
      request.log.error({ err: error }, "Failed to open realtime speech event stream")
      reply.code(404).send({ error: error instanceof Error ? error.message : "Realtime speech session not found" })
    }
  })

  app.post<{ Params: { sessionId: string } }>("/api/speech/realtime/sessions/:sessionId/audio", async (request, reply) => {
    try {
      const body = RealtimeAudioBodySchema.parse(request.body ?? {})
      realtimeSessions.appendAudio(request.params.sessionId, body.audioBase64)
      reply.code(204)
      return undefined
    } catch (error) {
      request.log.error({ err: error }, "Failed to append realtime speech audio")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to append realtime speech audio" }
    }
  })

  app.post<{ Params: { sessionId: string } }>("/api/speech/realtime/sessions/:sessionId/finalize", async (request, reply) => {
    try {
      realtimeSessions.finalize(request.params.sessionId)
      reply.code(204)
      return undefined
    } catch (error) {
      request.log.error({ err: error }, "Failed to finalize realtime speech session")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to finalize realtime speech session" }
    }
  })

  app.delete<{ Params: { sessionId: string } }>("/api/speech/realtime/sessions/:sessionId", async (request, reply) => {
    realtimeSessions.closeSession(request.params.sessionId, "client_closed")
    reply.code(204)
    return undefined
  })

  app.post("/api/speech/transcribe", async (request, reply) => {
    try {
      const body = TranscribeBodySchema.parse(request.body ?? {})
      return await deps.speechService.transcribe(body)
    } catch (error) {
      request.log.error({ err: error }, "Failed to transcribe audio")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to transcribe audio" }
    }
  })

  app.post("/api/speech/synthesize", async (request, reply) => {
    try {
      const body = SynthesizeBodySchema.parse(request.body ?? {})
      return await deps.speechService.synthesize(body)
    } catch (error) {
      request.log.error({ err: error }, "Failed to synthesize audio")
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to synthesize audio" }
    }
  })
}
