import fs from "node:fs"
import path from "node:path"
import { SettingsService } from "../service"
import { resolveConfigLocation } from "../../config/location"
import { createLogger } from "../../logger"

const [root, who, mode] = process.argv.slice(2)
const settings = new SettingsService(resolveConfigLocation(path.join(root, "config.yaml")), undefined,
  createLogger({ level: "ERROR" }))
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  if (mode === "crash-after-claim") process.exit(73)
  if (mode === "race") {
    fs.writeFileSync(path.join(root, `${who}.ready`), "")
    const deadline = Date.now() + 20_000
    while (!["a", "b"].every(id => fs.existsSync(path.join(root, `${id}.ready`)))) {
      if (Date.now() > deadline) throw new Error("Identity publication barrier timed out")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  return rename(from, to)
}
if (mode === "crash-before-claim") fs.linkSync = () => { process.exit(73) }
console.log(settings.getServerId())
