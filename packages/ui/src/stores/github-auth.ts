import { createSignal } from "solid-js"

// GitHub authentication state
const [githubAuthenticated, setGithubAuthenticated] = createSignal(false)
const [githubLoading, setGithubLoading] = createSignal(false)
const [githubUser, setGithubUser] = createSignal<string | null>(null)
const [githubErr, setGithubErr] = createSignal<string | null>(null)
const [ghCliInstalled, setGhCliInstalled] = createSignal(false)
const [ghCliChecked, setGhCliChecked] = createSignal(false)

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
  return ghCliInstalled()
}

export function isGhCliChecked(): boolean {
  return ghCliChecked()
}

export async function checkGitHubAuth(): Promise<void> {
  setGithubLoading(true)
  try {
    // Stub - would check GitHub auth status
    setGithubAuthenticated(false)
  } finally {
    setGithubLoading(false)
  }
}

export async function initiateGitHubLogin(): Promise<void> {
  setGithubLoading(true)
  try {
    // Stub - would initiate GitHub OAuth flow
  } finally {
    setGithubLoading(false)
  }
}

export async function githubLogout(): Promise<void> {
  setGithubLoading(true)
  try {
    setGithubAuthenticated(false)
    setGithubUser(null)
  } finally {
    setGithubLoading(false)
  }
}

export async function checkGhCliInstalled(): Promise<void> {
  // Stub - would check if gh CLI is installed
  setGhCliChecked(true)
  setGhCliInstalled(false)
}

export async function installGhCli(): Promise<void> {
  // Stub - would open gh CLI install page
}
