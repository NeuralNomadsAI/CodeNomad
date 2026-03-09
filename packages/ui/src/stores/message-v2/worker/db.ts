import { openDB, type DBSchema, type IDBPDatabase } from "idb"
import type { MessageRecord, SessionRecord, WorkspaceRecord } from "../types"

interface MessageDB extends DBSchema {
    messages: {
        key: string
        value: MessageRecord
        indexes: {
            "by-session": string
            "by-session-created": [string, number]
        }
    }
    workspaces: {
        key: string
        value: WorkspaceRecord
    }
}

const DB_NAME = "codenomad-messages-v2"
const DB_VERSION = 2

let dbPromise: Promise<IDBPDatabase<MessageDB>> | null = null

export function getDB(): Promise<IDBPDatabase<MessageDB>> {
    if (!dbPromise) {
        dbPromise = openDB<MessageDB>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion) {
                if (oldVersion < 1) {
                    if (!db.objectStoreNames.contains("messages")) {
                        const store = db.createObjectStore("messages", { keyPath: "id" })
                        store.createIndex("by-session", "sessionId")
                        store.createIndex("by-session-created", ["sessionId", "createdAt"])
                    }
                }
                if (oldVersion < 2) {
                    if (!db.objectStoreNames.contains("workspaces")) {
                        db.createObjectStore("workspaces", { keyPath: "id" })
                    }
                }
            },
        })
    }
    return dbPromise
}
