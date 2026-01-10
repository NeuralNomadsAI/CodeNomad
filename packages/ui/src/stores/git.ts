import { createSignal } from "solid-js"
import type { GitStatus, GitBranch, GitFileChange } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"

// Store state for each workspace
const gitStores = new Map<
    string,
    {
        status: GitStatus | null
        branches: GitBranch[]
        currentBranch: string
        loading: boolean
        error: string | null
        isGitRepo: boolean
    }
>()

// Signals for reactive updates
const [storeVersion, setStoreVersion] = createSignal(0)

function notifyUpdate() {
    setStoreVersion((v) => v + 1)
}

function getOrCreateStore(workspaceId: string) {
    if (!gitStores.has(workspaceId)) {
        gitStores.set(workspaceId, {
            status: null,
            branches: [],
            currentBranch: "",
            loading: false,
            error: null,
            isGitRepo: true,
        })
    }
    return gitStores.get(workspaceId)!
}

export function useGitStore(workspaceId: string) {
    // Subscribe to updates
    const version = () => storeVersion()

    const store = () => {
        version() // Create reactive dependency
        return getOrCreateStore(workspaceId)
    }

    return {
        status: () => store().status,
        branches: () => store().branches,
        currentBranch: () => store().currentBranch,
        loading: () => store().loading,
        error: () => store().error,
        isGitRepo: () => store().isGitRepo,
        stagedChanges: (): GitFileChange[] => store().status?.changes.filter((c) => c.staged) ?? [],
        unstagedChanges: (): GitFileChange[] => store().status?.changes.filter((c) => !c.staged && c.status !== "untracked") ?? [],
        untrackedChanges: (): GitFileChange[] => store().status?.changes.filter((c) => c.status === "untracked") ?? [],
    }
}

export async function fetchGitStatus(workspaceId: string): Promise<void> {
    const store = getOrCreateStore(workspaceId)
    store.loading = true
    store.error = null
    notifyUpdate()

    try {
        const status = await serverApi.fetchGitStatus(workspaceId)
        store.status = status
        store.currentBranch = status.branch
        store.isGitRepo = true
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch status"
        if (message.includes("Not a git repository")) {
            store.isGitRepo = false
            store.error = null
        } else {
            store.error = message
        }
    } finally {
        store.loading = false
        notifyUpdate()
    }
}

export async function fetchGitBranches(workspaceId: string): Promise<void> {
    const store = getOrCreateStore(workspaceId)

    try {
        const response = await serverApi.fetchGitBranches(workspaceId)
        store.branches = response.branches
        store.currentBranch = response.current
        store.isGitRepo = true
    } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to fetch branches"
        if (message.includes("Not a git repository")) {
            store.isGitRepo = false
        }
    } finally {
        notifyUpdate()
    }
}

export async function checkoutBranch(workspaceId: string, branch: string, create = false): Promise<boolean> {
    const store = getOrCreateStore(workspaceId)
    store.loading = true
    store.error = null
    notifyUpdate()

    try {
        await serverApi.checkoutBranch(workspaceId, branch, create)
        store.currentBranch = branch
        // Refresh status after checkout
        await fetchGitStatus(workspaceId)
        await fetchGitBranches(workspaceId)
        return true
    } catch (error) {
        store.error = error instanceof Error ? error.message : "Failed to checkout branch"
        return false
    } finally {
        store.loading = false
        notifyUpdate()
    }
}

export async function stageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
    const store = getOrCreateStore(workspaceId)

    try {
        await serverApi.stageFiles(workspaceId, paths)
        await fetchGitStatus(workspaceId)
        return true
    } catch (error) {
        store.error = error instanceof Error ? error.message : "Failed to stage files"
        notifyUpdate()
        return false
    }
}

export async function unstageFiles(workspaceId: string, paths: string[]): Promise<boolean> {
    const store = getOrCreateStore(workspaceId)

    try {
        await serverApi.unstageFiles(workspaceId, paths)
        await fetchGitStatus(workspaceId)
        return true
    } catch (error) {
        store.error = error instanceof Error ? error.message : "Failed to unstage files"
        notifyUpdate()
        return false
    }
}

export async function discardChanges(workspaceId: string, paths: string[]): Promise<boolean> {
    const store = getOrCreateStore(workspaceId)

    try {
        await serverApi.discardChanges(workspaceId, paths)
        await fetchGitStatus(workspaceId)
        return true
    } catch (error) {
        store.error = error instanceof Error ? error.message : "Failed to discard changes"
        notifyUpdate()
        return false
    }
}

export async function commitChanges(workspaceId: string, message: string): Promise<boolean> {
    const store = getOrCreateStore(workspaceId)
    store.loading = true
    store.error = null
    notifyUpdate()

    try {
        await serverApi.commitChanges(workspaceId, message)
        await fetchGitStatus(workspaceId)
        return true
    } catch (error) {
        store.error = error instanceof Error ? error.message : "Failed to commit"
        return false
    } finally {
        store.loading = false
        notifyUpdate()
    }
}

export async function refreshGit(workspaceId: string): Promise<void> {
    await Promise.all([fetchGitStatus(workspaceId), fetchGitBranches(workspaceId)])
}
