import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { BACKEND_RUNTIME_ENVIRONMENT } from "./backend-runtime"

let electron: string | undefined
let unavailable = ""
try { electron = createRequire(import.meta.url)("electron") as string }
catch (error) { unavailable = `Electron binary unavailable: ${error instanceof Error ? error.message : String(error)}` }

/** A minimal valid archive: Electron's fs treats it as a directory holding `a.txt`. */
function asarArchive(): Buffer {
  const header = Buffer.from(JSON.stringify({ files: { "a.txt": { size: 5, offset: "0" } } }))
  const padded = Buffer.alloc(Math.ceil(header.length / 4) * 4)
  header.copy(padded)
  const pickle = Buffer.alloc(8 + padded.length)
  pickle.writeUInt32LE(4 + padded.length, 0)
  pickle.writeUInt32LE(header.length, 4)
  padded.copy(pickle, 8)
  const size = Buffer.alloc(8)
  size.writeUInt32LE(4, 0)
  size.writeUInt32LE(pickle.length, 4)
  return Buffer.concat([size, pickle, Buffer.from("hello")])
}

// Runs inside Electron as Node: inspects both files, then removes their folder.
const probe = `
const fs = require("fs"), path = require("path")
const directory = process.argv[1]
const inspect = name => {
  const file = path.join(directory, name)
  try {
    const stat = fs.statSync(file)
    let bytes = null
    try { bytes = fs.readFileSync(file).length } catch (error) { bytes = error.code || error.message }
    return { directory: stat.isDirectory(), bytes }
  } catch (error) { return { error: error.code || error.message } }
}
const result = { valid: inspect("app.asar"), invalid: inspect("broken.asar") }
try { fs.rmSync(directory, { recursive: true }); result.rm = "removed" } catch (error) { result.rm = error.code || error.message }
process.stdout.write(JSON.stringify(result))
`

async function runProbe(env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "backend-asar-"))
  const archive = asarArchive()
  await writeFile(path.join(directory, "app.asar"), archive)
  await writeFile(path.join(directory, "broken.asar"), "not an archive")
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("ELECTRON_")))
  try {
    const output = execFileSync(electron!, ["-e", probe, directory], { env: { ...base, ...env }, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    return { result: JSON.parse(output), size: archive.length }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test("the backend runtime keeps project .asar files ordinary files", { skip: unavailable || false }, async () => {
  // Control: Electron as Node without ELECTRON_NO_ASAR reads the valid archive as a directory.
  const control = await runProbe({ ELECTRON_RUN_AS_NODE: "1" })
  assert.equal(control.result.valid.directory, true, "the fixture is a valid archive for Electron's fs")

  const { result, size } = await runProbe(BACKEND_RUNTIME_ENVIRONMENT)
  assert.deepEqual(result, {
    valid: { directory: false, bytes: size },
    invalid: { directory: false, bytes: "not an archive".length },
    rm: "removed",
  })
})
