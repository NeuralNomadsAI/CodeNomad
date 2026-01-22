import { createHash } from "crypto"
import fs from "fs"
import { promises as fsp } from "fs"
import os from "os"
import path from "path"
import { Readable } from "stream"
import { fetch } from "undici"
import yauzl from "yauzl"
import type { Logger } from "../logger"

export interface RemoteUiManifest {
  minServerVersion: string
  latestUIVersion: string
  uiPackageURL: string
  sha256: string
  latestServerVersion?: string
  latestServerUrl?: string
}

export type UiSource = "bundled" | "downloaded" | "previous" | "override" | "dev-proxy" | "missing"

export interface UiResolution {
  uiStaticDir?: string
  uiDevServerUrl?: string
  source: UiSource
  uiVersion?: string
  supported: boolean
  message?: string
  latestServerVersion?: string
  latestServerUrl?: string
  minServerVersion?: string
}

export interface RemoteUiOptions {
  serverVersion: string
  bundledUiDir: string
  autoUpdate: boolean
  overrideUiDir?: string
  uiDevServerUrl?: string
  manifestUrl?: string
  configDir?: string
  logger: Logger
}

const DEFAULT_MANIFEST_URL = "https://ui.codenomad.neuralnomads.ai/version.json"

const MANIFEST_TIMEOUT_MS = 5_000
const ZIP_TIMEOUT_MS = 30_000

export async function resolveUi(options: RemoteUiOptions): Promise<UiResolution> {
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL

  if (options.uiDevServerUrl) {
    return {
      uiDevServerUrl: options.uiDevServerUrl,
      source: "dev-proxy",
      supported: true,
    }
  }

  if (options.overrideUiDir) {
    const resolved = await resolveStaticUiDir(options.overrideUiDir)
    return {
      uiStaticDir: resolved ?? options.overrideUiDir,
      source: "override",
      uiVersion: await readUiVersion(resolved ?? options.overrideUiDir),
      supported: true,
    }
  }

  const uiRoot = resolveUiCacheRoot(options.configDir)
  const currentDir = path.join(uiRoot, "current")
  const previousDir = path.join(uiRoot, "previous")

  if (!options.autoUpdate) {
    return await resolveFromCacheOrBundled({
      logger: options.logger,
      bundledUiDir: options.bundledUiDir,
      currentDir,
      previousDir,
      supported: true,
    })
  }

  let manifest: RemoteUiManifest | null = null
  try {
    manifest = await fetchManifest(manifestUrl, options.logger)
  } catch (error) {
    options.logger.debug({ err: error }, "Remote UI manifest unavailable; using cached/bundled UI")
  }

  if (!manifest) {
    return await resolveFromCacheOrBundled({
      logger: options.logger,
      bundledUiDir: options.bundledUiDir,
      currentDir,
      previousDir,
      supported: true,
    })
  }

  const supported = compareSemverCore(options.serverVersion, manifest.minServerVersion) >= 0
  if (!supported) {
    const message = "Upgrade App to use latest features"
    return await resolveFromCacheOrBundled({
      logger: options.logger,
      bundledUiDir: options.bundledUiDir,
      currentDir,
      previousDir,
      supported: false,
      message,
      latestServerVersion: manifest.latestServerVersion,
      latestServerUrl: manifest.latestServerUrl,
      minServerVersion: manifest.minServerVersion,
    })
  }

  const bestLocal = await pickBestLocalUi({
    logger: options.logger,
    bundledUiDir: options.bundledUiDir,
    currentDir,
    previousDir,
  })

  const remoteIsNewer =
    !bestLocal ||
    compareSemverMaybe(manifest.latestUIVersion, bestLocal.uiVersion) > 0

  if (!remoteIsNewer) {
    return await resolveFromCacheOrBundled({
      logger: options.logger,
      bundledUiDir: options.bundledUiDir,
      currentDir,
      previousDir,
      supported: true,
      latestServerVersion: manifest.latestServerVersion,
      latestServerUrl: manifest.latestServerUrl,
      minServerVersion: manifest.minServerVersion,
    })
  }

  try {
    await installRemoteUi({
      manifest,
      uiRoot,
      currentDir,
      previousDir,
      logger: options.logger,
    })
  } catch (error) {
    options.logger.warn({ err: error }, "Failed to install remote UI; falling back")
    return await resolveFromCacheOrBundled({
      logger: options.logger,
      bundledUiDir: options.bundledUiDir,
      currentDir,
      previousDir,
      supported: true,
      latestServerVersion: manifest.latestServerVersion,
      latestServerUrl: manifest.latestServerUrl,
      minServerVersion: manifest.minServerVersion,
    })
  }

  const installed = await resolveStaticUiDir(currentDir)
  if (installed) {
    return {
      uiStaticDir: installed,
      source: "downloaded",
      uiVersion: await readUiVersion(installed),
      supported: true,
      latestServerVersion: manifest.latestServerVersion,
      latestServerUrl: manifest.latestServerUrl,
      minServerVersion: manifest.minServerVersion,
    }
  }

  return await resolveFromCacheOrBundled({
    logger: options.logger,
    bundledUiDir: options.bundledUiDir,
    currentDir,
    previousDir,
    supported: true,
    latestServerVersion: manifest.latestServerVersion,
    latestServerUrl: manifest.latestServerUrl,
    minServerVersion: manifest.minServerVersion,
  })
}

function resolveUiCacheRoot(configDir?: string): string {
  if (configDir) {
    return path.join(configDir, "ui")
  }
  return path.join(os.homedir(), ".config", "codenomad", "ui")
}

async function resolveFromCacheOrBundled(args: {
  logger: Logger
  bundledUiDir: string
  currentDir: string
  previousDir: string
  supported: boolean
  message?: string
  latestServerVersion?: string
  latestServerUrl?: string
  minServerVersion?: string
}): Promise<UiResolution> {
  const bestLocal = await pickBestLocalUi({
    logger: args.logger,
    bundledUiDir: args.bundledUiDir,
    currentDir: args.currentDir,
    previousDir: args.previousDir,
  })

  if (bestLocal) {
    return {
      uiStaticDir: bestLocal.uiStaticDir,
      source: bestLocal.source,
      uiVersion: bestLocal.uiVersion,
      supported: args.supported,
      message: args.message,
      latestServerVersion: args.latestServerVersion,
      latestServerUrl: args.latestServerUrl,
      minServerVersion: args.minServerVersion,
    }
  }

  args.logger.warn({ bundledUiDir: args.bundledUiDir }, "No UI assets found")
  return {
    uiStaticDir: args.bundledUiDir,
    source: "missing",
    supported: args.supported,
    message: args.message,
    latestServerVersion: args.latestServerVersion,
    latestServerUrl: args.latestServerUrl,
    minServerVersion: args.minServerVersion,
  }
}

async function pickBestLocalUi(args: {
  logger: Logger
  bundledUiDir: string
  currentDir: string
  previousDir: string
}): Promise<{ uiStaticDir: string; source: UiSource; uiVersion?: string } | null> {
  const candidates: Array<{ uiStaticDir: string; source: UiSource; uiVersion?: string; priority: number }> = []

  const currentResolved = await resolveStaticUiDir(args.currentDir)
  if (currentResolved) {
    candidates.push({
      uiStaticDir: currentResolved,
      source: "downloaded",
      uiVersion: await readUiVersion(currentResolved),
      priority: 2,
    })
  }

  const bundledResolved = await resolveStaticUiDir(args.bundledUiDir)
  if (bundledResolved) {
    candidates.push({
      uiStaticDir: bundledResolved,
      source: "bundled",
      uiVersion: await readUiVersion(bundledResolved),
      priority: 1,
    })
  }

  const previousResolved = await resolveStaticUiDir(args.previousDir)
  if (previousResolved) {
    candidates.push({
      uiStaticDir: previousResolved,
      source: "previous",
      uiVersion: await readUiVersion(previousResolved),
      priority: 0,
    })
  }

  if (candidates.length === 0) {
    return null
  }

  candidates.sort((a, b) => {
    const versionCmp = compareSemverMaybe(a.uiVersion, b.uiVersion)
    if (versionCmp !== 0) return -versionCmp
    return b.priority - a.priority
  })

  const best = candidates[0]
  if (!best) return null
  return { uiStaticDir: best.uiStaticDir, source: best.source, uiVersion: best.uiVersion }
}

function compareSemverMaybe(a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0
  if (!a) return -1
  if (!b) return 1
  return compareSemverCore(a, b)
}

async function resolveStaticUiDir(uiDir: string): Promise<string | null> {
  try {
    const indexPath = path.join(uiDir, "index.html")
    await fsp.access(indexPath, fs.constants.R_OK)
    return uiDir
  } catch {
    return null
  }
}

interface UiVersionFile {
  uiVersion?: string
  version?: string
}

async function readUiVersion(uiDir: string): Promise<string | undefined> {
  try {
    const content = await fsp.readFile(path.join(uiDir, "ui-version.json"), "utf-8")
    const parsed = JSON.parse(content) as UiVersionFile
    return parsed.uiVersion ?? parsed.version
  } catch {
    return undefined
  }
}

async function fetchManifest(url: string, logger: Logger): Promise<RemoteUiManifest> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "CodeNomad-CLI",
      },
    })
    if (!response.ok) {
      throw new Error(`Manifest responded with ${response.status}`)
    }
    const json = (await response.json()) as RemoteUiManifest
    validateManifest(json)
    return json
  } catch (error) {
    logger.debug({ err: error, url }, "Failed to fetch remote UI manifest")
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function validateManifest(manifest: RemoteUiManifest) {
  const required: Array<keyof RemoteUiManifest> = ["minServerVersion", "latestUIVersion", "uiPackageURL", "sha256"]
  for (const key of required) {
    const value = manifest[key]
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Manifest missing ${key}`)
    }
  }
  if (!/^https:\/\//i.test(manifest.uiPackageURL)) {
    throw new Error("uiPackageURL must be https")
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256.trim())) {
    throw new Error("sha256 must be 64 hex chars")
  }
}

async function installRemoteUi(args: {
  manifest: RemoteUiManifest
  uiRoot: string
  currentDir: string
  previousDir: string
  logger: Logger
}) {
  await fsp.mkdir(args.uiRoot, { recursive: true })

  const tmpDir = path.join(args.uiRoot, `tmp-${Date.now()}`)
  const zipPath = path.join(args.uiRoot, `ui-${args.manifest.latestUIVersion}.zip`)

  try {
    await downloadFile(args.manifest.uiPackageURL, zipPath, args.logger)
    const digest = await sha256File(zipPath)
    if (digest.toLowerCase() !== args.manifest.sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch for UI zip (expected ${args.manifest.sha256}, got ${digest})`)
    }

    await extractZip(zipPath, tmpDir)

    const indexPath = path.join(tmpDir, "index.html")
    if (!fs.existsSync(indexPath)) {
      throw new Error("Extracted UI missing index.html")
    }

    await rotateDirs({ currentDir: args.currentDir, previousDir: args.previousDir, logger: args.logger })

    fs.rmSync(args.currentDir, { recursive: true, force: true })
    fs.renameSync(tmpDir, args.currentDir)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(zipPath, { force: true })
  }
}

async function rotateDirs(args: { currentDir: string; previousDir: string; logger: Logger }) {
  try {
    if (fs.existsSync(args.previousDir)) {
      fs.rmSync(args.previousDir, { recursive: true, force: true })
    }
    if (fs.existsSync(args.currentDir)) {
      fs.renameSync(args.currentDir, args.previousDir)
    }
  } catch (error) {
    args.logger.warn({ err: error }, "Failed to rotate UI cache directories")
  }
}

async function downloadFile(url: string, targetPath: string, logger: Logger) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ZIP_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "CodeNomad-CLI",
      },
    })
    if (!response.ok || !response.body) {
      throw new Error(`UI zip download failed with ${response.status}`)
    }

    await fsp.mkdir(path.dirname(targetPath), { recursive: true })
    const fileStream = fs.createWriteStream(targetPath)

    const body = response.body
    if (!body) {
      throw new Error("UI zip response missing body")
    }

    const nodeStream = Readable.fromWeb(body as any)

    await new Promise<void>((resolve, reject) => {
      nodeStream.pipe(fileStream)
      nodeStream.on("error", reject)
      fileStream.on("error", reject)
      fileStream.on("finish", () => resolve())
    })

    logger.debug({ url, targetPath }, "Downloaded remote UI bundle")
  } finally {
    clearTimeout(timeout)
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  const stream = fs.createReadStream(filePath)
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve())
  })
  return hash.digest("hex")
}

async function extractZip(zipPath: string, targetDir: string): Promise<void> {
  await fsp.mkdir(targetDir, { recursive: true })

  await new Promise<void>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(openErr ?? new Error("Unable to open zip"))
        return
      }

      const root = path.resolve(targetDir)

      const closeWithError = (error: unknown) => {
        try {
          zipfile.close()
        } catch {
          // ignore
        }
        reject(error)
      }

      zipfile.readEntry()

      zipfile.on("entry", (entry) => {
        // Normalize and guard against zip-slip.
        const entryPath = entry.fileName.replace(/\\/g, "/")

        const segments = entryPath.split("/").filter(Boolean)
        if (segments.some((segment: string) => segment === "..") || path.isAbsolute(entryPath)) {
          closeWithError(new Error(`Invalid zip entry path: ${entry.fileName}`))
          return
        }

        const destination = path.resolve(targetDir, entryPath)
        if (!destination.startsWith(root + path.sep) && destination !== root) {
          closeWithError(new Error(`Zip entry escapes target dir: ${entry.fileName}`))
          return
        }

        const isDirectory = entry.fileName.endsWith("/")

        if (isDirectory) {
          fsp
            .mkdir(destination, { recursive: true })
            .then(() => zipfile.readEntry())
            .catch((error) => closeWithError(error))
          return
        }

        fsp
          .mkdir(path.dirname(destination), { recursive: true })
          .then(() => {
            zipfile.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr || !readStream) {
                closeWithError(streamErr ?? new Error("Unable to read zip entry"))
                return
              }

              const writeStream = fs.createWriteStream(destination)
              const cleanup = (error?: unknown) => {
                readStream.destroy()
                writeStream.destroy()
                if (error) {
                  closeWithError(error)
                }
              }

              readStream.on("error", cleanup)
              writeStream.on("error", cleanup)
              writeStream.on("finish", () => zipfile.readEntry())

              readStream.pipe(writeStream)
            })
          })
          .catch((error) => closeWithError(error))
      })

      zipfile.on("end", () => {
        zipfile.close()
        resolve()
      })

      zipfile.on("error", (error) => closeWithError(error))
    })
  })
}

function compareSemverCore(a: string, b: string): number {
  const pa = parseSemverCore(a)
  const pb = parseSemverCore(b)
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1
  return 0
}

function parseSemverCore(value: string): { major: number; minor: number; patch: number } {
  const core = value.trim().replace(/^v/i, "").split("-", 1)[0] ?? "0.0.0"
  const parts = core.split(".")
  const parsePart = (input: string | undefined) => {
    const n = Number.parseInt((input ?? "0").replace(/[^0-9]/g, ""), 10)
    return Number.isFinite(n) ? n : 0
  }
  return {
    major: parsePart(parts[0]),
    minor: parsePart(parts[1]),
    patch: parsePart(parts[2]),
  }
}
