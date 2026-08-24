export const canHydrateMessages = (expectedRevision: number, currentRevision: number): boolean =>
  expectedRevision === currentRevision
