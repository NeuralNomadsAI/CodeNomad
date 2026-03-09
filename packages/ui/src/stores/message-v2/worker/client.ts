import type { MessageRecord, WorkspaceRecord } from "../types"
import type { WorkerRequest, WorkerResponse } from "./message-worker"

class MessageDbClient {
    private worker: Worker | null = null
    private nextId = 1
    private pendingRequests = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>()

    private getWorker(): Worker {
        if (!this.worker) {
            this.worker = new Worker(new URL('./message-worker', import.meta.url), { type: 'module' })
            this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
                const { id } = e.data
                const callbacks = this.pendingRequests.get(id)
                if (callbacks) {
                    this.pendingRequests.delete(id)
                    if (e.data.type === "SUCCESS") {
                        callbacks.resolve(e.data.data)
                    } else {
                        callbacks.reject(new Error(e.data.error))
                    }
                }
            }
        }
        return this.worker
    }

    private request<T>(req: WorkerRequest): Promise<T> {
        const id = this.nextId++
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject })
            this.getWorker().postMessage({ id, request: req })
        })
    }

    getLatestMessages(sessionId: string, limit?: number): Promise<MessageRecord[]> {
        return this.request<MessageRecord[]>({ type: "GET_LATEST", sessionId, limit })
    }

    upsertMessages(messages: MessageRecord[]): Promise<void> {
        if (!messages.length) return Promise.resolve()
        return this.request<void>({ type: "UPSERT_MESSAGES", messages })
    }

    deleteSession(sessionId: string): Promise<void> {
        return this.request<void>({ type: "DELETE_SESSION", sessionId })
    }

    clearAll(): Promise<void> {
        return this.request<void>({ type: "CLEAR_ALL" })
    }

    getWorkspaces(): Promise<WorkspaceRecord[]> {
        return this.request<WorkspaceRecord[]>({ type: "GET_WORKSPACES" })
    }

    upsertWorkspaces(workspaces: WorkspaceRecord[]): Promise<void> {
        if (!workspaces.length) return Promise.resolve()
        return this.request<void>({ type: "UPSERT_WORKSPACES", workspaces })
    }
}

export const messageDb = new MessageDbClient()
