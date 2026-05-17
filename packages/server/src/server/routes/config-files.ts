import { FastifyInstance } from "fastify"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { z } from "zod"
import type { ConfigFileDescriptor } from "../../api-types"

type ConfigFileEntry = ConfigFileDescriptor & {
  absolutePath: string
}

const ConfigFileContentBodySchema = z.object({
  contents: z.string(),
})

function resolveOpenCodeGlobalConfigPath(): ConfigFileEntry {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim()
    const basePath = appData || path.join(os.homedir(), "AppData", "Roaming")
    const absolutePath = path.join(basePath, "opencode", "opencode.json")
    return {
      id: "opencode-global-config",
      label: "OpenCode Global Config",
      path: absolutePath,
      absolutePath,
      language: "json",
    }
  }

  return {
    id: "opencode-global-config",
    label: "OpenCode Global Config",
    path: "~/.config/opencode/opencode.json",
    absolutePath: path.join(os.homedir(), ".config", "opencode", "opencode.json"),
    language: "json",
  }
}

function listConfigFileEntries(): ConfigFileEntry[] {
  return [resolveOpenCodeGlobalConfigPath()]
}

function listConfigFiles(): ConfigFileDescriptor[] {
  return listConfigFileEntries().map(({ absolutePath: _absolutePath, ...file }) => file)
}

function getConfigFile(id: string): ConfigFileEntry | null {
  return listConfigFileEntries().find((file) => file.id === id) ?? null
}

export function registerConfigFileRoutes(app: FastifyInstance) {
  app.get("/api/config-files", async () => listConfigFiles())

  app.get<{ Params: { id: string } }>("/api/config-files/:id/content", async (request, reply) => {
    const file = getConfigFile(request.params.id)
    if (!file) {
      reply.code(404)
      return { error: "Config file not found" }
    }

    try {
      const contents = await fs.readFile(file.absolutePath, "utf-8")
      return { id: file.id, path: file.path, contents, exists: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { id: file.id, path: file.path, contents: "", exists: false }
      }

      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to read config file" }
    }
  })

  app.put<{ Params: { id: string } }>("/api/config-files/:id/content", async (request, reply) => {
    const file = getConfigFile(request.params.id)
    if (!file) {
      reply.code(404)
      return { error: "Config file not found" }
    }

    try {
      const body = ConfigFileContentBodySchema.parse(request.body ?? {})
      await fs.mkdir(path.dirname(file.absolutePath), { recursive: true })
      await fs.writeFile(file.absolutePath, body.contents, "utf-8")
      reply.code(204)
    } catch (error) {
      reply.code(400)
      return { error: error instanceof Error ? error.message : "Failed to save config file" }
    }
  })
}
