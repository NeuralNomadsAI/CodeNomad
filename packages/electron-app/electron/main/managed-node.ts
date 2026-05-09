import { app } from "electron"
import { existsSync, statSync } from "node:fs"
import path from "node:path"

interface NodeArtifactSpec {
  binaryRelativePath: string
}

function getNodeArtifactSpec(): NodeArtifactSpec {
  if (process.platform === "win32") {
    return { binaryRelativePath: "node.exe" }
  }

  return { binaryRelativePath: path.join("bin", "node") }
}

function getRuntimePlatformDir(): string {
  return `${process.platform}-${process.arch}`
}

function getCandidateRoots(): string[] {
  const platformDir = getRuntimePlatformDir()
  const roots: string[] = []

  if (app.isPackaged) {
    roots.push(path.join(process.resourcesPath, "node", platformDir))
  }

  // Development fallback for local packaged-resource smoke tests.
  roots.push(path.join(app.getAppPath(), "electron", "resources", "node", platformDir))

  return roots
}

export function ensureManagedNodeBinary(): string {
  const spec = getNodeArtifactSpec()

  for (const root of getCandidateRoots()) {
    const binaryPath = path.join(root, spec.binaryRelativePath)
    if (!existsSync(binaryPath)) {
      continue
    }

    const stats = statSync(binaryPath)
    if (stats.isFile()) {
      return binaryPath
    }
  }

  throw new Error(
    `Bundled Node runtime is missing for ${process.platform}-${process.arch}. Rebuild the desktop bundle with packaged Node resources.`,
  )
}
