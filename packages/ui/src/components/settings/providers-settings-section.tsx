import { type Component } from "solid-js"
import { activeInstanceId } from "../../stores/instances"
import { ProviderManagerModal } from "../provider-auth/provider-manager-modal"

export const ProvidersSettingsSection: Component = () => {
  return <ProviderManagerModal instanceId={activeInstanceId() ?? ""} embedded />
}
