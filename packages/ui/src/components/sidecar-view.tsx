import { createMemo, type Component } from "solid-js"
import type { SideCarTabRecord } from "../stores/sidecars"
import { useI18n } from "../lib/i18n"
import { BrowserFrame } from "./browser-frame"

interface SideCarViewProps {
  tab: SideCarTabRecord
}

export const SideCarView: Component<SideCarViewProps> = (props) => {
  const { t } = useI18n()

  const lockedBaseLabel = createMemo(() => {
    const hostLabel = props.tab.port ? `${props.tab.name}:${props.tab.port}` : props.tab.name
    if (props.tab.prefixMode === "preserve") {
      return `${hostLabel}${props.tab.proxyBasePath}`
    }
    return hostLabel
  })

  return (
    <BrowserFrame
      title={props.tab.name}
      initialUrl={props.tab.shellUrl}
      proxyBasePath={props.tab.proxyBasePath}
      lockedBaseLabel={lockedBaseLabel()}
      labels={{
        back: t("sidecars.back"),
        refresh: t("sidecars.refresh"),
        path: t("sidecars.path"),
        go: t("sidecars.go"),
        viewport: t("browserFrame.viewport"),
        viewportResponsive: t("browserFrame.viewport.responsive"),
        viewportDesktop: t("browserFrame.viewport.desktop"),
        viewportTablet: t("browserFrame.viewport.tablet"),
        viewportTabletLandscape: t("browserFrame.viewport.tabletLandscape"),
        viewportMobile: t("browserFrame.viewport.mobile"),
        viewportMobileLandscape: t("browserFrame.viewport.mobileLandscape"),
      }}
    />
  )
}
