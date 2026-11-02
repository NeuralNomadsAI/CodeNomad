import { build } from "esbuild"
import { copyFile, mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
const root = new URL("../", import.meta.url)
const destination = new URL("dist/host-lifetime/", root)
await mkdir(destination, { recursive: true })
const options = { bundle: true, platform: "node", format: "cjs", target: "node22",
  define: { "import.meta.url": "__moduleURL" },
  banner: { js: 'const __moduleURL = require("node:url").pathToFileURL(__filename).href;' } }
await build({ entryPoints: [fileURLToPath(new URL("src/host-lifetime/service-supervision-probe.ts", root))],
  outfile: fileURLToPath(new URL("service-supervision-probe.cjs", destination)), ...options })
await copyFile(new URL("src/host-lifetime/service-supervision-windows.ps1", root), new URL("service-supervision-windows.ps1", destination))
await build({ entryPoints: [fileURLToPath(new URL("src/host-lifetime/service-supervision-linux-guard.ts", root))],
  outfile: fileURLToPath(new URL("service-supervision-linux-guard.cjs", destination)), ...options })
if (process.platform === "darwin") {
  execFileSync("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", "x86_64", "-arch", "arm64", "-mmacosx-version-min=13.5",
    fileURLToPath(new URL("src/host-lifetime/service-supervision-macos-native.c", root)),
    "-o", fileURLToPath(new URL("service-supervision-macos-native", destination))])
}
