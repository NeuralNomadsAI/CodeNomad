import type { FastifyInstance } from "fastify"
import type { WorkspaceManager } from "../../workspaces/manager"
import type { SettingsService } from "../../settings/service"
import type { Logger } from "../../logger"
import { GitHubJobRunner } from "../../integrations/github/job-runner"

interface RouteDeps {
  workspaceManager: WorkspaceManager
  settings: SettingsService
  logger: Logger
}

export function registerGitHubWebhookRoutes(app: FastifyInstance, deps: RouteDeps) {
  const log = deps.logger.child({ component: "app", module: "github" })
  const runner = new GitHubJobRunner({ workspaceManager: deps.workspaceManager, settings: deps.settings, logger: log })

  app.register(async (instance) => {
    instance.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body))

    instance.post("/integrations/github/webhook", async (request, reply) => {
      const event = (request.headers["x-github-event"] as string | undefined) ?? ""
      const delivery = (request.headers["x-github-delivery"] as string | undefined) ?? ""
      const signature = (request.headers["x-hub-signature-256"] as string | undefined) ?? undefined
      const body = request.body
      if (!Buffer.isBuffer(body)) {
        reply.code(400).type("text/plain").send("Expected raw JSON body")
        return
      }

      log.info({ event, deliveryId: delivery }, "GitHub webhook received")
      runner.enqueue({ deliveryId: delivery, event, signature, body })
      reply.code(202).send({ ok: true })
    })
  })
}
