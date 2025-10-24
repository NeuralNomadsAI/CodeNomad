import { createSignal } from "solid-js"

const STORAGE_KEY = "opencode-preferences"
const RECENT_FOLDERS_KEY = "opencode-recent-folders"
const MAX_RECENT_FOLDERS = 10

interface Preferences {
  showThinkingBlocks: boolean
}

interface RecentFolder {
  path: string
  lastAccessed: number
}

const defaultPreferences: Preferences = {
  showThinkingBlocks: false,
}

function loadPreferences(): Preferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return { ...defaultPreferences, ...JSON.parse(stored) }
    }
  } catch (error) {
    console.error("Failed to load preferences:", error)
  }
  return defaultPreferences
}

function savePreferences(prefs: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch (error) {
    console.error("Failed to save preferences:", error)
  }
}

function loadRecentFolders(): RecentFolder[] {
  try {
    const stored = localStorage.getItem(RECENT_FOLDERS_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (error) {
    console.error("Failed to load recent folders:", error)
  }
  return []
}

function saveRecentFolders(folders: RecentFolder[]): void {
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(folders))
  } catch (error) {
    console.error("Failed to save recent folders:", error)
  }
}

const [preferences, setPreferences] = createSignal<Preferences>(loadPreferences())
const [recentFolders, setRecentFolders] = createSignal<RecentFolder[]>(loadRecentFolders())

function updatePreferences(updates: Partial<Preferences>): void {
  const updated = { ...preferences(), ...updates }
  setPreferences(updated)
  savePreferences(updated)
}

function toggleShowThinkingBlocks(): void {
  updatePreferences({ showThinkingBlocks: !preferences().showThinkingBlocks })
}

function addRecentFolder(path: string): void {
  const folders = recentFolders().filter((f) => f.path !== path)
  folders.unshift({ path, lastAccessed: Date.now() })

  const trimmed = folders.slice(0, MAX_RECENT_FOLDERS)
  setRecentFolders(trimmed)
  saveRecentFolders(trimmed)
}

function removeRecentFolder(path: string): void {
  const folders = recentFolders().filter((f) => f.path !== path)
  setRecentFolders(folders)
  saveRecentFolders(folders)
}

export { preferences, updatePreferences, toggleShowThinkingBlocks, recentFolders, addRecentFolder, removeRecentFolder }
