export function nativeScheduleContractFixture() {
  const string = { type: "string" }, number = { type: "number" }
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
  const struct = (properties: any, required: string[] = []) => ({ type: "object", properties, required })
  const action = () => ({ anyOf: [struct({ type: { type: "string", enum: ["code"] }, code: string }, ["type", "code"])] })
  const schemas = {
    "Config.InfoEncoded": struct({ automations: { type: "boolean" } }),
    "Automation.Info": struct({ id: string, name: string, projectID: string, directory: string, sessionID: string,
      trigger: ref("Automation.Trigger"), tz: string, action: action(),
      status: { type: "string", enum: ["active", "paused", "done"] }, runCount: { type: "integer", minimum: 0 },
      nextDueAt: number, expires: number, time: struct({ created: number, updated: number }) },
    ["id", "name", "projectID", "directory", "trigger", "tz", "action", "status", "runCount", "time"]),
    "Automation.Trigger": { anyOf: ["at", "every", "cron"].map(trigger => struct({ type: { type: "string", enum: [trigger] }, [trigger]: string, tz: string }, ["type", trigger])) },
    "Automation.CreatePayload": struct({ sessionID: string, name: string, trigger: ref("Automation.Trigger"), action: action(), expires: string }, ["name", "trigger", "action"]),
  }
  const base = "/api/experimental/automation", item = `${base}/{automationID}`
  const paths: any = {}
  for (const [path, method, name] of [[base, "post", "create"], [base, "get", "list"], [item, "get", "get"],
    [item, "delete", "delete"], [`${item}/pause`, "post", "pause"], [`${item}/resume`, "post", "resume"]]) {
    paths[path] ??= {}
    paths[path][method] = { operationId: `experimental.automation.${name}`,
      responses: name === "delete" ? { "204": {} } : { "200": { content: { "application/json": { schema: struct({
        data: name === "list" ? { type: "array", items: ref("Automation.Info") } : ref("Automation.Info"),
      }, ["data"]) } } } },
      ...(name === "list" ? { parameters: [{ name: "sessionID", in: "query", required: false, schema: { anyOf: [string] } }] }
        : path !== base ? { parameters: [{ name: "automationID", in: "path", required: true, schema: string }] } : {}),
      ...(name === "create" ? { requestBody: { content: { "application/json": { schema: ref("Automation.CreatePayload") } } } } : {}),
    }
  }
  return { paths, components: { schemas } }
}
