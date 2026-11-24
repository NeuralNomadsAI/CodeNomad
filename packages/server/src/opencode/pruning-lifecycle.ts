import { DesktopPluginLifecycle } from "./desktop-plugin-lifecycle"

export class PruningLifecycle extends DesktopPluginLifecycle {
  constructor() { super("session-pruning") }
}
