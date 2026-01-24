import { FastifyInstance } from "fastify"
import { z } from "zod"
import { FileSystemBrowser } from "../../filesystem/browser"

interface RouteDeps {
  fileSystemBrowser: FileSystemBrowser
}

const FilesystemQuerySchema = z.object({
  path: z.string().optional(),
  includeFiles: z.coerce.boolean().optional(),
})

const FilesystemCreateFolderSchema = z.object({
  parentPath: z.string().optional(),
  name: z.string(),
})

export function registerFilesystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  app.get("/api/filesystem", async (request, reply) => {
    const query = FilesystemQuerySchema.parse(request.query ?? {})

    try {
      return deps.fileSystemBrowser.browse(query.path, {
        includeFiles: query.includeFiles,
      })
    } catch (error) {
      reply.code(400)
      return { error: (error as Error).message }
    }
  })

  app.post("/api/filesystem/folders", async (request, reply) => {
    const body = FilesystemCreateFolderSchema.parse(request.body ?? {})

    try {
      const created = deps.fileSystemBrowser.createFolder(body.parentPath, body.name)
      reply.code(201)
      return created
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err?.code === "EEXIST") {
        reply.code(409).type("text/plain").send("Folder already exists")
        return
      }
      if (err?.code === "EACCES" || err?.code === "EPERM") {
        reply.code(403).type("text/plain").send("Permission denied")
        return
      }

      reply.code(400).type("text/plain").send((error as Error).message)
    }
  })
}
