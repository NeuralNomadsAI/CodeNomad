import { Component, Show, For, createSignal, createEffect, onMount } from "solid-js"
import { ChevronDown, RefreshCw, GitBranch, Plus, Minus, Undo2, Check } from "lucide-solid"
import type { GitFileChange } from "../../../../server/src/api-types"
import {
    useGitStore,
    fetchGitBranches,
    stageFiles,
    unstageFiles,
    discardChanges,
    commitChanges,
    checkoutBranch,
    refreshGit,
} from "../../stores/git"
import { serverApi } from "../../lib/api-client"

interface SourceControlPanelProps {
    workspaceId: string
}

const SourceControlPanel: Component<SourceControlPanelProps> = (props) => {
    const git = useGitStore(props.workspaceId)
    const [commitMessage, setCommitMessage] = createSignal("")
    const [expandedSections, setExpandedSections] = createSignal<string[]>(["staged", "changes", "untracked"])
    const [showDiff, setShowDiff] = createSignal(false)
    const [diffContent, setDiffContent] = createSignal("")
    const [diffPath, setDiffPath] = createSignal("")
    const [showBranchPicker, setShowBranchPicker] = createSignal(false)

    onMount(() => {
        refreshGit(props.workspaceId)
    })

    createEffect(() => {
        // Refresh when workspace changes
        const id = props.workspaceId
        if (id) {
            refreshGit(id)
        }
    })

    const handleRefresh = () => {
        refreshGit(props.workspaceId)
    }

    const handleStage = async (path: string) => {
        await stageFiles(props.workspaceId, [path])
    }

    const handleUnstage = async (path: string) => {
        await unstageFiles(props.workspaceId, [path])
    }

    const handleDiscard = async (path: string) => {
        if (confirm(`Discard changes to ${path}?`)) {
            await discardChanges(props.workspaceId, [path])
        }
    }

    const handleStageAll = async () => {
        const paths = [...git.unstagedChanges(), ...git.untrackedChanges()].map((c) => c.path)
        if (paths.length > 0) {
            await stageFiles(props.workspaceId, paths)
        }
    }

    const handleUnstageAll = async () => {
        const paths = git.stagedChanges().map((c) => c.path)
        if (paths.length > 0) {
            await unstageFiles(props.workspaceId, paths)
        }
    }

    const handleCommit = async () => {
        const message = commitMessage().trim()
        if (!message) return
        const success = await commitChanges(props.workspaceId, message)
        if (success) {
            setCommitMessage("")
        }
    }

    const handleViewDiff = async (file: GitFileChange) => {
        try {
            const response = await serverApi.fetchGitDiff(props.workspaceId, file.path, file.staged)
            setDiffPath(file.path)
            setDiffContent(response.diff)
            setShowDiff(true)
        } catch (error) {
            console.error("Failed to fetch diff", error)
        }
    }

    const renderDiffLine = (line: string, index: number) => {
        // Skip file metadata lines (diff --git, index, ---, +++)
        if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) {
            return null
        }

        // Skip hunk headers (@@ line numbers) - too confusing
        if (line.startsWith("@@")) {
            return null
        }

        // Determine line type and styling
        let bgClass = ""
        let textClass = "text-primary"
        let borderClass = ""
        let prefix = line.substring(0, 1)
        let content = line.substring(1)

        if (line.startsWith("+")) {
            // Added line
            bgClass = "bg-green-500/10"
            borderClass = "border-l-2 border-green-500"
            textClass = "text-green-400"
        } else if (line.startsWith("-")) {
            // Removed line
            bgClass = "bg-red-500/10"
            borderClass = "border-l-2 border-red-500"
            textClass = "text-red-400"
        } else {
            // Context line
            textClass = "text-secondary"
            prefix = " "
            content = line
        }

        return (
            <div class={`px-2 py-0.5 ${bgClass} ${borderClass} hover:bg-surface-tertiary/50`}>
                <span class={`${textClass} font-mono text-xs whitespace-pre`}>
                    <span class="select-none inline-block w-4 text-gray-500">{prefix}</span>
                    <span class="whitespace-pre-wrap break-all">{content}</span>
                </span>
            </div>
        )
    }

    const handleBranchSelect = async (branch: string) => {
        setShowBranchPicker(false)
        await checkoutBranch(props.workspaceId, branch)
    }

    const getStatusIcon = (status: GitFileChange["status"]) => {
        switch (status) {
            case "added":
                return "A"
            case "modified":
                return "M"
            case "deleted":
                return "D"
            case "renamed":
                return "R"
            case "untracked":
                return "U"
            default:
                return "?"
        }
    }

    const getStatusColor = (status: GitFileChange["status"]) => {
        switch (status) {
            case "added":
                return "text-green-500"
            case "modified":
                return "text-yellow-500"
            case "deleted":
                return "text-red-500"
            case "renamed":
                return "text-blue-500"
            case "untracked":
                return "text-gray-400"
            default:
                return "text-secondary"
        }
    }

    const FileChangeItem: Component<{
        file: GitFileChange
        showStage?: boolean
        showUnstage?: boolean
        showDiscard?: boolean
    }> = (itemProps) => (
        <div class="group flex items-center gap-2 px-2 py-1 hover:bg-surface-tertiary rounded text-xs">
            <span 
                class={`font-mono w-4 text-center ${getStatusColor(itemProps.file.status)}`}
                title={itemProps.file.status}
            >
                {getStatusIcon(itemProps.file.status)}
            </span>
            <button
                type="button"
                class="flex-1 text-left truncate text-primary hover:underline"
                onClick={() => handleViewDiff(itemProps.file)}
                title={`View diff: ${itemProps.file.path}`}
            >
                {(() => {
                    const path = itemProps.file.path
                    // Handle directories (trailing slash) - show dir name with indicator
                    if (path.endsWith("/")) {
                        const parts = path.slice(0, -1).split("/")
                        return parts[parts.length - 1] + "/"
                    }
                    // Normal file - show filename
                    return path.split("/").pop() || path
                })()}
            </button>
            <div class="hidden group-hover:flex items-center gap-1">
                <Show when={itemProps.showStage}>
                    <button
                        type="button"
                        class="p-1 hover:bg-surface-secondary rounded"
                        onClick={() => handleStage(itemProps.file.path)}
                        title="Stage this file for commit"
                    >
                        <Plus class="h-3 w-3" />
                    </button>
                </Show>
                <Show when={itemProps.showUnstage}>
                    <button
                        type="button"
                        class="p-1 hover:bg-surface-secondary rounded"
                        onClick={() => handleUnstage(itemProps.file.path)}
                        title="Remove from staging"
                    >
                        <Minus class="h-3 w-3" />
                    </button>
                </Show>
                <Show when={itemProps.showDiscard}>
                    <button
                        type="button"
                        class="p-1 hover:bg-surface-secondary rounded text-red-500"
                        onClick={() => handleDiscard(itemProps.file.path)}
                        title="Discard changes"
                    >
                        <Undo2 class="h-3 w-3" />
                    </button>
                </Show>
            </div>
        </div>
    )

    return (
        <div class="flex flex-col gap-2">
            <Show when={!git.isGitRepo()}>
                <p class="text-xs text-secondary">Not a git repository.</p>
            </Show>

            <Show when={git.isGitRepo()}>
                {/* Branch selector */}
                <div class="flex items-center gap-2">
                    <div class="relative flex-1 min-w-0">
                        <button
                            type="button"
                            class="w-full flex items-center gap-2 px-2 py-1 text-xs bg-surface-tertiary rounded hover:bg-surface-secondary"
                            onClick={() => {
                                fetchGitBranches(props.workspaceId)
                                setShowBranchPicker(!showBranchPicker())
                            }}
                            title="Switch branch"
                        >
                            <GitBranch class="h-3 w-3 shrink-0" />
                            <span class="flex-1 text-left truncate min-w-0">{git.currentBranch() || "No branch"}</span>
                            <ChevronDown class="h-3 w-3 shrink-0" />
                        </button>
                        <Show when={showBranchPicker()}>
                            <div class="absolute top-full left-0 right-0 mt-1 bg-surface-secondary border border-base rounded shadow-lg z-10 max-h-48 overflow-y-auto">
                                <For each={git.branches().filter((b) => !b.remote)}>
                                    {(branch) => (
                                        <button
                                            type="button"
                                            class={`w-full text-left px-3 py-1.5 text-xs hover:bg-surface-tertiary ${branch.current ? "bg-surface-tertiary font-semibold" : ""
                                                }`}
                                            onClick={() => handleBranchSelect(branch.name)}
                                            title={branch.name}
                                        >
                                            {branch.name}
                                            <Show when={branch.current}>
                                                <Check class="inline h-3 w-3 ml-1" />
                                            </Show>
                                        </button>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </div>
                    <button
                        type="button"
                        class="p-1 hover:bg-surface-secondary rounded"
                        onClick={handleRefresh}
                        disabled={git.loading()}
                        title="Refresh"
                    >
                        <RefreshCw class={`h-4 w-4 ${git.loading() ? "animate-spin" : ""}`} />
                    </button>
                </div>

                {/* Commit input */}
                <div class="flex flex-col gap-1">
                    <textarea
                        class="w-full px-2 py-1 text-xs bg-surface-tertiary border border-base rounded resize-none"
                        rows={2}
                        placeholder="Commit message..."
                        value={commitMessage()}
                        onInput={(e) => setCommitMessage(e.currentTarget.value)}
                    />
                    <button
                        type="button"
                        class="w-full px-2 py-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded disabled:opacity-50"
                        disabled={!commitMessage().trim() || git.stagedChanges().length === 0 || git.loading()}
                        onClick={handleCommit}
                        title="Commit"
                    >
                        Commit ({git.stagedChanges().length} staged)
                    </button>
                </div>

                <Show when={git.error()}>
                    <p class="text-xs text-red-500">{git.error()}</p>
                </Show>

                {/* File sections */}
                <div class="flex flex-col gap-1">
                    {/* Staged Changes */}
                    <div class="border border-base rounded">
                        <button
                            type="button"
                            class="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold hover:bg-surface-tertiary"
                            onClick={() => {
                                const current = expandedSections()
                                setExpandedSections(
                                    current.includes("staged") ? current.filter((s) => s !== "staged") : [...current, "staged"],
                                )
                            }}
                            title="Toggle staged changes section"
                        >
                            <span>Staged ({git.stagedChanges().length})</span>
                            <div class="flex items-center gap-1">
                                <Show when={git.stagedChanges().length > 0}>
                                    <button
                                        type="button"
                                        class="p-0.5 hover:bg-surface-secondary rounded"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            handleUnstageAll()
                                        }}
                                        title="Unstage All"
                                    >
                                        <Minus class="h-3 w-3" />
                                    </button>
                                </Show>
                                <ChevronDown
                                    class={`h-3 w-3 transition-transform ${expandedSections().includes("staged") ? "rotate-180" : ""}`}
                                />
                            </div>
                        </button>
                        <Show when={expandedSections().includes("staged")}>
                            <div class="px-1 pb-1">
                                <Show when={git.stagedChanges().length === 0}>
                                    <p class="text-xs text-secondary px-2 py-1">No staged changes</p>
                                </Show>
                                <For each={git.stagedChanges()}>{(file) => <FileChangeItem file={file} showUnstage />}</For>
                            </div>
                        </Show>
                    </div>

                    {/* Changes */}
                    <div class="border border-base rounded">
                        <button
                            type="button"
                            class="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold hover:bg-surface-tertiary"
                            onClick={() => {
                                const current = expandedSections()
                                setExpandedSections(
                                    current.includes("changes") ? current.filter((s) => s !== "changes") : [...current, "changes"],
                                )
                            }}
                            title="Toggle unstaged changes section"
                        >
                            <span>Changes ({git.unstagedChanges().length})</span>
                            <div class="flex items-center gap-1">
                                <Show when={git.unstagedChanges().length > 0}>
                                    <button
                                        type="button"
                                        class="p-0.5 hover:bg-surface-secondary rounded"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            handleStageAll()
                                        }}
                                        title="Stage All"
                                    >
                                        <Plus class="h-3 w-3" />
                                    </button>
                                </Show>
                                <ChevronDown
                                    class={`h-3 w-3 transition-transform ${expandedSections().includes("changes") ? "rotate-180" : ""}`}
                                />
                            </div>
                        </button>
                        <Show when={expandedSections().includes("changes")}>
                            <div class="px-1 pb-1">
                                <Show when={git.unstagedChanges().length === 0}>
                                    <p class="text-xs text-secondary px-2 py-1">No changes</p>
                                </Show>
                                <For each={git.unstagedChanges()}>
                                    {(file) => <FileChangeItem file={file} showStage showDiscard />}
                                </For>
                            </div>
                        </Show>
                    </div>

                    {/* Untracked */}
                    <div class="border border-base rounded">
                        <button
                            type="button"
                            class="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold hover:bg-surface-tertiary"
                            onClick={() => {
                                const current = expandedSections()
                                setExpandedSections(
                                    current.includes("untracked") ? current.filter((s) => s !== "untracked") : [...current, "untracked"],
                                )
                            }}
                            title="Toggle untracked files section"
                        >
                            <span>Untracked ({git.untrackedChanges().length})</span>
                            <ChevronDown
                                class={`h-3 w-3 transition-transform ${expandedSections().includes("untracked") ? "rotate-180" : ""}`}
                            />
                        </button>
                        <Show when={expandedSections().includes("untracked")}>
                            <div class="px-1 pb-1">
                                <Show when={git.untrackedChanges().length === 0}>
                                    <p class="text-xs text-secondary px-2 py-1">No untracked files</p>
                                </Show>
                                <For each={git.untrackedChanges()}>{(file) => <FileChangeItem file={file} showStage />}</For>
                            </div>
                        </Show>
                    </div>
                </div>
            </Show>

            {/* Diff Modal */}
            <Show when={showDiff()}>
                <div
                    class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
                    onClick={() => setShowDiff(false)}
                >
                    <div
                        class="bg-surface-primary border border-base rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div class="flex items-center justify-between px-4 py-2 border-b border-base">
                            <span class="font-semibold text-sm">{diffPath()}</span>
                            <button type="button" class="p-1 hover:bg-surface-secondary rounded" onClick={() => setShowDiff(false)} title="Close">
                                ×
                            </button>
                        </div>
                        <div class="flex-1 overflow-auto bg-surface-secondary">
                            <Show when={diffContent()} fallback={<p class="text-secondary text-sm p-4">No changes</p>}>
                                <div class="font-mono text-xs leading-relaxed">
                                    <For each={diffContent().split("\n")}>
                                        {(line, index) => renderDiffLine(line, index())}
                                    </For>
                                </div>
                            </Show>
                        </div>
                    </div>
                </div>
            </Show>
        </div>
    )
}

export default SourceControlPanel
