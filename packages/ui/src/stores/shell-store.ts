import { createSignal, untrack } from "solid-js"
import type { OpenCodeClient, ShellInfo } from "@opencode/client"
import { requestLocationOptions } from "./request-locations"

const MAX_SHELL_OUTPUT_DISPLAY_CHARS = 4 * 1024 * 1024

export function appendShellOutput(current: string, chunk: string): { output: string; truncated: boolean } {
  const output = current + chunk
  if (output.length <= MAX_SHELL_OUTPUT_DISPLAY_CHARS) return { output, truncated: false }

  let start = output.length - MAX_SHELL_OUTPUT_DISPLAY_CHARS
  if (output.charCodeAt(start) >= 0xdc00 && output.charCodeAt(start) <= 0xdfff) start += 1
  if (output[start] === "\u001b" && output[start + 1] === "\\") start += 2
  else if (output[start] === "\\" && output[start - 1] === "\u001b") start += 1
  const escape = output.lastIndexOf("\u001b", start)
  if (escape >= 0) {
    let end = -1
    let controlSequence = false
    if (output[escape + 1] === "[") {
      controlSequence = true
      for (let index = escape + 2; index < output.length; index += 1) {
        const code = output.charCodeAt(index)
        if (code === 0x18 || code === 0x1a) {
          end = index + 1
          break
        }
        if (code >= 0x40 && code <= 0x7e) {
          end = index + 1
          break
        }
      }
    } else if (output[escape + 1] === "]") {
      controlSequence = true
      const bell = output.indexOf("\u0007", escape + 2)
      const stringTerminator = output.indexOf("\u001b\\", escape + 2)
      const cancel = output.slice(escape + 2).search(/[\u0018\u001a]/)
      const terminators = [bell < 0 ? Infinity : bell + 1, stringTerminator < 0 ? Infinity : stringTerminator + 2, cancel < 0 ? Infinity : escape + 3 + cancel]
      end = Math.min(...terminators)
      if (!Number.isFinite(end)) end = -1
    } else if (["P", "X", "^", "_"].includes(output[escape + 1] ?? "")) {
      controlSequence = true
      const stringTerminator = output.indexOf("\u001b\\", escape + 2)
      const cancel = output.slice(escape + 2).search(/[\u0018\u001a]/)
      end = Math.min(stringTerminator < 0 ? Infinity : stringTerminator + 2, cancel < 0 ? Infinity : escape + 3 + cancel)
      if (!Number.isFinite(end)) end = -1
    }
    if (controlSequence && end >= start) start = end
    else if (controlSequence && end < 0 && escape < start) start = output.length
  }
  return { output: output.slice(start), truncated: true }
}

export interface ShellApi {
  list(directory: string, workspaceID?: string): Promise<ShellInfo[]>
  remove(directory: string, shellId: string, workspaceID?: string): Promise<void>
  output(directory: string, shellId: string, cursor?: number, workspaceID?: string): Promise<{ output: string; cursor: number; size: number; truncated: boolean }>
}

export interface ShellState {
  items: ShellInfo[]
  loading: boolean
  failed: boolean
}

export interface ShellRefreshEvent {
  type: string
  location?: { directory?: string; workspaceID?: string }
  data?: { info?: { cwd?: string } }
}

const EMPTY_STATE: ShellState = { items: [], loading: false, failed: false }
const SHELL_EVENTS = new Set(["shell.created", "shell.exited", "shell.deleted", "server.connected"])

export function createShellApi(client: OpenCodeClient): ShellApi {
  const location = (directory: string) => ({ directory })
  return {
    list: async (directory, workspaceID) => (await client.shell.list({ location: location(directory) }, requestLocationOptions({ directory, workspaceID }))).data,
    remove: (directory, shellId, workspaceID) => client.shell.remove({ id: shellId, location: location(directory) }, requestLocationOptions({ directory, workspaceID })),
    output: async (directory, shellId, cursor = 0, workspaceID) => (await client.shell.output({
      id: shellId,
      location: location(directory),
      cursor,
      limit: 1024 * 1024,
    }, requestLocationOptions({ directory, workspaceID }))).data,
  }
}

export function createShellStore(apiForInstance: (instanceId: string) => ShellApi) {
  const [states, setStates] = createSignal<Map<string, ShellState>>(new Map())
  const generations = new Map<string, number>()
  const key = (instanceId: string, directory: string, workspaceID?: string) => JSON.stringify([instanceId, directory, workspaceID])
  const setState = (stateKey: string, state: ShellState) => setStates((current) => new Map(current).set(stateKey, state))
  const readState = (stateKey: string): ShellState => untrack(() => states().get(stateKey) ?? EMPTY_STATE)

  const load = async (instanceId: string, directory: string, workspaceID?: string): Promise<void> => {
    if (!instanceId || !directory) return
    const stateKey = key(instanceId, directory, workspaceID)
    const generation = (generations.get(stateKey) ?? 0) + 1
    generations.set(stateKey, generation)
    setState(stateKey, { ...readState(stateKey), loading: true, failed: false })
    try {
      const items = await apiForInstance(instanceId).list(directory, workspaceID)
      if (generations.get(stateKey) === generation) setState(stateKey, { items, loading: false, failed: false })
    } catch {
      if (generations.get(stateKey) === generation) setState(stateKey, { ...readState(stateKey), loading: false, failed: true })
    }
  }

  const refreshForEvent = async (instanceId: string, event: ShellRefreshEvent): Promise<void> => {
    if (!SHELL_EVENTS.has(event.type)) return
    const eventDirectory = event.location?.directory ?? event.data?.info?.cwd
    const tracked = Array.from(states().keys())
      .map((stateKey): [string, string, string | null] => JSON.parse(stateKey))
      .filter(([trackedInstanceId]) => trackedInstanceId === instanceId)
    const matching = eventDirectory ? tracked.filter(([, directory, workspaceID]) => sameDirectory(directory, eventDirectory)
      && (event.location?.workspaceID === undefined || event.location.workspaceID === workspaceID)) : tracked
    await Promise.all((matching.length ? matching : tracked).map(([, directory, workspaceID]) => load(instanceId, directory, workspaceID ?? undefined)))
  }

  const remove = async (instanceId: string, directory: string, shellId: string, workspaceID?: string): Promise<boolean> => {
    try {
      await apiForInstance(instanceId).remove(directory, shellId, workspaceID)
      await load(instanceId, directory, workspaceID)
      return true
    } catch { return false }
  }

  const output = (instanceId: string, directory: string, shellId: string, cursor?: number, workspaceID?: string) =>
    apiForInstance(instanceId).output(directory, shellId, cursor, workspaceID)
  const getState = (instanceId: string, directory: string, workspaceID?: string): ShellState => states().get(key(instanceId, directory, workspaceID)) ?? EMPTY_STATE
  return { getState, load, refreshForEvent, remove, output }
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}
