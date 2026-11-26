// Read-only: which stored Mission schedules one native Automation can carry, and as what.
// Reads an OpenCode database without writing it and prints no objective, notes or profile.
// Usage: node --import tsx scripts/inspect-mission-calendar-conversion.mjs [absolute-opencode-db]
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import { missionCalendarAutomation } from "../packages/server/src/missions/calendar-automation.ts"
import { missionConfigurationSchema, requiresMissionCalendar } from "../packages/server/src/missions/launch-policy.ts"

const file = process.argv[2] ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const db = new DatabaseSync(file, { readOnly: true })
try {
  const rows = db.prepare("SELECT value FROM kv WHERE key LIKE '%codenomad-missions/documents-v1/project/%/missions/%'").all()
  for (const row of rows) {
    const doc = JSON.parse(row.value)
    if (doc.deletedAt !== undefined || doc.deletion) continue
    const parsed = missionConfigurationSchema.safeParse(doc.configuration)
    if (!parsed.success) { console.log(JSON.stringify({ id: doc.id, title: doc.configuration?.title, unreadable: true })); continue }
    if (!requiresMissionCalendar(parsed.data.launch)) continue
    const automation = missionCalendarAutomation(parsed.data)
    console.log(JSON.stringify("unsupported" in automation ? { id: doc.id, title: parsed.data.title, ...automation }
      : { id: doc.id, title: parsed.data.title, trigger: automation.trigger, when: automation.action.args.when ?? [],
        coordinator: automation.action.args.coordinatorSessionID ? "named" : "new each launch", arguments: Object.keys(automation.action.args) }))
  }
} finally { db.close() }
