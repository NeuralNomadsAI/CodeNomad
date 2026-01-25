import { keyboardRegistry } from "../keyboard-registry"

export function registerAgentShortcuts(
  focusModelSelector: () => void,
  openAgentSelector: () => void,
  focusVariantSelector: () => void,
) {
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

  keyboardRegistry.register({
    id: "focus-variant",
    key: "T",
    modifiers: { ctrl: !isMac(), meta: isMac(), shift: true },
    handler: focusVariantSelector,
    description: "focus thinking",
    context: "global",
  })
}
