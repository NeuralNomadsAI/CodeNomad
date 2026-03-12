import type { FastifyInstance } from "fastify"
import { z } from "zod"
import type { SpeechService } from "../../speech/service"

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
  format: z.enum(["mp3", "wav", "opus"]).optional(),
})

export function registerSpeechRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/speech/capabilities", async () => deps.speechService.getCapabilities())

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
