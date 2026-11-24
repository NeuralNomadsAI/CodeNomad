import { useConfig } from "../../stores/preferences"
import { openCodeSetupBusy, openCodeSetupStatus } from "../../stores/opencode-setup"
import OpenCodeBinarySelector from "../opencode-binary-selector"

export function OpenCodeExecutableCard() {
  const { serverSettings, updateLastUsedBinary } = useConfig()
  // The selector carries its own "OpenCode binary" heading.
  return <div class="settings-card">
    <OpenCodeBinarySelector selectedBinary={serverSettings().opencodeBinary || "opencode2"}
      defaultVersion={openCodeSetupStatus()?.installationSource ? openCodeSetupStatus()?.currentVersion ?? undefined : undefined}
      onBinaryChange={updateLastUsedBinary} disabled={openCodeSetupBusy()} isVisible />
  </div>
}
