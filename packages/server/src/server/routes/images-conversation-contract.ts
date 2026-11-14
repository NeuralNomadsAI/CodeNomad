import type { ImagesConversationInput, ImagesConversationResult } from "../../opencode/session-pruning/assets-gallery-contract"

/** `.codenomad/design/` exclusion after an `open` or `new`: only Git's explicit answer means no repository. */
export type GitExclusion = "excluded" | "not-repository" | "unavailable"
/** A read-only check of that exclusion: `missing` when the rule is not in the exclude file yet. */
export type GitExclusionCheck = GitExclusion | "missing"
export type ImagesConversationRequest = ImagesConversationInput & { directory: string }
export type ImagesConversationResponse = Exclude<ImagesConversationResult, { status: "found" }>
  | (Extract<ImagesConversationResult, { status: "found" }> & { gitExclusion?: GitExclusion })
