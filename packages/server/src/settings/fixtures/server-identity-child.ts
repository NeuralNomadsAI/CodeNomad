import fs from "node:fs"
import path from "node:path"
import { SettingsService } from "../service"
import { resolveConfigLocation } from "../../config/location"
import { createLogger } from "../../logger"

const [root, who, mode] = process.argv.slice(2)
const logger = createLogger({ level: "ERROR" })
logger.warn = ((details: { err?: Error }) => { process.stderr.write(`${details.err?.stack}\n`) }) as typeof logger.warn
const settings = new SettingsService(resolveConfigLocation(path.join(root, "config.yaml")), undefined, logger)
const rename = fs.renameSync
fs.renameSync = (from, to) => {
  if (mode === "crash-after-claim") process.exit(73)
  return rename(from, to)
}
const open = fs.openSync
fs.openSync = (file, flags, permissions) => {
  if (String(file).endsWith(".server-id") && flags === "wx") {
    if (mode === "crash-before-claim") process.exit(73)
    if (mode === "race") {
      fs.writeFileSync(path.join(root, `${who}.ready`), "")
      const deadline = Date.now() + 20_000
      while (!["a", "b"].every(id => fs.existsSync(path.join(root, `${id}.ready`)))) {
        if (Date.now() > deadline) throw new Error("Identity publication barrier timed out")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
  }
  return open(file, flags, permissions)
}
const write = fs.writeFileSync
fs.writeFileSync = (file, data, options) => {
  if (typeof file === "number" && ["crash-partial", "slow-writer"].includes(mode)) {
    write(file, String(data).slice(0, 8), options)
    if (mode === "crash-partial") process.exit(73)
    write(path.join(root, "partial.ready"), "")
    const deadline = Date.now() + 20_000
    while (!fs.existsSync(path.join(root, "contender.read"))) {
      if (Date.now() > deadline) throw new Error("Contender read barrier timed out")
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    return write(file, String(data).slice(8), options)
  }
  return write(file, data, options)
}
if (mode === "contender") {
  const read = fs.readFileSync
  fs.readFileSync = ((...args: Parameters<typeof read>) => {
    const result = read(...args)
    if (String(args[0]).endsWith(".server-id")) fs.writeFileSync(path.join(root, "contender.read"), "")
    return result
  }) as typeof read
  const deadline = Date.now() + 20_000
  while (!fs.existsSync(path.join(root, "partial.ready"))) {
    if (Date.now() > deadline) throw new Error("Partial writer barrier timed out")
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
console.log(settings.getServerId())
