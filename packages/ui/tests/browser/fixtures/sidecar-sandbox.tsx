import { render } from "solid-js/web"
import { BrowserFrame } from "../../../src/components/browser-frame"
import { SideCarView } from "../../../src/components/sidecar-view"
import type { SideCarTabRecord } from "../../../src/stores/sidecars"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any

const tab: SideCarTabRecord = {
  token: "fixture-token",
  sidecarId: "fixture",
  name: "ttyd",
  port: 7682,
  prefixMode: "strip",
  proxyBasePath: "/sidecars/fixture",
  shellUrl: "/sidecars/fixture/",
}

render(
  () => (
    <ConfigProvider>
      <I18nProvider>
        <div id="sidecar-root" style={{ width: "800px", height: "300px" }}>
          <SideCarView tab={tab} />
        </div>
        <div id="preview-root" style={{ width: "800px", height: "300px" }}>
          <BrowserFrame
            title="Preview"
            initialUrl="/sidecar-sandbox-guest"
            proxyBasePath=""
            labels={{
              back: "Back",
              refresh: "Refresh",
              path: "Address",
              go: "Go",
              viewport: "Viewport",
              viewportResponsive: "Responsive",
              viewportDesktop: "Desktop (1440 × 900)",
              viewportTablet: "Tablet (768 × 1024)",
              viewportTabletLandscape: "Tablet landscape (1024 × 768)",
              viewportMobile: "Mobile (390 × 844)",
              viewportMobileLandscape: "Mobile landscape (844 × 390)",
            }}
          />
        </div>
      </I18nProvider>
    </ConfigProvider>
  ),
  document.getElementById("root")!,
)
