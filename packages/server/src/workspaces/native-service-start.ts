import type { NativeParent } from "../native-parent"
import type { OpenCodeCliServiceDependencies, ServiceExecResult } from "./opencode-cli-service"

/** Only service start crosses to the desktop parent, outside backend containment.
 * Status, credentials and health still use the selected CLI's official lifecycle. */
export function nativeServiceStarter(parent: NativeParent): OpenCodeCliServiceDependencies["execFile"] | undefined {
  if (!parent.available) return undefined
  return (file, args, options) => parent.request<ServiceExecResult>("opencode.service.start", {
    file, args,
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
  }, options.timeout)
}
