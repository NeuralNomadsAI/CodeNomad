import { existsSync } from "fs"
import { createLogger } from "./logger"
import { resolveOpencodeTemplateDir } from "./runtime-paths"

const log = createLogger({ component: "opencode-config" })
const templateDir = resolveOpencodeTemplateDir(import.meta.url)

const isDevBuild = Boolean(process.env.CODENOMAD_DEV ?? process.env.CLI_UI_DEV_SERVER)

export function getOpencodeConfigDir(): string {
  if (!existsSync(templateDir)) {
    throw new Error(`CodeNomad Opencode config template missing at ${templateDir}`)
  }

  if (isDevBuild) {
    log.debug({ templateDir }, "Using Opencode config template directly (dev mode)")
  }

  return templateDir
}
