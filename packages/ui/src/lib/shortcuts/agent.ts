import { keyboardRegistry } from "../keyboard-registry"

export function registerAgentShortcuts(
  focusModelSelector: () => void,
  openAgentSelector: () => void,
  focusVariantSelector: () => void,
  condition: () => boolean = () => true,
) {

  keyboardRegistry.register({
    id: "focus-model",
    condition,
    handler: focusModelSelector,
    description: "focus model",
    context: "global",
  })

  keyboardRegistry.register({
    id: "open-agent-selector",
    condition,
    handler: openAgentSelector,
    description: "open agent",
    context: "global",
  })

  keyboardRegistry.register({
    id: "focus-variant",
    condition,
    handler: focusVariantSelector,
    description: "focus thinking",
    context: "global",
  })
  return () => ["focus-model", "open-agent-selector", "focus-variant"].forEach(id => keyboardRegistry.unregister(id))
}
