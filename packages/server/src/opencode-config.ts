import { existsSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createLogger } from "./logger"

const log = createLogger({ component: "opencode-config" })
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const devTemplateDir = path.resolve(__dirname, "../../opencode-config")
const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
const prodTemplateDirs = [
  resourcesPath ? path.resolve(resourcesPath, "opencode-config") : undefined,
  path.resolve(__dirname, "opencode-config"),
].filter((dir): dir is string => Boolean(dir))

const isDevBuild = Boolean(process.env.CODENOMAD_DEV ?? process.env.CLI_UI_DEV_SERVER) || existsSync(devTemplateDir)
const templateDir = isDevBuild
  ? devTemplateDir
  : prodTemplateDirs.find((dir) => existsSync(dir)) ?? prodTemplateDirs[0]

export function getOpencodeConfigDir(): string {
  if (!existsSync(templateDir)) {
    throw new Error(`CodeNomad Opencode config template missing at ${templateDir}`)
  }

  if (isDevBuild) {
    log.debug({ templateDir }, "Using Opencode config template directly (dev mode)")
  }

  return templateDir
}
