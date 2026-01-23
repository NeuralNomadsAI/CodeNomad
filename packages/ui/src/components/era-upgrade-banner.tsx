import { Component, Show, createEffect, onMount, untrack } from "solid-js"
import { Download, Loader2, CheckCircle, AlertCircle } from "lucide-solid"
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
      <div class={`era-upgrade-banner ${props.class ?? ""}`}>
        <div class="era-upgrade-content">
          <div class="era-upgrade-info">
            <Download class="era-upgrade-icon" />
            <div class="era-upgrade-text">
              <span class="era-upgrade-title">Era Code Update Available</span>
              <span class="era-upgrade-version">
                {upgradeStatus().currentVersion} → {upgradeTargetVersion()}
              </span>
            </div>
          </div>
          <button
            type="button"
            class="era-upgrade-button"
            onClick={handleUpgrade}
            disabled={isUpgrading() || isCheckingUpgrade()}
          >
            <Show
              when={!isUpgrading()}
              fallback={
                <>
                  <Loader2 class="era-upgrade-button-icon animate-spin" />
                  Upgrading...
                </>
              }
            >
              <Download class="era-upgrade-button-icon" />
              Upgrade Now
            </Show>
          </button>
        </div>
        <Show when={upgradeStatus().error}>
          <div class="era-upgrade-error">
            <AlertCircle class="w-4 h-4" />
            {upgradeStatus().error}
          </div>
        </Show>
      </div>
    </Show>
  )
}

export default EraUpgradeBanner
