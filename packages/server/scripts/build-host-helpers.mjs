import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import path from "node:path"
const root = new URL("../", import.meta.url)
const destination = new URL("dist/host-lifetime/", root)
await mkdir(destination, { recursive: true })
if (process.platform === "win32") {
  execFileSync(path.join(process.env.SystemRoot, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
    ["/nologo", "/target:winexe", "/optimize+", `/out:${fileURLToPath(new URL("opencode-login-launcher.exe", destination))}`,
      fileURLToPath(new URL("src/host-lifetime/opencode-login-launcher.cs", root))], { windowsHide: true })
}
if (process.platform === "darwin") {
  execFileSync("/usr/bin/clang", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-arch", "x86_64", "-arch", "arm64", "-mmacosx-version-min=13.5",
    fileURLToPath(new URL("src/host-lifetime/process-identity-macos.c", root)),
    "-o", fileURLToPath(new URL("process-identity-macos", destination))])
}
