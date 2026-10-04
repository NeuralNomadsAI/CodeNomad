import { HostLifetimeManager } from "./manager"
import { HostStorage } from "./storage"
import { NativeRuntimeBinding } from "./native-runtime-binding"
import { NativeRuntimeCapability } from "./native-runtime"
import { HostError } from "./protocol"

/** Actual Windows product entry for a trusted packaged host-specific binding.
 * S's authenticated live channel supplies launch/config/capability together;
 * this entry never reads renderer/environment configuration or waits for EOF.
 * Binding load arguments are compile-time/package authority, not CLI options. */
export async function runNativeRuntimeManager(binding: NativeRuntimeBinding): Promise<HostLifetimeManager> {
  NativeRuntimeBinding.assert(binding)
  // Packaging excludes fixture features and bytes; repeat the compiled export
  // check before consuming bootstrap. A fixture addon is never a product entry.
  if (Object.prototype.hasOwnProperty.call(binding.sdk, "fixtureAuthorizeNestedResponse")) throw new HostError("native-fixture-binding-refused")
  const runtime = await NativeRuntimeCapability.open(binding)
  try {
    const launch = runtime.launch
    const manager = new HostLifetimeManager({
      storage: new HostStorage(launch.root, launch.scope), backend: launch.backend, runtime,
    })
    await manager.start()
    return manager
  } catch {
    await runtime.fatal("startup-failed").catch(() => undefined)
    throw new HostError("native-manager-start-failed")
  }
}
export async function loadAndRunNativeRuntimeManager(trustedFile: string, trustedSha256: string): Promise<HostLifetimeManager> {
  return runNativeRuntimeManager(await NativeRuntimeBinding.load(trustedFile, trustedSha256))
}
