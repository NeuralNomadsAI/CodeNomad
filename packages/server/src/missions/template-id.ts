/** The Debugging template's identifier before its rename. Accepted only when
 * decoding already stored missions, schedules and UI preferences; new writes
 * and creation inputs always use `debug`. */
export const LEGACY_DEBUG_TEMPLATE_ID = "pocock-fix-bug"

export function normalizeStoredTemplateId(value: unknown): unknown {
  return value === LEGACY_DEBUG_TEMPLATE_ID ? "debug" : value
}
