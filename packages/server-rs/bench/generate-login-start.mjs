// Golden artifacts from the TypeScript implementation; renders only, without OS calls.
import path from "node:path"
import { writeFile } from "node:fs/promises"
import { fromDist, repo } from "./fixtures.mjs"

const { windowsLoginTaskXml } = await fromDist("host-lifetime/opencode-login-start-windows.js")
const { linuxLoginUnit, macosLoginAgentPlist } = await fromDist("host-lifetime/opencode-login-start-posix.js")
const args = ["serve", "--service"]
const windows = windowsLoginTaskXml({ user: "S-1-5-21-1234", launcher: "C:\\Users\\fixture\\launcher.exe",
  workingDirectory: "C:\\Users\\fixture", launch: { command: "C:\\Code & Files\\opencode.exe", args } })
  .replace(/>\s+</g, "><").trim()
const launch = { command: "/home/u/Code & $files%/opencode", args, environment: { PATH: "/opt/code:/bin" } }
await writeFile(path.join(repo, "packages/server-rs/tests/fixtures/login-start.json"),
  JSON.stringify({ windows, linux: linuxLoginUnit(launch), macos: macosLoginAgentPlist(launch) }, null, 2) + "\n")
