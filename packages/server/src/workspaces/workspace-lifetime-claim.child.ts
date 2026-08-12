import { access, writeFile } from "node:fs/promises"
import { acquireWorkspaceLifetimeClaim } from "./workspace-lifetime-claim"

const [repositoryKey, readyPath, stopPath] = process.argv.slice(2)
const claim = await acquireWorkspaceLifetimeClaim(repositoryKey!, "workspace")
await writeFile(readyPath!, "ready")
while (true) {
  if (await access(stopPath!).then(() => true, () => false)) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}
await claim.release()
