import { getDB } from "./db"
import type { MessageRecord, WorkspaceRecord } from "../types"

// Worker Event Types
export type WorkerRequest =
    | { type: "GET_LATEST"; sessionId: string; limit?: number }
    | { type: "UPSERT_MESSAGES"; messages: MessageRecord[] }
    | { type: "DELETE_SESSION"; sessionId: string }
    | { type: "GET_WORKSPACES" }
    | { type: "UPSERT_WORKSPACES"; workspaces: WorkspaceRecord[] }
    | { type: "CLEAR_ALL" }

export type WorkerResponse =
    | { type: "SUCCESS"; id: number; data?: any }
    | { type: "ERROR"; id: number; error: string }

self.onmessage = async (e: MessageEvent<{ id: number; request: WorkerRequest }>) => {
    const { id, request } = e.data

    try {
        const db = await getDB()

        switch (request.type) {
            case "GET_LATEST": {
                // Fetch up to `limit` messages for the given session, sorted by createdAt descending
                const tx = db.transaction("messages", "readonly")
                const index = tx.store.index("by-session-created")

                // We want descending order, so we need a cursor starting from the max possible date
                const range = IDBKeyRange.bound(
                    [request.sessionId, 0],
                    [request.sessionId, Infinity]
                )

                let cursor = await index.openCursor(range, "prev")
                const results: MessageRecord[] = []
                const limit = request.limit ?? 20

                while (cursor && results.length < limit) {
                    results.push(cursor.value)
                    cursor = await cursor.continue()
                }

                // Return ascending for the UI
                self.postMessage({ type: "SUCCESS", id, data: results.reverse() })
                break
            }

            case "UPSERT_MESSAGES": {
                const tx = db.transaction("messages", "readwrite")
                for (const msg of request.messages) {
                    await tx.store.put(msg)
                }
                await tx.done
                self.postMessage({ type: "SUCCESS", id })
                break
            }

            case "DELETE_SESSION": {
                const tx = db.transaction("messages", "readwrite")
                const index = tx.store.index("by-session")
                const range = IDBKeyRange.only(request.sessionId)

                let cursor = await index.openCursor(range)
                while (cursor) {
                    await cursor.delete()
                    cursor = await cursor.continue()
                }
                await tx.done
                self.postMessage({ type: "SUCCESS", id })
                break
            }

            case "CLEAR_ALL": {
                const tx1 = db.transaction("messages", "readwrite")
                await tx1.store.clear()
                await tx1.done
                const tx2 = db.transaction("workspaces", "readwrite")
                await tx2.store.clear()
                await tx2.done
                self.postMessage({ type: "SUCCESS", id })
                break
            }

            case "GET_WORKSPACES": {
                const results = await db.getAll("workspaces")
                self.postMessage({ type: "SUCCESS", id, data: results })
                break
            }

            case "UPSERT_WORKSPACES": {
                const tx = db.transaction("workspaces", "readwrite")
                for (const ws of request.workspaces) {
                    await tx.store.put(ws)
                }
                await tx.done
                self.postMessage({ type: "SUCCESS", id })
                break
            }

            default:
                throw new Error(`Unknown request type: ${(request as any).type}`)
        }
    } catch (error) {
        self.postMessage({
            type: "ERROR",
            id,
            error: error instanceof Error ? error.message : String(error)
        })
    }
}
