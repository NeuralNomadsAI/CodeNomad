import { keyboardRegistry } from "../keyboard-registry"

export function registerAgentShortcuts(focusModelSelector: () => void, openAgentSelector: () => void) {
  const isMac = () => navigator.platform.toLowerCase().includes("mac")

  keyboardRegistry.register({
    id: "focus-model",
    key: "M",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
    handler: focusModelSelector,
    description: "focus model",
    context: "global",
  })

  keyboardRegistry.register({
    id: "open-agent-selector",
    key: "A",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
    handler: openAgentSelector,
    description: "open agent",
    context: "global",
  })
}
