import { createSignal, onMount } from "solid-js"
import { storage, type ConfigData } from "../lib/storage"

export interface Preferences {
  showThinkingBlocks: boolean
}

export interface RecentFolder {
  path: string
  lastAccessed: number
}

const MAX_RECENT_FOLDERS = 10

const defaultPreferences: Preferences = {
  showThinkingBlocks: false,
}

const [preferences, setPreferences] = createSignal<Preferences>(defaultPreferences)
const [recentFolders, setRecentFolders] = createSignal<RecentFolder[]>([])

async function loadConfig(): Promise<void> {
  try {
    const config = await storage.loadConfig()
    setPreferences({ ...defaultPreferences, ...config.preferences })
    setRecentFolders(config.recentFolders)
  } catch (error) {
    console.error("Failed to load config:", error)
  }
}

async function saveConfig(): Promise<void> {
  try {
    const config: ConfigData = {
      preferences: preferences(),
      recentFolders: recentFolders(),
    }
    await storage.saveConfig(config)
  } catch (error) {
    console.error("Failed to save config:", error)
  }
}

function updatePreferences(updates: Partial<Preferences>): void {
  const updated = { ...preferences(), ...updates }
  setPreferences(updated)
  saveConfig().catch(console.error)
}

function toggleShowThinkingBlocks(): void {
  updatePreferences({ showThinkingBlocks: !preferences().showThinkingBlocks })
}

function addRecentFolder(path: string): void {
  const folders = recentFolders().filter((f) => f.path !== path)
  folders.unshift({ path, lastAccessed: Date.now() })

  const trimmed = folders.slice(0, MAX_RECENT_FOLDERS)
  setRecentFolders(trimmed)
  saveConfig().catch(console.error)
}

function removeRecentFolder(path: string): void {
  const folders = recentFolders().filter((f) => f.path !== path)
  setRecentFolders(folders)
  saveConfig().catch(console.error)
}

// Load config on mount and listen for changes from other instances
onMount(() => {
  loadConfig()

  // Reload config when changed by another instance
  const unsubscribe = storage.onConfigChanged(() => {
    loadConfig()
  })

  // Cleanup on unmount
  return unsubscribe
})

export { preferences, updatePreferences, toggleShowThinkingBlocks, recentFolders, addRecentFolder, removeRecentFolder }
