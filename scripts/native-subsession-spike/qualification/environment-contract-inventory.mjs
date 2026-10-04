// Static, read-only inventory of the assigned binary, not another CLI execution.
import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
const path = "C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe"
const bytes = await readFile(path), fragments = []
for (const key of ["OPENCODE_SESSION_ID", "OPENCODE_TERMINAL"]) {
  let from = 0
  for (let count = 0; count < 32; count++) {
    const offset = bytes.indexOf(key, from); if (offset < 0) break
    const fragment = bytes.subarray(Math.max(0, offset - 220), offset + 270).toString("utf8")
    if (fragment.includes('D.env.OPENCODE_SESSION_ID=U.sessionID') || fragment.includes('env:{...ke??process.env,TERM:"xterm-256color",OPENCODE_TERMINAL:"1"}')) fragments.push({ key, offset, fragment })
    from = offset + key.length
  }
}
assert(fragments.some(item => item.key === "OPENCODE_SESSION_ID"))
assert(fragments.some(item => item.key === "OPENCODE_TERMINAL"))
const inventory = { binary: path, binarySHA256: createHash("sha256").update(bytes).digest("hex"), fragments,
  interpretation: { toolSessionID: "Native shell Tool writes its caller session ID; direct session.shell does not make that Tool-level addition in measured maps", terminal: "Native shell creation overlays OPENCODE_TERMINAL=1 and TERM=xterm-256color on the session snapshot", modulePath: "PowerShell documents PSModulePath reconstruction on each startup; exact machine-specific transformation remains unqualified, and mismatched hashes are not excluded" },
  modulePathSource: "https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.5" }
await writeFile(new URL("./ENV_NATIVE_CONTRACT.json", import.meta.url), JSON.stringify(inventory, null, 2))
console.log(JSON.stringify(inventory, null, 2))
