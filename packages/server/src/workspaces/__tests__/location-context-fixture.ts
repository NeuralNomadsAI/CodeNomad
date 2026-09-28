import { readLocationRef } from "../../opencode/compatibility/location"

// Internal identity fixtures inspect the context before public transport rejects
// obsolete selectors. This is not a live-runtime serializer or admission path.
export function readInternalLocationContext(value: string | undefined) {
  return value === undefined ? undefined : readLocationRef(JSON.parse(decodeURIComponent(value)))
}
