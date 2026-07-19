import fs from "fs"
import { Octokit } from "@octokit/rest"
import { createAppAuth } from "@octokit/auth-app"

type GitHubAppConfig = {
  appId: string
  privateKeyPath: string
}

let cachedKey: { path: string; value: string } | null = null

function resolveHome(input: string): string {
  return input.startsWith("~/") ? `${process.env.HOME ?? ""}/${input.slice(2)}` : input
}

function readPrivateKey(privateKeyPath: string): string {
  const resolved = resolveHome(privateKeyPath)
  if (cachedKey && cachedKey.path === resolved) return cachedKey.value
  const value = fs.readFileSync(resolved, "utf-8")
  cachedKey = { path: resolved, value }
  return value
}

function appId(config: GitHubAppConfig): number {
  const value = Number(config.appId)
  if (!Number.isFinite(value)) throw new Error("Invalid GitHub App ID")
  return value
}

export function createAppOctokit(config: GitHubAppConfig): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appId(config),
      privateKey: readPrivateKey(config.privateKeyPath),
    },
  })
}

export function createInstallationOctokit(config: GitHubAppConfig, installationId: number): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: appId(config),
      privateKey: readPrivateKey(config.privateKeyPath),
      installationId,
    },
  })
}

export async function getInstallationToken(config: GitHubAppConfig, installationId: number): Promise<string> {
  const auth = createAppAuth({
    appId: appId(config),
    privateKey: readPrivateKey(config.privateKeyPath),
    installationId,
  })
  const result = await auth({ type: "installation" })
  return result.token
}
