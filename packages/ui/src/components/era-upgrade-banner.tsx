import { Component, Show, createEffect, onMount, untrack } from "solid-js"
import { Download, Loader2, CheckCircle, AlertCircle } from "lucide-solid"
import { cn } from "../lib/cn"
import {
  useEraUpgradeStatus,
  checkEraUpgrade,
  runEraUpgrade,
  isUpgradeAvailable,
  upgradeTargetVersion,
  isCheckingUpgrade,
  isUpgrading,
  useEraStatus,
  initEraStatus,
} from "../stores/era-status"

interface EraUpgradeBannerProps {
  class?: string
}

const EraUpgradeBanner: Component<EraUpgradeBannerProps> = (props) => {
  const eraStatus = useEraStatus()
  const upgradeStatus = useEraUpgradeStatus()

  // Initialize era status and check for upgrade
  onMount(() => {
    initEraStatus()
    if (eraStatus().installed && !upgradeStatus().lastChecked) {
      void checkEraUpgrade()
    }
  })

  // Check for upgrade when era status becomes available
  createEffect(() => {
    const status = eraStatus()
    if (status.installed) {
      // Use untrack to avoid re-triggering when upgradeStatus changes
      untrack(() => {
        if (!upgradeStatus().lastChecked) {
          void checkEraUpgrade()
        }
      })
    }
  })

  const handleUpgrade = async () => {
    const result = await runEraUpgrade()
    if (!result.success) {
      // Error is already set in the store
    }
  }

  return (
    <Show when={eraStatus().installed && isUpgradeAvailable()}>
      <div class={cn(
        "w-full max-w-lg rounded-lg border border-info px-4 py-3",
        "bg-gradient-to-br from-info/10 to-secondary",
        props.class,
      )}>
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <Download class="w-5 h-5 flex-shrink-0 text-info" />
            <div class="flex flex-col gap-0.5">
              <span class="text-sm font-semibold text-foreground">Era Code Update Available</span>
              <span class="text-xs text-muted-foreground">
                {upgradeStatus().currentVersion} → {upgradeTargetVersion()}
              </span>
            </div>
          </div>
          <button
            type="button"
            class={cn(
              "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors",
              "bg-info text-primary-foreground hover:bg-info/90",
              "disabled:opacity-70 disabled:cursor-not-allowed",
            )}
            onClick={handleUpgrade}
            disabled={isUpgrading() || isCheckingUpgrade()}
          >
            <Show
              when={!isUpgrading()}
              fallback={
                <>
                  <Loader2 class="w-4 h-4 animate-spin" />
                  Upgrading...
                </>
              }
            >
              <Download class="w-4 h-4" />
              Upgrade Now
            </Show>
          </button>
        </div>
        <Show when={upgradeStatus().error}>
          <div class="flex items-center gap-2 mt-2 text-xs text-destructive">
            <AlertCircle class="w-4 h-4" />
            {upgradeStatus().error}
          </div>
        </Show>
      </div>
    </Show>
  )
}

export default EraUpgradeBanner
