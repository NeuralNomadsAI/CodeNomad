// Negative control: feature flags alone never create an actual Node IPC channel.
import { installBackendChannelGuard } from "../../packages/server/src/host-lifetime/backend"
let rejected = false
try { installBackendChannelGuard() } catch { rejected = true }
if (!rejected || process.send || process.connected) process.exit(1)
console.log(JSON.stringify({ flagsRejectedWithoutNodeIpc: true }))
