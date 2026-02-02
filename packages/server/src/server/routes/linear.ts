import { FastifyInstance } from "fastify"

interface RouteDeps {
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
    debug: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export interface LinearIssue {
  id: string
  identifier: string
  title: string
  status: string
  statusColor: string
  priority: number
  priorityLabel: string
  labels: string[]
  assignee: string | null
  url: string
  updatedAt: number
}

export interface LinearStatus {
  connected: boolean
  workspace: string | null
  error: string | null
}

const PRIORITY_LABELS: Record<number, string> = {
  0: "No priority",
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
}

export function registerLinearRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { logger } = deps

  // Check Linear connection status
  app.get("/api/era/linear/status", async (): Promise<LinearStatus> => {
    try {
      // Check if Linear MCP server is configured and accessible
      // This is a placeholder — actual implementation would query the MCP server
      logger.debug("Checking Linear connection status")
      return {
        connected: false,
        workspace: null,
        error: "Linear MCP server not configured. Add https://mcp.linear.app/mcp as an MCP server.",
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error("Failed to check Linear status", { error: message })
      return { connected: false, workspace: null, error: message }
    }
  })

  // Fetch Linear issues for a project
  app.get<{ Querystring: { instanceId?: string } }>(
    "/api/era/linear/issues",
    async (request, reply) => {
      const { instanceId } = request.query
      if (!instanceId) {
        return reply.status(400).send({ error: "instanceId is required" })
      }

      try {
        logger.debug("Fetching Linear issues", { instanceId })

        // Placeholder: In production this queries the Linear MCP server
        // The MCP server at https://mcp.linear.app/mcp provides tools like:
        // - linear_search_issues
        // - linear_get_issue
        // - linear_list_teams
        // When connected, we'd call these MCP tools via the session's MCP client

        const issues: LinearIssue[] = []
        return issues
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Failed to fetch Linear issues", { error: message, instanceId })
        return reply.status(500).send({ error: message })
      }
    },
  )

  // Trigger a sync of Linear issues
  app.post<{ Body: { instanceId?: string } }>(
    "/api/era/linear/sync",
    async (request, reply) => {
      const { instanceId } = request.body || {}
      if (!instanceId) {
        return reply.status(400).send({ error: "instanceId is required" })
      }

      try {
        logger.info("Syncing Linear tasks", { instanceId })
        // Placeholder: Trigger a full sync with the Linear MCP server
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error("Failed to sync Linear tasks", { error: message, instanceId })
        return reply.status(500).send({ error: message })
      }
    },
  )
}
