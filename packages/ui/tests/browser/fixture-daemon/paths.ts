import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

/** The canonical daemon discovery location for a given UI root; the daemon
 * entry claims this directory and borrowers read its ready file. */
export function readyDirectoryFor(uiRoot: string): string {
  const runKey = createHash("sha1").update(uiRoot).digest("hex").slice(0, 12)
  return path.join(tmpdir(), `codenomad-fixture-daemon-${runKey}`)
}
