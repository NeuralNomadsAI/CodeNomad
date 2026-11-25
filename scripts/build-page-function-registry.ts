/** Generated native resources; functions.ts and diagnostic-events.ts are the only authored sources. */
import { writeFileSync } from "node:fs"
import { nativeFunctionRegistry } from "../packages/server/src/automation/page/functions"
import { DIAGNOSTICS } from "../packages/server/src/automation/page/diagnostic-events"
const write = (file: string, value: unknown) => writeFileSync(new URL(`../packages/server/src/automation/page/${file}`, import.meta.url), JSON.stringify(value, null, 2) + "\n")
write("functions.generated.json", nativeFunctionRegistry())
write("diagnostic-events.generated.json", DIAGNOSTICS)
