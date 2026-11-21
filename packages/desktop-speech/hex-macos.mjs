import { mkdtempSync, renameSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ensureDirectory, fileInfo, publish, readReceipt } from "./hex-files.mjs"
import { hexVersion } from "./hex-manifest.mjs"
import { command } from "./hex-process.mjs"

const requirement = 'anchor apple generic and identifier "anomaly.hex" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "5NZ4Q7NXJ4"'
const executable = app => join(app, "Contents", "MacOS", "hex")
const infoPlist = app => join(app, "Contents", "Info.plist")

function stampApp(app) {
  if (!ensureDirectory(app) || !ensureDirectory(join(app, "Contents")) ||
      !ensureDirectory(join(app, "Contents", "MacOS"))) return
  const binary = fileInfo(executable(app))
  const plist = fileInfo(infoPlist(app))
  if (binary && plist) return `${binary.stamp}/${plist.stamp}`
}

export function* macCandidates() {
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    const app = join(dir, "Hex.app")
    try {
      const stamp = stampApp(app)
      if (stamp) yield { path: executable(app), stamp, app }
    } catch { /* Don't traverse external symlinks. */ }
  }
}

export function macExecutable(root) {
  const app = join(root, "Hex.app")
  const stamp = stampApp(app)
  if (stamp && readReceipt(join(root, "mac-app.verified.json"))?.stamp === stamp) return { path: executable(app), stamp }
}

export async function verifyMac(app, signal) {
  await command("/usr/bin/codesign", ["--verify", "--deep", "--strict", `-R=${requirement}`, app], signal)
  return await command("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", infoPlist(app)], signal) === hexVersion
}

export async function materializeMac(root, source, signal) {
  const temp = mkdtempSync(join(root, "extract-"))
  const stagedApp = join(temp, "Hex.app")
  const final = join(root, "Hex.app")
  try {
    if (source.app) {
      if (stampApp(source.app) !== source.stamp) return false
      await command("/usr/bin/ditto", [source.app, stagedApp], signal)
    } else {
      await command("/usr/bin/ditto", ["-x", "-k", source.archive, temp], signal)
    }
    if (!stampApp(stagedApp) || !await verifyMac(stagedApp, signal)) return false
    signal.throwIfAborted()
    // This directory is the app's disposable, versioned cache, never the user's installation.
    rmSync(final, { recursive: true, force: true })
    renameSync(stagedApp, final)
    publish(join(root, "mac-app.verified.json"), JSON.stringify({ stamp: stampApp(final) }))
    return true
  } catch (error) {
    signal.throwIfAborted()
    if (!source.app) throw error
    return false
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
