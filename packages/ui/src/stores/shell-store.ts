import { createSignal, untrack } from "solid-js"
import type { OpenCodeClient, ShellInfo } from "@opencode/client"
import { requestLocationOptions } from "./request-locations"
import { parseInstanceKey } from "../lib/backend-identity"

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
  list(directory: string, workspaceID?: string, signal?: AbortSignal): Promise<{ data: ShellInfo[]; location?: { directory: string } }>
  remove(directory: string, shellId: string, workspaceID?: string): Promise<void>
  output(directory: string, shellId: string, cursor?: number, workspaceID?: string, signal?: AbortSignal): Promise<{ output: string; cursor: number; size: number; truncated: boolean }>
}

export interface ShellState {
  items: ShellInfo[]
  nativeDirectory?: string
  loading: boolean
  failed: boolean
}

export interface ShellRefreshEvent {
  type: string
  location?: { directory?: string; workspaceID?: string }
  data?: { info?: { cwd?: string } }
}

const EMPTY_STATE: ShellState = { items: [], loading: false, failed: false }
// Creation precedes background admission; the tool's terminal event confirms it.
const SHELL_EVENTS = new Set(["shell.created", "shell.exited", "shell.deleted", "session.tool.success", "session.tool.failed", "server.connected"])

export function createShellApi(client: OpenCodeClient, listBackground?: ShellApi["list"]): ShellApi {
  const location = (directory: string) => ({ directory })
  return {
    list: listBackground ?? ((directory, workspaceID, signal) => client.shell.list({ location: location(directory) }, { ...requestLocationOptions({ directory, workspaceID }), signal })),
    remove: (directory, shellId, workspaceID) => client.shell.remove({ id: shellId, location: location(directory) }, requestLocationOptions({ directory, workspaceID })),
    output: async (directory, shellId, cursor = 0, workspaceID, signal) => (await client.shell.output({
      id: shellId,
      location: location(directory),
      cursor,
      limit: 1024 * 1024,
    }, { ...requestLocationOptions({ directory, workspaceID }), signal })).data,
  }
}

export function createShellStore(apiForInstance: (instanceId: string) => ShellApi, signalForInstance?: (id: string) => AbortSignal) {
  const [states, setStates] = createSignal<Map<string, ShellState>>(new Map())
  const requests = new Map<string, { promise: Promise<void>; dirty: boolean; signal?: AbortSignal }>()
  const demands = new Map<string, number>()
  const key = (instanceId: string, directory: string, workspaceID?: string) => JSON.stringify([instanceId, directory, workspaceID])
  const setState = (stateKey: string, state: ShellState) => setStates((current) => new Map(current).set(stateKey, state))
  const readState = (stateKey: string): ShellState => untrack(() => states().get(stateKey) ?? EMPTY_STATE)

  const load = async (instanceId: string, directory: string, workspaceID?: string, refresh = false, signal = signalForInstance?.(instanceId)): Promise<void> => {
    if (!instanceId || !directory) return
    const stateKey = key(instanceId, directory, workspaceID)
    if (signal?.aborted) { setState(stateKey, { ...readState(stateKey), loading: false }); return }
    const pending = requests.get(stateKey)
    if (pending && pending.signal === signal) {
      if (refresh) pending.dirty = true
      return pending.promise
    }
    let api: ShellApi
    try { api = apiForInstance(instanceId) }
    catch { setState(stateKey, { ...readState(stateKey), loading: false, failed: true }); return }
    const request = { promise: Promise.resolve(), dirty: false, signal }
    const current = () => !signal?.aborted && requests.get(stateKey) === request
    requests.set(stateKey, request)
    setState(stateKey, { ...readState(stateKey), loading: true, failed: false })
    request.promise = Promise.resolve().then(async () => {
      do {
        if (!current()) return
        request.dirty = false
        try {
          const inventory = await api.list(directory, workspaceID, signal)
          const items = inventory.data
          if (current() && !request.dirty) {
            const previous = new Map(readState(stateKey).items.map(item => [item.id, item]))
            const stable = items.map(item => {
              const old = previous.get(item.id)
              return old && JSON.stringify(old) === JSON.stringify(item) ? old : item
            })
            setState(stateKey, { items: stable, nativeDirectory: inventory.location?.directory ?? directory, loading: false, failed: false })
          }
        } catch {
          if (current() && !request.dirty) setState(stateKey, { ...readState(stateKey), loading: false, failed: true })
        }
      } while (current() && request.dirty)
    }).finally(() => {
      if (requests.get(stateKey) !== request) return
      requests.delete(stateKey)
      if (signal?.aborted) setState(stateKey, { ...readState(stateKey), loading: false })
    })
    return request.promise
  }

  const refreshForEvent = async (instanceId: string, event: ShellRefreshEvent): Promise<void> => {
    if (!SHELL_EVENTS.has(event.type)) return
    const eventDirectory = event.location?.directory ?? event.data?.info?.cwd
    const tracked = Array.from(untrack(states).keys())
      .map((stateKey): [string, string, string | null] => JSON.parse(stateKey))
      .filter(([trackedInstanceId, directory, workspaceID]) => trackedInstanceId === instanceId
        && demands.has(key(instanceId, directory, workspaceID ?? undefined)))
    const matching = eventDirectory ? tracked.filter(([, directory, workspaceID]) => {
      if (event.location?.workspaceID !== undefined && event.location.workspaceID !== workspaceID) return false
      const stateKey = key(instanceId, directory, workspaceID ?? undefined)
      const state = readState(stateKey)
      const nativeDirectory = state.nativeDirectory
      // Until the first successful inventory, its native alias is unknown.
      // Events coalesce during the read and recover an initial read failure.
      return sameDirectory(directory, eventDirectory) || (nativeDirectory !== undefined
        ? sameDirectory(nativeDirectory, eventDirectory) : requests.has(stateKey) || state.failed)
    }) : tracked
    await Promise.all(matching.map(([, directory, workspaceID]) => load(instanceId, directory, workspaceID ?? undefined, true)))
  }

  const remove = async (instanceId: string, directory: string, shellId: string, workspaceID?: string): Promise<boolean> => {
    const signal = signalForInstance?.(instanceId)
    try {
      signal?.throwIfAborted()
      await apiForInstance(instanceId).remove(directory, shellId, workspaceID)
      if (!signal?.aborted) await load(instanceId, directory, workspaceID, true, signal)
      return true
    } catch { return false }
  }

  const output = async (instanceId: string, directory: string, shellId: string, cursor?: number, workspaceID?: string, parent?: AbortSignal) => {
    const attachment = signalForInstance?.(instanceId)
    const signal = parent && attachment ? AbortSignal.any([parent, attachment]) : parent ?? attachment
    signal?.throwIfAborted()
    const result = await apiForInstance(instanceId).output(directory, shellId, cursor, workspaceID, signal)
    signal?.throwIfAborted()
    return result
  }
  const getState = (instanceId: string, directory: string, workspaceID?: string): ShellState => states().get(key(instanceId, directory, workspaceID)) ?? EMPTY_STATE
  const refreshBackend = (backendId: string) => {
    const ids = new Set([...untrack(states).keys()].map(value => (JSON.parse(value) as string[])[0]))
    for (const id of ids) if (parseInstanceKey(id).backendId === backendId) void refreshForEvent(id, { type: "server.connected" })
  }
  const watch = (instanceId: string, directory: string, workspaceID?: string) => {
    const stateKey = key(instanceId, directory, workspaceID)
    demands.set(stateKey, (demands.get(stateKey) ?? 0) + 1)
    return () => {
      const remaining = (demands.get(stateKey) ?? 1) - 1
      if (remaining) demands.set(stateKey, remaining)
      else demands.delete(stateKey)
    }
  }
  return { getState, load, watch, refreshForEvent, refreshBackend, remove, output }
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
    return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized
  }
  return normalize(left) === normalize(right)
}
