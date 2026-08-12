import { TOOL_OUTPUT_RENDER_CHARACTER_LIMIT } from "./utils"

export const PERMISSION_REJECT_REASON_MAX_LENGTH = 2000

export function isPermissionDiffTooLarge(diffText: string | null | undefined): boolean {
  return (diffText?.length ?? 0) > TOOL_OUTPUT_RENDER_CHARACTER_LIMIT
}
