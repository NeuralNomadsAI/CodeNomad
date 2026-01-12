import { FastifyInstance } from "fastify"
import { z } from "zod"
import { FileSystemBrowser } from "../../filesystem/browser"

interface RouteDeps {
  fileSystemBrowser: FileSystemBrowser
}

const FilesystemQuerySchema = z.object({
  path: z.string().optional(),
  includeFiles: z.coerce.boolean().optional(),
  /** When true, allows navigating the full filesystem regardless of server's restricted mode. */
  allowFullNavigation: z.coerce.boolean().optional(),
})

export function registerFilesystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/filesystem", async (request, reply) => {
    const query = FilesystemQuerySchema.parse(request.query ?? {})

    try {
      return deps.fileSystemBrowser.browse(query.path, {
        includeFiles: query.includeFiles,
        forceUnrestricted: query.allowFullNavigation,
      })
    } catch (error) {
      reply.code(400)
      return { error: (error as Error).message }
    }
  })
}
