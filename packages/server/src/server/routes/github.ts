import { FastifyInstance } from "fastify"
import { spawn } from "child_process"
import { promisify } from "util"
import { exec } from "child_process"

const execAsync = promisify(exec)

interface RouteDeps {
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
    debug: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export interface GitHubStatus {
  installed: boolean
  authenticated: boolean
  username: string | null
}

export interface GitHubRepo {
  name: string
  description: string | null
  updatedAt: string
  visibility: string
  owner: { login: string }
  url: string
  sshUrl: string
  cloneUrl: string
}

export function registerGitHubRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { logger } = deps

  // Check GitHub CLI installation and auth status
  app.get("/api/github/status", async (): Promise<GitHubStatus> => {
    try {
      // Check if gh is installed
      const whichCmd = process.platform === "win32" ? "where" : "which"
      try {
        await execAsync(`${whichCmd} gh`)
      } catch {
        return { installed: false, authenticated: false, username: null }
      }

      // Check auth status
      try {
        const { stdout } = await execAsync("gh auth status 2>&1", { timeout: 10000 })
        // Parse username from output like "Logged in to github.com account username"
        const usernameMatch = stdout.match(/account\s+(\S+)/)
        const username = usernameMatch?.[1] ?? null
        return { installed: true, authenticated: true, username }
      } catch (error) {
        // gh auth status returns non-zero when not authenticated
        // but stderr may still contain useful info
        const errOutput = error instanceof Error ? error.message : String(error)
        if (errOutput.includes("not logged in") || errOutput.includes("authentication")) {
          return { installed: true, authenticated: false, username: null }
        }
        // Try parsing even from error output
        const usernameMatch = errOutput.match(/account\s+(\S+)/)
        if (usernameMatch) {
          return { installed: true, authenticated: true, username: usernameMatch[1] }
        }
        return { installed: true, authenticated: false, username: null }
      }
    } catch (error) {
      logger.error("Failed to check GitHub status", { error })
      return { installed: false, authenticated: false, username: null }
    }
  })

  // List repos for the authenticated user or a specific org
  app.get<{ Querystring: { org?: string } }>("/api/github/repos", async (request, reply) => {
    const { org } = request.query

    try {
      const orgArg = org ? org : ""
      const args = [
        "repo", "list", orgArg,
        "--json", "name,description,updatedAt,visibility,owner,url,sshUrl",
        "--limit", "30",
      ].filter(Boolean)

      const { stdout, stderr } = await execAsync(`gh ${args.join(" ")}`, { timeout: 15000 })

      if (stderr && !stdout) {
        logger.error("gh repo list error", { stderr })
        return reply.status(500).send({ error: stderr })
      }

      const repos: GitHubRepo[] = JSON.parse(stdout)
      // Add cloneUrl derived from url
      const enriched = repos.map((repo) => ({
        ...repo,
        cloneUrl: repo.sshUrl || `${repo.url}.git`,
      }))

      return enriched
    } catch (error) {
      logger.error("Failed to fetch GitHub repos", { error })
      return reply.status(500).send({
        error: error instanceof Error ? error.message : "Failed to fetch repos",
      })
    }
  })

  // List orgs the authenticated user belongs to
  app.get("/api/github/orgs", async (_request, reply) => {
    try {
      const { stdout } = await execAsync(
        `gh api user/orgs --jq '.[].login'`,
        { timeout: 10000 }
      )

      const orgs = stdout.trim().split("\n").filter(Boolean)
      return orgs
    } catch (error) {
      logger.error("Failed to fetch GitHub orgs", { error })
      return reply.status(500).send({
        error: error instanceof Error ? error.message : "Failed to fetch orgs",
      })
    }
  })

  // Clone a repository
  app.post<{ Body: { url: string; targetDir: string } }>("/api/github/clone", async (request, reply) => {
    const { url, targetDir } = request.body

    if (!url || !targetDir) {
      return reply.status(400).send({ error: "url and targetDir are required" })
    }

    logger.info("Cloning repository", { url, targetDir })

    try {
      return await new Promise<{ success: boolean; path: string }>((resolve, reject) => {
        const proc = spawn("gh", ["repo", "clone", url, targetDir], {
          shell: true,
          timeout: 120000,
        })

        let stdout = ""
        let stderr = ""

        proc.stdout?.on("data", (data) => {
          stdout += data.toString()
        })

        proc.stderr?.on("data", (data) => {
          stderr += data.toString()
        })

        proc.on("close", (code) => {
          if (code === 0) {
            resolve({ success: true, path: targetDir })
          } else {
            reject(new Error(stderr || `Clone failed with exit code ${code}`))
          }
        })

        proc.on("error", (error) => {
          reject(error)
        })
      })
    } catch (error) {
      logger.error("Failed to clone repository", { url, targetDir, error })
      return reply.status(500).send({
        error: error instanceof Error ? error.message : "Clone failed",
        success: false,
      })
    }
  })
}
