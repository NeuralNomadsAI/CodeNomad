import type { Preferences, RecentFolder } from "../stores/preferences"

export interface ConfigData {
  preferences: Preferences
  recentFolders: RecentFolder[]
}

export interface InstanceData {
  messageHistory: string[]
}

export class FileStorage {
  private configPath: string
  private instancesDir: string
  private configChangeListeners: Set<() => void> = new Set()

  constructor() {
    this.configPath = window.electronAPI.getConfigPath()
    this.instancesDir = window.electronAPI.getInstancesDir()

    // Listen for config changes from other instances
    window.electronAPI.onConfigChanged(() => {
      this.configChangeListeners.forEach((listener) => listener())
    })
  }

  // Config operations
  async loadConfig(): Promise<ConfigData> {
    try {
      const content = await window.electronAPI.readConfigFile()
      return JSON.parse(content)
    } catch (error) {
      console.warn("Failed to load config, using defaults:", error)
      return {
        preferences: {
          showThinkingBlocks: false,
        },
        recentFolders: [],
      }
    }
  }

  async saveConfig(config: ConfigData): Promise<void> {
    try {
      await window.electronAPI.writeConfigFile(JSON.stringify(config, null, 2))
    } catch (error) {
      console.error("Failed to save config:", error)
      throw error
    }
  }

  // Instance operations
  async loadInstanceData(instanceId: string): Promise<InstanceData> {
    try {
      const filename = this.instanceIdToFilename(instanceId)
      const content = await window.electronAPI.readInstanceFile(filename)
      return JSON.parse(content)
    } catch (error) {
      console.warn(`Failed to load instance data for ${instanceId}, using defaults:`, error)
      return {
        messageHistory: [],
      }
    }
  }

  async saveInstanceData(instanceId: string, data: InstanceData): Promise<void> {
    try {
      const filename = this.instanceIdToFilename(instanceId)
      await window.electronAPI.writeInstanceFile(filename, JSON.stringify(data, null, 2))
    } catch (error) {
      console.error(`Failed to save instance data for ${instanceId}:`, error)
      throw error
    }
  }

  async deleteInstanceData(instanceId: string): Promise<void> {
    try {
      const filename = this.instanceIdToFilename(instanceId)
      await window.electronAPI.deleteInstanceFile(filename)
    } catch (error) {
      console.error(`Failed to delete instance data for ${instanceId}:`, error)
      throw error
    }
  }

  // Convert folder path to safe filename
  private instanceIdToFilename(instanceId: string): string {
    // Convert folder path to safe filename
    // Replace path separators and other invalid characters
    return instanceId
      .replace(/[\\/]/g, "_") // Replace path separators
      .replace(/[^a-zA-Z0-9_.-]/g, "_") // Replace other invalid chars
      .replace(/_{2,}/g, "_") // Replace multiple underscores with single
      .replace(/^_|_$/g, "") // Remove leading/trailing underscores
      .toLowerCase()
  }

  // Config change listeners
  onConfigChanged(listener: () => void): () => void {
    this.configChangeListeners.add(listener)
    return () => this.configChangeListeners.delete(listener)
  }
}

// Singleton instance
export const storage = new FileStorage()
