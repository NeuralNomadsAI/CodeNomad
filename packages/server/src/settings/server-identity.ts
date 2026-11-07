import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { resolveWriteDestination } from "./yaml-doc-store"

/** Publish a complete immutable claim exclusively; a crash can only leave an unused temp file. */
export function claimServerIdentity(configPath: string): string {
  const identityPath = `${resolveWriteDestination(configPath)}.server-id`
  const read = () => z.string().uuid().parse(fs.readFileSync(identityPath, "utf8").trim())
  try {
    return read()
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error
  }
  fs.mkdirSync(path.dirname(identityPath), { recursive: true })
  const temporary = `${identityPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, randomUUID(), { flag: "wx", mode: 0o600 })
    try {
      // link is an atomic, no-replace publication on Windows, macOS and Linux.
      fs.linkSync(temporary, identityPath)
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error
    }
    return read()
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}
