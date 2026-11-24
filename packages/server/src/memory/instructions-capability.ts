import { readRuntimeContract } from "../opencode/compatibility/negotiate"
import type { ServiceConnection } from "../workspaces/opencode-service"

export type MemoryInstructionsCapability = "supported" | "unsupported" | "authentication" | "unavailable"
type Connection = Pick<ServiceConnection, "endpoint" | "fetch" | "assertCurrent">
const capabilities = new WeakMap<Connection, Promise<MemoryInstructionsCapability>>()
const entries = "/api/experimental/session/{sessionID}/instructions/entries"
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))

/** Only a valid authenticated contract can establish absence. Missing discovery, auth and transport stay unavailable. */
export function memoryInstructionsContract(document: unknown): MemoryInstructionsCapability {
  if (!object(document) || typeof document.openapi !== "string" || !/^3\./.test(document.openapi) || !object(document.paths)) return "unavailable"
  for (const [path, method] of [[entries, "get"], [`${entries}/{key}`, "put"], [`${entries}/{key}`, "delete"]]) {
    const operations = document.paths[path!]
    if (operations === undefined) return "unsupported"
    if (!object(operations)) return "unavailable"
    if (operations[method!] === undefined) return "unsupported"
    if (!object(operations[method!])) return "unavailable"
  }
  return "supported"
}

/** Connection-scoped optional capability: retain only authoritative answers. A new connection probes anew.
 * Each caller rechecks connection ownership, including callers joining an in-flight read.
 */
export async function readMemoryInstructionsCapability(connection: Connection): Promise<MemoryInstructionsCapability> {
  connection.assertCurrent()
  let pending = capabilities.get(connection)
  if (!pending) {
    pending = inspect(connection)
    capabilities.set(connection, pending)
    void pending.then(result => {
      if (result !== "supported" && result !== "unsupported" && capabilities.get(connection) === pending) capabilities.delete(connection)
    })
  }
  const result = await pending
  connection.assertCurrent()
  return result
}

async function inspect(connection: Connection): Promise<MemoryInstructionsCapability> {
  let status: number | undefined
  try {
    const contract = await readRuntimeContract(connection.endpoint, async (input, init) => {
      connection.assertCurrent()
      const response = await connection.fetch(input, init)
      status = response.status
      return response
    }, AbortSignal.timeout(5_000))
    connection.assertCurrent()
    return memoryInstructionsContract(contract)
  } catch {
    return status === 401 || status === 403 ? "authentication" : "unavailable"
  }
}
