import { createSignal, untrack } from "solid-js"
import type { OpenCodeClient, ShellInfo } from "@opencode-ai/client"

export interface ShellApi {
  list(directory: string): Promise<ShellInfo[]>
  remove(directory: string, shellId: string): Promise<void>
  output(directory: string, shellId: string, cursor?: number): Promise<{ output: string; cursor: number; size: number; truncated: boolean }>
}

export interface ShellState {
  items: ShellInfo[]
  loading: boolean
  failed: boolean
}

export interface ShellRefreshEvent {
  type: string
  location?: { directory?: string }
  data?: { info?: { cwd?: string } }
}

const EMPTY_STATE: ShellState = { items: [], loading: false, failed: false }
const SHELL_EVENTS = new Set(["shell.created", "shell.exited", "shell.deleted", "server.connected"])

export function createShellApi(client: OpenCodeClient): ShellApi {
  const location = (directory: string) => ({ directory })
  return {
    list: async (directory) => (await client.shell.list({ location: location(directory) })).data,
    remove: (directory, shellId) => client.shell.remove({ id: shellId, location: location(directory) }),
    output: async (directory, shellId, cursor = 0) => (await client.shell.output({
      id: shellId,
      location: location(directory),
      cursor,
      limit: 1024 * 1024,
    })).data,
  }
}

export function createShellStore(apiForInstance: (instanceId: string) => ShellApi) {
  const [states, setStates] = createSignal<Map<string, ShellState>>(new Map())
  const generations = new Map<string, number>()
  const key = (instanceId: string, directory: string) => `${instanceId}\0${directory}`
  const setState = (stateKey: string, state: ShellState) => setStates((current) => new Map(current).set(stateKey, state))
  const readState = (stateKey: string): ShellState => untrack(() => states().get(stateKey) ?? EMPTY_STATE)

  const load = async (instanceId: string, directory: string): Promise<void> => {
    if (!instanceId || !directory) return
    const stateKey = key(instanceId, directory)
    const generation = (generations.get(stateKey) ?? 0) + 1
    generations.set(stateKey, generation)
    setState(stateKey, { ...readState(stateKey), loading: true, failed: false })
    try {
      const items = await apiForInstance(instanceId).list(directory)
      if (generations.get(stateKey) === generation) setState(stateKey, { items, loading: false, failed: false })
    } catch {
      if (generations.get(stateKey) === generation) setState(stateKey, { ...readState(stateKey), loading: false, failed: true })
    }
  }

  const refreshForEvent = async (instanceId: string, event: ShellRefreshEvent): Promise<void> => {
    if (!SHELL_EVENTS.has(event.type)) return
    const eventDirectory = event.location?.directory ?? event.data?.info?.cwd
    const tracked = Array.from(states().keys())
      .map((stateKey) => stateKey.split("\0") as [string, string])
      .filter(([trackedInstanceId]) => trackedInstanceId === instanceId)
    const matching = eventDirectory ? tracked.filter(([, directory]) => sameDirectory(directory, eventDirectory)) : tracked
    await Promise.all((matching.length ? matching : tracked).map(([, directory]) => load(instanceId, directory)))
  }

  const remove = async (instanceId: string, directory: string, shellId: string): Promise<boolean> => {
    try {
      await apiForInstance(instanceId).remove(directory, shellId)
      await load(instanceId, directory)
      return true
    } catch { return false }
  }

  const output = (instanceId: string, directory: string, shellId: string, cursor?: number) =>
    apiForInstance(instanceId).output(directory, shellId, cursor)
  const getState = (instanceId: string, directory: string): ShellState => states().get(key(instanceId, directory)) ?? EMPTY_STATE
  return { getState, load, refreshForEvent, remove, output }
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}
