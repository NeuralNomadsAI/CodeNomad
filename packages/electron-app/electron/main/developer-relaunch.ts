import { createHash } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { Worker } from "node:worker_threads"
import { readDeveloperRestart, type DeveloperRestart } from "../../../server/src/automation/developer-restart"

const PREFIX = "--codenomad-automation-relaunch="

export interface DeveloperRelaunch {
  restart: DeveloperRestart
  profile: string
  pinned: boolean
  config: string | null
  storageRoot?: string
}

/** Capture the running module, not a second resolution of Electron's CLI operand. */
export function pinElectronRelaunch(execPath: string, appPath: string, appArgs: readonly string[], loadedMain: string) {
  const artifact = realpathSync.native(appPath)
  const mainPath = realpathSync.native(loadedMain)
  const operand = appArgs.at(-1)
  // Keep Electron's package launch when the CLI operand is its app root.
  const cliPackage = operand === appPath ? artifact : undefined
  return {
    execPath: realpathSync.native(execPath), appPath: artifact, mainPath, cliPackage,
    appArgs: operand && operand !== "--no-sandbox" ? [...appArgs.slice(0, -1), cliPackage ?? mainPath] : [...appArgs],
  }
}

export type ElectronRelaunchArtifact = ReturnType<typeof pinElectronRelaunch>

export function developerNativeIdentity(profile: string, configIdentity: string, config: string | undefined, { execPath, appPath, mainPath }: ElectronRelaunchArtifact, storageRoot = ""): string {
  return `electron:${createHash("sha256").update(`${profile}\0${configIdentity}\0${config ?? ""}\0${execPath}\0${appPath}\0${mainPath}\0${storageRoot}`).digest("hex")}`
}

export async function verifyElectronRelaunch({ execPath, appPath, mainPath, cliPackage }: ElectronRelaunchArtifact): Promise<void> {
  try {
    if (realpathSync.native(execPath) === execPath && realpathSync.native(appPath) === appPath
      && realpathSync.native(mainPath) === mainPath && statSync(mainPath).isFile()
      && (!cliPackage || await resolveFreshPackageMain(cliPackage) === mainPath)) return
  } catch (cause) {
    throw new Error("The CodeNomad relaunch artifact changed or is unavailable", { cause })
  }
  throw new Error("The CodeNomad relaunch artifact changed or is unavailable")
}

function resolveFreshPackageMain(appPath: string): Promise<string> {
  // Electron's default_app/main.ts uses Module._resolveFilename(operand, null, true).
  // A fresh isolate avoids Node's cached package paths and realpaths from the original load.
  const worker = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads")
    const { Module } = require("node:module")
    const { realpathSync } = require("node:fs")
    parentPort.postMessage(realpathSync.native(Module._resolveFilename(workerData, null, true)))
  `, { eval: true, execArgv: [], workerData: appPath })
  return new Promise<string>((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", reject)
    worker.once("exit", () => reject(new Error("Electron entry resolution ended without a result")))
  })
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

export function developerRelaunchOptions(launch: DeveloperRelaunch, { execPath, appArgs }: ElectronRelaunchArtifact): Electron.RelaunchOptions {
  return { execPath, args: [...appArgs, PREFIX + Buffer.from(JSON.stringify(launch)).toString("base64url")] }
}

/** The relaunch is one-shot: consume it before interpreting ordinary launch intents. */
export function readDeveloperRelaunch(args: string[]): DeveloperRelaunch | undefined {
  if (args[0] === "--no-sandbox") args = args.slice(1)
  const marker = args.find(arg => arg.startsWith(PREFIX))
  if (!marker) return
  if (args.length === 1) {
    try {
      const { restart: value, profile, pinned, config, storageRoot } = JSON.parse(Buffer.from(marker.slice(PREFIX.length), "base64url").toString("utf8"))
      const restart = readDeveloperRestart(value)
      // Storage keys also include verbatim normalized legacy aliases such as "default".
      if (restart && typeof profile === "string" && /^[a-z0-9._-]{1,255}$/.test(profile)
        && typeof pinned === "boolean" && (config === null || typeof config === "string" && isAbsolute(config) && !config.includes("\0"))
        && (storageRoot === undefined || typeof storageRoot === "string" && isAbsolute(storageRoot) && !storageRoot.includes("\0"))) {
        return { restart, profile, pinned, config, ...(storageRoot !== undefined && { storageRoot }) }
      }
    } catch { /* A malformed handoff must never fall back to another profile. */ }
  }
  throw new Error("Invalid CodeNomad automation relaunch")
}
