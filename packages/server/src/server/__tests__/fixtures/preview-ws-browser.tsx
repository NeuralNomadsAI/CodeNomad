import { render } from "solid-js/web"
import { BrowserFrame } from "../../../../../ui/src/components/browser-frame"
import { I18nProvider } from "../../../../../ui/src/lib/i18n"
import { ConfigProvider } from "../../../../../ui/src/stores/preferences"

// Exercise the production hosted-preview surface, including its opaque-origin
// sandbox and real providers. Their preference reads are disposable test data;
// this fixture has no desktop bridge or daemon.
const query = new URLSearchParams(location.search)
const base = query.get("preview")!
render(() => <ConfigProvider><I18nProvider><BrowserFrame
  title="Disposable WebSocket preview"
  initialUrl={`${base}/page?mode=${encodeURIComponent(query.get("mode")!)}`}
  proxyBasePath={base}
  labels={{ back: "Back", refresh: "Refresh", path: "Address", go: "Go", viewport: "Viewport" }}
  addressMode="url"
  onNavigate={async address => address}
/></I18nProvider></ConfigProvider>, document.getElementById("root")!)
