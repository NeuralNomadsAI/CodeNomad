import type { FastifyInstance } from "fastify"
import { z } from "zod"
import { LoginStartError, type OpenCodeLoginStart } from "../../host-lifetime/opencode-login-start"
import { recurrenceHumanSession } from "./mission-recurrence-proof"

type Deps = Parameters<typeof recurrenceHumanSession>[1] & { loginStart: Pick<OpenCodeLoginStart, "read" | "set"> }
const controlSchema = z.object({ enabled: z.boolean() }).strict()
const status = { unavailable: 503, "unsupported-binary": 422, failed: 500 } as const

/** Changing what the OS starts at login requires a live human session. */
export function registerOpenCodeLoginStartRoutes(app: FastifyInstance, deps: Deps) {
  const reply = (error: unknown) => {
    const code = error instanceof LoginStartError ? error.code : "failed"
    return { code: status[code], body: { error: `login-start-${code}` } }
  }
  app.get("/api/opencode/login-start", async (_request, response) => {
    try { return await deps.loginStart.read() } catch (error) {
      const failure = reply(error)
      return response.code(failure.code).send(failure.body)
    }
  })
  app.post("/api/opencode/login-start", async (request, response) => {
    const body = controlSchema.safeParse(request.body)
    if (!body.success) return response.code(400).send({ error: "login-start-input-invalid" })
    if (!recurrenceHumanSession(request, deps)) return response.code(401).send({ error: "login-start-human-required" })
    try { return await deps.loginStart.set(body.data.enabled) } catch (error) {
      const failure = reply(error)
      return response.code(failure.code).send(failure.body)
    }
  })
}
