import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { resolveWriteDestination } from "./yaml-doc-store"

/** Elect one persistent identity; an interrupted writer requires explicit repair. */
export function claimServerIdentity(configPath: string): string {
  const identityPath = `${resolveWriteDestination(configPath)}.server-id`
  const read = () => z.string().uuid().parse(fs.readFileSync(identityPath, "utf8").trim())
  fs.mkdirSync(path.dirname(identityPath), { recursive: true })
  try {
    const handle = fs.openSync(identityPath, "wx", 0o600)
    try { fs.writeFileSync(handle, randomUUID()) }
    finally { fs.closeSync(handle) }
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error
  }
  const deadline = Date.now() + 1000
  while (true) {
    try { return read() }
    catch (error) {
      if (!(error instanceof z.ZodError)) throw error
      if (Date.now() >= deadline) {
        throw new Error("Incomplete or invalid server identity file; explicit repair required")
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}
