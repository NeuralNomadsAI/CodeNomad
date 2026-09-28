// Isolate the sole HKCU side effect of the packaged installer. Every other
// process (bundled npm, CLI, native service start) executes normally.
const cp = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const { syncBuiltinESMExports } = require("node:module")
const original = cp.execFile
cp.execFile = function (file, args, options, callback) {
  const index = args?.indexOf("-EncodedCommand") ?? -1
  if (/powershell\.exe$/i.test(file) && index >= 0) {
    const script = Buffer.from(args[index + 1], "base64").toString("utf16le")
    if (script.includes("CodeNomad.EnvironmentBroadcast") && script.includes("CurrentUser.CreateSubKey('Environment')")) {
      const home = process.env.OPENCODE_TEST_HOME
      const prefix = path.join(process.env.APPDATA, "npm")
      if (!home || !prefix.startsWith(home + path.sep) || !script.includes(`$bin = '${prefix.replaceAll("'", "''")}'`)) {
        throw new Error("Refusing non-fixture PATH registration")
      }
      fs.writeFileSync(path.join(home, "path-registration.json"), JSON.stringify({ prefix }))
      queueMicrotask(() => callback(null, "", ""))
      return
    }
  }
  return original.apply(this, arguments)
}
syncBuiltinESMExports()
