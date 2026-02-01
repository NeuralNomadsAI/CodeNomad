import { Component, Show, createEffect } from "solid-js"
import { CheckCircle, XCircle, AlertCircle, Loader2 } from "lucide-solid"
import { cn } from "../lib/cn"
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
    <div class="flex items-center">
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

const badgeBase = "inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm bg-secondary border border-border"

const LoadingBadge: Component = () => (
  <div class={cn(badgeBase, "text-muted-foreground")}>
    <Loader2 class="w-4 h-4 animate-spin text-info flex-shrink-0" />
    <span>Checking Era Code...</span>
  </div>
)

const ErrorBadge: Component<{ error: string }> = (props) => (
  <div class={cn(badgeBase, "bg-destructive/10 border-destructive text-destructive")}>
    <AlertCircle class="w-4 h-4 flex-shrink-0" />
    <span>Error: {props.error}</span>
  </div>
)

const InstalledBadge: Component = () => {
  const assets = eraAssetCounts()

  return (
    <div class={cn(badgeBase, "bg-success/10 border-success")}>
      <CheckCircle class="w-4 h-4 text-success flex-shrink-0" />
      <span class="font-medium text-foreground">Era Code {eraVersion()}</span>
      <Show when={isEraProjectInitialized()}>
        <span class="px-2 py-0.5 rounded text-xs font-medium bg-info text-primary-foreground">Project Enabled</span>
      </Show>
      <Show when={areEraAssetsAvailable() && assets}>
        <span class="text-xs text-muted-foreground">
          {assets!.agents} agents, {assets!.commands} commands
        </span>
      </Show>
    </div>
  )
}

const NotInstalledBadge: Component = () => (
  <div class={cn(badgeBase, "text-muted-foreground")}>
    <XCircle class="w-4 h-4 flex-shrink-0" />
    <span>Era Code Not Installed</span>
  </div>
)

export default EraStatusBadge
