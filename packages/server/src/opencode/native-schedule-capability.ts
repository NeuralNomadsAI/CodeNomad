import type { PluginControlLocation } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { readRuntimeContract } from "./compatibility/negotiate"
import { effectiveMissionExperimental, readMissionExperimental } from "./native-experimental-settings"
import { PluginControlsError, type PluginControls } from "./plugin-controls"

type ObjectValue = Record<string, any>
const object = (value: unknown): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value : {}

/** Recognition is read-only and independent of runtime release labels and feature activation. */
export function nativeScheduleCapability(document: ObjectValue): { available: true } | {
  available: false; reason: "missing-api" | "incompatible-contract"
} {
  const base = "/api/experimental/schedule", item = `${base}/{scheduleID}`
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
  const when = (schema: unknown, tagged: boolean) => ["in", "at", "every", "cron"].every(trigger => {
    const branches = resolve(schema).anyOf
    return Array.isArray(branches) && branches.some((branch: unknown) => type(branch, "object") && required(branch, tagged ? ["type", trigger] : [trigger])
      && type(fields(branch)[trigger], "string") && (tagged ? type(fields(branch).type, "string")
        && includes(resolve(fields(branch).type).enum, trigger) : type(fields(branch).tz, "string")))
  })
  const info = (schema: unknown) => {
    const properties = fields(schema), actions = resolve(properties.action).anyOf
    return type(schema, "object") && required(schema, ["id", "when", "tz", "action", "status", "runCount", "time"])
      && type(properties.id, "string") && type(properties.sessionID, "string") && type(properties.tz, "string")
      && type(properties.runCount, "integer") && resolve(properties.runCount).minimum === 0
      && type(properties.nextDueAt, "number") && type(properties.endsAt, "number")
      && type(properties.status, "string") && ["active", "paused", "done"].every(status => includes(resolve(properties.status).enum, status))
      && type(properties.time, "object") && ["created", "updated"].every(key => type(fields(properties.time)[key], "number"))
      && when(properties.when, true) && Array.isArray(actions) && actions.some((branch: unknown) => type(branch, "object") && required(branch, ["type", "prompt"])
        && type(fields(branch).type, "string") && includes(resolve(fields(branch).type).enum, "prompt") && type(fields(branch).prompt, "string"))
  }
  const inputs = (schema: unknown) => {
    const properties = fields(schema)
    return type(schema, "object") && required(schema, ["sessionID", "prompt"]) && type(properties.sessionID, "string") && type(properties.prompt, "string")
      && type(properties.ends, "object") && type(fields(properties.ends).at, "string") && when(properties.when, false)
  }
  let valid = type(fields(fields(document.components?.schemas?.["Config.InfoEncoded"]).experimental).schedules, "boolean")
  for (const [path, method, name] of routes) {
    const operation = document.paths[path][method]
    valid &&= operation.operationId === `experimental.schedule.${name}`
    if (path !== base) valid &&= Array.isArray(operation.parameters) && operation.parameters.some((parameter: ObjectValue) =>
      parameter && parameter.name === "scheduleID" && parameter.in === "path" && parameter.required === true && type(parameter.schema, "string"))
    if (name === "delete") { valid &&= Boolean(operation.responses?.["204"]); continue }
    const response = operation.responses?.["200"]?.content?.["application/json"]?.schema
    valid &&= type(response, "object") && required(response, ["data"])
    const data = fields(response).data
    valid &&= name === "list" ? type(data, "array") && info(resolve(data).items) : info(data)
    if (name === "create") valid &&= inputs(operation.requestBody?.content?.["application/json"]?.schema)
    if (name === "list") valid &&= Array.isArray(operation.parameters) && operation.parameters.some((parameter: ObjectValue) =>
      parameter && parameter.name === "sessionID" && parameter.in === "query" && parameter.required === true && type(parameter.schema, "string"))
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
    const experimental = effectiveMissionExperimental(snapshot.entries)
    return { location: snapshot.location, api: nativeScheduleCapability(contract), enabled: experimental.schedules === true,
      origin: experimental.origin }
  }
}
