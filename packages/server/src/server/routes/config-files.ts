import { FastifyInstance } from "fastify"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { z } from "zod"
import type { ConfigFileDescriptor } from "../../api-types"

type ConfigFileEntry = ConfigFileDescriptor & {
  absolutePath: string
}

interface ConfigFileRouteOptions {
  files?: ConfigFileEntry[]
}

const ConfigFileContentBodySchema = z.object({
  contents: z.string(),
})

function resolveOpenCodeGlobalConfigPaths(): ConfigFileEntry[] {
  if (process.platform === "win32") {
    const basePath = path.join(os.homedir(), ".config", "opencode")
    return [
      {
        id: "opencode-global-config",
        label: "OpenCode Global Config",
        path: "%USERPROFILE%\\.config\\opencode\\opencode.json",
        absolutePath: path.join(basePath, "opencode.json"),
        language: "json",
      },
      {
        id: "opencode-global-config-jsonc",
        label: "OpenCode Global Config (JSONC)",
        path: "%USERPROFILE%\\.config\\opencode\\opencode.jsonc",
        absolutePath: path.join(basePath, "opencode.jsonc"),
        language: "jsonc",
      },
    ]
  }

  return [
    {
      id: "opencode-global-config",
      label: "OpenCode Global Config",
      path: "~/.config/opencode/opencode.json",
      absolutePath: path.join(os.homedir(), ".config", "opencode", "opencode.json"),
      language: "json",
    },
    {
      id: "opencode-global-config-jsonc",
      label: "OpenCode Global Config (JSONC)",
      path: "~/.config/opencode/opencode.jsonc",
      absolutePath: path.join(os.homedir(), ".config", "opencode", "opencode.jsonc"),
      language: "jsonc",
    },
  ]
}

function defaultConfigFileEntries(): ConfigFileEntry[] {
  return resolveOpenCodeGlobalConfigPaths()
}

function listConfigFiles(files: ConfigFileEntry[]): ConfigFileDescriptor[] {
  return files.map(({ absolutePath: _absolutePath, ...file }) => file)
}

function getConfigFile(files: ConfigFileEntry[], id: string): ConfigFileEntry | null {
  return files.find((file) => file.id === id) ?? null
}

export function registerConfigFileRoutes(app: FastifyInstance, options: ConfigFileRouteOptions = {}) {
  const configFiles = options.files ?? defaultConfigFileEntries()

  app.get("/api/config-files", async () => listConfigFiles(configFiles))

  app.get<{ Params: { id: string } }>("/api/config-files/:id/content", async (request, reply) => {
    const file = getConfigFile(configFiles, request.params.id)
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
    const file = getConfigFile(configFiles, request.params.id)
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
