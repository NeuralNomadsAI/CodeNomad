import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import DirectoryBrowserDialog from "../../../src/components/directory-browser-dialog"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
const initialPath = params.get("initialPath") ?? ""
const mode = (params.get("mode") as "directories" | "files") ?? "directories"
const title = params.get("title") ?? "Test"

let navigations: string[] = []
const [open, setOpen] = createSignal(true)

render(
  () => (
    <DirectoryBrowserDialog
      open={open()}
      mode={mode}
      title={title}
      initialPath={initialPath}
      onSelect={(path) => {
        navigations.push(path)
      }}
      onClose={() => setOpen(false)}
    />
  ),
  document.getElementById("root")!,
)

;(window as any).directoryBrowserFixture = {
  navigations: () => navigations,
}
