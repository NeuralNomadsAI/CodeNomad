import { Component, Show, createEffect } from "solid-js"
import { CheckCircle, XCircle, AlertCircle, Loader2 } from "lucide-solid"
import {
  useEraStatus,
  isEraInstalled,
  eraVersion,
  isEraProjectInitialized,
  areEraAssetsAvailable,
  isEraStatusLoading,
  eraStatusError,
  eraAssetCounts,
  initEraStatus,
} from "../stores/era-status"

/**
 * Badge showing Era Code installation and project status
 */
const EraStatusBadge: Component = () => {
  // Initialize era status on mount
  createEffect(() => {
    initEraStatus()
  })

  return (
    <div class="era-status-badge">
      <Show when={isEraStatusLoading()}>
        <LoadingBadge />
      </Show>
      <Show when={!isEraStatusLoading() && eraStatusError()}>
        <ErrorBadge error={eraStatusError()!} />
      </Show>
      <Show when={!isEraStatusLoading() && !eraStatusError() && isEraInstalled()}>
        <InstalledBadge />
      </Show>
      <Show when={!isEraStatusLoading() && !eraStatusError() && !isEraInstalled()}>
        <NotInstalledBadge />
      </Show>
    </div>
  )
}

const LoadingBadge: Component = () => (
  <div class="era-badge era-badge-loading">
    <Loader2 class="w-4 h-4 animate-spin" />
    <span>Checking Era Code...</span>
  </div>
)

const ErrorBadge: Component<{ error: string }> = (props) => (
  <div class="era-badge era-badge-error">
    <AlertCircle class="w-4 h-4" />
    <span>Error: {props.error}</span>
  </div>
)

const InstalledBadge: Component = () => {
  const assets = eraAssetCounts()

  return (
    <div class="era-badge era-badge-installed">
      <CheckCircle class="w-4 h-4" />
      <span class="era-badge-version">Era Code {eraVersion()}</span>
      <Show when={isEraProjectInitialized()}>
        <span class="era-badge-project">Project Enabled</span>
      </Show>
      <Show when={areEraAssetsAvailable() && assets}>
        <span class="era-badge-assets">
          {assets!.agents} agents, {assets!.commands} commands
        </span>
      </Show>
    </div>
  )
}

const NotInstalledBadge: Component = () => (
  <div class="era-badge era-badge-not-installed">
    <XCircle class="w-4 h-4" />
    <span>Era Code Not Installed</span>
  </div>
)

export default EraStatusBadge
