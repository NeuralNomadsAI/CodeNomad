import { instances } from "../../../src/stores/instances"
import { canOpenWorkspacePaths, openWorkspacePath } from "../../../src/lib/workspace-open"
import type { Instance } from "../../../src/types/instance"

for (const [id, serverId] of [["legacy", undefined], ["local", "local-shared"], ["loopback", "loopback-profile"], ["remote", "remote"], ["unknown", "missing-profile"]]) {
  instances().set(id!, { id, folder: "C:\\workspace\\app", ...(serverId ? { binding: { serverId, directory: "C:\\workspace\\app" } } : {}) } as Instance)
}
instances().set("capability-only", { capabilities: { serverId: "explicit", features: { files: { state: "available" } } } } as Instance)
instances().set("unavailable", { capabilities: { serverId: "local-shared", features: { files: { state: "unavailable" } } } } as Instance)
Object.assign(window, { workspaceOpenFixture: { canOpenWorkspacePaths, openWorkspacePath } })
