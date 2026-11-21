const { execFileSync } = require("node:child_process")
const { mkdirSync } = require("node:fs")
const { dirname, join, resolve } = require("node:path")

const source = resolve(__dirname, "../packages/desktop-speech")

function buildSystemSpeech(serverDest, target, output) {
  const [platform, arch] = target.split("-")
  if (platform !== "darwin") return
  if (process.platform !== "darwin") throw new Error("System dictation must be built on a macOS host")
  const executable = output ?? join(serverDest, "desktop-speech", "codenomad-system-speech")
  mkdirSync(dirname(executable), { recursive: true })
  execFileSync("/usr/bin/xcrun", ["clang", "-arch", arch === "x64" ? "x86_64" : "arm64",
    "-mmacosx-version-min=13.5", "-O2", "-fobjc-arc", "-Wall", "-Wextra",
    "-framework", "Foundation", "-framework", "AVFoundation", "-framework", "Speech",
    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
    "-Xlinker", join(source, "system-macos.plist"), join(source, "system-macos.m"), "-o", executable], { stdio: "inherit" })
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements",
    join(source, "system-macos-entitlements.plist"), executable], { stdio: "inherit" })
  return executable
}

function buildTauriSystemSpeech(resources, target) {
  if (!target.startsWith("darwin-")) return
  const sidecar = join(resources, `codenomad-system-speech-${target === "darwin-x64" ? "x86_64" : "aarch64"}-apple-darwin`)
  return buildSystemSpeech(join(resources, "server"), target, sidecar)
}

module.exports = { buildSystemSpeech, buildTauriSystemSpeech }

if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/desktop-system-speech.cjs <server resource directory>")
  buildSystemSpeech(resolve(process.argv[2]), `${process.platform}-${process.arch}`)
}
