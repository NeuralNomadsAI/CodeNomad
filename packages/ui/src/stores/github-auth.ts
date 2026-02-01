import { createSignal } from "solid-js"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("github-auth")

// GitHub authentication state
const [githubAuthenticated, setGithubAuthenticated] = createSignal(false)
const [githubLoading, setGithubLoading] = createSignal(false)
const [githubUser, setGithubUser] = createSignal<string | null>(null)
const [githubErr, setGithubErr] = createSignal<string | null>(null)
const [ghCliInstalledSignal, setGhCliInstalled] = createSignal(false)
const [ghCliCheckedSignal, setGhCliChecked] = createSignal(false)

interface GitHubStatus {
  installed: boolean
  authenticated: boolean
  username: string | null
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const url = ERA_CODE_API_BASE ? new URL(path, ERA_CODE_API_BASE).toString() : path
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...(init?.headers ?? {}),
  }
  const response = await fetch(url, { ...init, headers })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || `Request failed with ${response.status}`)
  }
  return (await response.json()) as T
}

export function isGitHubAuthenticated(): boolean {
  return githubAuthenticated()
}

export function isGitHubLoading(): boolean {
  return githubLoading()
}

export function githubUsername(): string | null {
  return githubUser()
}

export function githubError(): string | null {
  return githubErr()
}

export function isGhCliInstalled(): boolean {
  return ghCliInstalledSignal()
}

export function isGhCliChecked(): boolean {
  return ghCliCheckedSignal()
}

export async function checkGitHubAuth(): Promise<void> {
  setGithubLoading(true)
  try {
    const status = await apiRequest<GitHubStatus>("/api/github/status")
    setGhCliInstalled(status.installed)
    setGhCliChecked(true)
    setGithubAuthenticated(status.authenticated)
    setGithubUser(status.username)
    setGithubErr(null)
  } catch (error) {
    log.error("Failed to check GitHub auth", error)
    setGithubErr(error instanceof Error ? error.message : "Failed to check auth")
  } finally {
    setGithubLoading(false)
  }
}

export async function checkGhCliInstalled(): Promise<void> {
  setGithubLoading(true)
  try {
    const status = await apiRequest<GitHubStatus>("/api/github/status")
    setGhCliInstalled(status.installed)
    setGhCliChecked(true)
    setGithubAuthenticated(status.authenticated)
    setGithubUser(status.username)
    setGithubErr(null)
  } catch (error) {
    log.error("Failed to check gh CLI", error)
    setGhCliChecked(true)
    setGhCliInstalled(false)
  } finally {
    setGithubLoading(false)
  }
}

export async function initiateGitHubLogin(): Promise<void> {
  setGithubLoading(true)
  setGithubErr(null)
  try {
    // Use the exec endpoint to run gh auth login --web
    await apiRequest<{ stdout: string; stderr: string; exitCode: number }>("/api/system/exec", {
      method: "POST",
      body: JSON.stringify({
        command: "gh",
        args: ["auth", "login", "--web"],
        background: true,
        timeout: 60000,
      }),
    })

    // After login attempt, re-check auth status
    await checkGitHubAuth()
  } catch (error) {
    log.error("Failed to initiate GitHub login", error)
    setGithubErr(error instanceof Error ? error.message : "Login failed")
    // Still try to re-check in case login succeeded
    await checkGitHubAuth()
  } finally {
    setGithubLoading(false)
  }
}

export async function githubLogout(): Promise<void> {
  setGithubLoading(true)
  try {
    await apiRequest<{ stdout: string; stderr: string; exitCode: number }>("/api/system/exec", {
      method: "POST",
      body: JSON.stringify({
        command: "gh",
        args: ["auth", "logout", "--hostname", "github.com"],
        timeout: 10000,
      }),
    })
    setGithubAuthenticated(false)
    setGithubUser(null)
  } catch (error) {
    log.error("Failed to logout from GitHub", error)
  } finally {
    setGithubLoading(false)
  }
}

export async function installGhCli(): Promise<void> {
  // Open the gh CLI install page in the browser
  try {
    await apiRequest<{ success: boolean; message: string }>("/api/system/cli/install", {
      method: "POST",
      body: JSON.stringify({ tool: "gh" }),
    })
    // Re-check after install attempt
    await checkGhCliInstalled()
  } catch (error) {
    log.error("Failed to install gh CLI", error)
    // Fallback: open the download page
    window.open("https://cli.github.com/", "_blank")
  }
}
