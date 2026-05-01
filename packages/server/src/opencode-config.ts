import { cpSync, existsSync, mkdirSync, rmSync } from "fs"
import os from "os"
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
const userConfigDir = path.join(os.homedir(), ".config", "opencode")

function copyConfigDirectory(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
  })
}

function copyBridgePlugin(target: string): void {
  const bridgePluginDir = path.join(templateDir, "plugin")
  if (existsSync(bridgePluginDir)) {
    copyConfigDirectory(bridgePluginDir, path.join(target, "plugin"))
  }
}

function prepareMergedConfigDir(baseDir: string): string {
  const mergedConfigDir = path.join(baseDir, "opencode-config")

  rmSync(mergedConfigDir, { recursive: true, force: true })
  mkdirSync(mergedConfigDir, { recursive: true })

  copyConfigDirectory(templateDir, mergedConfigDir)

  if (existsSync(userConfigDir)) {
    copyConfigDirectory(userConfigDir, mergedConfigDir)
    copyBridgePlugin(mergedConfigDir)
    log.debug({ templateDir, userConfigDir, mergedConfigDir }, "Using merged OpenCode config")
  } else {
    log.debug({ templateDir, mergedConfigDir }, "Using generated OpenCode config without user overlay")
  }

  return mergedConfigDir
}

export function getOpencodeConfigDir(baseDir: string): string {
  if (!existsSync(templateDir)) {
    throw new Error(`CodeNomad Opencode config template missing at ${templateDir}`)
  }

  return prepareMergedConfigDir(baseDir)
}
