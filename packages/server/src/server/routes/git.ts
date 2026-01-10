import type { FastifyInstance } from "fastify"
import { exec } from "child_process"
import { promisify } from "util"
import path from "path"
import type { WorkspaceManager } from "../../workspaces/manager"
import type {
    GitStatus,
    GitFileChange,
    GitFileStatus,
    GitBranch,
    GitBranchListResponse,
    GitDiffResponse,
    GitCommitRequest,
    GitCommitResponse,
    GitCheckoutRequest,
    GitStageRequest,
} from "../../api-types"

const execAsync = promisify(exec)

interface GitRoutesDeps {
    workspaceManager: WorkspaceManager
}

async function runGitCommand(cwd: string, args: string): Promise<string> {
    try {
        const { stdout } = await execAsync(`git ${args}`, {
            cwd,
            maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large diffs
        })
        return stdout.trim()
    } catch (error) {
        const execError = error as { stderr?: string; message?: string }
        throw new Error(execError.stderr || execError.message || "Git command failed")
    }
}

async function isGitRepository(cwd: string): Promise<boolean> {
    try {
        await runGitCommand(cwd, "rev-parse --git-dir")
        return true
    } catch {
        return false
    }
}

function parseStatusLine(line: string): GitFileChange | null {
    if (line.length < 3) return null

    const indexStatus = line[0]
    const worktreeStatus = line[1]
    const filePath = line.slice(3)

    // Handle renames (format: "R  old -> new")
    let actualPath = filePath
    let originalPath: string | undefined
    if (filePath.includes(" -> ")) {
        const parts = filePath.split(" -> ")
        originalPath = parts[0]
        actualPath = parts[1]
    }

    // Determine status and staging state
    let status: GitFileStatus
    let staged = false

    if (indexStatus === "?" && worktreeStatus === "?") {
        status = "untracked"
    } else if (indexStatus === "!" && worktreeStatus === "!") {
        status = "ignored"
    } else if (indexStatus !== " " && indexStatus !== "?") {
        // File has staged changes
        staged = true
        switch (indexStatus) {
            case "M":
                status = "modified"
                break
            case "A":
                status = "added"
                break
            case "D":
                status = "deleted"
                break
            case "R":
                status = "renamed"
                break
            case "C":
                status = "copied"
                break
            default:
                status = "modified"
        }
    } else {
        // File has unstaged changes
        switch (worktreeStatus) {
            case "M":
                status = "modified"
                break
            case "D":
                status = "deleted"
                break
            default:
                status = "modified"
        }
    }

    return {
        path: actualPath,
        status,
        staged,
        originalPath,
    }
}

async function getGitStatus(cwd: string): Promise<GitStatus> {
    // Check if there are any commits
    let hasCommits = true
    try {
        await runGitCommand(cwd, "rev-parse HEAD")
    } catch {
        hasCommits = false
    }

    // Get current branch
    let branch = "HEAD"
    try {
        branch = await runGitCommand(cwd, "symbolic-ref --short HEAD")
    } catch {
        // Detached HEAD state
        try {
            branch = (await runGitCommand(cwd, "rev-parse --short HEAD")).slice(0, 7)
        } catch {
            branch = "HEAD"
        }
    }

    // Get ahead/behind counts
    let ahead = 0
    let behind = 0
    try {
        const tracking = await runGitCommand(cwd, "rev-parse --abbrev-ref @{upstream}")
        if (tracking) {
            const counts = await runGitCommand(cwd, `rev-list --left-right --count HEAD...@{upstream}`)
            const [aheadStr, behindStr] = counts.split("\t")
            ahead = parseInt(aheadStr, 10) || 0
            behind = parseInt(behindStr, 10) || 0
        }
    } catch {
        // No upstream tracking
    }

    // Get file status
    const statusOutput = await runGitCommand(cwd, "status --porcelain=v1")
    const changes: GitFileChange[] = []

    if (statusOutput) {
        for (const line of statusOutput.split("\n")) {
            const change = parseStatusLine(line)
            if (change) {
                changes.push(change)
            }
        }
    }

    return {
        branch,
        changes,
        hasCommits,
        ahead,
        behind,
    }
}

async function getBranches(cwd: string): Promise<GitBranchListResponse> {
    const branches: GitBranch[] = []
    let current = ""

    // Get local branches
    try {
        const localOutput = await runGitCommand(cwd, "branch --format='%(refname:short)|%(upstream:short)|%(HEAD)'")
        for (const line of localOutput.split("\n")) {
            if (!line.trim()) continue
            const cleanLine = line.replace(/'/g, "")
            const [name, upstream, head] = cleanLine.split("|")
            const isCurrent = head === "*"
            if (isCurrent) current = name
            branches.push({
                name,
                current: isCurrent,
                remote: false,
                upstream: upstream || undefined,
            })
        }
    } catch {
        // No branches yet
    }

    // Get remote branches
    try {
        const remoteOutput = await runGitCommand(cwd, "branch -r --format='%(refname:short)'")
        for (const line of remoteOutput.split("\n")) {
            if (!line.trim()) continue
            const name = line.replace(/'/g, "").trim()
            // Skip HEAD references
            if (name.includes("/HEAD")) continue
            branches.push({
                name,
                current: false,
                remote: true,
            })
        }
    } catch {
        // No remote branches
    }

    return { branches, current }
}

export function registerGitRoutes(app: FastifyInstance, deps: GitRoutesDeps) {
    const { workspaceManager } = deps

    // Helper to get workspace path
    const getWorkspacePath = (id: string): string | null => {
        const workspace = workspaceManager.get(id)
        return workspace?.path ?? null
    }

    // GET /api/workspaces/:id/git/status
    app.get<{ Params: { id: string } }>("/api/workspaces/:id/git/status", async (request, reply) => {
        const workspacePath = getWorkspacePath(request.params.id)
        if (!workspacePath) {
            return reply.status(404).send({ error: "Workspace not found" })
        }

        if (!(await isGitRepository(workspacePath))) {
            return reply.status(400).send({ error: "Not a git repository" })
        }

        try {
            const status = await getGitStatus(workspacePath)
            return status
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to get git status"
            return reply.status(500).send({ error: message })
        }
    })

    // GET /api/workspaces/:id/git/branches
    app.get<{ Params: { id: string } }>("/api/workspaces/:id/git/branches", async (request, reply) => {
        const workspacePath = getWorkspacePath(request.params.id)
        if (!workspacePath) {
            return reply.status(404).send({ error: "Workspace not found" })
        }

        if (!(await isGitRepository(workspacePath))) {
            return reply.status(400).send({ error: "Not a git repository" })
        }

        try {
            const branches = await getBranches(workspacePath)
            return branches
        } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to get branches"
            return reply.status(500).send({ error: message })
        }
    })

    // POST /api/workspaces/:id/git/checkout
    app.post<{ Params: { id: string }; Body: GitCheckoutRequest }>(
        "/api/workspaces/:id/git/checkout",
        async (request, reply) => {
            const workspacePath = getWorkspacePath(request.params.id)
            if (!workspacePath) {
                return reply.status(404).send({ error: "Workspace not found" })
            }

            if (!(await isGitRepository(workspacePath))) {
                return reply.status(400).send({ error: "Not a git repository" })
            }

            const { branch, create } = request.body
            if (!branch) {
                return reply.status(400).send({ error: "Branch name is required" })
            }

            try {
                const args = create ? `checkout -b ${branch}` : `checkout ${branch}`
                await runGitCommand(workspacePath, args)
                return { success: true, branch }
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to checkout branch"
                return reply.status(500).send({ error: message })
            }
        },
    )

    // GET /api/workspaces/:id/git/diff
    app.get<{ Params: { id: string }; Querystring: { path?: string; staged?: string } }>(
        "/api/workspaces/:id/git/diff",
        async (request, reply) => {
            const workspacePath = getWorkspacePath(request.params.id)
            if (!workspacePath) {
                return reply.status(404).send({ error: "Workspace not found" })
            }

            if (!(await isGitRepository(workspacePath))) {
                return reply.status(400).send({ error: "Not a git repository" })
            }

            const filePath = request.query.path
            const staged = request.query.staged === "true"

            try {
                let args = staged ? "diff --cached" : "diff"
                if (filePath) {
                    args += ` -- ${filePath}`
                }

                const diff = await runGitCommand(workspacePath, args)

                // Check if file is binary
                const isBinary = diff.includes("Binary files") || diff.includes("GIT binary patch")

                const response: GitDiffResponse = {
                    path: filePath || "",
                    diff,
                    isBinary,
                }
                return response
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to get diff"
                return reply.status(500).send({ error: message })
            }
        },
    )

    // POST /api/workspaces/:id/git/stage
    app.post<{ Params: { id: string }; Body: GitStageRequest }>(
        "/api/workspaces/:id/git/stage",
        async (request, reply) => {
            const workspacePath = getWorkspacePath(request.params.id)
            if (!workspacePath) {
                return reply.status(404).send({ error: "Workspace not found" })
            }

            if (!(await isGitRepository(workspacePath))) {
                return reply.status(400).send({ error: "Not a git repository" })
            }

            const { paths } = request.body
            if (!paths || paths.length === 0) {
                return reply.status(400).send({ error: "Paths are required" })
            }

            try {
                const quotedPaths = paths.map((p) => `"${p}"`).join(" ")
                await runGitCommand(workspacePath, `add ${quotedPaths}`)
                return { success: true }
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to stage files"
                return reply.status(500).send({ error: message })
            }
        },
    )

    // POST /api/workspaces/:id/git/unstage
    app.post<{ Params: { id: string }; Body: GitStageRequest }>(
        "/api/workspaces/:id/git/unstage",
        async (request, reply) => {
            const workspacePath = getWorkspacePath(request.params.id)
            if (!workspacePath) {
                return reply.status(404).send({ error: "Workspace not found" })
            }

            if (!(await isGitRepository(workspacePath))) {
                return reply.status(400).send({ error: "Not a git repository" })
            }

            const { paths } = request.body
            if (!paths || paths.length === 0) {
                return reply.status(400).send({ error: "Paths are required" })
            }

            try {
                const quotedPaths = paths.map((p) => `"${p}"`).join(" ")
                await runGitCommand(workspacePath, `reset HEAD -- ${quotedPaths}`)
                return { success: true }
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to unstage files"
                return reply.status(500).send({ error: message })
            }
        },
    )

    // POST /api/workspaces/:id/git/discard
    app.post<{ Params: { id: string }; Body: GitStageRequest }>(
        "/api/workspaces/:id/git/discard",
        async (request, reply) => {
            const workspacePath = getWorkspacePath(request.params.id)
            if (!workspacePath) {
                return reply.status(404).send({ error: "Workspace not found" })
            }

            if (!(await isGitRepository(workspacePath))) {
                return reply.status(400).send({ error: "Not a git repository" })
            }

            const { paths } = request.body
            if (!paths || paths.length === 0) {
                return reply.status(400).send({ error: "Paths are required" })
            }

            try {
                const quotedPaths = paths.map((p) => `"${p}"`).join(" ")
                await runGitCommand(workspacePath, `checkout -- ${quotedPaths}`)
                return { success: true }
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to discard changes"
                return reply.status(500).send({ error: message })
            }
        },
    )

    // POST /api/workspaces/:id/git/commit
    app.post<{ Params: { id: string }; Body: GitCommitRequest }>(
        "/api/workspaces/:id/git/commit",
        async (request, reply) => {
            const workspacePath = getWorkspacePath(request.params.id)
            if (!workspacePath) {
                return reply.status(404).send({ error: "Workspace not found" })
            }

            if (!(await isGitRepository(workspacePath))) {
                return reply.status(400).send({ error: "Not a git repository" })
            }

            const { message } = request.body
            if (!message || !message.trim()) {
                return reply.status(400).send({ error: "Commit message is required" })
            }

            try {
                // Escape quotes in message
                const escapedMessage = message.replace(/"/g, '\\"')
                await runGitCommand(workspacePath, `commit -m "${escapedMessage}"`)

                // Get the commit hash
                const hash = await runGitCommand(workspacePath, "rev-parse --short HEAD")

                const response: GitCommitResponse = {
                    hash,
                    message: message.trim(),
                }
                return response
            } catch (error) {
                const message = error instanceof Error ? error.message : "Failed to commit"
                return reply.status(500).send({ error: message })
            }
        },
    )
}
