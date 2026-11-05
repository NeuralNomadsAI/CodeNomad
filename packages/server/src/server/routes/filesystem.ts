import { FastifyInstance } from "fastify"
import { z } from "zod"
import { FileSystemBrowser } from "../../filesystem/browser"
import { hostOnlyQuery } from "./host-only-query"

interface RouteDeps {
  fileSystemBrowser: FileSystemBrowser
}

const FilesystemQuerySchema = z.object({
  path: z.string().optional(),
  includeFiles: z.coerce.boolean().optional(),
}).strict()

const FilesystemCreateFolderSchema = z.object({
  parentPath: z.string().optional(),
  name: z.string(),
}).strict()

const FilesystemFileContentQuerySchema = z.object({
  path: z.string(),
  encoding: z.enum(["utf-8", "base64"]).optional(),
}).strict()

export function registerFilesystemRoutes(app: FastifyInstance, deps: RouteDeps) {
  // These are host browser operations. Project paths use the workspace API;
  // reject scope selectors rather than silently treating them as host paths.
  app.get("/api/filesystem", async (request, reply) => {
    try {
      const query = FilesystemQuerySchema.parse(request.query ?? {})
      return await deps.fileSystemBrowser.browse(query.path, {
        includeFiles: query.includeFiles,
      })
    } catch (error) {
      reply.code(400)
      return { error: (error as Error).message }
    }
  })

  app.post("/api/filesystem/folders", { preHandler: hostOnlyQuery("files") }, async (request, reply) => {
    try {
      const body = FilesystemCreateFolderSchema.parse(request.body ?? {})
      const created = await deps.fileSystemBrowser.createFolder(body.parentPath, body.name)
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

  app.get("/api/filesystem/files/content", async (request, reply) => {
    try {
      const query = FilesystemFileContentQuerySchema.parse(request.query ?? {})
      return await deps.fileSystemBrowser.readFileContent(query.path, { encoding: query.encoding })
    } catch (error) {
      reply.code(400).type("text/plain").send((error as Error).message)
    }
  })
}
