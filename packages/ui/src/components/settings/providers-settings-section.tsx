import { type Component } from "solid-js"
import type { LocationRef } from "@opencode-ai/client"
import { activeInstanceId } from "../../stores/instances"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"

interface ProvidersSettingsSectionProps {
  instanceId?: string
  location?: LocationRef
}

export const ProvidersSettingsSection: Component<ProvidersSettingsSectionProps> = (props) => {
  return <ProviderManagerModal instanceId={props.instanceId ?? activeInstanceId() ?? ""} location={props.location} embedded />
}
