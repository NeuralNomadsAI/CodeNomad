import type { FastifyInstance } from "fastify"
import { z } from "zod"

import { missionPlaybookDetails } from "../../missions/recipes"
import { missionTaskModeInputSchema } from "../../missions/task-execution-mode"

const QuerySchema = z.object({ taskMode: missionTaskModeInputSchema.optional() }).strict()

/** The playbook definitions this backend's Missions build assembles its prompts from.
 * Static read-only data: no workspace, plugin read or native effect. */
export function registerMissionPlaybookRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: Record<string, unknown> }>("/api/missions/playbooks", async (request, reply) => {
    const query = QuerySchema.safeParse(request.query ?? {})
    if (!query.success) return reply.code(400).send({ error: "Invalid playbook request" })
    return missionPlaybookDetails(query.data.taskMode)
  })
}
