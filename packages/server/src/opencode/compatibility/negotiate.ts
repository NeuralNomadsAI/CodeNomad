import { Service, type Endpoint } from "@opencode/client/service"
import { runtimeIdentity, type ContractProfile } from "./runtime"
import { UnsupportedOpenCodeError } from "../runtime-support"

type ObjectValue = Record<string, any>
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

// Unknown release numbers are not a startup/version gate. Read their declared
// HTTP contract before selecting a serializer; never trial a write operation.
export async function negotiateRuntime(endpoint: Endpoint, fetcher: typeof fetch, signal: AbortSignal): Promise<Exclude<ContractProfile, "unknown">> {
  const response = await fetcher(new URL("/openapi.json", endpoint.url), {
    headers: Service.headers(endpoint), redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Cannot negotiate OpenCode contract (HTTP ${response.status})`)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Missing OpenCode contract")
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > 8 * 1024 * 1024) throw new Error("OpenCode contract exceeds limit")
      chunks.push(chunk.value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  finally { reader.releaseLock() }
  const document = object(JSON.parse(Buffer.concat(chunks, length).toString("utf8")))
  const paths = object(document.paths)
  const resolve = (input: unknown) => {
    const schema = object(input)
    const ref = schema.$ref
    return typeof ref === "string" && ref.startsWith("#/components/schemas/")
      ? object(document.components?.schemas?.[ref.slice("#/components/schemas/".length)]) : schema
  }
  const has = (path: string, method: string) => Boolean(object(paths[path])[method])
  const body = (path: string, field: string, method = "post") => {
    const operation = object(object(paths[path])[method])
    return field in object(resolve(operation.requestBody?.content?.["application/json"]?.schema).properties)
  }
  const session = "/api/session/{sessionID}"
  const inbox = object(resolve(document.components?.schemas?.["Session.Inbox.User"]).properties)
  const modern = has(session, "patch") && has("/api/form", "get")
    && has(`${session}/form/{formID}`, "delete") && has(`/api/experimental/session/{sessionID}/wait`, "post")
    && body(`${session}/fork`, "before") && body(`${session}/command`, "name")
    && body(`${session}/permission/{requestID}/reply`, "decision")
    && "time" in inbox && !("timeCreated" in inbox)
  const legacy = has(`${session}/rename`, "post") && has("/api/form/request", "get")
    && has(`${session}/form/{formID}/cancel`, "post") && has(`${session}/wait`, "post")
    && body(`${session}/fork`, "boundary") && body(`${session}/command`, "command")
    && body(`${session}/permission/{requestID}/reply`, "reply")
    && "timeCreated" in inbox && !("time" in inbox)
  if (modern === legacy) throw new UnsupportedOpenCodeError(runtimeIdentity(endpoint)?.version ?? "unknown", "canonical_api")
  if (modern && !body(`${session}/environment`, "variables", "put")) {
    throw new UnsupportedOpenCodeError(runtimeIdentity(endpoint)?.version ?? "unknown", "session_environment")
  }
  const profile = modern ? "modern" : "legacy"
  const identity = runtimeIdentity(endpoint)
  if (identity?.contract) {
    identity.contract.profile = profile
    identity.contract.reload = has("/api/location/reload", "post")
  }
  return profile
}
