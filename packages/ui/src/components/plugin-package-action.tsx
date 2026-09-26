import { Show, createEffect, createMemo, onCleanup } from "solid-js"
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
  return <Show when={source()}><button type="button" class="icon-button-compact" disabled={busy() || props.active === false}
    title={`${label()}\n${t("settings.pluginPackages.shared")}`} aria-label={label()} aria-busy={busy()} onClick={() => {
      const item = source()
      if (!item || busy() || props.active === false) return
      const captured = generation
      void runPluginPackageAction(props.instanceId, { ...props.location }, item.target, action()).catch(() => {
        if (captured === generation && props.active !== false) showToastNotification({ variant: "error", message: t("settings.pluginPackages.error", { target: item.target }) })
      })
    }}>
    <Show when={action() === "update"} fallback={<PackageSearch class="h-3.5 w-3.5" classList={{ "animate-pulse": busy() }} aria-hidden="true" />}>
      <Download class="h-3.5 w-3.5" classList={{ "animate-pulse": busy() }} aria-hidden="true" />
    </Show>
  </button></Show>
}
