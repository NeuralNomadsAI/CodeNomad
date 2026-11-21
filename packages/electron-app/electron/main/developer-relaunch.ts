import { createHash } from "node:crypto"
import { isAbsolute, resolve } from "node:path"
import { readDeveloperRestart, type DeveloperRestart } from "../../../server/src/automation/developer-restart"

const PREFIX = "--codenomad-automation-relaunch="

export interface DeveloperRelaunch {
  restart: DeveloperRestart
  profile: string
  pinned: boolean
  config: string | null
}

export function developerNativeIdentity(profile: string, configIdentity: string, config: string | undefined, execPath: string, appPath: string): string {
  return `electron:${createHash("sha256").update(`${profile}\0${configIdentity}\0${config ?? ""}\0${execPath}\0${resolve(appPath)}`).digest("hex")}`
}

/** Entry selection follows Electron's default_app/main.ts. Only --no-sandbox carries over. */
export function readElectronEntry(argv: readonly string[]) {
  const args: string[] = []
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === "--require" || argument === "-r") {
      index++
      continue
    }
    if (argument === "--version" || argument === "-v" || argument === "--test-type=webdriver") break
    if (argument === "--no-sandbox") args.push(argument)
    const entry = argument.startsWith("--app=") ? argument.split("=")[1]
      : argument.startsWith("-") ? undefined : argument
    if (entry === undefined) continue
    if (!entry) break
    const path = resolve(entry)
    return { path, args: [...args, path], nextIndex: index + 1 }
  }
}

export function developerRelaunchOptions(launch: DeveloperRelaunch, execPath: string, appArgs: readonly string[]): Electron.RelaunchOptions {
  return { execPath, args: [...appArgs, PREFIX + Buffer.from(JSON.stringify(launch)).toString("base64url")] }
}

/** The relaunch is one-shot: consume it before interpreting ordinary launch intents. */
export function readDeveloperRelaunch(args: string[]): DeveloperRelaunch | undefined {
  const marker = args.find(arg => arg.startsWith(PREFIX))
  if (!marker) return
  if (args.length === 1) {
    try {
      const { restart: value, profile, pinned, config } = JSON.parse(Buffer.from(marker.slice(PREFIX.length), "base64url").toString("utf8"))
      const restart = readDeveloperRestart(value)
      // Storage keys also include verbatim normalized legacy aliases such as "default".
      if (restart && typeof profile === "string" && /^[a-z0-9._-]{1,255}$/.test(profile)
        && typeof pinned === "boolean" && (config === null || typeof config === "string" && isAbsolute(config) && !config.includes("\0"))) {
        return { restart, profile, pinned, config }
      }
    } catch { /* A malformed handoff must never fall back to another profile. */ }
  }
  throw new Error("Invalid CodeNomad automation relaunch")
}
