import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dist = path.join(packageRoot, "dist")
fs.mkdirSync(dist, { recursive: true })
fs.writeFileSync(path.join(dist, "version.json"), "{}\n", "utf8")
