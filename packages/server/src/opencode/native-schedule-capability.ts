import type { PluginControlLocation } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { readRuntimeContract } from "./compatibility/negotiate"
import { readMissionExperimental } from "./native-experimental-settings"
import { readNativeScheduleFlag, nativeScheduleFlagOrigin } from "./native-schedule-flag"
import { PluginControlsError, type PluginControls } from "./plugin-controls"

type ObjectValue = Record<string, any>
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value : {}

/** Recognition is read-only and independent of runtime release labels and feature activation. */
export function nativeScheduleCapability(document: ObjectValue): { available: true } | {
  available: false; reason: "missing-api" | "incompatible-contract"
} {
  const base = "/api/experimental/automation", item = `${base}/{automationID}`
  const routes = [[base, "post", "create"], [base, "get", "list"], [item, "get", "get"],
    [item, "delete", "delete"], [`${item}/pause`, "post", "pause"], [`${item}/resume`, "post", "resume"]]
  if (routes.some(([path, method]) => !object(document.paths?.[path])[method]))
    return { available: false, reason: "missing-api" }
  const resolve = (input: unknown): ObjectValue => {
    const schema = object(input), ref = schema.$ref
    return typeof ref === "string" && ref.startsWith("#/components/schemas/")
      ? object(document.components?.schemas?.[ref.slice("#/components/schemas/".length)]) : schema
  }
  const fields = (schema: unknown) => object(resolve(schema).properties)
  const type = (schema: unknown, expected: string) => resolve(schema).type === expected
  const includes = (values: unknown, value: string) => Array.isArray(values) && values.includes(value)
  const required = (schema: unknown, keys: string[]) => keys.every(key => includes(resolve(schema).required, key))
  const when = (schema: unknown) => ["at", "every", "cron"].every(trigger => {
    const branches = resolve(schema).anyOf
    return Array.isArray(branches) && branches.some((branch: unknown) => type(branch, "object") && required(branch, ["type", trigger])
      && type(fields(branch)[trigger], "string") && type(fields(branch).tz, "string")
      && includes(resolve(fields(branch).type).enum, trigger))
  })
  const code = (schema: unknown) => {
    const actions = resolve(schema).anyOf
    const branches = Array.isArray(actions) ? actions : [schema]
    return branches.some((branch: unknown) => type(branch, "object") && required(branch, ["type", "code"])
      && includes(resolve(fields(branch).type).enum, "code") && type(fields(branch).code, "string"))
  }
  const info = (schema: unknown) => {
    const properties = fields(schema)
    return type(schema, "object") && required(schema, ["id", "name", "projectID", "directory", "trigger", "tz", "action", "status", "runCount", "time"])
      && ["id", "name", "projectID", "directory", "sessionID", "tz"].every(key => type(properties[key], "string"))
      && type(properties.runCount, "integer") && resolve(properties.runCount).minimum === 0
      && type(properties.nextDueAt, "number") && type(properties.expires, "number")
      && type(properties.status, "string") && ["active", "paused", "done"].every(status => includes(resolve(properties.status).enum, status))
      && type(properties.time, "object") && ["created", "updated"].every(key => type(fields(properties.time)[key], "number"))
      && when(properties.trigger) && code(properties.action)
  }
  const inputs = (schema: unknown) => {
    const properties = fields(schema)
    return type(schema, "object") && required(schema, ["name", "trigger", "action"])
      && type(properties.sessionID, "string") && type(properties.name, "string") && type(properties.expires, "string")
      && when(properties.trigger) && code(properties.action)
  }
  // The on/off setting is top-level `automations`.
  let valid = type(fields(document.components?.schemas?.["Config.InfoEncoded"]).automations, "boolean")
  for (const [path, method, name] of routes) {
    const operation = document.paths[path][method]
    valid &&= operation.operationId === `experimental.automation.${name}`
    if (path !== base) valid &&= Array.isArray(operation.parameters) && operation.parameters.some((parameter: ObjectValue) =>
      parameter && parameter.name === "automationID" && parameter.in === "path" && parameter.required === true && type(parameter.schema, "string"))
    if (name === "delete") { valid &&= Boolean(operation.responses?.["204"]); continue }
    const response = operation.responses?.["200"]?.content?.["application/json"]?.schema
    valid &&= type(response, "object") && required(response, ["data"])
    const data = fields(response).data
    valid &&= name === "list" ? type(data, "array") && info(resolve(data).items) : info(data)
    if (name === "create") valid &&= inputs(operation.requestBody?.content?.["application/json"]?.schema)
    if (name === "list") valid &&= Array.isArray(operation.parameters) && operation.parameters.some((parameter: ObjectValue) =>
      parameter && parameter.name === "sessionID" && parameter.in === "query"
      && (type(parameter.schema, "string") || (Array.isArray(resolve(parameter.schema).anyOf) && resolve(parameter.schema).anyOf.some((member: unknown) => type(member, "string")))))
  }
  return valid ? { available: true } : { available: false, reason: "incompatible-contract" }
}

/** Foundation reader; callers keep scheduling admission closed until all other capabilities qualify. */
export class NativeScheduleCapabilityReader {
  constructor(private readonly documents: Pick<PluginControls, "readConfigDocuments">,
    private readonly manager: Pick<WorkspaceManager, "getSharedServiceConnection">) {}

  async read(workspaceId: string, location: PluginControlLocation) {
    const connection = await this.manager.getSharedServiceConnection(workspaceId)
    if (!connection) throw new PluginControlsError("OpenCode is unavailable", "unavailable")
    const snapshot = await this.documents.readConfigDocuments(workspaceId, location, undefined, true)
    connection.assertCurrent()
    for (const document of snapshot.documents) readMissionExperimental(document.document)
    const contract = await readRuntimeContract(connection.endpoint, connection.fetch, AbortSignal.timeout(5_000))
    connection.assertCurrent()
    const flag = await readNativeScheduleFlag(connection, location)
    return { location: snapshot.location, api: nativeScheduleCapability(contract), enabled: flag.enabled,
      provenance: flag.provenance, origin: nativeScheduleFlagOrigin(flag) }
  }
}
