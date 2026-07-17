export const shouldReplaceSessionMetadata = (current: Record<string, unknown> | undefined): boolean =>
  current === undefined || Object.keys(current).length === 0

export const preferSessionMetadata = (
  incoming: Record<string, unknown> | undefined,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => shouldReplaceSessionMetadata(incoming) ? existing ?? incoming : incoming
