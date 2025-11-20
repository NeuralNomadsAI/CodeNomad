#!/usr/bin/env node

import { spawn } from "child_process"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cliEntry = path.join(__dirname, "index.js")
const loaderFileUrl = pathToFileURL(path.join(__dirname, "loader.js")).href
const registerScript = `import { register } from "node:module"; import { pathToFileURL } from "node:url"; register("${encodeURI(loaderFileUrl)}", pathToFileURL("./"));`
const loaderArg = `data:text/javascript,${registerScript}`

const child = spawn(process.execPath, ["--import", loaderArg, cliEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on("error", (error) => {
  console.error("Failed to launch CLI runtime", error)
  process.exit(1)
})
