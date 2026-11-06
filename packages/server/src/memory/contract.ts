/** Shared memory data contract for the server, native tool and UI. */
export type MemoryScope = "global" | "project"
export type MemoryEntryType = "fact" | "preference" | "reference"

export interface MemoryContent {
  title: string
  type: MemoryEntryType
  text: string
}

export interface MemoryEntryHeader {
  id: string
  title: string
  type: MemoryEntryType
  createdAt: string
  updatedAt: string
  sessionId: string
}

export interface MemoryEntry extends MemoryEntryHeader { text: string }
export type MemoryErrorCode = "disabled" | "full" | "conflict" | "invalid" | "unreadable" | "git_unavailable" | "malformed"

export type MemoryOperation =
  | { action: "list"; scope: MemoryScope }
  | { action: "read"; scope: MemoryScope; query: string }
  | { action: "save"; scope: MemoryScope; content: MemoryContent; id?: string; revision?: string }
  | { action: "delete"; scope: MemoryScope; id: string; revision: string }
export interface MemoryContext { workspaceId: string; directory?: string }
export interface MemorySettings { enabled: boolean }
export type MemoryVersionedEntry = MemoryEntry & { revision: string }
export type MemoryUIEntry = MemoryVersionedEntry & { flagged: boolean; warning?: "suspected_injection" }
export type MemoryListEntry = MemoryEntryHeader & { revision: string }
export interface MemoryUIListResult { entries: MemoryUIEntry[]; scopeKey: string; observedAt: string; cleanupWritable: boolean; cleanupDirectory?: string }
export type MemoryResult = { entries: MemoryUIEntry[] | MemoryListEntry[]; scopeKey?: string; observedAt?: string; cleanupWritable?: boolean; cleanupDirectory?: string }
  | { entry: MemoryUIEntry | MemoryVersionedEntry | null }
  | { id: string; revision: string; flagged: boolean } | { deleted: true }
export interface MemoryApiError { code: MemoryErrorCode; error: string; titles?: readonly string[] }
export type MemoryInstructionContext = { supported: false } | { supported: true; value: string | null }
