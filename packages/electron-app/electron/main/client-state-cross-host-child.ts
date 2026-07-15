import { existsSync, writeFileSync } from "node:fs"
import { CrossHostRegistration, createCrossHostOwner } from "./client-state-cross-host"

const [directory, startPath, readyPath] = process.argv.slice(2)
if (!directory || !startPath) throw new Error("Expected election directory and start path")
if (readyPath) writeFileSync(readyPath, "")
while (!existsSync(startPath)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)

const owner = createCrossHostOwner()
const registration = owner && CrossHostRegistration.register(directory, owner, true)
process.stdout.write(`${JSON.stringify({ acquired: Boolean(registration?.isPrimary) })}\n`)
process.stdin.resume()
process.stdin.once("end", () => registration?.release())
