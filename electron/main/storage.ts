import { app, ipcMain } from "electron"
import { join } from "path"
import { readFile, writeFile, mkdir, unlink, stat } from "fs/promises"
import { existsSync } from "fs"

const CONFIG_DIR = join(app.getPath("home"), ".config", "opencode-client")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")
const INSTANCES_DIR = join(CONFIG_DIR, "instances")

// File watching for config changes
let configWatchers = new Set<number>()
let configLastModified = 0
let configCache: string | null = null

async function ensureDirectories() {
  try {
    await mkdir(CONFIG_DIR, { recursive: true })
    await mkdir(INSTANCES_DIR, { recursive: true })
  } catch (error) {
    console.error("Failed to create directories:", error)
  }
}

async function readConfigWithCache(): Promise<string> {
  try {
    const stats = await stat(CONFIG_FILE)
    const currentModified = stats.mtime.getTime()

    // If file hasn't been modified since last read, return cache
    if (configCache && configLastModified >= currentModified) {
      return configCache
    }

    const content = await readFile(CONFIG_FILE, "utf-8")
    configCache = content
    configLastModified = currentModified
    return content
  } catch (error) {
    // File doesn't exist or can't be read
    configCache = null
    configLastModified = 0
    throw error
  }
}

function invalidateConfigCache() {
  configCache = null
  configLastModified = 0
}

export function setupStorageIPC() {
  ensureDirectories()

  ipcMain.handle("storage:getConfigPath", () => CONFIG_FILE)
  ipcMain.handle("storage:getInstancesDir", () => INSTANCES_DIR)

  ipcMain.handle("storage:readConfigFile", async () => {
    try {
      return await readConfigWithCache()
    } catch (error) {
      // Return empty config if file doesn't exist
      return JSON.stringify({ preferences: { showThinkingBlocks: false }, recentFolders: [] }, null, 2)
    }
  })

  ipcMain.handle("storage:writeConfigFile", async (_, content: string) => {
    try {
      await writeFile(CONFIG_FILE, content, "utf-8")
      invalidateConfigCache()

      // Notify other renderer processes about config change
      const windows = require("electron").BrowserWindow.getAllWindows()
      windows.forEach((win: any) => {
        if (win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.send("storage:configChanged")
        }
      })
    } catch (error) {
      console.error("Failed to write config file:", error)
      throw error
    }
  })

  ipcMain.handle("storage:readInstanceFile", async (_, filename: string) => {
    const instanceFile = join(INSTANCES_DIR, `${filename}.json`)
    try {
      return await readFile(instanceFile, "utf-8")
    } catch (error) {
      // Return empty instance data if file doesn't exist
      return JSON.stringify({ messageHistory: [] }, null, 2)
    }
  })

  ipcMain.handle("storage:writeInstanceFile", async (_, filename: string, content: string) => {
    const instanceFile = join(INSTANCES_DIR, `${filename}.json`)
    try {
      await writeFile(instanceFile, content, "utf-8")
    } catch (error) {
      console.error(`Failed to write instance file for ${filename}:`, error)
      throw error
    }
  })

  ipcMain.handle("storage:deleteInstanceFile", async (_, filename: string) => {
    const instanceFile = join(INSTANCES_DIR, `${filename}.json`)
    try {
      if (existsSync(instanceFile)) {
        await unlink(instanceFile)
      }
    } catch (error) {
      console.error(`Failed to delete instance file for ${filename}:`, error)
      throw error
    }
  })
}

// Clean up on app quit
app.on("before-quit", () => {
  configCache = null
  configLastModified = 0
})
