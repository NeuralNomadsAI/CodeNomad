import { FastifyInstance } from "fastify"
import { z } from "zod"
import fs from "node:fs/promises"
import { FileSystemBrowser } from "../../filesystem/browser"
import { RecentFolder, RecentFolderSchema } from '../../config/schema'

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

const FilesystemFileContentQuerySchema = z.object({
  path: z.string(),
  encoding: z.enum(["utf-8", "base64"]).optional(),
})

const FilesystemFileRealpathQuerySchema = z.object({
  currentPath: z.string(),
  recentFolders: z.array(RecentFolderSchema).default([]),
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

  app.get("/api/filesystem/files/content", async (request, reply) => {
    const query = FilesystemFileContentQuerySchema.parse(request.query ?? {})

    try {
      return deps.fileSystemBrowser.readFileContent(query.path, { encoding: query.encoding })
    } catch (error) {
      reply.code(400).type("text/plain").send((error as Error).message)
    }
  })

  app.post("/api/filesystem/detect-path-existing-in-recent", async (request, reply) => {
    const query = FilesystemFileRealpathQuerySchema.parse(request.body ?? {})

    try {
      const currentPath = query.currentPath
      const currentReal = await fs.realpath(currentPath)

      let exists = false
      let foundResult: RecentFolder | undefined

      const fn = async (folder: RecentFolder) => {
        return (await fs.exists(folder.path)) && currentReal === await fs.realpath(folder.path)
      }

      for (const folder of query.recentFolders) {
        if (currentPath === folder.path || currentReal === folder.path || await fn(folder).catch(() => false)) {
          exists = true
          foundResult = folder
          break
        }
      }

      return {
        exists,
        currentPath,
        currentReal,
        foundResult
      }
    } catch (error) {
      reply.code(400).type("text/plain").send((error as Error).message)
    }
  })

}
