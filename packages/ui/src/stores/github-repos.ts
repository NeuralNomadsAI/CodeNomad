import { createSignal } from "solid-js"
import { ERA_CODE_API_BASE } from "../lib/api-client"
import { getLogger } from "../lib/logger"

const log = getLogger("github-repos")

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

const [repos, setRepos] = createSignal<GitHubRepo[]>([])
const [orgs, setOrgs] = createSignal<string[]>([])
const [currentSelectedOrg, setCurrentSelectedOrg] = createSignal<string | null>(null)
const [loading, setLoading] = createSignal(false)
const [cloning, setCloning] = createSignal(false)
const [cloneError, setCloneError] = createSignal<string | null>(null)

export const githubRepos = repos
export const githubOrgs = orgs
export const selectedOrg = currentSelectedOrg
export const setSelectedOrg = setCurrentSelectedOrg
export const isReposLoading = loading
export const isCloning = cloning
export { cloneError }

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

export async function fetchRepos(org?: string): Promise<void> {
  setLoading(true)
  try {
    const params = org ? `?org=${encodeURIComponent(org)}` : ""
    const result = await apiRequest<GitHubRepo[]>(`/api/github/repos${params}`)
    setRepos(result)
  } catch (error) {
    log.error("Failed to fetch repos", error)
    setRepos([])
  } finally {
    setLoading(false)
  }
}

export async function fetchOrgs(): Promise<void> {
  try {
    const result = await apiRequest<string[]>("/api/github/orgs")
    setOrgs(result)
  } catch (error) {
    log.error("Failed to fetch orgs", error)
    setOrgs([])
  }
}

export async function cloneRepo(
  repoUrl: string,
  targetDir: string
): Promise<{ success: boolean; path?: string }> {
  setCloning(true)
  setCloneError(null)
  try {
    const result = await apiRequest<{ success: boolean; path: string }>("/api/github/clone", {
      method: "POST",
      body: JSON.stringify({ url: repoUrl, targetDir }),
    })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : "Clone failed"
    setCloneError(message)
    log.error("Failed to clone repo", error)
    throw error
  } finally {
    setCloning(false)
  }
}
