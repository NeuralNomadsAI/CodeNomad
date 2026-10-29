export function nativeScheduleContractFixture() {
  const string = { type: "string" }, number = { type: "number" }
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
  const struct = (properties: any, required: string[] = []) => ({ type: "object", properties, required })
  const triggers = ["in", "at", "every", "cron"]
  const schemas = {
    "Config.InfoEncoded": struct({ experimental: struct({ schedules: { type: "boolean" } }) }),
    "Schedule.Info": struct({ id: string, sessionID: string, when: ref("Schedule.When"), tz: string,
      action: { anyOf: [struct({ type: { type: "string", enum: ["prompt"] }, prompt: string }, ["type", "prompt"])] },
      status: { type: "string", enum: ["active", "paused", "done"] }, runCount: { type: "integer", minimum: 0 },
      nextDueAt: number, endsAt: number, time: struct({ created: number, updated: number }) },
    ["id", "when", "tz", "action", "status", "runCount", "time"]),
    "Schedule.When": { anyOf: triggers.map(trigger => struct({ type: { type: "string", enum: [trigger] }, [trigger]: string }, ["type", trigger])) },
    "Schedule.CreatePayload": struct({ sessionID: string, prompt: string,
      when: { anyOf: triggers.map(trigger => struct({ [trigger]: string, tz: string }, [trigger])) }, ends: struct({ at: string }) }, ["sessionID", "when", "prompt"]),
  }
  const base = "/api/experimental/schedule", item = `${base}/{scheduleID}`
  const paths: any = {}
  for (const [path, method, name] of [[base, "post", "create"], [base, "get", "list"], [item, "get", "get"],
    [item, "delete", "delete"], [`${item}/pause`, "post", "pause"], [`${item}/resume`, "post", "resume"]]) {
    paths[path] ??= {}
    paths[path][method] = { operationId: `experimental.schedule.${name}`,
      responses: name === "delete" ? { "204": {} } : { "200": { content: { "application/json": { schema: struct({
        data: name === "list" ? { type: "array", items: ref("Schedule.Info") } : ref("Schedule.Info"),
      }, ["data"]) } } } },
      ...(name === "list" ? { parameters: [{ name: "sessionID", in: "query", required: true, schema: string }] }
        : path !== base ? { parameters: [{ name: "scheduleID", in: "path", required: true, schema: string }] } : {}),
      ...(name === "create" ? { requestBody: { content: { "application/json": { schema: ref("Schedule.CreatePayload") } } } } : {}),
    }
  }
  return { paths, components: { schemas } }
}
