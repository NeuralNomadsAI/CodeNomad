import { useConfig } from "../../stores/preferences"
import { openCodeSetupBusy, openCodeSetupStatus } from "../../stores/opencode-setup"
import OpenCodeBinarySelector from "../opencode-binary-selector"

export function OpenCodeExecutableCard(props: { active?: () => boolean } = {}) {
  const { serverSettings, updateLastUsedBinary } = useConfig()
  // The selector carries its own "OpenCode binary" heading.
  return <div class="settings-card">
    <OpenCodeBinarySelector selectedBinary={serverSettings().opencodeBinary || "opencode2"}
      defaultVersion={openCodeSetupStatus()?.installationSource ? openCodeSetupStatus()?.currentVersion ?? undefined : undefined}
      onBinaryChange={binary => { if (props.active?.() !== false) updateLastUsedBinary(binary) }} active={props.active} disabled={openCodeSetupBusy()} isVisible />
  </div>
}
