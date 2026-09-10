import { Plugin } from "@opencode/plugin/tui"
import { createPruningReload } from "./tui-reload"

// Companion entry point: no UI replacement, settings mutation or SQL in the TUI.
export default Plugin.define({
  id: "codenomad-session-pruning-tui",
  setup(ctx) {
    const reload = createPruningReload(ctx.data.session)
    const unsubscribe = ctx.data.listen(({ details }) => reload.event(details))
    return () => { reload.dispose(); unsubscribe() }
  },
})
