import { appMessages } from "../i18n/messages/en/app"
import { commandMessages } from "../i18n/messages/en/commands"
import { NATIVE_MENU_LABEL_KEYS, type NativeMenuLabels } from "./menu-labels"

const english: Record<string, string> = { ...appMessages, ...commandMessages }

/** English labels a native host shows before any renderer has reported its
 * locale. Renderer code must translate through `nativeMenuLabels(t)` instead. */
export const DEFAULT_NATIVE_MENU_LABELS = Object.fromEntries(
  Object.entries(NATIVE_MENU_LABEL_KEYS).map(([name, key]) => [name, english[key]]),
) as NativeMenuLabels
