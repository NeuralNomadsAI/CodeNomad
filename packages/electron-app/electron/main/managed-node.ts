import { dialog, app } from "electron"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { createWriteStream } from "node:fs"
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { pipeline } from "node:stream/promises"
import { spawn } from "node:child_process"

const MANAGED_NODE_VERSION = "v22.22.2"
const CONFIG_DIR = path.join(app.getPath("home"), ".config", "codenomad")

interface NodeArtifactSpec {
  archiveName: string
  archiveRoot: string
  binaryRelativePath: string
  url: string
}

function getNodeArtifactSpec(): NodeArtifactSpec {
  const platform = process.platform
  const arch = process.arch

  if (platform === "darwin" && arch === "x64") {
    return buildTarGzSpec("darwin-x64")
  }
  if (platform === "darwin" && arch === "arm64") {
    return buildTarGzSpec("darwin-arm64")
  }
  if (platform === "linux" && arch === "x64") {
    return buildTarGzSpec("linux-x64")
  }
  if (platform === "linux" && arch === "arm64") {
    return buildTarGzSpec("linux-arm64")
  }
  if (platform === "win32" && arch === "x64") {
    return buildZipSpec("win-x64", "node.exe")
  }
  if (platform === "win32" && arch === "arm64") {
    return buildZipSpec("win-arm64", "node.exe")
  }

  throw new Error(`Managed Node runtime is not supported on ${platform}-${arch}.`)
}

function buildTarGzSpec(target: string): NodeArtifactSpec {
  const archiveName = `node-${MANAGED_NODE_VERSION}-${target}.tar.gz`
  return {
    archiveName,
    archiveRoot: archiveName.replace(/\.tar\.gz$/, ""),
    binaryRelativePath: path.join("bin", "node"),
    url: `https://nodejs.org/dist/${MANAGED_NODE_VERSION}/${archiveName}`,
  }
}

function buildZipSpec(target: string, binaryName: string): NodeArtifactSpec {
  const archiveName = `node-${MANAGED_NODE_VERSION}-${target}.zip`
  return {
    archiveName,
    archiveRoot: archiveName.replace(/\.zip$/, ""),
    binaryRelativePath: binaryName,
    url: `https://nodejs.org/dist/${MANAGED_NODE_VERSION}/${archiveName}`,
  }
}

function getRuntimePlatformDir(): string {
  return `${process.platform}-${process.arch}`
}

function getManagedNodeRoot(): string {
  return path.join(CONFIG_DIR, "node", MANAGED_NODE_VERSION, getRuntimePlatformDir())
}

function getManagedNodeBinaryPath(): string {
  return path.join(getManagedNodeRoot(), getNodeArtifactSpec().binaryRelativePath)
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath)
  } catch {
    return false
  }
}

async function fetchText(url: string): Promise<string> {
  const response = await request(url)
  return response.toString("utf-8")
}

function request(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doRequest = (target: string) => {
      https
        .get(target, (response) => {
          const statusCode = response.statusCode ?? 0
          const redirect = response.headers.location

          if (statusCode >= 300 && statusCode < 400 && redirect) {
            response.resume()
            doRequest(new URL(redirect, target).toString())
            return
          }

          if (statusCode < 200 || statusCode >= 300) {
            response.resume()
            reject(new Error(`Request failed for ${target} with status ${statusCode}`))
            return
          }

          const chunks: Buffer[] = []
          response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
          response.on("end", () => resolve(Buffer.concat(chunks)))
          response.on("error", reject)
        })
        .on("error", reject)
    }

    doRequest(url)
  })
}

function downloadFile(url: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doDownload = (target: string) => {
      https
        .get(target, (response) => {
          const statusCode = response.statusCode ?? 0
          const redirect = response.headers.location

          if (statusCode >= 300 && statusCode < 400 && redirect) {
            response.resume()
            doDownload(new URL(redirect, target).toString())
            return
          }

          if (statusCode < 200 || statusCode >= 300) {
            response.resume()
            reject(new Error(`Download failed for ${target} with status ${statusCode}`))
            return
          }

          const output = createWriteStream(destination)
          pipeline(response, output).then(() => resolve()).catch(reject)
        })
        .on("error", reject)
    }

    doDownload(url)
  })
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve())
    stream.on("error", reject)
  })
  return hash.digest("hex")
}

async function fetchExpectedSha256(archiveName: string): Promise<string> {
  const checksums = await fetchText(`https://nodejs.org/dist/${MANAGED_NODE_VERSION}/SHASUMS256.txt`)
  for (const line of checksums.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [checksum, fileName] = trimmed.split(/\s+/, 2)
    if (fileName === archiveName) {
      return checksum
    }
  }
  throw new Error(`Unable to find checksum for ${archiveName}.`)
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? 1}`))
      }
    })
  })
}

async function extractArchive(archivePath: string, destination: string): Promise<void> {
  if (archivePath.endsWith(".zip")) {
    const command = process.platform === "win32" ? "powershell.exe" : "powershell"
    await runCommand(command, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive",
      "-LiteralPath",
      archivePath,
      "-DestinationPath",
      destination,
      "-Force",
    ])
    return
  }

  await runCommand("tar", ["-xzf", archivePath, "-C", destination])
}

async function promptForManagedNodeDownload(): Promise<boolean> {
  const result = await dialog.showMessageBox({
    type: "question",
    buttons: ["Download", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: "Download Node Runtime",
    message: "CodeNomad needs its managed Node.js runtime to start the server.",
    detail: `Download ${MANAGED_NODE_VERSION} for ${process.platform}-${process.arch} into ~/.config/codenomad?`,
  })

  return result.response === 0
}

async function installManagedNodeRuntime(): Promise<string> {
  const spec = getNodeArtifactSpec()
  const runtimeRoot = getManagedNodeRoot()
  const runtimeParent = path.dirname(runtimeRoot)
  await mkdir(runtimeParent, { recursive: true })
  const tempRoot = await mkdtemp(path.join(runtimeParent, ".download-"))
  const archivePath = path.join(tempRoot, spec.archiveName)
  const extractRoot = path.join(tempRoot, "extract")

  try {
    await mkdir(extractRoot, { recursive: true })

    const expectedSha = await fetchExpectedSha256(spec.archiveName)
    await downloadFile(spec.url, archivePath)

    const actualSha = await sha256File(archivePath)
    if (actualSha !== expectedSha) {
      throw new Error(`Checksum mismatch for ${spec.archiveName}.`)
    }

    await extractArchive(archivePath, extractRoot)

    const extractedRoot = path.join(extractRoot, spec.archiveRoot)
    const extractedBinary = path.join(extractedRoot, spec.binaryRelativePath)
    if (!fileExists(extractedBinary)) {
      throw new Error(`Managed Node binary missing after extraction: ${extractedBinary}`)
    }

    await rm(runtimeRoot, { recursive: true, force: true })
    await rename(extractedRoot, runtimeRoot)

    return path.join(runtimeRoot, spec.binaryRelativePath)
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function ensureManagedNodeBinary(): Promise<string> {
  const binaryPath = getManagedNodeBinaryPath()
  if (fileExists(binaryPath)) {
    return binaryPath
  }

  const confirmed = await promptForManagedNodeDownload()
  if (!confirmed) {
    throw new Error("CodeNomad requires the managed Node.js runtime to start. Download was cancelled.")
  }

  const installedBinary = await installManagedNodeRuntime()
  const installedStats = await stat(installedBinary)
  if (!installedStats.isFile()) {
    throw new Error(`Managed Node binary is invalid: ${installedBinary}`)
  }

  return installedBinary
}
