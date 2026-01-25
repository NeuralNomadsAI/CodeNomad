import { createSignal } from "solid-js"
import { getLogger } from "../lib/logger"

const log = getLogger("api")

const STORAGE_KEY = "codenomad:github:stars"
const REPO_API_URL = "https://api.github.com/repos/NeuralNomadsAI/CodeNomad"

function readStoredStars(): number | null {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

function storeStars(value: number): void {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, String(value))
}

const [githubStars, setGithubStars] = createSignal<number | null>(readStoredStars())

let initialized = false

export async function initGithubStars(): Promise<void> {
  if (initialized) return
  initialized = true

  try {
    const response = await fetch(REPO_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
      },
    })
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`)
    }

    const data = (await response.json()) as { stargazers_count?: unknown }
    const next = typeof data.stargazers_count === "number" ? data.stargazers_count : null
    if (next === null || !Number.isFinite(next) || next < 0) {
      return
    }
    const normalized = Math.floor(next)
    setGithubStars(normalized)
    storeStars(normalized)
  } catch (error) {
    log.warn("Failed to fetch GitHub stars", error)
  }
}

export { githubStars }
