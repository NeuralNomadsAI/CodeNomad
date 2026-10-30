import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { SupervisionError } from "../../host-lifetime/service-supervision-contract"
import { ServiceSupervisionSettings, supervisionSettingsControlSchema } from "../../host-lifetime/service-supervision-service"
import { recurrenceHumanSession } from "./mission-recurrence-proof"
import { requestAdmission } from "../request-admission"

type HumanDeps = Parameters<typeof recurrenceHumanSession>[1]
type Deps = HumanDeps & { service: ServiceSupervisionSettings }
const querySchema = z.object({ serviceKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  requestID: z.string().uuid().optional() }).strict()

/** Register only with an exact Settings execution-host resolver. The global
 * HTTP authentication hook and this live human check are both required. */
export function registerServiceSupervisionRoutes(app: FastifyInstance, deps: Deps) {
  for (const method of ["GET", "POST"] as const) app.route({ method, url: "/api/opencode/supervision",
    handler: async (request, reply) => {
      const query = querySchema.safeParse(request.query)
      const body = method === "POST" ? supervisionSettingsControlSchema.safeParse(request.body) : undefined
      if (!query.success || method === "POST" && (!body?.success || Object.keys(query.data).length > 0))
        return reply.code(400).send({ error: "supervision-input-invalid" })
      const human = recurrenceHumanSession(request, deps)
      if (!human) return reply.code(401).send({ error: "supervision-human-required" })
      const lifetime = requestAdmission(request, reply)
      const authorize = () => {
        lifetime.signal.throwIfAborted()
        if (recurrenceHumanSession(request, deps)?.sessionId !== human.sessionId) throw new Error("supervision-human-changed")
      }
      try {
        authorize()
        const result = method === "POST" && body?.success
          ? await deps.service.control(body.data, authorize) : await deps.service.read(query.data)
        authorize()
        return result
      } catch (error) {
        const code = error instanceof SupervisionError ? error.code : "unavailable"
        return reply.code(code === "conflict" || code === "busy" ? 409 : code === "invalid" ? 400 : 503)
          .send({ error: `supervision-${code}` })
      } finally { lifetime.dispose() }
    },
  })
}
