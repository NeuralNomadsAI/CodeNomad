import { type Component } from "solid-js"
import type { LocationRef } from "@opencode/client"
import { activeInstanceId } from "../../stores/instances"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"
import { WebSearchSettingsCard } from "./websearch-settings-card"

interface ProvidersSettingsSectionProps {
  instanceId?: string
  location?: LocationRef
}

export const ProvidersSettingsSection: Component<ProvidersSettingsSectionProps> = (props) => {
  const instanceId = () => props.instanceId ?? activeInstanceId() ?? ""
  return <><ProviderManagerModal instanceId={instanceId()} location={props.location} embedded />
    <WebSearchSettingsCard instanceId={instanceId()} location={props.location} /></>
}
