import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import DirectoryBrowserDialog from "../../../src/components/directory-browser-dialog"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
const [initialPath, setInitialPath] = createSignal(params.get("initialPath") ?? "")
const mode = (params.get("mode") as "directories" | "files") ?? "directories"
const title = params.get("title") ?? "Test"

let navigations: string[] = []
const [open, setOpen] = createSignal(true)

render(
  () => (
    <ConfigProvider>
      <I18nProvider>
        <ThemeProvider>
          <DirectoryBrowserDialog
            open={open()}
            mode={mode}
            title={title}
            initialPath={initialPath()}
            onSelect={(path) => {
              navigations.push(path)
            }}
            onClose={() => setOpen(false)}
          />
        </ThemeProvider>
      </I18nProvider>
    </ConfigProvider>
  ),
  document.getElementById("root")!,
)

;(window as any).directoryBrowserFixture = {
  navigations: () => navigations,
  setInitialPath: (value: string) => setInitialPath(value),
  open: () => setOpen(true),
  close: () => setOpen(false),
}
