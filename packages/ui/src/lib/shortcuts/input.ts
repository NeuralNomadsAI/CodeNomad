import { keyboardRegistry } from "../keyboard-registry"

export function registerInputShortcuts(
  clearInput: () => void,
  focusInput: () => void,
  condition: () => boolean = () => true,
  clearCondition: () => boolean = condition,
) {

  keyboardRegistry.register({
    id: "clear-input",
    condition: clearCondition,
    handler: clearInput,
    description: "clear input",
    context: "global",
  })

  keyboardRegistry.register({
    id: "focus-input",
    condition,
    handler: focusInput,
    description: "focus input",
    context: "global",
  })
  return () => ["clear-input", "focus-input"].forEach(id => keyboardRegistry.unregister(id))
}
