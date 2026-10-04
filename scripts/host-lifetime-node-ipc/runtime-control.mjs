// PRIVATE nested-Job proof launcher. Native supervisor is NOT independently launched.
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = process.argv[2]
const repo = fileURLToPath(new URL("../../", import.meta.url))
const native = path.join(repo, "packages/native-host-lifetime/target/debug/host-lifetime-fixture.exe")
const config = Buffer.from([process.execPath, root,
  new URL("./loader.mjs", import.meta.url).href,
  fileURLToPath(new URL("./runtime-manager.ts", import.meta.url))].join("\n"))
if (!path.isAbsolute(root) || config.length > 4000) process.exit(1)
const child = spawn(native, ["runtime-ipc"], { stdio: ["pipe", "pipe", "pipe"],
  shell: false, windowsHide: true, cwd: repo })
const packet = Buffer.alloc(4 + config.length); packet.writeUInt32LE(config.length); config.copy(packet, 4)
child.stdin.on("error", () => undefined); child.stdin.write(packet)
let output = Buffer.alloc(0), errors = 0, staticError = ""
const deadline = setTimeout(() => { child.stdin.destroy(); process.exitCode = 1 }, 45_000)
child.stdout.on("data", data => {
  output = Buffer.concat([output, data])
  if (output.length > 4096) { child.stdout.destroy(); child.stdin.destroy(); process.exitCode = 1 }
})
child.stderr.on("data", data => {
  errors += data.length
  if (errors <= 1024) staticError += data.toString()
  else child.stderr.destroy()
})
child.once("error", () => { clearTimeout(deadline); process.exitCode = 1 })
child.once("close", code => {
  clearTimeout(deadline); child.stdin.destroy()
  try {
    if (code !== 0 || process.exitCode || errors) throw new Error("private-runtime-failed")
    const evidence = JSON.parse(output.toString())
    // Native fixture emits only this fixed bounded schema, never M stdout/auth tokens.
    if (evidence.runtimeInheritedJob !== true || evidence.nativeMembershipBeforeReadiness !== 4
      || evidence.independentLaunchQualified !== false) throw new Error("private-runtime-failed")
    console.log(JSON.stringify(evidence))
  } catch {
    const code = staticError.trim()
    console.log(JSON.stringify({ failedStage: "native-runtime",
      code: /^(native|runtime-fixture)-[a-z-]+$/.test(code) ? code : "private-runtime-failed" }))
    process.exitCode = 1
  }
})
