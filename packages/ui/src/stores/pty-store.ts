import { createSignal } from "solid-js"
import type { OpenCodeClient, Pty } from "@opencode-ai/client"

export interface PtyApi {
  list(directory: string): Promise<Pty[]>
  get(directory: string, ptyId: string): Promise<Pty>
  updateTitle(directory: string, ptyId: string, title: string): Promise<Pty>
  remove(directory: string, ptyId: string): Promise<void>
}

export interface PtyState {
  items: Pty[]
  loading: boolean
  failed: boolean
}

export interface PtyRefreshEvent {
  type: string
  location?: { directory?: string }
  data?: { info?: { cwd?: string } }
}

const EMPTY_STATE: PtyState = { items: [], loading: false, failed: false }
const PTY_EVENTS = new Set(["pty.created", "pty.updated", "pty.exited", "pty.deleted", "server.connected"])

export function createPtyApi(client: OpenCodeClient): PtyApi {
  const location = (directory: string) => ({ directory })
  return {
    list: async (directory) => (await client.pty.list({ location: location(directory) })).data,
    get: async (directory, ptyId) => (await client.pty.get({ ptyID: ptyId, location: location(directory) })).data,
    updateTitle: async (directory, ptyId, title) => (
      await client.pty.update({ ptyID: ptyId, location: location(directory), title })
    ).data,
    remove: (directory, ptyId) => client.pty.remove({ ptyID: ptyId, location: location(directory) }),
  }
}

export function createPtyStore(apiForInstance: (instanceId: string) => PtyApi) {
  const [states, setStates] = createSignal<Map<string, PtyState>>(new Map())
  const generations = new Map<string, number>()
  const key = (instanceId: string, directory: string) => `${instanceId}\0${directory}`

  const setState = (stateKey: string, state: PtyState) => {
    setStates((current) => new Map(current).set(stateKey, state))
  }

  const load = async (instanceId: string, directory: string): Promise<void> => {
    if (!instanceId || !directory) return
    const stateKey = key(instanceId, directory)
    const generation = (generations.get(stateKey) ?? 0) + 1
    generations.set(stateKey, generation)
    setState(stateKey, { ...(states().get(stateKey) ?? EMPTY_STATE), loading: true, failed: false })
    try {
      const items = await apiForInstance(instanceId).list(directory)
      if (generations.get(stateKey) === generation) setState(stateKey, { items, loading: false, failed: false })
    } catch {
      if (generations.get(stateKey) === generation) {
        setState(stateKey, { ...(states().get(stateKey) ?? EMPTY_STATE), loading: false, failed: true })
      }
    }
  }

  const refreshForEvent = async (instanceId: string, event: PtyRefreshEvent): Promise<void> => {
    if (!PTY_EVENTS.has(event.type)) return
    const eventDirectory = event.location?.directory ?? event.data?.info?.cwd
    const tracked = Array.from(states().keys())
      .map((stateKey) => stateKey.split("\0") as [string, string])
      .filter(([trackedInstanceId]) => trackedInstanceId === instanceId)
    const matching = eventDirectory ? tracked.filter(([, directory]) => sameDirectory(directory, eventDirectory)) : tracked
    // Events are already ownership-scoped by the server. Fall back to every tracked
    // location when host/WSL path forms differ so an exact PTY event is never missed.
    await Promise.all((matching.length ? matching : tracked).map(([, directory]) => load(instanceId, directory)))
  }

  const updateTitle = async (instanceId: string, directory: string, ptyId: string, title: string): Promise<boolean> => {
    try {
      await apiForInstance(instanceId).updateTitle(directory, ptyId, title)
      await load(instanceId, directory)
      return true
    } catch {
      setState(key(instanceId, directory), { ...getState(instanceId, directory), failed: true })
      return false
    }
  }

  const remove = async (instanceId: string, directory: string, ptyId: string): Promise<boolean> => {
    try {
      await apiForInstance(instanceId).remove(directory, ptyId)
      await load(instanceId, directory)
      return true
    } catch {
      setState(key(instanceId, directory), { ...getState(instanceId, directory), failed: true })
      return false
    }
  }

  const getState = (instanceId: string, directory: string): PtyState => states().get(key(instanceId, directory)) ?? EMPTY_STATE

  return { getState, load, refreshForEvent, updateTitle, remove }
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}
