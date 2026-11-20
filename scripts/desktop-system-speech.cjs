const { execFileSync } = require("node:child_process")
const { mkdirSync } = require("node:fs")
const { dirname, join, resolve } = require("node:path")

const source = resolve(__dirname, "../packages/desktop-speech")

function buildSystemSpeech(serverDest, target, output) {
  const [platform, arch] = target.split("-")
  if (platform !== "win32" && platform !== "darwin") return
  if (platform !== process.platform) throw new Error(`System dictation must be built on a ${platform} host`)
  const executable = output ?? join(serverDest, "desktop-speech",
    platform === "win32" ? "codenomad-system-speech.exe" : "codenomad-system-speech")
  mkdirSync(dirname(executable), { recursive: true })
  if (platform === "win32") {
    const windows = process.env.SystemRoot
    const compiler = join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
    const assembly = join(windows, "Microsoft.NET", "assembly", "GAC_MSIL", "System.Speech",
      "v4.0_4.0.0.0__31bf3856ad364e35", "System.Speech.dll")
    execFileSync(compiler, ["/nologo", "/platform:anycpu", "/optimize+", `/reference:${assembly}`,
      "/reference:System.Web.Extensions.dll", `/out:${executable}`, join(source, "system-windows.cs")], { stdio: "inherit" })
  } else {
    execFileSync("/usr/bin/xcrun", ["clang", "-arch", arch === "x64" ? "x86_64" : "arm64",
      "-mmacosx-version-min=13.5", "-O2", "-fobjc-arc", "-Wall", "-Wextra",
      "-framework", "Foundation", "-framework", "AVFoundation", "-framework", "Speech",
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
      "-Xlinker", join(source, "system-macos.plist"), join(source, "system-macos.m"), "-o", executable], { stdio: "inherit" })
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements",
      join(source, "system-macos-entitlements.plist"), executable], { stdio: "inherit" })
  }
  return executable
}

function buildTauriSystemSpeech(resources, target) {
  const sidecar = target.startsWith("darwin-")
    ? join(resources, `codenomad-system-speech-${target === "darwin-x64" ? "x86_64" : "aarch64"}-apple-darwin`)
    : undefined
  return buildSystemSpeech(join(resources, "server"), target, sidecar)
}

module.exports = { buildSystemSpeech, buildTauriSystemSpeech }

if (require.main === module) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/desktop-system-speech.cjs <server resource directory>")
  buildSystemSpeech(resolve(process.argv[2]), `${process.platform}-${process.arch}`)
}
