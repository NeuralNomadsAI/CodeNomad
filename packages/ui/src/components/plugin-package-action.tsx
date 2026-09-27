import { Show, createEffect, createMemo, onCleanup } from "solid-js"
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import { Download, PackageSearch } from "lucide-solid"
import type { PluginControlLocation, PluginRuntimeSource } from "../../../server/src/api-types"
import { useI18n } from "../lib/i18n"
import { isPluginPackagePending, runPluginPackageAction } from "../stores/plugin-package-actions"
import { showToastNotification } from "../lib/notifications"

export function PluginPackageAction(props: { instanceId: string; location: PluginControlLocation; source?: PluginRuntimeSource; active?: boolean }) {
  const { t } = useI18n()
  let generation = 0
  const ownership = createMemo(() => JSON.stringify([props.instanceId, props.location.directory,
    props.source?.type === "package" ? props.source.target : null, props.active !== false]))
  createEffect(() => { ownership(); generation++ })
  onCleanup(() => { generation++ })
  const source = () => props.source?.type === "package" ? props.source : undefined
  const busy = () => Boolean(source()?.updating || (source() && isPluginPackagePending(props.instanceId, source()!.target)))
  const action = () => source()?.outdated ? "update" as const : "check" as const
  const label = () => t(`settings.pluginPackages.${action()}`, { target: source()?.target ?? "" })
  const hint = () => `${label()}\n${t("settings.pluginPackages.shared")}`
  const run = () => {
    const item = source()
    if (!item || busy() || props.active === false) return
    const captured = generation
    void runPluginPackageAction(props.instanceId, { ...props.location }, item.target, action()).catch(() => {
      if (captured === generation && props.active !== false) showToastNotification({ variant: "error", message: t("settings.pluginPackages.error", { target: item.target }) })
    })
  }
  // The row stays minimal (one compact icon), but activating it names the
  // exact package operation instead of firing it blindly from the icon.
  return <Show when={source()}>{item => (
    <DropdownMenu placement="bottom-end" gutter={4}>
      <DropdownMenu.Trigger type="button" class="icon-button-compact" disabled={busy() || props.active === false}
        title={hint()} aria-label={label()} aria-busy={busy()}>
        <Show when={action() === "update"} fallback={<PackageSearch class="h-3.5 w-3.5" classList={{ "animate-pulse": busy() }} aria-hidden="true" />}>
          <Download class="h-3.5 w-3.5" classList={{ "animate-pulse": busy() }} aria-hidden="true" />
        </Show>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="action-overflow-content">
          <DropdownMenu.Item class="action-overflow-item" disabled={busy() || props.active === false}
            title={t("settings.pluginPackages.shared")} onSelect={run}>
            <span class="action-overflow-item-icon" aria-hidden="true">
              <Show when={action() === "update"} fallback={<PackageSearch class="h-3.5 w-3.5" aria-hidden="true" />}>
                <Download class="h-3.5 w-3.5" aria-hidden="true" />
              </Show>
            </span>
            <span class="action-overflow-item-label">{label()}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  )}</Show>
}
