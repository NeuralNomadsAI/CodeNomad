import { Service, type Endpoint } from "@opencode/client/service"
import { runtimeIdentity, type ContractProfile } from "./runtime"
import { UnsupportedOpenCodeError, type OpenCodeIncompatibility } from "../runtime-support"

export class ExplicitContractError extends Error {
  readonly code = "missing_contract"
  constructor(readonly reason: OpenCodeIncompatibility) { super(`missing_contract: ${reason}`); this.name = "ExplicitContractError" }
}

type ObjectValue = Record<string, any>
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

// Unknown release numbers are not a startup/version gate. Read their declared
// HTTP contract before selecting a serializer; never trial a write operation.
export async function readRuntimeContract(endpoint: Endpoint, fetcher: typeof fetch, signal: AbortSignal): Promise<ObjectValue> {
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
  try { return object(JSON.parse(Buffer.concat(chunks, length).toString("utf8"))) }
  catch { throw new ExplicitContractError("canonical_api") }
}

export async function negotiateRuntime(endpoint: Endpoint, fetcher: typeof fetch, signal: AbortSignal,
  contract: "local" | "explicit-e1" = "local"): Promise<Exclude<ContractProfile, "unknown">> {
  const document = await readRuntimeContract(endpoint, fetcher, signal)
  const refuse = (reason: OpenCodeIncompatibility): never => {
    if (contract === "explicit-e1") throw new ExplicitContractError(reason)
    throw new UnsupportedOpenCodeError(runtimeIdentity(endpoint)?.version ?? "unknown", reason)
  }
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
  // Retired (pre-2.0.4) and unrecognised contracts alike are refused.
  if (!modern) refuse("canonical_api")
  if (contract === "local" && !body(`${session}/environment`, "variables", "put")) {
    refuse("session_environment")
  }
  // The pinned client reducer consumes 2.1's replay shape: `native`, never `state`/`recent`.
  const fields = (name: string) => object(object(document.components?.schemas?.[name]).properties)
  const text = fields("Session.Message.Assistant.Text"), compaction = fields("Session.Message.Compaction.Completed")
  if (!("native" in text && !("state" in text) && "metadata" in compaction && !("recent" in compaction))) {
    refuse("native_contract")
  }
  if (contract === "explicit-e1") {
    const properties = (schema: unknown) => object(resolve(schema).properties)
    const strings = (schema: unknown, names: string[]) => names.every(name => resolve(properties(schema)[name]).type === "string")
    const request = (route: string) => paths[route]?.post?.requestBody?.content?.["application/json"]?.schema
    // Selection writes precede prompts; catalogue locations and entries are read
    // by metadata and the mention picker. Optional display/enrichment fields stay optional.
    const catalog = (route: string, names: string[]) => {
      const operation = object(paths[route]?.get)
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : []
      const location = resolve(parameters.find((parameter: ObjectValue) => parameter.name === "location" && parameter.in === "query")?.schema)
      const selectors = Array.isArray(location.anyOf) ? location.anyOf : [location]
      const response = properties(operation.responses?.["200"]?.content?.["application/json"]?.schema)
      const data = resolve(response.data)
      return selectors.some((schema: unknown) => {
        const directory = resolve(properties(schema).directory)
        const variants = Array.isArray(directory.anyOf) ? directory.anyOf : [directory]
        return variants.some((value: unknown) => resolve(value).type === "string")
      })
        && (route !== "/api/mcp" || strings(response.location, ["directory"]))
        && data.type === "array" && strings(data.items, names)
    }
    const mcp = properties(paths["/api/mcp"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema)
    const status = resolve(properties(resolve(mcp.data).items).status)
    const statuses = Array.isArray(status.anyOf) ? status.anyOf : [status]
    const required: [string, string][] = [
      ["/api/info", "get"], ["/api/location", "get"], ["/api/event", "get"],
      ["/api/session", "get"], ["/api/session", "post"], [session, "get"], [session, "delete"],
      [`${session}/message`, "get"], [`${session}/message/{messageID}`, "get"],
      [`${session}/prompt`, "post"], [`${session}/shell`, "post"], [`${session}/interrupt`, "post"],
      [`${session}/form/{formID}`, "get"], [`${session}/form/{formID}/reply`, "post"],
      ["/api/agent", "get"], ["/api/model", "get"], ["/api/provider", "get"], ["/api/command", "get"],
      [`${session}/agent`, "post"], [`${session}/model`, "post"], ["/api/mcp", "get"], ["/api/skill", "get"],
    ]
    if (required.some(([path, method]) => !has(path, method))
      || !body(`${session}/prompt`, "text") || !body(`${session}/shell`, "command")
      || !Array.isArray(paths[`${session}/interrupt`]?.post?.parameters)
      || !paths[`${session}/interrupt`].post.parameters.some((parameter: ObjectValue) => parameter.name === "resume" && parameter.in === "query")
      || !body(`${session}/form/{formID}/reply`, "answer")
      || !strings(request(`${session}/agent`), ["agent"])
      || !strings(properties(request(`${session}/model`)).model, ["id", "providerID", "variant"])
      || !catalog("/api/mcp", ["name"]) || !catalog("/api/skill", ["id", "name"])
      || !statuses.length || !statuses.every((schema: unknown) => strings(schema, ["status"]))
      || !("id" in fields("Session.Info") && "location" in fields("Session.Info"))
      || !("data" in fields("SessionsResponse") && "cursor" in fields("SessionsResponse"))) {
      refuse("canonical_api")
    }
  }
  const identity = runtimeIdentity(endpoint)
  if (identity?.contract) {
    identity.contract.profile = "modern"
    identity.contract.reload = has("/api/location/reload", "post")
  }
  return "modern"
}
