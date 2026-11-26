import { authorityDigest } from "./authority-protocol"

export type PassageSource = { conversationID: string; directory: string; workspaceID?: string;
  afterMessageID: string | null; messages: Array<{ id: string; type: string; text: string; nativeDigest: string;
    completedAt?: number; needsDecision?: "source-input-capacity" }> }

export function recurrenceSourceLocationDigest(source: { directory: string; workspaceID?: string }) {
  return authorityDigest({ directory: source.directory, workspaceID: source.workspaceID ?? null })
}
