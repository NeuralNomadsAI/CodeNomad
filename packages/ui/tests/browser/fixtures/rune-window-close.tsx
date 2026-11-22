import { render } from "solid-js/web"
import {SourceContext,prepareSourceContext,sourceContextSettled} from '../../../../../scripts/rune/parity/source-context.fixture'
import WindowCloseButton from "../../../src/components/window-close-button"
import "../../../src/index.css"

// The production component, providers and styles supply the reference surface.
const fixture = { presses: 0 }
Object.assign(window, { runeWindowClose: fixture })
await prepareSourceContext()
render(() => <SourceContext>
  <div class="window-shell" style={{ background: "var(--surface-overlay)", width: "max-content" }}>
    <WindowCloseButton onClose={() => fixture.presses++} />
  </div>
</SourceContext>, document.getElementById("root")!)
await sourceContextSettled()
