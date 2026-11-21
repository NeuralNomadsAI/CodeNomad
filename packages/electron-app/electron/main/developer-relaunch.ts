import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { readDeveloperRestart, type DeveloperRestart } from "../../../server/src/automation/developer-restart"

const PREFIX = "--codenomad-automation-relaunch="

export interface DeveloperRelaunch {
  restart: DeveloperRestart
  profile: string
  pinned: boolean
  config: string | null
}

/** Capture the running module, not a second resolution of Electron's CLI operand. */
export function pinElectronRelaunch(execPath: string, appPath: string, appArgs: readonly string[], loadedMain: string) {
  const artifact = realpathSync.native(appPath)
  const mainPath = realpathSync.native(loadedMain)
  const operand = appArgs.at(-1)
  // Electron's default_app sets getAppPath() to the CLI operand when it
  // applies a manifest, or to dirname(resolved entry) otherwise. Require
  // that the direct entry preserves both the app path and metadata.
  return {
    execPath: realpathSync.native(execPath), appPath: artifact, mainPath,
    appArgs: operand && operand !== appPath && dirname(mainPath) === appPath
      ? [...appArgs.slice(0, -1), mainPath] : undefined,
  }
}

export type ElectronRelaunchArtifact = ReturnType<typeof pinElectronRelaunch>

export function developerNativeIdentity(profile: string, configIdentity: string, config: string | undefined, { execPath, appPath, mainPath }: ElectronRelaunchArtifact): string {
  return `electron:${createHash("sha256").update(`${profile}\0${configIdentity}\0${config ?? ""}\0${execPath}\0${appPath}\0${mainPath}`).digest("hex")}`
}

export async function verifyElectronRelaunch(artifact: ElectronRelaunchArtifact): Promise<void> {
  directEntryArgs(artifact)
  const { execPath, appPath, mainPath } = artifact
  try {
    if (realpathSync.native(execPath) === execPath && realpathSync.native(appPath) === appPath
      && realpathSync.native(mainPath) === mainPath && statSync(mainPath).isFile()) return
  } catch (cause) {
    throw new Error("The CodeNomad relaunch artifact changed or is unavailable", { cause })
  }
  throw new Error("The CodeNomad relaunch artifact changed or is unavailable")
}

function directEntryArgs({ appArgs }: ElectronRelaunchArtifact): string[] {
  // Packaged startup selects main in LoadAppPackage() before handling any
  // application arguments. A CLI package similarly resolves main on startup.
  if (!appArgs) throw new Error("Electron cannot relaunch this entry directly. Restart CodeNomad manually.")
  return appArgs
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

export function developerRelaunchOptions(launch: DeveloperRelaunch, artifact: ElectronRelaunchArtifact): Electron.RelaunchOptions {
  return { execPath: artifact.execPath, args: [...directEntryArgs(artifact), PREFIX + Buffer.from(JSON.stringify(launch)).toString("base64url")] }
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
