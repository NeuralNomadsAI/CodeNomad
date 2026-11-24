import assert from "node:assert/strict"
import test from "node:test"
import { describeMissionCriteria } from "./mission-scheduling-summary"

test("once-now summaries use the same ordered connectors and keep following cron rows aligned", () => {
  const now = { kind: "now" } as const
  const event = { kind: "files-changed", paths: ["a.ts"] } as const
  const daily = { kind: "cron", expression: "0 9 * * *", zone: "UTC" } as const
  const translate = (key: string) => key.replace("missions.scheduling.", "")
  assert.deepEqual(describeMissionCriteria({ when: [now, { ...event, paths: [...event.paths] }] }, translate, "en"),
    ["source.now", "connector.if · condition.files-changed · a.ts"])
  assert.deepEqual(describeMissionCriteria({ when: [{ ...event, paths: [...event.paths] }, now, daily] }, translate, "en"),
    ["condition.files-changed · a.ts", "connector.else · source.now", "connector.or · shortcut.daily · 09:00 · UTC"])
})
