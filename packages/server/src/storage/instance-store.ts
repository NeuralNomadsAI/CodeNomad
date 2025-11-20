import fs from "fs"
import { promises as fsp } from "fs"
import os from "os"
import path from "path"
import type { InstanceData } from "../api-types"

const DEFAULT_INSTANCE_DATA: InstanceData = {
  messageHistory: [],
  agentModelSelections: {},
}

export class InstanceStore {
  private readonly instancesDir: string

  constructor(baseDir = path.join(os.homedir(), ".config", "codenomad", "instances")) {
    this.instancesDir = baseDir
    fs.mkdirSync(this.instancesDir, { recursive: true })
  }

  async read(id: string): Promise<InstanceData> {
    try {
      const filePath = this.resolvePath(id)
      const content = await fsp.readFile(filePath, "utf-8")
      const parsed = JSON.parse(content)
      return { ...DEFAULT_INSTANCE_DATA, ...parsed }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return DEFAULT_INSTANCE_DATA
      }
      throw error
    }
  }

  async write(id: string, data: InstanceData): Promise<void> {
    const filePath = this.resolvePath(id)
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
  }

  async delete(id: string): Promise<void> {
    try {
      const filePath = this.resolvePath(id)
      await fsp.unlink(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
  }

  private resolvePath(id: string): string {
    const filename = this.sanitizeId(id)
    return path.join(this.instancesDir, `${filename}.json`)
  }

  private sanitizeId(id: string): string {
    return id
      .replace(/[\\/]/g, "_")
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .replace(/_{2,}/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase()
  }
}
