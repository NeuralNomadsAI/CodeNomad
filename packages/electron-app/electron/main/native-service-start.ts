import { spawn } from "node:child_process"
import { createNativeServiceLauncher } from "../../../server/src/workspaces/native-service-launcher"

/** Private backend stdout/stdin bridge only, never renderer IPC. This existing
 * Electron-parent spawn is outside the backend tree and preserves live runtime
 * behavior. It does NOT attest escape from a UI-inherited Windows Job; a future
 * persistent manager must supply its own natively verified spawn capability. */
export const startNativeService = createNativeServiceLauncher((file, args, options) => spawn(file, args, options))
