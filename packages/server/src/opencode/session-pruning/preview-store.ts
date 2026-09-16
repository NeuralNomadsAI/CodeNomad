import path from "node:path"
import type { z } from "zod"
import type { messageTargetSchema } from "./contract"
import { storageDirectory } from "./storage-path"
import type { LocationRef } from "@opencode/client"

export async function readPruningPreview(
  filename: unknown, target: z.infer<typeof messageTargetSchema>, location: LocationRef, projectID: string,
): Promise<unknown | undefined> {
  // Deliberately no default ~/.local/share path or UI-supplied override.
  if (typeof filename !== "string" || !path.isAbsolute(filename)) return undefined
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 1000 })
  try {
    db.exec("PRAGMA query_only=ON")
    const row = db.prepare(`SELECT m.data FROM session_message m
      JOIN session_v2 s ON s.id = m.session_id
      WHERE m.id = ? AND m.session_id = ? AND m.type = 'assistant' AND s.directory = ?
       AND s.project_id = ? AND s.workspace_id IS ?
       AND length(CAST(m.data AS BLOB)) <= 16777216`).get(target.messageID, target.sessionID,
         storageDirectory(location.directory), projectID, location.workspaceID ?? null)
    return typeof row?.data === "string" ? JSON.parse(row.data) : undefined
  } finally { db.close() }
}
