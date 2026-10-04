/** PRIVATE fixture launcher. Never packaged/enabled as a product manager. */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHostLifetimeManagerForPrivateFixture } from "./manager"
import { HostStorage } from "./storage"
import { fixtureStoragePolicy } from "./test-fixture"
import { canonicalScope } from "./protocol"

const [mode, root] = process.argv.slice(2)
if (mode === "manager") {
  const config = path.join(root, "profile", "config.yaml")
  const scope = canonicalScope("stable", config, root, root)
  const manager = createHostLifetimeManagerForPrivateFixture({
    storage: new HostStorage(path.join(root, "hosts"), scope, fixtureStoragePolicy),
    backend: {
      file: process.execPath,
      args: ["--import", "tsx", fileURLToPath(new URL("./backend-entry.ts", import.meta.url)),
        ...process.argv.slice(4)],
      cwd: process.cwd(),
      env: { ...process.env, CODENOMAD_HOST_BACKEND_ENTRY: path.join(root, "profile", "index.ts") },
    },
    startService: async () => { throw new Error("private no-workspaces fixture must never start a daemon") },
  })
  try { if (!await manager.start()) process.exit(0) } catch { process.exit(2) }
}
