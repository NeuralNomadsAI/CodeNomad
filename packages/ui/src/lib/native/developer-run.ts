import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export type DeveloperRunTarget = "electron" | "tauri"
export type DeveloperRunState = "stopped" | "starting" | "ready" | "stopping" | "error"

export interface DeveloperRunStatus {
  state: DeveloperRunState
  runId?: string
  target?: DeveloperRunTarget
  executable?: string
  pid?: number
  profilePath?: string
  cdpUrl?: string
  targetId?: string
  targetTitle?: string
  targetUrl?: string
  error?: string
}

export interface DeveloperRunLog {
  runId: string
  timestamp: number
  stream: "system" | "stdout" | "stderr"
  message: string
}

interface DeveloperRunElectronAPI {
  getDeveloperRun?: () => Promise<{ status: DeveloperRunStatus; logs: DeveloperRunLog[] }>
  startDeveloperRun?: (input: { target: DeveloperRunTarget; executable: string }) => Promise<DeveloperRunStatus>
  stopDeveloperRun?: () => Promise<void>
  onDeveloperRunStatus?: (callback: (status: DeveloperRunStatus) => void) => () => void
  onDeveloperRunLog?: (callback: (log: DeveloperRunLog) => void) => () => void
}

function electronAPI(): DeveloperRunElectronAPI | undefined {
  return (window as Window & { electronAPI?: DeveloperRunElectronAPI }).electronAPI
}

export async function getDeveloperRun(): Promise<{ status: DeveloperRunStatus; logs: DeveloperRunLog[] }> {
  const api = electronAPI()
  return api?.getDeveloperRun ? api.getDeveloperRun() : invoke("developer_run_get")
}

export async function startDeveloperRun(input: { target: DeveloperRunTarget; executable: string }): Promise<DeveloperRunStatus> {
  const api = electronAPI()
  return api?.startDeveloperRun ? api.startDeveloperRun(input) : invoke("developer_run_start", { input })
}

export async function stopDeveloperRun(): Promise<void> {
  const api = electronAPI()
  return api?.stopDeveloperRun ? api.stopDeveloperRun() : invoke("developer_run_stop")
}

export async function onDeveloperRunStatus(callback: (status: DeveloperRunStatus) => void): Promise<() => void> {
  const unsubscribe = electronAPI()?.onDeveloperRunStatus?.(callback)
  return unsubscribe ?? listen<DeveloperRunStatus>("developer-run:status", (event) => callback(event.payload))
}

export async function onDeveloperRunLog(callback: (log: DeveloperRunLog) => void): Promise<() => void> {
  const unsubscribe = electronAPI()?.onDeveloperRunLog?.(callback)
  return unsubscribe ?? listen<DeveloperRunLog>("developer-run:log", (event) => callback(event.payload))
}
