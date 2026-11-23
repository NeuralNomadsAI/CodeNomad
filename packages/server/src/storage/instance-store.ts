import fs from "fs"
import { promises as fsp } from "fs"
import { randomUUID } from "node:crypto"
import os from "os"
import path from "path"
import type { InstanceData } from "../api-types"

const DEFAULT_INSTANCE_DATA: InstanceData = {
  messageHistory: [],
  agentModelSelections: {},
}
const INSTANCE_BYTES = 8 * 1024 * 1024
export const HISTORY_ENTRY_BYTES = 128 * 1024

export class InstanceStore {
  private readonly instancesDir: string
  private readonly writes = new Map<string, Promise<unknown>>()

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
        return { messageHistory: [], agentModelSelections: {} }
      }
      throw error
    }
  }

  async write(id: string, data: InstanceData): Promise<void> {
    const filePath = this.resolvePath(id)
    return this.mutate(filePath, () => this.replace(filePath, JSON.stringify(data, null, 2)))
  }

  async appendHistory(id: string, text: string): Promise<InstanceData> {
    const filePath = this.resolvePath(id)
    return this.mutate(filePath, async () => {
      const data = await this.read(id)
      const history = data.messageHistory
      if (!Array.isArray(history) || !history.every(value => typeof value === "string")) {
        throw new Error("Invalid stored prompt history")
      }
      data.messageHistory = [text, ...history.slice(0, 99)]
      const content = JSON.stringify(data)
      const count = data.messageHistory.length
      let bytes = Buffer.byteLength(content)
      while (bytes > INSTANCE_BYTES) {
        if (data.messageHistory.length === 1) throw new Error("Instance storage limit reached")
        bytes -= Buffer.byteLength(JSON.stringify(data.messageHistory.pop())) + 1
      }
      await this.replace(filePath, data.messageHistory.length === count ? content : JSON.stringify(data))
      return data
    })
  }

  async delete(id: string): Promise<void> {
    const filePath = this.resolvePath(id)
    return this.mutate(filePath, async () => {
      try {
        await fsp.unlink(filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    })
  }

  private async mutate<T>(filePath: string, action: () => Promise<T>): Promise<T> {
    const task = (this.writes.get(filePath) ?? Promise.resolve()).then(action, action)
    this.writes.set(filePath, task)
    try {
      return await task
    } finally {
      if (this.writes.get(filePath) === task) this.writes.delete(filePath)
    }
  }

  private async replace(filePath: string, content: string): Promise<void> {
    const temporary = `${filePath}.${randomUUID()}.tmp`
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    try {
      await fsp.writeFile(temporary, content, { encoding: "utf-8", flag: "wx" })
      await fsp.rename(temporary, filePath)
    } finally {
      await fsp.unlink(temporary).catch(() => {})
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
