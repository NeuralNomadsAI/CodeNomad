import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { PermissionRequest } from "../types/permission"
import { getPermissionDiffPayload } from "./tool-call/permission-block"
import type { DiffPayload } from "./tool-call/types"

export interface PermissionDiffReview {
  payload: DiffPayload
  reviewed: Accessor<boolean>
  complete: () => void
}

/** Keep access acknowledgements across queue refreshes, only for the exact pending diff. */
export function createPermissionDiffReviews(instanceId: Accessor<string>, permissions: Accessor<PermissionRequest[]>) {
  let disposed = false
  onCleanup(() => { disposed = true })
  const key = (permission: PermissionRequest) => JSON.stringify([instanceId(), permission.sessionID, permission.id])
  const reviews = createMemo<Map<string, PermissionDiffReview>>((previous) => {
    const next = new Map<string, PermissionDiffReview>()
    for (const permission of permissions()) {
      const payload = getPermissionDiffPayload(permission)
      if (!payload) continue
      const id = key(permission)
      const existing = previous?.get(id)
      if (existing?.payload.diffText === payload.diffText && existing.payload.filePath === payload.filePath) {
        next.set(id, existing)
        continue
      }
      const [reviewed, setReviewed] = createSignal(false)
      const review: PermissionDiffReview = {
        payload,
        reviewed,
        complete: () => {
          // A late clipboard result cannot acknowledge a replaced/removed request.
          if (!disposed && reviews().get(id) === review) setReviewed(true)
        },
      }
      next.set(id, review)
    }
    return next
  })
  return (permission: PermissionRequest) => reviews().get(key(permission))
}
